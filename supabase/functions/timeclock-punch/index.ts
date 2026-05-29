// Supabase Edge Function · timeclock-punch
//
// The single endpoint every punch flows through — Raspberry Pi NFC taps AND
// the web/mobile "PUNCH IN/OUT" button on the Timesheet tab. The function:
//
//   1. Authenticates the caller in one of two modes:
//        • Device mode  — Authorization: Bearer <TIMECLOCK_DEVICE_KEY> + a
//          known device_id in time_devices.
//        • User mode    — Authorization: Bearer <session-JWT>; user resolved
//          from auth.uid().
//   2. Resolves the user:
//        • NFC source → look up nfc_tags.uid → user_id. Unknown UID returns
//          {code:'unenrolled', uid:'…'} so the Pi flashes red AND the admin
//          NFC-enrollment UI sees the captured UID via nfc_enroll_sessions.
//        • Web/mobile → user from JWT, ignore any body.user_id.
//   3. De-dupes: a punch from the same (user, source_nfc_uid) within 30 s of
//      another one is treated as a confirming re-tap and returns the existing
//      state instead of inserting.
//   4. Inserts a time_punches row. The fn_punch_reconcile trigger handles
//      closing the open interval, opening the new one, classifying via the
//      rule-based fn_classify_interval, and bumping the day rollup.
//   5. Fires a non-blocking call to timeclock-classify so calendar correlation
//      can refine the just-closed interval (best-effort).
//   6. Updates nfc_tags.last_seen_* and time_devices.last_seen_at.
//   7. Returns the user's new state plus a small `message` the Pi can render
//      on its OLED ("Welcome back, Chris. Now: working.").
//
// Required secrets:
//   TIMECLOCK_DEVICE_KEY    — random 32-byte hex; Pi puts this in
//                             Authorization for source=nfc requests
//   APP_URL                 — used in classifier deep links (already set
//                             from the alerts wiring)
// Auto-injected by Supabase runtime:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//
// Deploy:
//   supabase functions deploy timeclock-punch --project-ref ggqlcsppojypgaiyhods

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY             = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TIMECLOCK_DEVICE_KEY = Deno.env.get("TIMECLOCK_DEVICE_KEY") || "";

const DEDUPE_WINDOW_SEC    = 30;
const CLOCK_DRIFT_SEC      = 60;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age":       "86400",
  "Vary":                         "Origin",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function err(code: string, message: string, status = 400) {
  return json({ ok: false, code, message }, status);
}

type Source = "nfc" | "web" | "mobile" | "manual";
interface PunchBody {
  source:      Source;
  device_id?:  string;
  nfc_uid?:    string;
  user_id?:    string;             // only honored in device mode for source=manual
  punched_at?: string;             // advisory; server uses now() if drift > 60 s
  geo?:        { lat?: number; lng?: number; accuracy_m?: number };
  note?:       string;
  // Kiosk category tagging (two-phase: punch first, then tag the opened
  // interval once the user picks on the 7" screen).
  action?:      "tag";
  interval_id?: string;            // interval to tag (returned by the punch as open_interval_id)
  category?:    string;            // interval_category_enum value
}

// Categories the kiosk / device may set. Mirrors interval_category_enum minus
// the auto-only 'meeting_untagged'/'holiday' values.
const TAGGABLE_CATEGORIES = new Set([
  "work", "lunch", "break", "meeting", "travel", "eod", "vacation", "off",
]);

// Only allow tagging an interval that started recently — a shared device must
// not be able to relabel arbitrary history.
const TAG_MAX_AGE_MS = 30 * 60 * 1000;

async function handleTag(body: PunchBody): Promise<Response> {
  const intervalId = (body.interval_id || "").trim();
  const category   = (body.category || "").trim();
  if (!intervalId) return err("interval_required", "interval_id required for action=tag");
  if (!TAGGABLE_CATEGORIES.has(category)) return err("bad_category", `unknown category: ${category}`);

  const sb = svc();
  const { data: iv, error: ivErr } = await sb
    .from("time_intervals")
    .select("id, user_id, start_at")
    .eq("id", intervalId)
    .maybeSingle();
  if (ivErr) return err("interval_lookup_failed", ivErr.message, 500);
  if (!iv)   return err("interval_unknown", "interval not found", 404);
  if (Date.now() - +new Date(iv.start_at) > TAG_MAX_AGE_MS) {
    return err("interval_too_old", "interval is older than 30 minutes", 409);
  }

  // category_source='user' freezes it so the rule/Outlook classifiers won't
  // overwrite the person's explicit choice (same as the web punch prompt).
  const { error: upErr } = await sb
    .from("time_intervals")
    .update({
      category,
      category_source: "user",
      notes:           body.note ?? null,
      computed_at:     new Date().toISOString(),
    })
    .eq("id", intervalId);
  if (upErr) return err("tag_failed", upErr.message, 500);

  const day = new Date(iv.start_at).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  await sb.rpc("fn_recompute_day", { _user_id: iv.user_id, _date: day });

  return json({ ok: true, tagged: true, interval_id: intervalId, category });
}

function svc() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    db:   { schema: "beacon_v2" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function clientIp(req: Request): string | null {
  // Supabase routes through Cloudflare; the first hop IP shows up here.
  const h = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip");
  if (!h) return null;
  return h.split(",")[0].trim() || null;
}

function resolvePunchedAt(advisory: string | undefined): string {
  if (!advisory) return new Date().toISOString();
  const t = new Date(advisory);
  if (Number.isNaN(+t)) return new Date().toISOString();
  const driftMs = Math.abs(+new Date() - +t);
  if (driftMs > CLOCK_DRIFT_SEC * 1000) return new Date().toISOString();
  return t.toISOString();
}

// ---------------------------------------------------------------------------
// Auth resolution. Returns whichever of { device, user } applies; throws
// Response on failure.
// ---------------------------------------------------------------------------
type AuthResolved =
  | { mode: "device"; device_id: string }
  | { mode: "user";   user_id: string; auth_user_id: string };

async function resolveAuth(req: Request, body: PunchBody): Promise<AuthResolved> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) throw err("auth_required", "missing authorization header", 401);

  // Device mode: shared static bearer. The body must name a known device_id.
  if (TIMECLOCK_DEVICE_KEY && bearer === TIMECLOCK_DEVICE_KEY) {
    const deviceId = (body.device_id || "").trim();
    if (!deviceId) throw err("device_id_required", "device_id missing in device-mode request");
    const { data: dev, error: devErr } = await svc()
      .from("time_devices")
      .select("id, active")
      .eq("id", deviceId)
      .maybeSingle();
    if (devErr) throw err("device_lookup_failed", devErr.message, 500);
    if (!dev) throw err("device_unknown", `device_id "${deviceId}" not registered`, 403);
    if (!dev.active) throw err("device_inactive", `device "${deviceId}" is inactive`, 403);
    return { mode: "device", device_id: deviceId };
  }

  // User mode: validate the session JWT and pull beacon_v2.users.id.
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    db:     { schema: "beacon_v2" },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth:   { persistSession: false, autoRefreshToken: false },
  });
  const { data: u, error: uErr } = await client.auth.getUser();
  if (uErr || !u?.user) throw err("invalid_session", "invalid or expired session", 401);

  const { data: me, error: meErr } = await svc()
    .from("users")
    .select("id, is_enabled")
    .eq("auth_user_id", u.user.id)
    .maybeSingle();
  if (meErr) throw err("profile_lookup_failed", meErr.message, 500);
  if (!me)   throw err("no_beacon_user", "no beacon_v2.users row for this auth user", 403);
  if (!me.is_enabled) throw err("user_disabled", "this account is disabled", 403);

  return { mode: "user", user_id: me.id, auth_user_id: u.user.id };
}

// ---------------------------------------------------------------------------
// Pre-flight gate: workspace-wide kill switch.
// ---------------------------------------------------------------------------
async function checkEnabled() {
  const sb = svc();
  const { data, error } = await sb
    .from("app_settings")
    .select("tk_enabled")
    .eq("singleton", true)
    .maybeSingle();
  if (error) throw err("settings_load_failed", error.message, 500);
  if (!data?.tk_enabled) {
    throw err("disabled", "timekeeping is not yet enabled for this workspace", 503);
  }
}

// ---------------------------------------------------------------------------
// User resolution from NFC. Also writes to nfc_enroll_sessions if an admin
// is currently waiting for the next tap.
// ---------------------------------------------------------------------------
async function resolveUserFromNfc(uid: string, deviceId: string): Promise<{
  user_id: string;
  tag_uid: string;
}> {
  const sb = svc();
  const { data: tag, error: tagErr } = await sb
    .from("nfc_tags")
    .select("uid, user_id, active")
    .eq("uid", uid)
    .maybeSingle();
  if (tagErr) throw err("tag_lookup_failed", tagErr.message, 500);

  if (!tag || !tag.active) {
    // Surface the UID to any open admin capture session AND tell the caller.
    await sb
      .from("nfc_enroll_sessions")
      .update({ captured_uid: uid, captured_at: new Date().toISOString() })
      .is("captured_uid", null)
      .gt("expires_at", new Date().toISOString());
    throw err("unenrolled", `nfc UID ${uid} is not bound to a user`, 404);
  }
  return { user_id: tag.user_id, tag_uid: tag.uid };
}

// ---------------------------------------------------------------------------
// Admin capture mode (enroll / verify). If an admin has an open capture
// session (nfc_enroll_sessions row with captured_uid still null and not yet
// expired), ANY tap — enrolled or not — is diverted INTO that session instead
// of becoming a punch. This is what lets the in-app "Verify a fob" and
// re-enroll-by-tapping flows see an already-enrolled fob (resolveUserFromNfc
// only ever stashed *unenrolled* UIDs, so enrolled fobs used to silently punch
// the user in/out and never reach the website).
//
// Trade-off (acceptable for the single-reader prototype): while a capture
// session is open, a normal employee tap on the same reader is captured rather
// than punched. The window is bounded by the session's 90 s TTL.
// ---------------------------------------------------------------------------
async function captureIfSessionOpen(uid: string): Promise<boolean> {
  const sb = svc();
  const nowIso = new Date().toISOString();
  const { data, error } = await sb
    .from("nfc_enroll_sessions")
    .update({ captured_uid: uid, captured_at: nowIso })
    .is("captured_uid", null)
    .gt("expires_at", nowIso)
    .select("admin_user_id");
  if (error) return false;
  return !!(data && data.length);
}

// ---------------------------------------------------------------------------
// De-dupe: a punch within 30 s for the same (user, nfc_uid) collapses.
// Returns the existing punch_id if a dupe is found.
// ---------------------------------------------------------------------------
async function findRecentDupe(
  userId: string,
  punchedAt: string,
  source: Source,
  nfcUid: string | null,
): Promise<string | null> {
  if (source !== "nfc" || !nfcUid) return null;
  const sb = svc();
  const windowStart = new Date(+new Date(punchedAt) - DEDUPE_WINDOW_SEC * 1000).toISOString();
  const { data, error } = await sb
    .from("time_punches")
    .select("id")
    .eq("user_id", userId)
    .eq("source_nfc_uid", nfcUid)
    .gte("punched_at", windowStart)
    .order("punched_at", { ascending: false })
    .limit(1);
  if (error) return null;     // best-effort; let the unique index catch it
  return data?.[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// State after the punch: do they have an open interval, and how many minutes
// of work today.
// ---------------------------------------------------------------------------
async function loadState(userId: string): Promise<{
  state:            "in" | "out";
  open_since:       string | null;
  open_interval_id: string | null;
  open_is_out:      boolean;
  today_minutes_work: number;
}> {
  const sb = svc();
  // The open interval's is_out is what decides IN vs OUT: a punch-out now opens
  // an OUT interval (the "currently out" period), so an open interval no longer
  // implies the user is IN — only an open IN (is_out=false) interval does.
  // The open interval id is what the kiosk tags a category onto (it's the one
  // this punch just opened, whether IN or OUT).
  const { data: open } = await sb
    .from("time_intervals")
    .select("id, start_at, is_out")
    .eq("user_id", userId)
    .is("end_at", null)
    .order("start_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const openIn = open && !open.is_out ? open : null;

  // Today's date in CT. The DB function uses 'America/Chicago' literally;
  // we replicate via toLocaleDateString.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const { data: day } = await sb
    .from("timesheet_days")
    .select("minutes_work")
    .eq("user_id", userId)
    .eq("date", today)
    .maybeSingle();

  return {
    state:              openIn ? "in" : "out",
    open_since:         openIn?.start_at ?? null,
    open_interval_id:   open?.id ?? null,
    open_is_out:        !!open?.is_out,
    today_minutes_work: day?.minutes_work ?? 0,
  };
}

async function loadUserGreeting(userId: string): Promise<{
  id: string; first_name: string | null; display_name: string | null;
}> {
  const sb = svc();
  const { data } = await sb
    .from("users")
    .select("id, first_name, display_name")
    .eq("id", userId)
    .maybeSingle();
  return data ?? { id: userId, first_name: null, display_name: null };
}

// Fire-and-forget classifier kick. We don't await — the punch response
// shouldn't be gated on calendar correlation.
function kickClassifier(userId: string) {
  try {
    const url = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/timeclock-classify`;
    fetch(url, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ user_id: userId }),
    }).catch(() => { /* best-effort */ });
  } catch (_) { /* never throws into the punch path */ }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response("method not allowed", { status: 405, headers: CORS });

  let body: PunchBody;
  try { body = await req.json(); }
  catch { return err("bad_body", "invalid JSON body"); }

  if (!body || !body.source) return err("bad_body", "source is required");
  if (!["nfc","web","mobile","manual"].includes(body.source)) {
    return err("bad_body", `unknown source: ${body.source}`);
  }

  let auth: AuthResolved;
  try {
    auth = await resolveAuth(req, body);
  } catch (resp) {
    if (resp instanceof Response) return resp;
    return err("auth_failed", String(resp), 500);
  }

  try { await checkEnabled(); }
  catch (resp) {
    if (resp instanceof Response) return resp;
    return err("settings_check_failed", String(resp), 500);
  }

  // Phase 2 of the kiosk flow: tag a category onto the interval the punch just
  // opened. Auth already validated above (device bearer or session JWT).
  if (body.action === "tag") {
    try { return await handleTag(body); }
    catch (e) { return err("tag_failed", String(e), 500); }
  }

  // Resolve user id from auth + body.
  let userId: string;
  let nfcUid: string | null = null;
  if (auth.mode === "device") {
    if (body.source === "nfc") {
      const rawUid = (body.nfc_uid || "").trim();
      if (!rawUid) return err("nfc_uid_required", "nfc_uid required for source=nfc");
      // Admin enroll/verify capture takes priority over punching — and works
      // for enrolled fobs too (see captureIfSessionOpen).
      try {
        if (await captureIfSessionOpen(rawUid)) {
          return json({ ok: true, captured: true, uid: rawUid, message: "captured for enrollment/verify" });
        }
      } catch (_e) { /* fall through to normal punch */ }
      try {
        const r = await resolveUserFromNfc(rawUid, auth.device_id);
        userId = r.user_id;
        nfcUid = r.tag_uid;
      } catch (resp) {
        if (resp instanceof Response) return resp;
        return err("unenrolled", String(resp), 404);
      }
    } else if (body.source === "manual" && body.user_id) {
      userId = body.user_id;
    } else {
      return err("source_not_allowed_in_device_mode", `device mode only accepts source=nfc (or manual w/ user_id)`);
    }
  } else {
    userId = auth.user_id;
    if (body.source === "nfc") {
      return err("source_not_allowed_in_user_mode", "web/mobile callers must use source=web or source=mobile");
    }
  }

  const punchedAt = resolvePunchedAt(body.punched_at);
  const sb        = svc();

  // De-dupe
  const dupeId = await findRecentDupe(userId, punchedAt, body.source, nfcUid);
  if (dupeId) {
    const state = await loadState(userId);
    const user  = await loadUserGreeting(userId);
    return json({
      ok:                 true,
      deduped:            true,
      punch_id:           dupeId,
      user,
      state:              state.state,
      open_since:         state.open_since,
      open_interval_id:   state.open_interval_id,
      open_is_out:        state.open_is_out,
      today_minutes_work: state.today_minutes_work,
      message:            buildMessage(user, state),
    });
  }

  // Insert. The trigger does the rest.
  const insertPayload = {
    user_id:          userId,
    punched_at:       punchedAt,
    source:           body.source,
    source_device_id: auth.mode === "device" ? auth.device_id : null,
    source_nfc_uid:   nfcUid,
    client_ip:        clientIp(req),
    user_agent:       req.headers.get("user-agent") || null,
    geo_lat:          body.geo?.lat ?? null,
    geo_lng:          body.geo?.lng ?? null,
    geo_accuracy_m:   body.geo?.accuracy_m ?? null,
    note:             body.note ?? null,
    created_by:       auth.mode === "user" ? auth.user_id : null,
  };

  const { data: punch, error: pErr } = await sb
    .from("time_punches")
    .insert(insertPayload)
    .select("id")
    .single();
  if (pErr) {
    // Lock-guard or unique-index violations bubble up here.
    if (/locked/i.test(pErr.message)) return err("week_locked", pErr.message, 409);
    if (pErr.code === "23505")        return err("duplicate", pErr.message, 409);
    return err("insert_failed", pErr.message, 500);
  }

  // Update last-seen telemetry (best-effort; never block the response).
  if (nfcUid) {
    sb.from("nfc_tags")
      .update({ last_seen_at: punchedAt, last_seen_device: auth.mode === "device" ? auth.device_id : null })
      .eq("uid", nfcUid)
      .then(() => {}, () => {});
  }
  if (auth.mode === "device") {
    sb.from("time_devices")
      .update({ last_seen_at: punchedAt })
      .eq("id", auth.device_id)
      .then(() => {}, () => {});
  }

  // Kick the classifier for calendar enrichment.
  kickClassifier(userId);

  const state = await loadState(userId);
  const user  = await loadUserGreeting(userId);
  return json({
    ok:                 true,
    punch_id:           punch.id,
    user,
    state:              state.state,
    open_since:         state.open_since,
    open_interval_id:   state.open_interval_id,
    open_is_out:        state.open_is_out,
    today_minutes_work: state.today_minutes_work,
    message:            buildMessage(user, state),
  });
});

function buildMessage(user: { first_name: string | null; display_name: string | null }, state: { state: "in"|"out" }): string {
  const name = (user.first_name || user.display_name || "").trim() || "there";
  if (state.state === "in") return `Welcome, ${name}. Now: working.`;
  return `See you, ${name}. Punched out.`;
}
