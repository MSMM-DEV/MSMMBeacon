// invoice-billing-reminders — end-of-month invoice billing reminders + auto-clear.
//
// Runs daily (GitHub Actions cron) or on-demand (admin "Run billing reminders now").
//
// Anchored on the workspace's "Move actual to" cutover (app_settings
// invoice_actual_cutover_day + invoice_actual_cutover_next_month). For the month
// that becomes Actual on the upcoming cutover date ("the month being closed"):
//
//   #3  For every active invoice project whose total for that month has a VALUE
//       entered but NO invoice attached to the total/prime cell — regardless of
//       the paid flag — send a reminder on each of the final 5 days before the
//       cutover, then (only if INVOICE_AUTOCLEAR_ENABLED) CLEAR that month's
//       total value ON the cutover date. ENG↔MHZ linked siblings clear together
//       and count as billed if EITHER perspective has an attachment.
//
//   #4  For every project where a SUB invoice is attached for that month but the
//       project total is missing OR the total cell has no invoice attached, send
//       a reminder on each of the final 5 days before the cutover (no clear).
//
// Recipients: three fixed managers (FIXED_INVOICE_ALERT_EMAILS, default
// rpausina / jlavenia / dsmith @msmmeng.com) + the project's PM(s) resolved from
// anticipated_invoice_pms.
//
// Env (function secrets):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (runtime-injected)
//   RESEND_API_KEY, ALERT_FROM_EMAIL, APP_URL           (reused from send-alert)
//   INVOICE_REMINDERS_ENABLED  "false" to silence emails            (default: on)
//   INVOICE_AUTOCLEAR_ENABLED  "true" to arm the destructive clear  (default: OFF)
//   FIXED_INVOICE_ALERT_EMAILS comma-separated fixed recipients     (default 3 mgrs)
//
// Caller auth (same as send-alert / license-reminders): Bearer ===
// SUPABASE_SERVICE_ROLE_KEY (cron) OR a session JWT whose users.role = 'Admin'.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY           = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY     = Deno.env.get("RESEND_API_KEY") || "";
const ALERT_FROM_EMAIL   = Deno.env.get("ALERT_FROM_EMAIL") || "";
const APP_URL            = (Deno.env.get("APP_URL") || "http://localhost:5173").replace(/\/+$/, "");
const REMINDERS_ENABLED  = (Deno.env.get("INVOICE_REMINDERS_ENABLED") || "true").toLowerCase() !== "false";
const AUTOCLEAR_ENABLED  = (Deno.env.get("INVOICE_AUTOCLEAR_ENABLED") || "false").toLowerCase() === "true";
const DEFAULT_FIXED      = "rpausina@msmmeng.com,jlavenia@msmmeng.com,dsmith@msmmeng.com";
const FIXED_EMAILS       = (Deno.env.get("FIXED_INVOICE_ALERT_EMAILS") || DEFAULT_FIXED);

const BUSINESS_TZ = "America/Chicago";
const REMIND_DAYS = 5;
const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

const pad2 = (n: number) => String(n).padStart(2, "0");
// Whole-day epoch index of a YYYY-MM-DD (UTC midnight), for date-only math.
const epochDay = (iso: string) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86400000);
// Today's date in the business timezone, as YYYY-MM-DD.
function todayInTZ(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
// Days in a calendar month (0-indexed month).
const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

// The calendar date (YYYY-MM-DD) on which month (targetY, targetM0) flips from
// Projection to Actual — mirrors data.js actualThruMonth: same-month mode flips
// on day `eff` of the month itself; next-month mode flips on day `eff` of the
// FOLLOWING month (so day 1 ⇒ June flips on July 1). `eff` is the cutover day
// clamped to the flip month's length (31 acts as "last day").
function cutoverIsoFor(targetY: number, targetM0: number, cutoverDay: number, nextMonth: boolean): string {
  let flipY = targetY, flipM = targetM0;
  if (nextMonth) { flipM += 1; if (flipM > 11) { flipM = 0; flipY += 1; } }
  const eff = Math.min(Math.max(1, Math.round(cutoverDay) || 1), daysInMonth(flipY, flipM));
  return `${flipY}-${pad2(flipM + 1)}-${pad2(eff)}`;
}

const prettyDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
const money = (n: number) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isEmail = (s: string) => typeof s === "string" && /\S+@\S+\.\S+/.test(s.trim());

async function sendViaResend(opts: { key: string; to: string[]; subject: string; html: string; text: string }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization":   `Bearer ${RESEND_API_KEY}`,
      "Content-Type":    "application/json",
      "Idempotency-Key": opts.key,   // per (kind, project, month, day) — no double-send within a day
    },
    body: JSON.stringify({ from: ALERT_FROM_EMAIL, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`resend ${res.status}: ${body.slice(0, 300)}`);
  }
}

function shell(eyebrow: string, headline: string, bodyHtml: string, facts: [string, string][], accent: string, link: string): string {
  const rows = facts.map(([k, v]) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#8a8378;font-size:13px;">${k}</td><td style="padding:4px 0;font-size:13px;color:#2a2620;font-weight:600;">${v}</td></tr>`).join("");
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto;">
    <div style="border-left:4px solid ${accent};padding:4px 0 4px 16px;margin-bottom:18px;">
      <div style="font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8378;">${eyebrow}</div>
      <h2 style="margin:4px 0 0;font-size:19px;color:#2a2620;">${headline}</h2>
    </div>
    ${bodyHtml}
    <table style="border-collapse:collapse;margin:0 0 18px;">${rows}</table>
    <a href="${link}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px;">Open Invoice →</a>
    <p style="font-size:11px;color:#a8a296;margin:22px 0 0;">Automated reminder from MSMM Beacon.</p>
  </div>`;
}

interface InvRow {
  id: string; source_project_id: string | null; project_number: string | null;
  project_name: string | null; type: string | null; year: number;
  billing_state: string | null; anticipated_invoice_pms?: { user_id: string }[];
  [monthCol: string]: unknown;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST")    return new Response("method not allowed", { status: 405, headers: CORS });

  const bearer = (req.headers.get("authorization") || req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ ok: false, error: "missing authorization" }, 401);

  if (bearer !== SERVICE_ROLE_KEY) {
    // Admin session JWT path (the in-app "Run billing reminders now" button).
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      db: { schema: "beacon_v2" },
      global: { headers: { Authorization: `Bearer ${bearer}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: u, error: uErr } = await userClient.auth.getUser();
    if (uErr || !u?.user) return json({ ok: false, error: "invalid session" }, 401);
    const { data: me } = await userClient.from("users").select("role").eq("auth_user_id", u.user.id).maybeSingle();
    if (!me || me.role !== "Admin") return json({ ok: false, error: "forbidden" }, 403);
  }

  if (!REMINDERS_ENABLED && !AUTOCLEAR_ENABLED) return json({ ok: true, disabled: true });
  if (REMINDERS_ENABLED && (!RESEND_API_KEY || !ALERT_FROM_EMAIL))
    return json({ ok: false, error: "missing RESEND_API_KEY or ALERT_FROM_EMAIL" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    db: { schema: "beacon_v2" },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- cutover config + target month --------------------------------------
  const { data: settings } = await sb.from("app_settings")
    .select("invoice_actual_cutover_day, invoice_actual_cutover_next_month").limit(1).maybeSingle();
  const cutoverDay = Math.min(Math.max(1, Math.round(Number(settings?.invoice_actual_cutover_day) || 1)), 31);
  const nextMonth  = !!settings?.invoice_actual_cutover_next_month;

  const today = todayInTZ();
  // This feature closes the month that has just ENDED — which maps cleanly only
  // in NEXT-MONTH cutover mode (e.g. day 1 ⇒ June closes on July 1). In
  // same-month mode the "month becoming Actual" on the cutover is the current /
  // upcoming month, so targeting it would nag about — and, with autoclear, wipe
  // — a not-yet-billable projection. Skip entirely rather than risk that.
  if (!nextMonth) return json({ ok: true, today, note: "same-month cutover mode — end-of-month reminders/clear only run in next-month mode", reminders: 0, cleared: 0 });
  const curY  = Number(today.slice(0, 4));
  const curM0 = Number(today.slice(5, 7)) - 1;

  // The month whose cutover is the SOONEST date within [today, today+5]. That is
  // "the month being closed": it becomes Actual on cutoverIso; reminders run on
  // the final 5 days before it, and the clear runs on the cutover day itself.
  let target: { ty: number; tm0: number; cutoverIso: string; du: number } | null = null;
  for (let delta = -1; delta <= 1; delta++) {
    let ty = curY, tm0 = curM0 + delta;
    while (tm0 < 0)  { tm0 += 12; ty -= 1; }
    while (tm0 > 11) { tm0 -= 12; ty += 1; }
    const cutoverIso = cutoverIsoFor(ty, tm0, cutoverDay, nextMonth);
    const du = epochDay(cutoverIso) - epochDay(today);
    if (du >= 0 && du <= REMIND_DAYS && (!target || du < target.du)) target = { ty, tm0, cutoverIso, du };
  }
  if (!target) return json({ ok: true, today, note: "no invoice cutover within the reminder window", reminders: 0, cleared: 0 });

  const { ty: targetYear, tm0: targetM0, cutoverIso, du } = target;
  const monthCol   = `${MONTHS[targetM0]}_amount`;
  const month1     = targetM0 + 1;
  const monthLabel = `${MONTH_NAMES[targetM0]} ${targetYear}`;
  const cutoverPretty = prettyDate(cutoverIso);
  const isClearDay = du === 0;
  const inReminderWindow = du >= 1 && du <= REMIND_DAYS;
  const link = `${APP_URL}?tab=invoice`;

  // ---- pull the active invoice rows for the target year -------------------
  const { data: invRows, error } = await sb.from("anticipated_invoice")
    .select(`id, source_project_id, project_number, project_name, type, year, ${monthCol}, billing_state, anticipated_invoice_pms(user_id)`)
    .eq("year", targetYear)
    .eq("billing_state", "active");
  if (error) return json({ ok: false, error: error.message }, 500);
  const rows = (invRows || []) as InvRow[];

  const invoiceIds      = rows.map(r => r.id);
  const sourceProjectIds = [...new Set(rows.map(r => r.source_project_id).filter(Boolean) as string[])];

  // prime attachment presence per invoice row for the target month
  const primeAttached = new Set<string>();
  if (invoiceIds.length) {
    const { data } = await sb.from("prime_invoice_files").select("invoice_id").eq("month", month1).in("invoice_id", invoiceIds);
    for (const f of (data || []) as { invoice_id: string }[]) primeAttached.add(f.invoice_id);
  }

  // sub-invoice attachment presence per project for the target month
  const subAttachedProjects = new Set<string>();
  if (sourceProjectIds.length) {
    const { data: subs } = await sb.from("sub_invoices").select("id, project_id")
      .eq("year", targetYear).eq("month", month1).in("project_id", sourceProjectIds);
    const subToProject = new Map<string, string>();
    const subIds: string[] = [];
    for (const s of (subs || []) as { id: string; project_id: string }[]) { subToProject.set(s.id, s.project_id); subIds.push(s.id); }
    if (subIds.length) {
      const { data: files } = await sb.from("sub_invoice_files").select("sub_invoice_id").in("sub_invoice_id", subIds);
      for (const f of (files || []) as { sub_invoice_id: string }[]) {
        const pid = subToProject.get(f.sub_invoice_id);
        if (pid) subAttachedProjects.add(pid);
      }
    }
  }

  // PM emails
  const pmIds = new Set<string>();
  for (const r of rows) for (const p of (r.anticipated_invoice_pms || [])) if (p.user_id) pmIds.add(p.user_id);
  const pmEmail = new Map<string, string>();
  if (pmIds.size) {
    const { data: us } = await sb.from("users").select("id, email").in("id", [...pmIds]);
    for (const u of (us || []) as { id: string; email: string }[]) if (isEmail(u.email)) pmEmail.set(u.id, u.email.trim());
  }
  const fixed = FIXED_EMAILS.split(",").map(e => e.trim()).filter(isEmail);

  // ---- group by billing track ---------------------------------------------
  // ENG↔MHZ are LINKED perspectives (synced values) → one group per project.
  // PM (and anything else) is a separate billing track → its own group.
  interface Group { rows: InvRow[]; sourceId: string | null; number: string; name: string; isHz: boolean }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const type = r.type || "ENG";
    const isHz = type === "ENG" || type === "MHZ";
    const num  = (r.project_number || "").trim().toLowerCase();
    const base = r.source_project_id || `row:${r.id}`;
    // Mirror linkedInvoiceIdsFor (invoice-perspectives.js): ENG↔MHZ siblings
    // link by project_number OR source_project_id. Prefer the number so a
    // manually-created null-source pair sharing a number still co-groups (clear
    // together / billed if either) instead of splitting + double-emailing.
    const key  = isHz ? `hz:${num ? `num:${num}` : base}` : `${type}:${base}`;
    let g = groups.get(key);
    if (!g) { g = { rows: [], sourceId: r.source_project_id || null, number: r.project_number || "", name: r.project_name || "", isHz }; groups.set(key, g); }
    g.rows.push(r);
    if (!g.number && r.project_number) g.number = r.project_number;
    if (!g.name && r.project_name)     g.name = r.project_name;
  }

  let reminders3 = 0, reminders4 = 0, cleared = 0, projects = 0;
  const errors: string[] = [];

  for (const [key, g] of groups) {
    projects++;
    const projLabel = g.number ? `${g.number} — ${g.name}` : (g.name || g.number || "project");
    const amt = g.rows.reduce((a, r) => Math.max(a, Number(r[monthCol]) || 0), 0);
    const anyPrimeAttached = g.rows.some(r => primeAttached.has(r.id));
    const subAtt = g.sourceId ? subAttachedProjects.has(g.sourceId) : false;

    const pmSet = new Set<string>();
    for (const r of g.rows) for (const p of (r.anticipated_invoice_pms || [])) { const e = pmEmail.get(p.user_id); if (e) pmSet.add(e); }
    const to = [...new Set([...fixed, ...pmSet])];

    const hasValueUnbilled   = amt > 0 && !anyPrimeAttached;   // #3 — value entered, not billed
    // #4 — a sub is billed but the project has NO total value entered. The
    // "value present but total not attached" case is already covered by #3, so
    // scope #4 to the no-total case to avoid double-emailing the same project.
    // (Subs belong to the ENG/prime track, hence g.isHz.)
    const subButTotalPending = g.isHz && subAtt && amt <= 0;

    try {
      // #3 reminder — value entered but not billed
      if (REMINDERS_ENABLED && inReminderWindow && hasValueUnbilled && to.length) {
        const body = `<p style="font-size:14px;color:#4a463e;margin:0 0 14px;">For project <strong>${projLabel}</strong>, for the month of <strong>${monthLabel}</strong>, a total of <strong>${money(amt)}</strong> was entered, but it has not been billed yet — no invoice is attached in Beacon. Please bill it and attach the invoice to Beacon.${AUTOCLEAR_ENABLED ? ` If it is still unbilled on <strong>${cutoverPretty}</strong>, this month's total value will be cleared automatically.` : ""}</p>`;
        const facts: [string, string][] = [["Project", projLabel], ["Month", monthLabel], ["Entered total", money(amt)], ["Status", "No invoice attached"]];
        const text = `For project ${projLabel}, for the month of ${monthLabel}, you entered a value of ${money(amt)}, but you have not billed it yet. Please make sure to bill it and attach the invoice to Beacon.` +
          (AUTOCLEAR_ENABLED ? `\n\nIf it is still unbilled on ${cutoverPretty}, this month's value will be cleared automatically.` : "") + `\n\nOpen Invoice: ${link}`;
        await sendViaResend({
          key: `ir3:${key}:${targetYear}-${month1}:${today}`,
          to, subject: `Beacon · Unbilled invoice — ${projLabel} (${monthLabel})`,
          html: shell("Invoice · unbilled", `Unbilled: ${projLabel}`, body, facts, "#B9851A", link), text,
        });
        reminders3++;
      }

      // #4 reminder — sub billed but the project total is missing / not attached
      if (REMINDERS_ENABLED && inReminderWindow && subButTotalPending && to.length) {
        const reason = "no total value has been entered for that month";
        const body = `<p style="font-size:14px;color:#4a463e;margin:0 0 14px;">For project <strong>${projLabel}</strong>, a sub invoice has been attached for <strong>${monthLabel}</strong>, but ${reason}. Please add the project total and attach the prime invoice in Beacon.</p>`;
        const facts: [string, string][] = [["Project", projLabel], ["Month", monthLabel], ["Sub invoice", "Attached"], ["Project total", "Missing"]];
        const text = `For project ${projLabel}, a sub invoice is attached for ${monthLabel}, but ${reason}. Please add the project total and attach the prime invoice in Beacon.\n\nOpen Invoice: ${link}`;
        await sendViaResend({
          key: `ir4:${key}:${targetYear}-${month1}:${today}`,
          to, subject: `Beacon · Sub billed, total pending — ${projLabel} (${monthLabel})`,
          html: shell("Invoice · total pending", `Sub billed, total pending: ${projLabel}`, body, facts, "#B9851A", link), text,
        });
        reminders4++;
      }

      // #3 auto-clear — on the cutover day, wipe the unbilled month value.
      // Never delete silently: require an active email path + at least one
      // recipient so a destructive clear always leaves a notice + audit trail.
      if (isClearDay && AUTOCLEAR_ENABLED && hasValueUnbilled) {
        if (!REMINDERS_ENABLED || !to.length) {
          errors.push(`${projLabel}: clear skipped — no recipient to notify`);
        } else {
          const { error: upErr } = await sb.from("anticipated_invoice")
            .update({ [monthCol]: null }).in("id", g.rows.map(r => r.id));
          if (upErr) throw new Error(`clear: ${upErr.message}`);
          cleared++;
          const body = `<p style="font-size:14px;color:#4a463e;margin:0 0 14px;">For project <strong>${projLabel}</strong>, the <strong>${monthLabel}</strong> total of <strong>${money(amt)}</strong> was cleared because no invoice was attached by the ${cutoverPretty} cutover. If this was in error, re-enter the value and attach the invoice in Beacon.</p>`;
          const facts: [string, string][] = [["Project", projLabel], ["Month", monthLabel], ["Cleared value", money(amt)], ["Reason", "No invoice attached by cutover"]];
          const text = `For project ${projLabel}, the ${monthLabel} total value of ${money(amt)} was cleared because no invoice was attached by the ${cutoverPretty} cutover. If this was in error, re-enter it and attach the invoice.\n\nOpen Invoice: ${link}`;
          await sendViaResend({
            key: `ir3clr:${key}:${targetYear}-${month1}:${today}`,
            to, subject: `Beacon · Invoice value cleared — ${projLabel} (${monthLabel})`,
            html: shell("Invoice · value cleared", `Cleared: ${projLabel}`, body, facts, "#B86B66", link), text,
          });
        }
      }
    } catch (e) {
      errors.push(`${projLabel}: ${(e as Error).message}`);
    }
  }

  return json({
    ok: true, today, targetMonth: monthLabel, cutover: cutoverIso, daysUntil: du,
    autoclearArmed: AUTOCLEAR_ENABLED, remindersEnabled: REMINDERS_ENABLED,
    projects, reminders3, reminders4, cleared, errors,
  });
});
