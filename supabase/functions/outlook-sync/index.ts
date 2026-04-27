// Supabase Edge Function · outlook-sync
//
// Pulls calendar events from the shared `beacon@msmmeng.com` mailbox via
// Microsoft Graph and lands them in beacon.events as `source='outlook'`
// rows. Uses Graph's /calendarView/delta cursor so each tick only sees
// changes since the last run. Internal MSMM attendees become
// beacon.event_attendees rows; external invitees stay in the
// outlook_external_attendees JSON snapshot.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST")    return new Response("method not allowed", { status: 405, headers: CORS });

  const bearer = (req.headers.get("authorization") || req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ ok: false, error: "missing authorization" }, 401);

  const isServiceCall = bearer === SERVICE_ROLE_KEY;
  if (!isServiceCall) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      db: { schema: "beacon" },
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
    db: { schema: "beacon" },
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
