-- Self-service timesheet editing — everyone can modify their OWN time directly,
-- no admin approval. Replaces the correction-request → admin-approve flow and
-- the weekly submit → approve → lock flow (both retired per client direction).
--
-- Before: time_punches writes were admin-only; time_intervals allowed self
-- UPDATE (reclassify) but not insert/delete; timesheet_days was admin-write
-- only; and trg_punches_lock_guard blocked non-admins from editing approved
-- (locked) weeks. The rebuild/reconcile/recompute functions are SECURITY
-- INVOKER, so when a regular user edits a punch the trigger + rebuild run AS
-- that user and need write access to the derived tables.
--
-- This migration grants each user full write on their OWN rows of the three
-- tables the edit path touches (punches they edit + intervals/days the rebuild
-- re-derives), drops the lock guard, and unlocks any pre-existing approved
-- weeks/days so every day is owner-editable. The Pi / Edge-Function punch path
-- is unaffected (service-role bypasses RLS); only the new direct user-edit path
-- gains permission. Idempotent / re-runnable.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. time_punches — users may insert/update/delete their OWN punches.
--    (The grant of insert/update/delete to authenticated already exists from
--    20260601120400; this adds the missing self-write POLICY alongside the
--    existing admin-write one — RLS combines policies as a UNION.)
--------------------------------------------------------------------------------
drop policy if exists "tk_punches_self_write" on beacon_v2.time_punches;
create policy "tk_punches_self_write" on beacon_v2.time_punches
  for all to authenticated
  using      (beacon_v2.is_current_user(user_id))
  with check (beacon_v2.is_current_user(user_id));

--------------------------------------------------------------------------------
-- 2. time_intervals — self UPDATE already exists (tk_intervals_self_update).
--    Add self INSERT + DELETE so the INVOKER rebuild can delete + re-derive a
--    user's own intervals when they edit a punch.
--------------------------------------------------------------------------------
drop policy if exists "tk_intervals_self_insert" on beacon_v2.time_intervals;
create policy "tk_intervals_self_insert" on beacon_v2.time_intervals
  for insert to authenticated
  with check (beacon_v2.is_current_user(user_id));

drop policy if exists "tk_intervals_self_delete" on beacon_v2.time_intervals;
create policy "tk_intervals_self_delete" on beacon_v2.time_intervals
  for delete to authenticated
  using (beacon_v2.is_current_user(user_id));

grant insert, delete on beacon_v2.time_intervals to authenticated;

--------------------------------------------------------------------------------
-- 3. timesheet_days — fn_recompute_day upserts the per-day rollup. Allow users
--    to write their OWN day rows.
--------------------------------------------------------------------------------
drop policy if exists "tk_days_self_write" on beacon_v2.timesheet_days;
create policy "tk_days_self_write" on beacon_v2.timesheet_days
  for all to authenticated
  using      (beacon_v2.is_current_user(user_id))
  with check (beacon_v2.is_current_user(user_id));

grant insert, update on beacon_v2.timesheet_days to authenticated;

--------------------------------------------------------------------------------
-- 4. Retire the week-lock guard — there is no approval/lock anymore, so no week
--    should ever block its owner's edits.
--------------------------------------------------------------------------------
drop trigger if exists trg_punches_lock_guard on beacon_v2.time_punches;

--------------------------------------------------------------------------------
-- 5. Unlock everything that was locked/approved under the old flow so every day
--    is editable by its owner. (fn_recompute_day skips days with
--    approval_status='approved', so those are reset to 'pending' or their
--    totals would go stale after an edit.)
--------------------------------------------------------------------------------
update beacon_v2.timesheet_weeks set locked = false where locked = true;
update beacon_v2.timesheet_days  set approval_status = 'pending' where approval_status = 'approved';

notify pgrst, 'reload schema';
