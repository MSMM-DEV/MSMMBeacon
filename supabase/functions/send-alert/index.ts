// Supabase Edge Function · send-alert
//
// Called every minute by the GitHub Actions workflow alert-tick.yml. Pulls
// due rows from beacon.alert_fires, renders a row-specific email, sends via
// Resend, and records the result. Run idempotently — safe to invoke as many
// times as you like; claim_pending_fires uses FOR UPDATE SKIP LOCKED so two
// concurrent invocations can't double-send the same fire.
//
// Deploy:
//   supabase functions deploy send-alert --project-ref ggqlcsppojypgaiyhods
//
// Required secrets (set via `supabase secrets set ... --project-ref ...`):
//   RESEND_API_KEY            Resend dashboard → API Keys
//   ALERT_FROM_EMAIL          e.g. "Beacon <alerts@msmmeng.com>" (domain must be verified in Resend)
//   APP_URL                   e.g. "https://beacon.msmmeng.com" — used in deep-link {APP_URL}?tab=X&rowId=Y
//   ALERTS_ENABLED            "true" to dispatch; anything else → no-op (kill switch)
//
// Auto-injected by the Supabase runtime:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Caller auth: Authorization: Bearer <service-role-key>. Compared against the
// service-role secret to refuse random anon callers even if the function is
// exposed without --no-verify-jwt.
//
// POST body is ignored. Return:
//   { ok: true, processed: N, sent: X, failed: Y, skipped: Z, disabled?: true }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { RRule } from "npm:rrule@2.8.1";

const SUPABASE_URL           = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY               = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY         = Deno.env.get("RESEND_API_KEY") || "";
const ALERT_FROM_EMAIL       = Deno.env.get("ALERT_FROM_EMAIL") || "";
const APP_URL                = (Deno.env.get("APP_URL") || "http://localhost:5173").replace(/\/+$/, "");
const ALERTS_ENABLED         = (Deno.env.get("ALERTS_ENABLED") || "").toLowerCase() === "true";

const MAX_ATTEMPTS = 3;      // cap retry loop for persistently-failing fires
const CLAIM_BATCH  = 50;     // pulls per tick

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

// --------------------------------------------------------------------------
// Enum → DB table name. Matches the do-block in 20260424120000_alerts_wiring.
// --------------------------------------------------------------------------
const SUBJECT_TABLE: Record<string, string> = {
  potential:   "potential_projects",
  awaiting:    "awaiting_verdict",
  awarded:     "awarded_projects",
  soq:         "soq",
  closed_out:  "closed_out_projects",
  invoice:     "anticipated_invoice",
  event:       "events",
};

// Friendly labels for anchor_field keys when phrased in an email.
const ANCHOR_LABEL: Record<string, string> = {
  next_action_date:        "the next action",
  anticipated_result_date: "the anticipated verdict",
  date_submitted:          "the submission date",
  contract_expiry_date:    "the contract expiry",
  start_date:              "the start date",
  date_closed:             "the close date",
  event_date:              "the event date",
  event_datetime:          "the event",
};

// --------------------------------------------------------------------------
// Types (loose — we only read what we need off each row)
// --------------------------------------------------------------------------
interface Fire {
  id: string;
  alert_id: string;
  scheduled_at: string;
  attempts: number;
  status: string;
}
interface Alert {
  id: string;
  subject_table: string;
  subject_row_id: string;
  first_fire_at: string;
  recurrence: "one_time" | "weekly" | "biweekly" | "monthly" | "custom";
  recurrence_rule: string | null;
  message: string | null;
  anchor_field: string | null;
  anchor_offset_minutes: number | null;
  timezone: string;
  is_active: boolean;
}
interface Recipient { email: string; name: string; }

// --------------------------------------------------------------------------
// Row-specific renderers. Each returns { subject, summaryLines, deepLinkTab }.
// deepLinkTab is the URL-param value for `?tab=X`; summaryLines are plain
// strings joined into the email body.
// --------------------------------------------------------------------------
type Rendered = { subject: string; summaryLines: string[]; deepLinkTab: string };

function fmt$(n: unknown): string {
  const v = typeof n === "number" ? n : Number(n || 0);
  if (!v) return "";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(+dt)) return String(d);
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function render(subjectTable: string, row: any): Rendered {
  switch (subjectTable) {
    case "potential": return {
      subject:      `Beacon · Next action: "${row.project_name}"${row.next_action_date ? ` (${fmtDate(row.next_action_date)})` : ""}`,
      deepLinkTab:  "potential",
      summaryLines: [
        row.project_number ? `Project #: ${row.project_number}` : null,
        row.total_contract_amount ? `Contract: ${fmt$(row.total_contract_amount)}` : null,
        row.msmm_amount ? `MSMM: ${fmt$(row.msmm_amount)}` : null,
        row.next_action_date ? `Next action: ${fmtDate(row.next_action_date)}` : null,
        row.next_action_note ? `Notes: ${row.next_action_note}` : null,
      ].filter(Boolean) as string[],
    };
    case "awaiting": return {
      subject:      `Beacon · Verdict expected: "${row.project_name}"${row.anticipated_result_date ? ` (${fmtDate(row.anticipated_result_date)})` : ""}`,
      deepLinkTab:  "awaiting",
      summaryLines: [
        row.project_number ? `Project #: ${row.project_number}` : null,
        row.date_submitted ? `Submitted: ${fmtDate(row.date_submitted)}` : null,
        row.anticipated_result_date ? `Anticipated result: ${fmtDate(row.anticipated_result_date)}` : null,
        row.msmm_contract_number ? `MSMM contract: ${row.msmm_contract_number}` : null,
      ].filter(Boolean) as string[],
    };
    case "awarded": return {
      subject:      `Beacon · Contract expiry: "${row.project_name}"${row.contract_expiry_date ? ` (${fmtDate(row.contract_expiry_date)})` : ""}`,
      deepLinkTab:  "awarded",
      summaryLines: [
        row.project_number ? `Project #: ${row.project_number}` : null,
        row.contract_expiry_date ? `Contract expires: ${fmtDate(row.contract_expiry_date)}` : null,
        row.msmm_remaining ? `MSMM remaining: ${fmt$(row.msmm_remaining)}` : null,
      ].filter(Boolean) as string[],
    };
    case "soq": return {
      subject:      `Beacon · SOQ reminder: "${row.project_name}"`,
      deepLinkTab:  "soq",
      summaryLines: [
        row.project_number ? `Project #: ${row.project_number}` : null,
        row.start_date ? `Start date: ${fmtDate(row.start_date)}` : null,
        row.contract_expiry_date ? `Contract expires: ${fmtDate(row.contract_expiry_date)}` : null,
        row.recurring ? `Recurring: ${row.recurring}` : null,
      ].filter(Boolean) as string[],
    };
    case "closed_out": return {
      subject:      `Beacon · Follow-up: "${row.project_name}"`,
      deepLinkTab:  "closed",
      summaryLines: [
        row.project_number ? `Project #: ${row.project_number}` : null,
        row.date_closed ? `Closed: ${fmtDate(row.date_closed)}` : null,
        row.reason_for_closure ? `Reason: ${row.reason_for_closure}` : null,
      ].filter(Boolean) as string[],
    };
    case "invoice": return {
      subject:      `Beacon · Invoice reminder: "${row.project_name}"`,
      deepLinkTab:  "invoice",
      summaryLines: [
        row.project_number ? `Project #: ${row.project_number}` : null,
        row.contract_amount ? `Contract: ${fmt$(row.contract_amount)}` : null,
        row.type ? `Type: ${row.type}` : null,
        row.year ? `Year: ${row.year}` : null,
      ].filter(Boolean) as string[],
    };
    case "event": return {
      subject:      `Beacon · ${row.type || "Event"}: "${row.title}"${row.event_datetime ? ` (${fmtDate(row.event_datetime)})` : ""}`,
      deepLinkTab:  "events",
      summaryLines: [
        row.event_datetime ? `When: ${fmtDate(row.event_datetime)}` : (row.event_date ? `Date: ${fmtDate(row.event_date)}` : null),
        row.status ? `Status: ${row.status}` : null,
        row.type ? `Type: ${row.type}` : null,
      ].filter(Boolean) as string[],
    };
    default: return {
      subject:      `Beacon reminder`,
      deepLinkTab:  "invoice",
      summaryLines: [],
    };
  }
}

function anchorPhrase(alert: Alert, row: any): string | null {
  if (!alert.anchor_field || alert.anchor_offset_minutes == null) return null;
  const noun = ANCHOR_LABEL[alert.anchor_field] || alert.anchor_field;
  const m = Math.abs(alert.anchor_offset_minutes);
  const when = alert.anchor_offset_minutes < 0 ? "before" : "after";
  let span: string;
  if (m >= 1440 && m % 1440 === 0)   span = `${m / 1440} day${m / 1440 === 1 ? "" : "s"}`;
  else if (m >= 60 && m % 60 === 0)  span = `${m / 60} hour${m / 60 === 1 ? "" : "s"}`;
  else                               span = `${m} minute${m === 1 ? "" : "s"}`;
  const anchorVal = row?.[alert.anchor_field];
  const anchorStr = anchorVal ? fmtDate(anchorVal) : "";
  return `This is ${span} ${when} ${noun}${anchorStr ? ` on ${anchorStr}` : ""}.`;
}

function renderEmailHtml(opts: {
  subject: string;
  greetingName: string;
  summaryLines: string[];
  anchorLine: string | null;
  message: string | null;
  deepLink: string;
}): string {
  const { subject, greetingName, summaryLines, anchorLine, message, deepLink } = opts;
  const lines = summaryLines.map(l => `<li style="margin:2px 0">${escape(l)}</li>`).join("");
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#1f1a15;background:#faf7f2;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #ece5d8;border-radius:10px;padding:24px">
  <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8a7960;margin-bottom:4px">MSMM Beacon</div>
  <h2 style="margin:0 0 12px;font-size:18px;color:#1f1a15">${escape(subject)}</h2>
  <p style="margin:0 0 14px;color:#2a251e">Hi ${escape(greetingName)},</p>
  ${lines ? `<ul style="margin:0 0 14px;padding-left:18px;color:#3a332a">${lines}</ul>` : ""}
  ${anchorLine ? `<p style="margin:0 0 14px;color:#6d5f47;font-size:13px">${escape(anchorLine)}</p>` : ""}
  ${message ? `<div style="margin:0 0 14px;padding:10px 12px;background:#fbf3e5;border-left:3px solid #c8823b;color:#3a332a;font-size:14px;white-space:pre-wrap">${escape(message)}</div>` : ""}
  <p style="margin:16px 0 0"><a href="${deepLink}" style="display:inline-block;background:#c8823b;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;font-size:13px;font-weight:600">Open in Beacon →</a></p>
  <p style="margin:18px 0 0;color:#8a7960;font-size:11px;border-top:1px solid #ece5d8;padding-top:12px">You're receiving this because you were tagged on this row. Reply to your team to remove yourself.</p>
</div></body></html>`;
}

function renderEmailText(opts: {
  subject: string;
  greetingName: string;
  summaryLines: string[];
  anchorLine: string | null;
  message: string | null;
  deepLink: string;
}): string {
  const { subject, greetingName, summaryLines, anchorLine, message, deepLink } = opts;
  return [
    `MSMM Beacon`,
    subject,
    ``,
    `Hi ${greetingName},`,
    ``,
    ...summaryLines.map(l => `• ${l}`),
    anchorLine ? `` : null,
    anchorLine ?? null,
    message ? `` : null,
    message ?? null,
    ``,
    `Open in Beacon: ${deepLink}`,
  ].filter(v => v !== null).join("\n");
}

function escape(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]!));
}

// --------------------------------------------------------------------------
// Resend delivery. Raw fetch keeps the dep surface tiny. Idempotency-Key
// ensures a retry after a partial crash doesn't double-send — Resend dedupes
// server-side on the key.
// --------------------------------------------------------------------------
async function sendViaResend(opts: {
  fireId: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization":   `Bearer ${RESEND_API_KEY}`,
      "Content-Type":    "application/json",
      "Idempotency-Key": opts.fireId,
    },
    body: JSON.stringify({
      from:    ALERT_FROM_EMAIL,
      to:      opts.to,
      subject: opts.subject,
      html:    opts.html,
      text:    opts.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`resend ${res.status}: ${body.slice(0, 400)}`);
  }
}

// --------------------------------------------------------------------------
// Entrypoint
// --------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST")    return new Response("method not allowed", { status: 405, headers: CORS });

  // Auth: two acceptable callers —
  //   (a) GitHub Actions tick: Bearer === SUPABASE_SERVICE_ROLE_KEY (exact match).
  //   (b) Admin-triggered "Run tick now" from the browser: a valid Supabase
  //       session JWT whose beacon.users.role = 'Admin'.
  // Anything else is 403.
  const bearer = (req.headers.get("authorization") || req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ ok: false, error: "missing authorization" }, 401);

  const isServiceCall = bearer === SERVICE_ROLE_KEY;
  if (!isServiceCall) {
    // Treat as a user JWT. Verify via anon-key client + confirm Admin role.
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
    if (meErr)       return json({ ok: false, error: "profile lookup failed" }, 500);
    if (!me || me.role !== "Admin") return json({ ok: false, error: "forbidden" }, 403);
  }

  if (!ALERTS_ENABLED) {
    return json({ ok: true, disabled: true, processed: 0, sent: 0, failed: 0, skipped: 0 });
  }
  if (!RESEND_API_KEY || !ALERT_FROM_EMAIL) {
    return json({ ok: false, error: "missing RESEND_API_KEY or ALERT_FROM_EMAIL" }, 500);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    db: { schema: "beacon" },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Atomic claim — rows come back already marked 'processing' with
  //    attempts incremented. Subsequent ticks won't see them.
  const { data: claimed, error: claimErr } = await sb.rpc("claim_pending_fires", { _limit: CLAIM_BATCH });
  if (claimErr) {
    console.error("claim_pending_fires failed:", claimErr);
    return json({ ok: false, error: claimErr.message }, 500);
  }
  const fires: Fire[] = (claimed || []) as Fire[];

  let sent = 0, failed = 0, skipped = 0;

  for (const fire of fires) {
    try {
      // 2. Load the alert + its recipients + enabled user rows.
      const { data: alertData, error: alertErr } = await sb
        .from("alerts")
        .select("*")
        .eq("id", fire.alert_id)
        .maybeSingle();
      if (alertErr || !alertData) throw new Error(alertErr?.message || "alert row missing");
      const alert = alertData as Alert;

      if (!alert.is_active) {
        await sb.rpc("complete_fire", { _fire_id: fire.id, _status: "skipped", _error_message: "alert inactive" });
        skipped++; continue;
      }

      const { data: recips, error: recErr } = await sb
        .from("alert_recipients")
        .select("user_id, users(id, email, first_name, display_name, is_enabled)")
        .eq("alert_id", alert.id);
      if (recErr) throw new Error(recErr.message);

      const recipients: Recipient[] = ((recips || []) as any[])
        .map(r => r.users)
        .filter(u => u && u.is_enabled && u.email)
        .map(u => ({ email: String(u.email), name: String(u.display_name || u.first_name || u.email) }));

      if (recipients.length === 0) {
        await sb.rpc("complete_fire", { _fire_id: fire.id, _status: "skipped", _error_message: "no enabled recipients" });
        skipped++; continue;
      }

      // 3. Load the subject row. If it's been deleted (or the table name is
      //    somehow unmapped) mark skipped and deactivate the alert.
      const tableName = SUBJECT_TABLE[alert.subject_table];
      if (!tableName) {
        await sb.rpc("complete_fire", { _fire_id: fire.id, _status: "skipped", _error_message: `unknown subject_table: ${alert.subject_table}` });
        skipped++; continue;
      }
      const { data: row, error: rowErr } = await sb.from(tableName).select("*").eq("id", alert.subject_row_id).maybeSingle();
      if (rowErr) throw new Error(rowErr.message);
      if (!row) {
        await sb.rpc("complete_fire", { _fire_id: fire.id, _status: "skipped", _error_message: "subject deleted" });
        await sb.rpc("deactivate_alerts_for", { _table: alert.subject_table, _id: alert.subject_row_id });
        skipped++; continue;
      }

      // 4. Retry cap: after MAX_ATTEMPTS, stop trying forever.
      if (fire.attempts > MAX_ATTEMPTS) {
        await sb.rpc("complete_fire", { _fire_id: fire.id, _status: "skipped", _error_message: `retry cap (${MAX_ATTEMPTS}) exceeded` });
        skipped++; continue;
      }

      // 5. Render + send.
      const rendered  = render(alert.subject_table, row);
      const deepLink  = `${APP_URL}?tab=${rendered.deepLinkTab}&rowId=${encodeURIComponent(alert.subject_row_id)}`;
      const anchorLn  = anchorPhrase(alert, row);

      for (const rec of recipients) {
        const html = renderEmailHtml({
          subject:      rendered.subject,
          greetingName: rec.name,
          summaryLines: rendered.summaryLines,
          anchorLine:   anchorLn,
          message:      alert.message,
          deepLink,
        });
        const text = renderEmailText({
          subject:      rendered.subject,
          greetingName: rec.name,
          summaryLines: rendered.summaryLines,
          anchorLine:   anchorLn,
          message:      alert.message,
          deepLink,
        });
        await sendViaResend({
          fireId:  `${fire.id}:${rec.email}`,   // per-recipient idempotency
          to:      [rec.email],
          subject: rendered.subject,
          html, text,
        });
      }

      // 6. Mark sent. For simple recurrences, complete_fire spawns the next
      //    fire atomically in PG. For 'custom', we compute next with rrule
      //    here and insert the follow-up fire ourselves.
      const { error: doneErr } = await sb.rpc("complete_fire", { _fire_id: fire.id, _status: "sent", _error_message: null });
      if (doneErr) throw new Error(`complete_fire: ${doneErr.message}`);

      if (alert.recurrence === "custom" && alert.recurrence_rule) {
        try {
          const rule = RRule.fromString(alert.recurrence_rule);
          const next = rule.after(new Date(fire.scheduled_at), false);
          if (next) {
            await sb.from("alert_fires").insert({
              alert_id:     alert.id,
              scheduled_at: next.toISOString(),
              status:       "pending",
            });
          }
        } catch (e) {
          console.warn(`rrule parse/compute failed for alert ${alert.id}:`, e);
        }
      }

      sent++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`fire ${fire.id} failed:`, msg);
      await sb.rpc("complete_fire", { _fire_id: fire.id, _status: "failed", _error_message: msg.slice(0, 500) });
      failed++;
    }
  }

  return json({ ok: true, processed: fires.length, sent, failed, skipped });
});
