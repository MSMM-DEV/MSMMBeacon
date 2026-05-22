// Supabase Edge Function · timeclock-classify
//
// The async, smart half of the timekeeping classifier. The synchronous trigger
// fn_classify_interval (in 20260601120100_timekeeping_intervals.sql) handles
// the time-of-day rule the moment a punch arrives — lunch window → 'lunch',
// before-16:00 closed gap → 'meeting_untagged', after-16:00 → 'eod'. This
// function refines those classifications with Outlook calendar correlation
// and fires "tag your meeting" alerts for closed out-of-office gaps that
// stayed 'meeting_untagged' past the configurable grace window
// (tk_untagged_alert_after_min, default 30 min).
//
// Trigger modes:
//   • Kicked from timeclock-punch immediately after each tap (with user_id)
//   • Cron'd every 5 min by .github/workflows/timekeeping-classify-tick.yml
//     (no user_id → sweeps all users with enabled outlook sync state)
//
// Auth:
//   • Service-role bearer (cron + the punch endpoint's fire-and-forget kick)
//   • Admin session JWT (manual "Reclassify now" button in TimeAdminTab)
//
// Idempotent: re-running on the same window converges on the same state. It
// only writes to time_intervals when something needs to change, and the
// alert-insert path checks for an existing alert for the same user+date
// before inserting.
//
// Deploy:
//   supabase functions deploy timeclock-classify --project-ref ggqlcsppojypgaiyhods

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CT_TZ             = "America/Chicago";
const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_USERS_PER_TICK     = 50;       // soft cap to keep cron under timeout

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

function svc() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    db:   { schema: "beacon_v2" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface Interval {
  id:                     string;
  user_id:                string;
  start_at:               string;
  end_at:                 string | null;
  category:               string;
  category_source:        string;
  outlook_event_id:       string | null;
  start_punch_id:         string | null;
  end_punch_id:           string | null;
}

interface CalEvent {
  outlook_event_id:   string;
  subject:            string | null;
  start_at:           string;
  end_at:             string;
  location:           string | null;
  is_all_day:         boolean;
  is_cancelled:       boolean;
  show_as:            string | null;
  travel_buffer_min:  number;
}

interface Settings {
  tk_eod_window_start:           string;     // 'HH:MM'
  tk_untagged_alert_after_min:   number;
  tk_default_travel_buffer_min:  number;
  tk_holidays:                   string[];   // ['YYYY-MM-DD', ...]
  tk_business_tz:                string;
}

async function loadSettings(): Promise<Settings> {
  const sb = svc();
  const { data, error } = await sb
    .from("app_settings")
    .select("tk_eod_window_start, tk_untagged_alert_after_min, tk_default_travel_buffer_min, tk_holidays, tk_business_tz")
    .eq("singleton", true)
    .maybeSingle();
  if (error) throw new Error(`settings load: ${error.message}`);
  return {
    tk_eod_window_start:          (data?.tk_eod_window_start as string) || "16:00",
    tk_untagged_alert_after_min:  (data?.tk_untagged_alert_after_min as number) ?? 30,
    tk_default_travel_buffer_min: (data?.tk_default_travel_buffer_min as number) ?? 30,
    tk_holidays:                  ((data?.tk_holidays as string[]) || []),
    tk_business_tz:               (data?.tk_business_tz as string) || CT_TZ,
  };
}

function ctDate(iso: string, tz = CT_TZ): string {
  // YYYY-MM-DD in CT.
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
}

function overlapMinutes(a0: number, a1: number, b0: number, b1: number): number {
  const start = Math.max(a0, b0);
  const end   = Math.min(a1, b1);
  return Math.max(0, end - start) / 60000;
}

// Pick the single best matching event for an interval. Score by overlap %.
// Returns null if best overlap < 30% of the interval duration.
function pickBestEvent(interval: Interval, events: CalEvent[], defaultBufferMin: number): CalEvent | null {
  if (!interval.end_at) return null;
  const iv0 = +new Date(interval.start_at);
  const iv1 = +new Date(interval.end_at);
  const dur = iv1 - iv0;
  if (dur <= 0) return null;

  let best: CalEvent | null = null;
  let bestOverlap = 0;

  for (const ev of events) {
    if (ev.is_cancelled) continue;
    if (ev.show_as === "free") continue;
    const buf = (ev.travel_buffer_min ?? defaultBufferMin) * 60_000;
    const evStart = +new Date(ev.start_at) - buf;
    const evEnd   = +new Date(ev.end_at)   + buf;
    const ov = overlapMinutes(iv0, iv1, evStart, evEnd);
    if (ov * 60_000 / dur > 0.3 && ov > bestOverlap) {
      bestOverlap = ov;
      best = ev;
    }
  }
  return best;
}

// Determine whether an interval is OOO ("out for meeting" candidate).
// An interval is OOO when both its punches exist (closed) and the prior
// interval was IN (work). Because intervals always alternate open-close-open
// in the append-only model, an interval being "OOO" boils down to: it's
// closed AND it's the gap BETWEEN two IN-state intervals. We can detect that
// indirectly via category: anything classified work/break is not OOO. But
// 'meeting_untagged' / 'lunch' / 'eod' are all OOO.
function isOooCandidate(interval: Interval): boolean {
  if (!interval.end_at) return false;
  if (interval.category_source === "user" || interval.category_source === "admin") return false;
  return ["meeting_untagged", "lunch", "eod", "work", "break"].includes(interval.category);
}

async function classifyUser(userId: string, lookbackHours: number, settings: Settings): Promise<{
  user_id:                string;
  intervals_examined:     number;
  intervals_tagged:       number;
  alerts_inserted:        number;
  days_recomputed:        number;
}> {
  const sb = svc();
  const since = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
  const result = {
    user_id:            userId,
    intervals_examined: 0,
    intervals_tagged:   0,
    alerts_inserted:    0,
    days_recomputed:    0,
  };

  const { data: ivs, error: ivErr } = await sb
    .from("time_intervals")
    .select("id, user_id, start_at, end_at, category, category_source, outlook_event_id, start_punch_id, end_punch_id")
    .eq("user_id", userId)
    .gte("start_at", since)
    .not("end_at", "is", null)
    .order("start_at", { ascending: true });
  if (ivErr) throw new Error(`intervals load: ${ivErr.message}`);
  const intervals = (ivs || []) as Interval[];
  if (intervals.length === 0) return result;
  result.intervals_examined = intervals.length;

  // Pull candidate events in the window (± 4 hours to catch travel buffers).
  const winStart = new Date(Date.now() - (lookbackHours + 4) * 3600_000).toISOString();
  const winEnd   = new Date(Date.now() + 4 * 3600_000).toISOString();
  const { data: evs, error: evErr } = await sb
    .from("user_calendar_events")
    .select("outlook_event_id, subject, start_at, end_at, location, is_all_day, is_cancelled, show_as, travel_buffer_min")
    .eq("user_id", userId)
    .gte("end_at", winStart)
    .lte("start_at", winEnd);
  if (evErr) throw new Error(`events load: ${evErr.message}`);
  const events = (evs || []) as CalEvent[];

  // First pass: all-day OOO events → mark every interval that day 'vacation'.
  const vacDates = new Set<string>();
  for (const ev of events) {
    if (ev.is_cancelled) continue;
    if (ev.is_all_day && (ev.show_as === "oof")) {
      vacDates.add(ctDate(ev.start_at, settings.tk_business_tz));
    }
  }

  // Holiday overrides
  const holidaySet = new Set(settings.tk_holidays || []);
  const datesTouched = new Set<string>();

  for (const iv of intervals) {
    if (!iv.end_at) continue;
    const ivDate = ctDate(iv.start_at, settings.tk_business_tz);
    datesTouched.add(ivDate);

    // Vacation override
    if (vacDates.has(ivDate) && iv.category_source !== "user" && iv.category_source !== "admin") {
      if (iv.category !== "vacation") {
        const { error } = await sb
          .from("time_intervals")
          .update({ category: "vacation", category_source: "outlook", computed_at: new Date().toISOString() })
          .eq("id", iv.id);
        if (!error) result.intervals_tagged++;
      }
      continue;
    }

    // Holiday override
    if (holidaySet.has(ivDate) && iv.category_source !== "user" && iv.category_source !== "admin") {
      if (iv.category !== "holiday") {
        const { error } = await sb
          .from("time_intervals")
          .update({ category: "holiday", category_source: "auto", computed_at: new Date().toISOString() })
          .eq("id", iv.id);
        if (!error) result.intervals_tagged++;
      }
      continue;
    }

    if (!isOooCandidate(iv)) continue;

    // Calendar correlation
    const match = pickBestEvent(iv, events, settings.tk_default_travel_buffer_min);
    if (match) {
      if (iv.outlook_event_id === match.outlook_event_id && iv.category === "meeting") continue;
      const { error } = await sb
        .from("time_intervals")
        .update({
          category:                "meeting",
          category_source:         "outlook",
          outlook_event_id:        match.outlook_event_id,
          outlook_event_subject:   match.subject,
          outlook_event_location:  match.location,
          computed_at:             new Date().toISOString(),
        })
        .eq("id", iv.id);
      if (!error) result.intervals_tagged++;
      continue;
    }

    // No match — and rule classifier put it at 'meeting_untagged'. Maybe alert.
    if (iv.category === "meeting_untagged" && iv.category_source === "rule") {
      const endMs   = +new Date(iv.end_at);
      const ageMin  = (Date.now() - endMs) / 60_000;
      if (ageMin >= settings.tk_untagged_alert_after_min) {
        // Check if we've already alerted for this user+date.
        const dayStart = new Date(`${ivDate}T00:00:00`).toISOString();
        const dayEnd   = new Date(`${ivDate}T23:59:59`).toISOString();
        const { data: existing } = await sb
          .from("alerts")
          .select("id")
          .eq("subject_table", "timesheet")
          .eq("subject_row_id", userId)
          .gte("first_fire_at", dayStart)
          .lte("first_fire_at", dayEnd)
          .eq("is_active", true)
          .limit(1);
        if (!existing || existing.length === 0) {
          const message = `Untagged out-of-office on ${ivDate} (${iv.start_at.slice(11,16)}–${iv.end_at.slice(11,16)}). Open Beacon to tag it as a meeting or mark it as personal time.`;
          const { data: alert, error: aErr } = await sb
            .from("alerts")
            .insert({
              subject_table:  "timesheet",
              subject_row_id: userId,
              first_fire_at:  new Date().toISOString(),
              recurrence:     "one_time",
              message,
              anchor_field:   "interval_end",
              anchor_offset_minutes: settings.tk_untagged_alert_after_min,
              timezone:       settings.tk_business_tz,
              is_active:      true,
            })
            .select("id")
            .single();
          if (!aErr && alert) {
            await sb.from("alert_recipients").insert({ alert_id: alert.id, user_id: userId });
            await sb.from("alert_fires").insert({
              alert_id: alert.id, scheduled_at: new Date().toISOString(), status: "pending",
            });
            result.alerts_inserted++;
          }
        }
      }
    }
  }

  // Recompute day rollups for affected dates.
  for (const d of datesTouched) {
    const { error } = await sb.rpc("fn_recompute_day", { _user_id: userId, _date: d });
    if (!error) result.days_recomputed++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response("method not allowed", { status: 405, headers: CORS });

  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return json({ ok: false, error: "missing authorization" }, 401);

  const isService = bearer === SERVICE_ROLE_KEY;
  if (!isService) {
    const c = createClient(SUPABASE_URL, ANON_KEY, {
      db:     { schema: "beacon_v2" },
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth:   { persistSession: false, autoRefreshToken: false },
    });
    const { data: u } = await c.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "invalid session" }, 401);
    const { data: me } = await c.from("users").select("role").eq("auth_user_id", u.user.id).maybeSingle();
    if (!me || me.role !== "Admin") return json({ ok: false, error: "forbidden" }, 403);
  }

  const body = await req.json().catch(() => ({})) as { user_id?: string; lookback_hours?: number };
  const lookback = Math.min(Math.max(body.lookback_hours ?? DEFAULT_LOOKBACK_HOURS, 1), 168);

  let settings: Settings;
  try { settings = await loadSettings(); }
  catch (e) { return json({ ok: false, error: String((e as Error).message) }, 500); }

  const sb = svc();
  let users: string[];
  if (body.user_id) {
    users = [body.user_id];
  } else {
    const { data, error } = await sb
      .from("user_outlook_sync_state")
      .select("user_id")
      .eq("enabled", true)
      .order("last_run_at", { ascending: true, nullsFirst: true })
      .limit(MAX_USERS_PER_TICK);
    if (error) return json({ ok: false, error: error.message }, 500);
    users = (data || []).map((r: { user_id: string }) => r.user_id);
  }

  const summary = {
    tick_at:           new Date().toISOString(),
    user_count:        users.length,
    intervals_tagged:  0,
    alerts_inserted:   0,
    days_recomputed:   0,
    errors:            [] as string[],
  };

  for (const uid of users) {
    try {
      const r = await classifyUser(uid, lookback, settings);
      summary.intervals_tagged += r.intervals_tagged;
      summary.alerts_inserted  += r.alerts_inserted;
      summary.days_recomputed  += r.days_recomputed;
    } catch (e) {
      summary.errors.push(`${uid}: ${(e as Error).message}`.slice(0, 240));
    }
  }

  // Best-effort: prune expired enrollment sessions.
  try {
    await sb.from("nfc_enroll_sessions").delete().lt("expires_at", new Date().toISOString());
  } catch (_) { /* best-effort */ }

  return json({ ok: true, ...summary });
});
