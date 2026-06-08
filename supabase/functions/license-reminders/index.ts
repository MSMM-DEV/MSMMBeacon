// license-reminders — milestone expiry reminders for beacon_v2.licenses.
//
// Runs daily (GitHub Actions cron) or on-demand (admin "Send reminders now").
// For each enabled license with an expiration date, it figures out the tightest
// reminder milestone the license currently falls in — 60 / 30 / 14 / 7 / 1 days
// out, or 0 (expiry day / overdue) — and, if that band is tighter than the last
// one we emailed (`last_notified_band`), sends one email to the license's
// notification addresses and records the band. So each license emails AT MOST
// once per band as it counts down, never spamming. A renewal (expiration_date
// change) resets `last_notified_band` via a DB trigger, restarting the cycle.
//
// Env (function secrets):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY            (reused from send-alert)
//   ALERT_FROM_EMAIL          e.g. "Beacon <alerts@msmmeng.com>"
//   APP_URL                   deployed frontend URL (for the deep link)
//   LICENSE_REMINDERS_ENABLED set to "false" to kill-switch (default: on)
//
// Caller auth (same as send-alert): Bearer === SUPABASE_SERVICE_ROLE_KEY (the
// cron) OR a Supabase session JWT whose beacon_v2.users.role = 'Admin'.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY           = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY     = Deno.env.get("RESEND_API_KEY") || "";
const ALERT_FROM_EMAIL   = Deno.env.get("ALERT_FROM_EMAIL") || "";
const APP_URL            = (Deno.env.get("APP_URL") || "http://localhost:5173").replace(/\/+$/, "");
const ENABLED            = (Deno.env.get("LICENSE_REMINDERS_ENABLED") || "true").toLowerCase() !== "false";

// Descending so we resolve the *tightest* applicable band first.
const MILESTONES = [60, 30, 14, 7, 1, 0];
const BUSINESS_TZ = "America/Chicago";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

// Whole-day epoch index of a YYYY-MM-DD (UTC midnight), for date-only math.
const epochDay = (iso: string) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86400000);

// Today's date in the business timezone, as YYYY-MM-DD.
function todayInTZ(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// Tightest milestone the license currently falls in, or null if > 60 days out.
function currentBand(days: number): number | null {
  let band: number | null = null;
  for (const m of MILESTONES) if (days <= m) band = m;   // smallest m with days<=m wins (loop is descending)
  return band;
}

const isEmail = (s: string) => typeof s === "string" && /\S+@\S+\.\S+/.test(s.trim());

async function sendViaResend(opts: { key: string; to: string[]; subject: string; html: string; text: string }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization":   `Bearer ${RESEND_API_KEY}`,
      "Content-Type":    "application/json",
      "Idempotency-Key": opts.key,    // license.id:band — same band never double-sends
    },
    body: JSON.stringify({ from: ALERT_FROM_EMAIL, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`resend ${res.status}: ${body.slice(0, 300)}`);
  }
}

interface License {
  id: string; entity: string; state: string | null; lic_type: string | null;
  license_no: string | null; expiration_date: string | null;
  notify_emails: string[] | null; last_notified_band: number | null;
}

function renderEmail(lic: License, days: number) {
  const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });
  const when = days < 0 ? `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`
    : days === 0 ? "expires today"
    : `expires in ${days} day${days === 1 ? "" : "s"}`;
  const headline = days < 0 ? `License expired: ${lic.entity}`
    : days === 0 ? `License expires today: ${lic.entity}`
    : `License ${when}: ${lic.entity}`;
  const link = `${APP_URL}?tab=licenses`;
  const facts = [
    ["Entity", lic.entity],
    ["Type", lic.lic_type || "—"],
    ["State", lic.state || "—"],
    ["License no", lic.license_no || "—"],
    ["Expiration", lic.expiration_date ? fmt(lic.expiration_date) : "—"],
  ];
  const rows = facts.map(([k, v]) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#8a8378;font-size:13px;">${k}</td><td style="padding:4px 0;font-size:13px;color:#2a2620;font-weight:600;">${v}</td></tr>`).join("");
  const accent = days <= 30 ? "#B86B66" : days <= 60 ? "#B9851A" : "#7E8F6F";
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;">
    <div style="border-left:4px solid ${accent};padding:4px 0 4px 16px;margin-bottom:18px;">
      <div style="font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#8a8378;">Licenses &amp; Certifications</div>
      <h2 style="margin:4px 0 0;font-size:19px;color:#2a2620;">${headline}</h2>
    </div>
    <p style="font-size:14px;color:#4a463e;margin:0 0 14px;">This license <strong>${when}</strong>. Review or renew it in Beacon.</p>
    <table style="border-collapse:collapse;margin:0 0 18px;">${rows}</table>
    <a href="${link}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px;">Open Licenses →</a>
    <p style="font-size:11px;color:#a8a296;margin:22px 0 0;">Automated reminder from MSMM Beacon. You're receiving this because this address is on the license's notification list.</p>
  </div>`;
  const text = `${headline}\n\nThis license ${when}.\n\n` +
    facts.map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\n\nOpen Licenses: ${link}`;
  return { subject: headline, html, text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST")    return new Response("method not allowed", { status: 405, headers: CORS });

  const bearer = (req.headers.get("authorization") || req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ ok: false, error: "missing authorization" }, 401);

  if (bearer !== SERVICE_ROLE_KEY) {
    // Admin session JWT path (the in-app "Send reminders now" button).
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

  if (!ENABLED) return json({ ok: true, disabled: true, checked: 0, sent: 0 });
  if (!RESEND_API_KEY || !ALERT_FROM_EMAIL) return json({ ok: false, error: "missing RESEND_API_KEY or ALERT_FROM_EMAIL" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    db: { schema: "beacon_v2" },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const today = todayInTZ();
  const { data: licenses, error } = await sb
    .from("licenses")
    .select("id, entity, state, lic_type, license_no, expiration_date, notify_emails, last_notified_band")
    .eq("email_enabled", true)
    .not("expiration_date", "is", null);
  if (error) return json({ ok: false, error: error.message }, 500);

  let checked = 0, sent = 0;
  const errors: string[] = [];

  for (const lic of (licenses || []) as License[]) {
    checked++;
    const days = epochDay(lic.expiration_date as string) - epochDay(today);
    const band = currentBand(days);
    if (band === null) continue;                                   // > 60 days out — nothing due
    if (lic.last_notified_band !== null && band >= lic.last_notified_band) continue;  // band already emailed

    const recipients = (lic.notify_emails || []).map((e) => e.trim()).filter(isEmail);
    if (recipients.length === 0) continue;                         // nothing to send; don't advance the band

    try {
      const { subject, html, text } = renderEmail(lic, days);
      await sendViaResend({ key: `${lic.id}:${band}`, to: recipients, subject, html, text });
      const { error: upErr } = await sb.from("licenses")
        .update({ last_notified_band: band, last_notified_at: new Date().toISOString() })
        .eq("id", lic.id);
      if (upErr) throw new Error(`stamp: ${upErr.message}`);
      sent++;
    } catch (e) {
      errors.push(`${lic.entity}: ${(e as Error).message}`);
    }
  }

  return json({ ok: true, today, checked, sent, errors });
});
