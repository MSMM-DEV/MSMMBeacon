// Supabase Edge Function · outlook-sync
//
// Two parallel sync passes against the same Graph client-credential token:
//
//   1. PASS A — shared beacon@msmmeng.com mailbox → beacon_v2.events.
//      Drives the Events & Other tab + the calendar view (BD events).
//      Authority split: title/datetime/internal attendees/external snapshot
//      overwrite on UPDATE; sticky type/status/notes stay user-editable.
//
//   2. PASS B — every internal @msmmeng.com user's calendar → the per-user
//      mirror in beacon_v2.user_calendar_events. Drives the timekeeping
//      classifier's "auto-tag this OUT against an Outlook meeting" logic.
//      Per-user delta cursor in beacon_v2.user_outlook_sync_state.
//
// Pass B is gated on the tenant-wide RBAC scope created by
// scripts/setup_outlook_rbac.ps1 (MSMM-AllUsers-Scope binding Application
// Calendars.Read against PrimarySmtpAddress -like '*@msmmeng.com'). The same
// app registration grants access to BOTH the shared mailbox and every user
// mailbox, so a single token works for both passes.
//
// Authority split:
//   - Synced fields (title, start/end datetime, internal attendees,
//     external snapshot, organizer, web link, cancellation, etag, last-
//     synced timestamp) overwrite on every UPDATE.
//   - Beacon-extras (type, status, notes) are NEVER touched on UPDATE.
//
// Triggered every 15 minutes by .github/workflows/outlook-sync-tick.yml.
// Also callable from the admin UI via the same dual-auth gate as send-alert
// (service-role bearer OR Admin-role JWT).
//
// Deploy:
//   supabase functions deploy outlook-sync --project-ref ggqlcsppojypgaiyhods
//
// Required secrets:
//   MS_GRAPH_TENANT_ID
//   MS_GRAPH_CLIENT_ID
//   MS_GRAPH_CLIENT_SECRET
//   OUTLOOK_MAILBOX            e.g. "beacon@msmmeng.com"
//   OUTLOOK_SYNC_ENABLED       "true" to dispatch; anything else → no-op
//
// Auto-injected by the Supabase runtime:
//   SUPABASE_URL
//   SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY              = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MS_TENANT_ID          = Deno.env.get("MS_GRAPH_TENANT_ID") || "";
const MS_CLIENT_ID          = Deno.env.get("MS_GRAPH_CLIENT_ID") || "";
const MS_CLIENT_SECRET      = Deno.env.get("MS_GRAPH_CLIENT_SECRET") || "";
const MAILBOX               = Deno.env.get("OUTLOOK_MAILBOX") || "beacon@msmmeng.com";
const OUTLOOK_SYNC_ENABLED  = (Deno.env.get("OUTLOOK_SYNC_ENABLED") || "").toLowerCase() === "true";

const WINDOW_MONTHS_BACK    = 12;
const WINDOW_MONTHS_FWD     = 12;
const PAGE_LIMIT            = 200;
const MAX_PAGES             = 50;
const MSMM_DOMAIN           = "@msmmeng.com";

// Per-user (pass B) window is narrower than the shared beacon@ window — the
// classifier only needs ±90 days for tap correlation, and a tighter window
// keeps the per-user delta replay manageable on first run for 30+ users.
const USER_WINDOW_DAYS_BACK = 30;
const USER_WINDOW_DAYS_FWD  = 90;
const USER_MAX_PAGES        = 25;
const USER_CONCURRENCY      = 4;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

interface GraphAttendee {
  emailAddress?: { address?: string; name?: string };
  status?:       { response?: string };
  type?:         string;
}
interface GraphEvent {
  id:            string;
  iCalUId?:      string;
  changeKey?:    string;
  subject?:      string;
  start?:        { dateTime?: string; timeZone?: string };
  end?:          { dateTime?: string; timeZone?: string };
  attendees?:    GraphAttendee[];
  organizer?:    { emailAddress?: { address?: string; name?: string } };
  webLink?:      string;
  isCancelled?:  boolean;
  ["@removed"]?: { reason?: string };
}
interface GraphPage {
  value:               GraphEvent[];
  ["@odata.nextLink"]?:  string;
  ["@odata.deltaLink"]?: string;
}
interface BeaconUser { id: string; email: string; }
interface SyncState {
  mailbox:           string;
  delta_link:        string | null;
  last_full_sync_at: string | null;
}
type ExternalAttendee = {
  email:    string;
  name:     string;
  response: string;
  type:     string;
};

async function fetchGraphToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     MS_CLIENT_ID,
    client_secret: MS_CLIENT_SECRET,
    scope:         "https://graph.microsoft.com/.default",
  });
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`graph token ${res.status}: ${detail.slice(0, 400)}`);
  }
  const data = await res.json() as { access_token?: string };
  if (!data.access_token) throw new Error("graph token: no access_token in response");
  return data.access_token;
}

function startWindowIso(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - WINDOW_MONTHS_BACK);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
function endWindowIso(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + WINDOW_MONTHS_FWD);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

function buildInitialDeltaUrl(): string {
  const params = new URLSearchParams({
    startDateTime: startWindowIso(),
    endDateTime:   endWindowIso(),
  });
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/calendarView/delta?${params.toString()}`;
}

async function fetchGraphPage(url: string, token: string): Promise<GraphPage> {
  const res = await fetch(url, {
    method:  "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Prefer":        `outlook.timezone="UTC", odata.maxpagesize=${PAGE_LIMIT}`,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`graph page ${res.status}: ${detail.slice(0, 400)}`);
  }
  return await res.json() as GraphPage;
}

function isoOrNull(s: string | undefined | null): string | null {
  if (!s) return null;
  // Why: Graph returns UTC timestamps without a trailing 'Z' when the Prefer
  // header pins outlook.timezone="UTC"; appending 'Z' makes them parse as UTC.
  const hasTz = /Z|[+-]\d{2}:?\d{2}$/.test(s);
  const d = new Date(hasTz ? s : `${s}Z`);
  if (Number.isNaN(+d)) return null;
  return d.toISOString();
}
function isoToDate(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}

function partitionAttendees(attendees: GraphAttendee[] | undefined): {
  internalEmails: string[];
  external:       ExternalAttendee[];
} {
  const internalEmails: string[] = [];
  const external: ExternalAttendee[] = [];
  for (const a of attendees || []) {
    const email = (a.emailAddress?.address || "").trim();
    if (!email) continue;
    if (email.toLowerCase().endsWith(MSMM_DOMAIN)) {
      internalEmails.push(email);
    } else {
      external.push({
        email,
        name:     a.emailAddress?.name || "",
        response: a.status?.response   || "none",
        type:     a.type               || "required",
      });
    }
  }
  return { internalEmails, external };
}

function diffJoinIds(oldIds: string[], newIds: string[]): { toAdd: string[]; toRemove: string[] } {
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);
  return {
    toAdd:    [...newSet].filter(x => !oldSet.has(x)),
    toRemove: [...oldSet].filter(x => !newSet.has(x)),
  };
}

// ---------------------------------------------------------------------------
// PASS B helpers — per-user calendar mirror for the timekeeping classifier.
// ---------------------------------------------------------------------------
function userStartWindowIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - USER_WINDOW_DAYS_BACK);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}
function userEndWindowIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + USER_WINDOW_DAYS_FWD);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}
function buildInitialUserDeltaUrl(mailbox: string): string {
  const params = new URLSearchParams({
    startDateTime: userStartWindowIso(),
    endDateTime:   userEndWindowIso(),
  });
  return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/calendarView/delta?${params.toString()}`;
}

interface UserCalEventPayload {
  user_id:            string;
  outlook_event_id:   string;
  ical_uid:           string | null;
  subject:            string | null;
  start_at:           string;
  end_at:             string;
  location:           string | null;
  is_all_day:         boolean;
  is_cancelled:       boolean;
  sensitivity:        string | null;
  show_as:            string | null;
  organizer:          Record<string, unknown> | null;
  attendees:          unknown[];
  outlook_web_link:   string | null;
  last_synced_at:     string;
}

interface GraphUserEvent extends GraphEvent {
  isAllDay?:    boolean;
  sensitivity?: string;
  showAs?:      string;
  location?:    { displayName?: string };
}

async function syncOneUserCalendar(
  token:    string,
  sb:       ReturnType<typeof createClient>,
  userId:   string,
  mailbox:  string,
  cursor:   string | null,
): Promise<{
  pages:    number;
  upserts:  number;
  deletes:  number;
  skipped:  number;
  delta:    string | null;
  error?:   string;
}> {
  const out = { pages: 0, upserts: 0, deletes: 0, skipped: 0, delta: cursor };

  let nextUrl: string | undefined = cursor || buildInitialUserDeltaUrl(mailbox);
  let pages = 0;

  while (nextUrl && pages < USER_MAX_PAGES) {
    const page = await fetchGraphPage(nextUrl, token);
    pages++;
    const events = page.value || [];

    for (const ev of events as GraphUserEvent[]) {
      if (ev["@removed"]) {
        if (ev.id) {
          const { error } = await sb
            .from("user_calendar_events")
            .delete()
            .eq("user_id", userId)
            .eq("outlook_event_id", ev.id);
          if (!error) out.deletes++;
        } else {
          out.skipped++;
        }
        continue;
      }
      if (!ev.id || !ev.start?.dateTime || !ev.end?.dateTime) {
        out.skipped++;
        continue;
      }

      const startIso = isoOrNull(ev.start?.dateTime);
      const endIso   = isoOrNull(ev.end?.dateTime);
      if (!startIso || !endIso) { out.skipped++; continue; }

      const payload: UserCalEventPayload = {
        user_id:           userId,
        outlook_event_id:  ev.id,
        ical_uid:          ev.iCalUId ?? null,
        subject:           ev.subject ?? null,
        start_at:          startIso,
        end_at:            endIso,
        location:          ev.location?.displayName ?? null,
        is_all_day:        !!ev.isAllDay,
        is_cancelled:      !!ev.isCancelled,
        sensitivity:       ev.sensitivity ?? null,
        show_as:           ev.showAs ?? null,
        organizer:         ev.organizer?.emailAddress
                             ? { name: ev.organizer.emailAddress.name || "", email: ev.organizer.emailAddress.address || "" }
                             : null,
        attendees:         (ev.attendees || []).map(a => ({
                              name:     a.emailAddress?.name    || "",
                              email:    a.emailAddress?.address || "",
                              response: a.status?.response      || "none",
                              type:     a.type                  || "required",
                           })),
        outlook_web_link:  ev.webLink ?? null,
        last_synced_at:    new Date().toISOString(),
      };

      // Upsert WITHOUT touching travel_buffer_min (user/admin-editable).
      // The two-call insert-vs-update keeps the UPDATE column list narrow.
      const { data: existing } = await sb
        .from("user_calendar_events")
        .select("outlook_event_id")
        .eq("user_id", userId)
        .eq("outlook_event_id", ev.id)
        .maybeSingle();

      if (existing) {
        const { error } = await sb
          .from("user_calendar_events")
          .update(payload)
          .eq("user_id", userId)
          .eq("outlook_event_id", ev.id);
        if (!error) out.upserts++;
        else out.skipped++;
      } else {
        const { error } = await sb
          .from("user_calendar_events")
          .insert(payload);
        if (!error) out.upserts++;
        else out.skipped++;
      }
    }

    if (page["@odata.deltaLink"]) {
      out.delta = page["@odata.deltaLink"];
      nextUrl = undefined;
    } else if (page["@odata.nextLink"]) {
      nextUrl = page["@odata.nextLink"];
    } else {
      nextUrl = undefined;
    }
  }

  out.pages = pages;
  return out;
}

async function runWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function syncAllUserCalendars(
  token:           string,
  sb:              ReturnType<typeof createClient>,
  msmmUsers:       { id: string; email: string }[],
): Promise<{
  user_total:        number;
  user_ok:           number;
  user_err:          number;
  user_pages:        number;
  user_upserts:      number;
  user_deletes:      number;
  user_first_runs:   number;
  user_errors:       string[];
}> {
  // Seed any missing user_outlook_sync_state rows so newly-onboarded users are
  // auto-included in the sync without an explicit admin action.
  for (const u of msmmUsers) {
    if (!u.email) continue;
    await sb
      .from("user_outlook_sync_state")
      .upsert(
        { user_id: u.id, mailbox: u.email, enabled: true },
        { onConflict: "user_id", ignoreDuplicates: true },
      );
  }

  const { data: states, error: stErr } = await sb
    .from("user_outlook_sync_state")
    .select("user_id, mailbox, delta_link, enabled")
    .eq("enabled", true);
  if (stErr) throw new Error(`user_outlook_sync_state load: ${stErr.message}`);

  const targets = (states || []) as { user_id: string; mailbox: string; delta_link: string | null }[];

  const summary = {
    user_total:        targets.length,
    user_ok:           0,
    user_err:          0,
    user_pages:        0,
    user_upserts:      0,
    user_deletes:      0,
    user_first_runs:   0,
    user_errors:       [] as string[],
  };

  await runWithConcurrency(targets, USER_CONCURRENCY, async (t) => {
    const firstRun = !t.delta_link;
    try {
      const r = await syncOneUserCalendar(token, sb, t.user_id, t.mailbox, t.delta_link);
      summary.user_ok++;
      summary.user_pages   += r.pages;
      summary.user_upserts += r.upserts;
      summary.user_deletes += r.deletes;
      if (firstRun) summary.user_first_runs++;

      await sb
        .from("user_outlook_sync_state")
        .update({
          delta_link:       r.delta,
          last_run_at:      new Date().toISOString(),
          last_run_summary: { pages: r.pages, upserts: r.upserts, deletes: r.deletes, skipped: r.skipped, first_run: firstRun },
        })
        .eq("user_id", t.user_id);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      summary.user_err++;
      summary.user_errors.push(`${t.mailbox}: ${msg.slice(0, 200)}`);
      try {
        await sb
          .from("user_outlook_sync_state")
          .update({
            last_run_at:      new Date().toISOString(),
            last_run_summary: { error: msg.slice(0, 500), pages: 0 },
          })
          .eq("user_id", t.user_id);
      } catch (_) { /* best-effort */ }
    }
  });

  return summary;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST")    return new Response("method not allowed", { status: 405, headers: CORS });

  const bearer = (req.headers.get("authorization") || req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ ok: false, error: "missing authorization" }, 401);

  const isServiceCall = bearer === SERVICE_ROLE_KEY;
  if (!isServiceCall) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      db: { schema: "beacon_v2" },
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: u, error: uErr } = await userClient.auth.getUser();
    if (uErr || !u?.user) return json({ ok: false, error: "invalid session" }, 401);
    const { data: me, error: meErr } = await userClient
      .from("users")
      .select("id, role")
      .eq("auth_user_id", u.user.id)
      .maybeSingle();
    if (meErr)                          return json({ ok: false, error: "profile lookup failed" }, 500);
    if (!me || me.role !== "Admin")     return json({ ok: false, error: "forbidden" }, 403);
  }

  if (!OUTLOOK_SYNC_ENABLED) {
    return json({ ok: true, disabled: true, processed: 0, inserted: 0, updated: 0, cancelled: 0, skipped: 0 });
  }
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    return json({ ok: false, error: "missing MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, or MS_GRAPH_CLIENT_SECRET" }, 500);
  }
  if (!MAILBOX) {
    return json({ ok: false, error: "missing OUTLOOK_MAILBOX" }, 500);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    db: { schema: "beacon_v2" },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let processed = 0, inserted = 0, updated = 0, cancelled = 0, skipped = 0;
  const unmatchedEmails = new Set<string>();
  let firstRun = false;

  try {
    const { data: stateRow, error: stateErr } = await sb
      .from("outlook_sync_state")
      .select("mailbox, delta_link, last_full_sync_at")
      .eq("id", 1)
      .maybeSingle();
    if (stateErr) throw new Error(`sync_state load: ${stateErr.message}`);
    const state = (stateRow || { mailbox: MAILBOX, delta_link: null, last_full_sync_at: null }) as SyncState;
    firstRun = !state.delta_link;

    const token = await fetchGraphToken();

    const { data: usersRows, error: usersErr } = await sb
      .from("users")
      .select("id, email")
      .ilike("email", `%${MSMM_DOMAIN}`);
    if (usersErr) throw new Error(`users load: ${usersErr.message}`);
    const usersByEmail = new Map<string, string>();
    for (const u of (usersRows || []) as BeaconUser[]) {
      if (u.email) usersByEmail.set(u.email.toLowerCase(), u.id);
    }

    let nextUrl: string | undefined = state.delta_link || buildInitialDeltaUrl();
    let finalDeltaLink: string | null = state.delta_link;
    let pages = 0;

    while (nextUrl && pages < MAX_PAGES) {
      const page: GraphPage = await fetchGraphPage(nextUrl, token);
      pages++;
      const events = page.value || [];

      for (const ev of events) {
        processed++;

        if (ev["@removed"]) {
          if (ev.id) {
            const { data: existing } = await sb
              .from("events")
              .select("id")
              .eq("outlook_event_id", ev.id)
              .maybeSingle();
            if (existing?.id) {
              const { error: delErr } = await sb
                .from("events")
                .update({ outlook_is_cancelled: true, outlook_last_synced_at: new Date().toISOString() })
                .eq("id", existing.id);
              if (delErr) throw new Error(`mark cancelled ${existing.id}: ${delErr.message}`);
              cancelled++;
            } else {
              skipped++;
            }
          } else {
            skipped++;
          }
          continue;
        }

        if (!ev.id || !ev.subject) {
          skipped++;
          continue;
        }

        const startIso = isoOrNull(ev.start?.dateTime);
        const endIso   = isoOrNull(ev.end?.dateTime);
        const dateOnly = isoToDate(startIso);

        const { internalEmails, external } = partitionAttendees(ev.attendees);
        const internalUserIds: string[] = [];
        for (const em of internalEmails) {
          const uid = usersByEmail.get(em.toLowerCase());
          if (uid) internalUserIds.push(uid);
          else     unmatchedEmails.add(em);
        }

        const organizerAddr = ev.organizer?.emailAddress?.address || "";
        const organizer = organizerAddr
          ? { email: organizerAddr, name: ev.organizer?.emailAddress?.name || "" }
          : null;

        const syncedFields = {
          title:                      ev.subject,
          event_datetime:             startIso,
          event_date:                 dateOnly,
          outlook_end_datetime:       endIso,
          outlook_etag:               ev.changeKey ?? null,
          outlook_external_attendees: external,
          outlook_organizer:          organizer,
          outlook_web_link:           ev.webLink ?? null,
          outlook_is_cancelled:       !!ev.isCancelled,
          outlook_last_synced_at:     new Date().toISOString(),
        };

        // Why: supabase-js .upsert() overwrites every column in the payload,
        // which would clobber sticky Beacon-extras (type/status/notes) on
        // re-sync. We branch insert-vs-update explicitly so the UPDATE path
        // never names those columns.
        const { data: existing, error: lookupErr } = await sb
          .from("events")
          .select("id")
          .eq("outlook_event_id", ev.id)
          .maybeSingle();
        if (lookupErr) throw new Error(`events lookup ${ev.id}: ${lookupErr.message}`);

        let eventRowId: string;
        if (!existing) {
          const insertPayload = {
            ...syncedFields,
            source:                "outlook",
            status:                "Booked",
            type:                  null,
            notes:                 null,
            outlook_event_id:      ev.id,
            outlook_ical_uid:      ev.iCalUId ?? null,
          };
          const { data: insRow, error: insErr } = await sb
            .from("events")
            .insert(insertPayload)
            .select("id")
            .single();
          if (insErr) throw new Error(`events insert ${ev.id}: ${insErr.message}`);
          eventRowId = insRow!.id;
          inserted++;
        } else {
          eventRowId = existing.id;
          const { error: updErr } = await sb
            .from("events")
            .update(syncedFields)
            .eq("id", eventRowId);
          if (updErr) throw new Error(`events update ${eventRowId}: ${updErr.message}`);
          updated++;
        }

        const { data: existAttendees, error: aSelErr } = await sb
          .from("event_attendees")
          .select("user_id")
          .eq("event_id", eventRowId);
        if (aSelErr) throw new Error(`event_attendees load ${eventRowId}: ${aSelErr.message}`);
        const oldIds = ((existAttendees || []) as { user_id: string }[]).map(r => r.user_id);
        const { toAdd, toRemove } = diffJoinIds(oldIds, internalUserIds);

        if (toRemove.length > 0) {
          const { error: aDelErr } = await sb
            .from("event_attendees")
            .delete()
            .eq("event_id", eventRowId)
            .in("user_id", toRemove);
          if (aDelErr) throw new Error(`event_attendees delete ${eventRowId}: ${aDelErr.message}`);
        }
        if (toAdd.length > 0) {
          const { error: aInsErr } = await sb
            .from("event_attendees")
            .insert(toAdd.map(uid => ({ event_id: eventRowId, user_id: uid })));
          if (aInsErr) throw new Error(`event_attendees insert ${eventRowId}: ${aInsErr.message}`);
        }
      }

      if (page["@odata.deltaLink"]) {
        finalDeltaLink = page["@odata.deltaLink"];
        nextUrl = undefined;
      } else if (page["@odata.nextLink"]) {
        nextUrl = page["@odata.nextLink"];
      } else {
        nextUrl = undefined;
      }
    }

    const summary = {
      processed,
      inserted,
      updated,
      cancelled,
      skipped,
      pages,
      first_run:         firstRun,
      unmatched_emails:  [...unmatchedEmails],
    };

    const stateUpdate: Record<string, unknown> = {
      delta_link:       finalDeltaLink,
      last_run_at:      new Date().toISOString(),
      last_run_summary: summary,
    };
    if (firstRun && finalDeltaLink) {
      stateUpdate.last_full_sync_at = new Date().toISOString();
    }
    const { error: stateUpErr } = await sb
      .from("outlook_sync_state")
      .update(stateUpdate)
      .eq("id", 1);
    if (stateUpErr) throw new Error(`sync_state update: ${stateUpErr.message}`);

    // ------------------------------------------------------------------
    // PASS B — per-user calendar mirror for the timekeeping classifier.
    // Skipped if the workspace hasn't enabled timekeeping yet.
    // ------------------------------------------------------------------
    let passB: Awaited<ReturnType<typeof syncAllUserCalendars>> | null = null;
    try {
      const { data: settings } = await sb
        .from("app_settings")
        .select("tk_enabled")
        .eq("singleton", true)
        .maybeSingle();
      if (settings?.tk_enabled) {
        passB = await syncAllUserCalendars(token, sb, (usersRows || []) as BeaconUser[]);
      }
    } catch (e) {
      console.error("outlook-sync pass B failed:", (e as Error).message);
    }

    return json({
      ok: true,
      disabled:         false,
      processed,
      inserted,
      updated,
      cancelled,
      skipped,
      pages,
      first_run:        firstRun,
      unmatched_emails: [...unmatchedEmails],
      user_pass:        passB,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("outlook-sync failed:", msg);
    // Why: we still want last_run_at + last_run_summary updated on failure
    // so the admin UI surfaces the error rather than showing a stale OK.
    try {
      await sb
        .from("outlook_sync_state")
        .update({
          last_run_at:      new Date().toISOString(),
          last_run_summary: {
            error:    msg.slice(0, 500),
            processed, inserted, updated, cancelled, skipped,
            unmatched_emails: [...unmatchedEmails],
          },
        })
        .eq("id", 1);
    } catch (_) { /* best-effort */ }
    return json({ ok: false, error: msg.slice(0, 500), processed, inserted, updated, cancelled, skipped }, 500);
  }
});
