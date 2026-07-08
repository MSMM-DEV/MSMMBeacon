// Supabase Edge Function · timeclock-eod-sweep
//
// Auto-punches-out users who are still clocked in past the workday's EOD
// boundary (app_settings.tk_eod_window_end, default 7:00 PM America/Chicago)
// and marks them "done for the day". Thin wrapper over the
// beacon_v2.auto_punch_out_eod() RPC, which does all the work:
//   • self-gates on tk_enabled + tk_auto_punchout_enabled + CT wall-clock
//     >= tk_eod_window_end (so it is a no-op before the boundary),
//   • closes the open IN interval + opens an 'eod' OUT interval per user,
//   • is idempotent (once out, a user no longer matches the sweep).
//
// Because the RPC self-gates and is idempotent, this endpoint can be cron'd
// frequently across the evening window without side effects.
//
// Auth (same dual pattern as timeclock-classify):
//   • Service-role bearer  — the GitHub Actions cron
//   • Admin session JWT    — a manual "run now" trigger
//
// Deploy:
//   supabase functions deploy timeclock-eod-sweep --project-ref ggqlcsppojypgaiyhods

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response("method not allowed", { status: 405, headers: CORS });

  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return json({ ok: false, error: "missing authorization" }, 401);

  // Service-role bearer bypasses; otherwise require an Admin session JWT.
  if (bearer !== SERVICE_ROLE_KEY) {
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

  try {
    const { data, error } = await svc().rpc("auto_punch_out_eod");
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, punched_out: (data as number) ?? 0 });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
