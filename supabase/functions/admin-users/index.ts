// Supabase Edge Function · admin-users
//
// Privileged user management for MSMM Beacon. Callers must hold a valid
// Supabase JWT whose beacon.users.role = 'Admin'. All mutating actions go
// through the service role on the server side so the admin panel in the
// browser never needs to ship privileged keys.
//
// Deploy:
//   supabase functions deploy admin-users
//
// Env (set automatically by Supabase runtime):
//   SUPABASE_URL
//   SUPABASE_ANON_KEY            (to validate the caller's JWT)
//   SUPABASE_SERVICE_ROLE_KEY    (for privileged admin.* calls)
//
// Wire:
//   POST /functions/v1/admin-users
//   body: { action, payload }
//   headers: Authorization: Bearer <caller-jwt>

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY           = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Supabase injects these for every function invocation. No defaults.
if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error("admin-users: missing env", {
    hasUrl: !!SUPABASE_URL, hasAnon: !!ANON_KEY, hasService: !!SERVICE_ROLE_KEY,
  });
}

// CORS headers are attached to EVERY response (including errors) so the
// browser can read them. Preflight is handled with an explicit 204 below.
// Access-Control-Max-Age trims the preflight chatter to once per day.
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Max-Age":       "86400",
  "Vary":                         "Origin",
};

type ActionName =
  | "create_user"
  | "change_password"
  | "delete_user"
  | "set_ban"
  | "set_role";

interface Body {
  action: ActionName;
  payload: Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

// --------------------------------------------------------------------------
// JWT + role check. Returns the caller's beacon.users row on success.
//
// Lookup strategy:
//   1. JWT → validate → extract { id (auth_user_id), email }.
//   2. Match beacon.users by auth_user_id (the trigger-linked case).
//   3. If not found, fall back to a case-insensitive email match — some
//      legacy rows haven't been linked yet, either because seed_auth_users.py
//      ran AFTER beacon.users was populated without the link backfill, or
//      because an admin was created out-of-band in Studio.
//   4. If we resolve via email, repair beacon.users.auth_user_id with the
//      service role so subsequent calls take the fast path.
// --------------------------------------------------------------------------
async function authorizeCaller(req: Request) {
  const auth = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!auth) throw errResp("missing authorization header", 401);

  // JWT validation runs against the anon client (caller's JWT in header).
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    db: { schema: "beacon" },
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userRes, error: userErr } = await anon.auth.getUser();
  if (userErr || !userRes?.user) throw errResp("invalid session", 401);
  const authUser = userRes.user;

  // Reads go through service-role (bypass RLS) so we can cleanly fall back
  // to an email match even when the RLS policy we'd hit here is permissive.
  const admin = svc();

  let { data: me, error: meErr } = await admin
    .from("users")
    .select("id, email, role, auth_user_id, first_name")
    .eq("auth_user_id", authUser.id)
    .maybeSingle();
  if (meErr) throw errResp(`profile lookup failed: ${meErr.message}`, 500);

  if (!me && authUser.email) {
    const { data: byEmail, error: emErr } = await admin
      .from("users")
      .select("id, email, role, auth_user_id, first_name")
      .ilike("email", authUser.email)
      .maybeSingle();
    if (emErr) throw errResp(`profile lookup (email) failed: ${emErr.message}`, 500);
    if (byEmail) {
      me = byEmail;
      // Heal the missing link so next time the fast path works.
      if (!byEmail.auth_user_id) {
        await admin.from("users")
          .update({ auth_user_id: authUser.id })
          .eq("id", byEmail.id);
      }
    }
  }

  if (!me) {
    throw errResp(
      `no beacon.users row found for auth user ${authUser.email || authUser.id}`,
      403,
    );
  }
  if (me.role !== "Admin") {
    throw errResp(`forbidden · ${authUser.email} has role=${me.role}`, 403);
  }
  return me;
}

// Small helper so all thrown responses carry CORS headers + a JSON body.
function errResp(msg: string, status: number) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

// --------------------------------------------------------------------------
// Action handlers. All receive a service-role client + validated payload.
// Return the shape { ok: true, data?, message? } or throw a Response.
// --------------------------------------------------------------------------
type ServiceClient = ReturnType<typeof createClient>;

function svc(): ServiceClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    db: { schema: "beacon" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function bad(msg: string, code = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: code,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

async function fetchBeaconUser(admin: ServiceClient, id: string) {
  const { data, error } = await admin
    .from("users")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw bad(error.message, 500);
  if (!data) throw bad("beacon.users row not found", 404);
  return data;
}

async function countAdmins(admin: ServiceClient): Promise<number> {
  const { count, error } = await admin
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("role", "Admin");
  if (error) throw bad(error.message, 500);
  return count ?? 0;
}

// ----- create_user --------------------------------------------------------
// Body: { email, first_name, last_name?, role, password? }
// Password defaults to `${first_name}123$` (matches seed_auth_users.py).
async function createUser(admin: ServiceClient, payload: any) {
  const email     = String(payload.email || "").trim().toLowerCase();
  const firstName = String(payload.first_name || "").trim();
  const lastName  = payload.last_name ? String(payload.last_name).trim() : null;
  const role      = payload.role === "Admin" ? "Admin" : "User";
  const password  = String(payload.password || `${firstName}123$`);

  if (!email || !firstName) return bad("email and first_name are required");
  if (password.length < 6) return bad("password must be at least 6 chars");

  // Seed beacon.users first so the auth.users trigger's UPDATE branch picks
  // it up on link. Role + first_name + display_name all live on this row.
  const display = [firstName, lastName].filter(Boolean).join(" ");
  const { data: existing } = await admin
    .from("users")
    .select("id")
    .ilike("email", email)
    .maybeSingle();
  if (existing) return bad("a user with that email already exists");

  const { data: bRow, error: bErr } = await admin
    .from("users")
    .insert({
      email,
      first_name: firstName,
      last_name: lastName,
      display_name: display,
      short_name: firstName,
      role,
      is_enabled: true,
    })
    .select()
    .single();
  if (bErr) return bad(`insert beacon.users failed: ${bErr.message}`, 500);

  const { data: aRes, error: aErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role, provider: "email", providers: ["email"] },
  });
  if (aErr) {
    // Roll back the beacon.users row so we don't strand half-created users.
    await admin.from("users").delete().eq("id", bRow.id);
    return bad(`create auth.users failed: ${aErr.message}`, 500);
  }

  // The handle_new_auth_user trigger should have linked auth_user_id by now,
  // but belt-and-braces: update explicitly in case the trigger is disabled.
  await admin
    .from("users")
    .update({ auth_user_id: aRes.user!.id })
    .eq("id", bRow.id);

  const fresh = await fetchBeaconUser(admin, bRow.id);
  return json({ ok: true, data: fresh, message: "user created" });
}

// ----- change_password ----------------------------------------------------
// Body: { beacon_user_id, new_password }
async function changePassword(admin: ServiceClient, payload: any) {
  const id  = String(payload.beacon_user_id || "");
  const pw  = String(payload.new_password || "");
  if (!id) return bad("beacon_user_id required");
  if (pw.length < 6) return bad("new_password must be at least 6 chars");

  const row = await fetchBeaconUser(admin, id);
  if (!row.auth_user_id) return bad("user is not linked to an auth account");

  const { error } = await admin.auth.admin.updateUserById(row.auth_user_id, {
    password: pw,
  });
  if (error) return bad(`update password failed: ${error.message}`, 500);
  return json({ ok: true, message: "password updated" });
}

// ----- delete_user --------------------------------------------------------
// Body: { beacon_user_id, confirm_email }
// Extra guards: can't delete self; can't delete the last Admin.
async function deleteUser(admin: ServiceClient, payload: any, callerBeaconId: string) {
  const id = String(payload.beacon_user_id || "");
  const confirm = String(payload.confirm_email || "").toLowerCase().trim();
  if (!id) return bad("beacon_user_id required");
  if (id === callerBeaconId) return bad("you can't delete yourself");

  const row = await fetchBeaconUser(admin, id);
  if (confirm !== String(row.email).toLowerCase()) {
    return bad("email confirmation does not match");
  }
  if (row.role === "Admin") {
    const n = await countAdmins(admin);
    if (n <= 1) return bad("refusing to delete the last Admin");
  }

  // Cascade: *_pms join rows are ON DELETE CASCADE from beacon.users.
  // Delete beacon.users first, then auth.users (the FK from beacon.users →
  // auth.users is ON DELETE SET NULL, so it's safe in either order).
  const { error: bErr } = await admin.from("users").delete().eq("id", id);
  if (bErr) return bad(`delete beacon.users failed: ${bErr.message}`, 500);

  if (row.auth_user_id) {
    const { error: aErr } = await admin.auth.admin.deleteUser(row.auth_user_id);
    if (aErr) {
      // beacon.users is already gone; we could recreate it but the safer
      // signal is to surface a partial-failure so the admin can investigate.
      return bad(`beacon.users deleted but auth.users still present: ${aErr.message}`, 500);
    }
  }
  return json({ ok: true, message: "user deleted" });
}

// ----- set_ban ------------------------------------------------------------
// Body: { beacon_user_id, banned: boolean }
// Mirrors state in beacon.users.is_enabled + auth.users.banned_until.
async function setBan(admin: ServiceClient, payload: any, callerBeaconId: string) {
  const id     = String(payload.beacon_user_id || "");
  const banned = !!payload.banned;
  if (!id) return bad("beacon_user_id required");
  if (banned && id === callerBeaconId) return bad("you can't ban yourself");

  const row = await fetchBeaconUser(admin, id);
  if (row.auth_user_id) {
    const { error } = await admin.auth.admin.updateUserById(row.auth_user_id, {
      ban_duration: banned ? "87600h" : "none",
    });
    if (error) return bad(`auth ban failed: ${error.message}`, 500);
  }
  const { error: upErr } = await admin
    .from("users")
    .update({ is_enabled: !banned })
    .eq("id", id);
  if (upErr) return bad(`beacon is_enabled failed: ${upErr.message}`, 500);

  const fresh = await fetchBeaconUser(admin, id);
  return json({ ok: true, data: fresh, message: banned ? "user banned" : "user unbanned" });
}

// ----- set_role -----------------------------------------------------------
// Body: { beacon_user_id, role: 'Admin' | 'User' }
async function setRole(admin: ServiceClient, payload: any, callerBeaconId: string) {
  const id   = String(payload.beacon_user_id || "");
  const role = payload.role === "Admin" ? "Admin" : "User";
  if (!id) return bad("beacon_user_id required");

  const row = await fetchBeaconUser(admin, id);
  // Can't demote the last Admin — including yourself.
  if (row.role === "Admin" && role === "User") {
    const n = await countAdmins(admin);
    if (n <= 1) return bad("refusing to demote the last Admin");
  }

  const { error: upErr } = await admin
    .from("users")
    .update({ role })
    .eq("id", id);
  if (upErr) return bad(`update role failed: ${upErr.message}`, 500);

  // Mirror into auth.users.app_metadata so JWTs reflect the new role after
  // the next token refresh. Ignored silently if no auth link exists.
  if (row.auth_user_id) {
    const { error: aErr } = await admin.auth.admin.updateUserById(row.auth_user_id, {
      app_metadata: { role },
    });
    if (aErr) {
      // Non-fatal — beacon.users is the source of truth for the app.
      console.warn("app_metadata sync failed:", aErr.message);
    }
  }
  const fresh = await fetchBeaconUser(admin, id);
  return json({ ok: true, data: fresh, message: `role set to ${role}` });
}

// --------------------------------------------------------------------------
// Entrypoint
// --------------------------------------------------------------------------
Deno.serve(async (req) => {
  // Preflight must return 2xx with CORS headers BEFORE we touch auth — browser
  // spec says preflights never carry the Authorization header. With
  // verify_jwt=false in supabase/config.toml the gateway passes OPTIONS
  // through to us; we answer 204 and short-circuit.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response("method not allowed", { status: 405, headers: CORS });

  let me;
  try {
    me = await authorizeCaller(req);
  } catch (resp) {
    if (resp instanceof Response) return resp;
    return new Response("authorization failed", { status: 500, headers: CORS });
  }

  let body: Body;
  try { body = await req.json(); }
  catch { return bad("invalid JSON body"); }

  const admin = svc();

  try {
    switch (body.action) {
      case "create_user":      return await createUser(admin, body.payload);
      case "change_password":  return await changePassword(admin, body.payload);
      case "delete_user":      return await deleteUser(admin, body.payload, me.id);
      case "set_ban":          return await setBan(admin, body.payload, me.id);
      case "set_role":         return await setRole(admin, body.payload, me.id);
      default:                 return bad(`unknown action: ${body.action}`);
    }
  } catch (e) {
    if (e instanceof Response) return e;
    console.error(e);
    return bad(String(e?.message || e), 500);
  }
});
