// Supabase Edge Function · timeclock-admin
//
// Privileged admin operations on the timekeeping pipeline. All callers must
// hold a session JWT whose beacon_v2.users.role = 'Admin' — the function
// re-validates the role server-side on every call. Writes flow through the
// service-role key so RLS doesn't fight us, and the lock-guard trigger gets
// an explicit opt-in via the session GUC `beacon_v2.timekeeping_bypass_lock`.
//
// Actions:
//   enroll-tag           bind an NFC UID to a user (retires any prior active tag)
//   start-enroll         open a capture session (Plan §9 NFC enrollment flow)
//   cancel-enroll        close the caller's capture session
//   approve-week         lock a (user, week) timesheet
//   reject-week          push a week back to the user with a reason
//   unlock-week          rare admin override on an approved week
//   resolve-correction   approve/reject a timesheet_corrections row
//   reclassify-interval  override category / outlook_event_id on one interval
//   set-travel-buffer    edit a user_calendar_events row's travel_buffer_min
//   register-device      add a Pi/kiosk to time_devices
//
// All mutations call beacon_v2.fn_rebuild_user_day() where appropriate so the
// derived interval set + day rollup stay in sync after admin edits.
//
// Deploy:
//   supabase functions deploy timeclock-admin --project-ref ggqlcsppojypgaiyhods

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
function bad(msg: string, code = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: code, headers: { ...CORS, "content-type": "application/json" },
  });
}

function svc() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    db:   { schema: "beacon_v2" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function categoryPresencePatch(category: string): Record<string, unknown> {
  if (category === "work") return { category, is_out: false };
  if (["travel", "lunch", "break", "eod", "vacation", "holiday", "off", "meeting_untagged"].includes(category)) {
    return { category, is_out: true };
  }
  return { category };
}

async function authorize(req: Request): Promise<{ admin_user_id: string }> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) throw bad("missing authorization header", 401);

  const c = createClient(SUPABASE_URL, ANON_KEY, {
    db:     { schema: "beacon_v2" },
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth:   { persistSession: false, autoRefreshToken: false },
  });
  const { data: u, error: uErr } = await c.auth.getUser();
  if (uErr || !u?.user) throw bad("invalid session", 401);

  const sb = svc();
  const { data: me } = await sb.from("users").select("id, role").eq("auth_user_id", u.user.id).maybeSingle();
  if (!me)                       throw bad("no beacon_v2.users row", 403);
  if (me.role !== "Admin")       throw bad("forbidden", 403);
  return { admin_user_id: me.id };
}

// Set the lock-bypass GUC for the next statement. PostgREST's .rpc is the
// cleanest way to ask Postgres to apply a session GUC; we expose a tiny
// helper to set it transactionally. The Edge Function calls this before any
// punch write that needs to bypass week-lock guards.
async function bypassLock(sb: ReturnType<typeof svc>): Promise<void> {
  // No transactional GUC across PostgREST calls; we instead include the
  // bypass directly in the SQL we run via .rpc('exec_sql'). Since we don't
  // have such an RPC, the practical option is: SECURITY DEFINER wrapper
  // functions in the DB that set the GUC + run the mutation in one call.
  // For v1, we expose only the actions that DON'T need to write into locked
  // weeks (approve, reject, reclassify, etc.). Punch edits inside a locked
  // week are deferred to v1.1.
  void sb; // no-op for now; documented intent.
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function enrollTag(payload: any, admin: { admin_user_id: string }) {
  const userId = String(payload.user_id || "");
  const uid    = String(payload.uid || "").trim();
  const label  = payload.label ? String(payload.label) : null;
  if (!userId || !uid) return bad("user_id and uid are required");

  const sb = svc();

  // Retire any active tag currently bound to this user.
  await sb
    .from("nfc_tags")
    .update({ active: false, retired_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("active", true);

  // Retire (or update-and-reactivate) the same UID if it's bound to a different user.
  await sb
    .from("nfc_tags")
    .update({ active: false, retired_at: new Date().toISOString() })
    .eq("uid", uid)
    .eq("active", true)
    .neq("user_id", userId);

  // Upsert the new binding. If the UID row already exists for this user
  // (re-enrolling the same fob), flip it back to active.
  const { data: existing } = await sb
    .from("nfc_tags")
    .select("uid")
    .eq("uid", uid)
    .maybeSingle();

  if (existing) {
    const { error } = await sb
      .from("nfc_tags")
      .update({
        user_id:    userId,
        label,
        active:     true,
        retired_at: null,
        enrolled_at: new Date().toISOString(),
        enrolled_by: admin.admin_user_id,
      })
      .eq("uid", uid);
    if (error) return bad(`nfc_tags update: ${error.message}`, 500);
  } else {
    const { error } = await sb
      .from("nfc_tags")
      .insert({
        uid, user_id: userId, label, active: true,
        enrolled_at: new Date().toISOString(),
        enrolled_by: admin.admin_user_id,
      });
    if (error) return bad(`nfc_tags insert: ${error.message}`, 500);
  }

  // Close the capture session for this admin (if any).
  await sb.from("nfc_enroll_sessions").delete().eq("admin_user_id", admin.admin_user_id);

  return json({ ok: true, message: "tag enrolled" });
}

async function startEnroll(payload: any, admin: { admin_user_id: string }) {
  const targetUserId = String(payload.user_id || "");
  if (!targetUserId) return bad("user_id is required");
  const sb = svc();
  const { error } = await sb
    .from("nfc_enroll_sessions")
    .upsert({
      admin_user_id:  admin.admin_user_id,
      target_user_id: targetUserId,
      captured_uid:   null,
      captured_at:    null,
      started_at:     new Date().toISOString(),
      expires_at:     new Date(Date.now() + 90_000).toISOString(),
    }, { onConflict: "admin_user_id" });
  if (error) return bad(`enroll session start: ${error.message}`, 500);
  return json({ ok: true, message: "capture session open for 90 s" });
}

async function cancelEnroll(_payload: any, admin: { admin_user_id: string }) {
  const sb = svc();
  await sb.from("nfc_enroll_sessions").delete().eq("admin_user_id", admin.admin_user_id);
  return json({ ok: true, message: "capture session closed" });
}

async function approveWeek(payload: any, admin: { admin_user_id: string }) {
  const userId    = String(payload.user_id || "");
  const weekStart = String(payload.week_start || "");
  if (!userId || !weekStart) return bad("user_id and week_start (YYYY-MM-DD) required");
  const sb = svc();

  // Snapshot totals at approval time.
  const weekEndDate = new Date(`${weekStart}T00:00:00`);
  weekEndDate.setDate(weekEndDate.getDate() + 7);
  const weekEnd = weekEndDate.toISOString().slice(0, 10);

  const { data: days } = await sb
    .from("timesheet_days")
    .select("date, minutes_work, minutes_lunch, minutes_meeting, minutes_travel, minutes_untagged, flags")
    .eq("user_id", userId)
    .gte("date", weekStart)
    .lt("date",  weekEnd);
  const totals = (days || []).reduce<Record<string, number>>((acc, d: any) => {
    acc.work     = (acc.work     ?? 0) + (d.minutes_work     ?? 0);
    acc.lunch    = (acc.lunch    ?? 0) + (d.minutes_lunch    ?? 0);
    acc.meeting  = (acc.meeting  ?? 0) + (d.minutes_meeting  ?? 0);
    acc.travel   = (acc.travel   ?? 0) + (d.minutes_travel   ?? 0);
    acc.untagged = (acc.untagged ?? 0) + (d.minutes_untagged ?? 0);
    return acc;
  }, {});

  const { error: wkErr } = await sb
    .from("timesheet_weeks")
    .upsert({
      user_id:         userId,
      week_start:      weekStart,
      approval_status: "approved",
      approved_at:     new Date().toISOString(),
      approved_by:     admin.admin_user_id,
      locked:          true,
      totals,
    }, { onConflict: "user_id,week_start" });
  if (wkErr) return bad(`weeks upsert: ${wkErr.message}`, 500);

  // Mark all that week's days as approved.
  await sb
    .from("timesheet_days")
    .update({ approval_status: "approved" })
    .eq("user_id", userId)
    .gte("date", weekStart)
    .lt("date",  weekEnd);

  return json({ ok: true, message: "week approved & locked", totals });
}

async function rejectWeek(payload: any, admin: { admin_user_id: string }) {
  const userId    = String(payload.user_id || "");
  const weekStart = String(payload.week_start || "");
  const reason    = String(payload.reason || "").trim();
  if (!userId || !weekStart || !reason) return bad("user_id, week_start, reason required");
  const sb = svc();

  const { error } = await sb
    .from("timesheet_weeks")
    .upsert({
      user_id:         userId,
      week_start:      weekStart,
      approval_status: "rejected",
      reject_reason:   reason,
      locked:          false,
    }, { onConflict: "user_id,week_start" });
  if (error) return bad(`weeks upsert: ${error.message}`, 500);

  // Fire an alert to the user about the rejection.
  const { data: alert } = await sb
    .from("alerts")
    .insert({
      subject_table:  "timesheet",
      subject_row_id: userId,
      first_fire_at:  new Date().toISOString(),
      recurrence:     "one_time",
      message:        `Your timesheet for the week of ${weekStart} was returned for review: ${reason}`,
      is_active:      true,
    })
    .select("id")
    .single();
  if (alert) {
    await sb.from("alert_recipients").insert({ alert_id: alert.id, user_id: userId });
    await sb.from("alert_fires").insert({ alert_id: alert.id, scheduled_at: new Date().toISOString(), status: "pending" });
  }

  return json({ ok: true, message: "week rejected & user notified" });
}

async function unlockWeek(payload: any, admin: { admin_user_id: string }) {
  const userId    = String(payload.user_id || "");
  const weekStart = String(payload.week_start || "");
  if (!userId || !weekStart) return bad("user_id and week_start required");
  const sb = svc();

  const { error } = await sb
    .from("timesheet_weeks")
    .update({
      approval_status: "open",
      locked:          false,
      approved_at:     null,
      approved_by:     null,
    })
    .eq("user_id", userId)
    .eq("week_start", weekStart);
  if (error) return bad(`weeks update: ${error.message}`, 500);

  // Audit row in corrections.
  await sb.from("timesheet_corrections").insert({
    user_id:     userId,
    date:        weekStart,
    kind:        "note",
    payload:     { unlocked_by: admin.admin_user_id, week_start: weekStart },
    reason:      "admin unlock",
    status:      "approved",
    reviewed_at: new Date().toISOString(),
    reviewed_by: admin.admin_user_id,
  });

  return json({ ok: true, message: "week unlocked" });
}

async function resolveCorrection(payload: any, admin: { admin_user_id: string }) {
  const id       = String(payload.correction_id || "");
  // Accept either "approve" or "approved" (and lowercase variants) from the
  // client. Anything else is treated as a rejection. The client today sends
  // the past-tense form; this normalization keeps both spellings working.
  const raw      = String(payload.decision ?? "").toLowerCase();
  const decision = (raw === "approve" || raw === "approved") ? "approved" : "rejected";
  const note     = payload.note ? String(payload.note) : null;
  if (!id) return bad("correction_id required");
  const sb = svc();

  const { data: corr, error: cErr } = await sb
    .from("timesheet_corrections")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (cErr || !corr) return bad("correction not found", 404);
  if (corr.status !== "pending") return bad("correction is not pending");

  if (decision === "approved") {
    // 1) Apply the payload to the underlying tables. applyCorrection now
    //    throws when zero rows are matched (silent-no-op guard), so a stale
    //    punch_id / interval_id surfaces as a 500 the admin can see, not
    //    a "successful" approval with no actual change.
    try {
      await applyCorrection(sb, corr, admin.admin_user_id);
    } catch (e) {
      return bad(`apply failed: ${(e as Error).message}`, 500);
    }

    // 2) Re-derive that day from punches. The previous version swallowed
    //    rpc errors silently — that left time_punches updated but
    //    time_intervals + timesheet_days stale, which is the exact bug
    //    the admin sees as "approve succeeded but my timesheet didn't
    //    change". We now check the error AND only proceed to step 3 if
    //    the rebuild lands cleanly.
    const { error: rpcErr } = await sb.rpc("fn_rebuild_user_day", {
      _user_id: corr.user_id, _date: corr.date,
    });
    if (rpcErr) {
      return bad(`rebuild failed: ${rpcErr.message}`, 500);
    }

    // 2b) For add_interval, stamp the freshly-carved interval's category with
    //     source='user' so the user's chosen label (lunch/break/meeting/…)
    //     survives every later rebuild — the override snapshot in
    //     fn_rebuild_user_day preserves rows whose category_source is
    //     user/admin/outlook, keyed on the exact (start_at, end_at) boundary.
    //     The boundaries match the two punches we just inserted. Presence
    //     (is_out) comes from punch order, not from us, so we never write it
    //     here. A 'work' carve needs no stamp (rebuild defaults to work) and
    //     would not survive as an override anyway, so we skip it.
    if (corr.kind === "add_interval") {
      const p = corr.payload || {};
      const category = String(p.category || (p.is_out ? "break" : "work"));
      if (category !== "work") {
        const patch: Record<string, unknown> = {
          category, category_source: "user", computed_at: new Date().toISOString(),
        };
        if (typeof p.note === "string" && p.note.trim()) patch.notes = p.note.trim();
        const { error: stampErr } = await sb.from("time_intervals")
          .update(patch)
          .eq("user_id", corr.user_id)
          .eq("start_at", p.start_at)
          .eq("end_at", p.end_at);
        if (stampErr) return bad(`category stamp failed: ${stampErr.message}`, 500);
      }
    }
  }

  // 3) Only mark the correction approved/rejected once the underlying work
  //    has actually landed. Previously this ran unconditionally, which let
  //    a silent apply / rebuild failure flip the status to "approved" with
  //    no real change on disk.
  const { error: upErr } = await sb
    .from("timesheet_corrections")
    .update({
      status:      decision,
      reviewed_at: new Date().toISOString(),
      reviewed_by: admin.admin_user_id,
      review_note: note,
    })
    .eq("id", id);
  if (upErr) return bad(`correction update: ${upErr.message}`, 500);

  return json({ ok: true, message: `correction ${decision}` });
}

async function applyCorrection(sb: ReturnType<typeof svc>, corr: any, adminUserId: string) {
  const p = corr.payload || {};
  switch (corr.kind) {
    case "add_punch": {
      if (!p.punched_at) throw new Error("add_punch: payload missing punched_at");
      const { data, error } = await sb.from("time_punches").insert({
        user_id:    corr.user_id,
        punched_at: p.punched_at,
        source:     "manual",
        note:       p.note ?? `correction ${corr.id}`,
        created_by: adminUserId,
      }).select("id").maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("add_punch: insert returned no row");
      return;
    }
    case "add_interval": {
      // Atomic "away/worked sub-range" carve. Insert BOTH boundary punches in
      // one shot so the day can never be left half-toggled. fn_rebuild_user_day
      // (called by resolveCorrection right after this) re-derives the interval
      // chain from punches; the per-presence color falls out of punch order,
      // and resolveCorrection then stamps the carved interval's category with
      // source='user' so the user's chosen label sticks across future rebuilds.
      if (!p.start_at) throw new Error("add_interval: payload missing start_at");
      if (!p.end_at)   throw new Error("add_interval: payload missing end_at");
      if (new Date(p.end_at).getTime() <= new Date(p.start_at).getTime()) {
        throw new Error("add_interval: end_at must be after start_at");
      }
      const note = typeof p.note === "string" && p.note.trim() ? p.note.trim() : `correction ${corr.id}`;
      const { error } = await sb.from("time_punches").insert([
        { user_id: corr.user_id, punched_at: p.start_at, source: "manual", note, created_by: adminUserId },
        { user_id: corr.user_id, punched_at: p.end_at,   source: "manual", note, created_by: adminUserId },
      ]);
      if (error) throw error;
      return;
    }
    case "edit_punch": {
      // Hard-required fields. CorrectionModal sends both, but a stale or
      // hand-crafted payload could be missing either — surface that
      // explicitly rather than no-op.
      if (!p.punch_id)   throw new Error("edit_punch: payload missing punch_id");
      if (!p.punched_at) throw new Error("edit_punch: payload missing punched_at");
      // Only patch punched_at. The prior version also wrote `note: p.note ?? null`
      // which silently BLANKED any existing note on the punch, since the
      // CorrectionModal never sends a note field for edit_punch. Leave note
      // alone unless the payload explicitly provides one.
      const patch: Record<string, unknown> = { punched_at: p.punched_at };
      if (typeof p.note === "string") patch.note = p.note;
      const { data, error } = await sb.from("time_punches")
        .update(patch)
        .eq("id", p.punch_id)
        .select("id");
      if (error) throw error;
      // Supabase JS returns {data: [], error: null} when zero rows match.
      // Without this guard, a stale/wrong punch_id silently no-ops AND the
      // resolveCorrection still marks the row "approved" — exactly the
      // "approved but nothing changed" symptom.
      if (!data || data.length === 0) {
        throw new Error(`edit_punch: no punch matched id=${p.punch_id} (already deleted?)`);
      }
      return;
    }
    case "delete_punch": {
      if (!p.punch_id) throw new Error("delete_punch: payload missing punch_id");
      const { data, error } = await sb.from("time_punches")
        .delete()
        .eq("id", p.punch_id)
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error(`delete_punch: no punch matched id=${p.punch_id}`);
      }
      return;
    }
    case "reclassify_interval": {
      if (!p.interval_id) throw new Error("reclassify_interval: payload missing interval_id");
      if (!p.category)    throw new Error("reclassify_interval: payload missing category");
      const { data, error } = await sb.from("time_intervals")
        .update({
          ...categoryPresencePatch(String(p.category)),
          category_source: "admin",
          notes:           p.notes ?? null,
          outlook_event_id: p.outlook_event_id ?? null,
        })
        .eq("id", p.interval_id)
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error(`reclassify_interval: no interval matched id=${p.interval_id}`);
      }
      return;
    }
    case "note": {
      // Pure notation; nothing to apply beyond the corrections row itself.
      // No row to verify here.
      void adminUserId;
      return;
    }
    default:
      throw new Error(`unknown correction kind: ${corr.kind}`);
  }
}

async function reclassifyInterval(payload: any, admin: { admin_user_id: string }) {
  const id       = String(payload.interval_id || "");
  const category = String(payload.category || "");
  const notes    = payload.notes ? String(payload.notes) : null;
  const eventId  = payload.outlook_event_id ? String(payload.outlook_event_id) : null;
  if (!id || !category) return bad("interval_id and category required");
  const sb = svc();

  const { data: iv, error: ivErr } = await sb
    .from("time_intervals")
    .select("user_id, start_at")
    .eq("id", id)
    .maybeSingle();
  if (ivErr || !iv) return bad("interval not found", 404);

  const { error } = await sb
    .from("time_intervals")
    .update({
      ...categoryPresencePatch(category),
      category_source:    "admin",
      notes,
      outlook_event_id:   eventId,
      computed_at:        new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return bad(`update: ${error.message}`, 500);

  const date = new Date(iv.start_at).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  await sb.rpc("fn_recompute_day", { _user_id: iv.user_id, _date: date });

  void admin;     // touched for parity with other actions
  return json({ ok: true, message: "interval reclassified" });
}

async function setTravelBuffer(payload: any) {
  const userId  = String(payload.user_id || "");
  const eventId = String(payload.outlook_event_id || "");
  const minutes = Number(payload.travel_buffer_min);
  if (!userId || !eventId || !Number.isFinite(minutes) || minutes < 0 || minutes > 240) {
    return bad("user_id, outlook_event_id, travel_buffer_min (0..240) required");
  }
  const sb = svc();
  const { error } = await sb
    .from("user_calendar_events")
    .update({ travel_buffer_min: Math.round(minutes) })
    .eq("user_id", userId)
    .eq("outlook_event_id", eventId);
  if (error) return bad(`update: ${error.message}`, 500);
  return json({ ok: true, message: "travel buffer updated" });
}

async function retireTag(payload: any, _admin: { admin_user_id: string }) {
  const uid = String(payload.uid || "").trim();
  if (!uid) return bad("uid is required");
  const sb = svc();
  const { error } = await sb
    .from("nfc_tags")
    .update({ active: false, retired_at: new Date().toISOString() })
    .eq("uid", uid)
    .eq("active", true);
  if (error) return bad(`retire tag: ${error.message}`, 500);
  return json({ ok: true, message: "tag retired" });
}

async function registerDevice(payload: any, admin: { admin_user_id: string }) {
  const id       = String(payload.id || "");
  const label    = payload.label ? String(payload.label) : null;
  const location = payload.location ? String(payload.location) : null;
  if (!id) return bad("device id required");
  const sb = svc();
  const { error } = await sb
    .from("time_devices")
    .upsert({
      id, label, location, active: true,
      registered_at: new Date().toISOString(),
      registered_by: admin.admin_user_id,
    });
  if (error) return bad(`device upsert: ${error.message}`, 500);
  return json({ ok: true, message: "device registered" });
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return new Response("method not allowed", { status: 405, headers: CORS });

  let admin;
  try { admin = await authorize(req); }
  catch (resp) { return resp instanceof Response ? resp : bad("auth failed", 500); }

  let body: { action?: string; payload?: any };
  try { body = await req.json(); }
  catch { return bad("invalid JSON body"); }

  const action  = body?.action || "";
  const payload = body?.payload || {};

  try {
    switch (action) {
      case "enroll-tag":          return await enrollTag(payload, admin);
      case "start-enroll":        return await startEnroll(payload, admin);
      case "cancel-enroll":       return await cancelEnroll(payload, admin);
      case "approve-week":        return await approveWeek(payload, admin);
      case "reject-week":         return await rejectWeek(payload, admin);
      case "unlock-week":         return await unlockWeek(payload, admin);
      case "resolve-correction":  return await resolveCorrection(payload, admin);
      case "reclassify-interval": return await reclassifyInterval(payload, admin);
      case "set-travel-buffer":   return await setTravelBuffer(payload);
      case "retire-tag":          return await retireTag(payload, admin);
      case "register-device":     return await registerDevice(payload, admin);
      default:                    return bad(`unknown action: ${action}`);
    }
  } catch (e) {
    console.error("timeclock-admin error:", e);
    return bad((e as Error).message || "internal error", 500);
  }
});
