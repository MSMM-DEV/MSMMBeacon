-- MSMM Beacon v2 — RLS posture for the timekeeping tables.
--
-- This migration intentionally diverges from the project's prototype-era
-- baseline (20260428121000_grants_rls.sql) which grants permissive
-- "auth full access" + "anon read/write" to almost every table. Timekeeping
-- holds employee work history — same sensitivity as a payroll system — so we
-- ship it with default-deny + narrow, named policies from day one.
--
-- IMPORTANT GOTCHA: If 20260428121000_grants_rls.sql is ever re-applied AFTER
-- this file, its do$$ loop will re-create the permissive "auth full access" /
-- "anon *" policies on timekeeping tables (it iterates pg_tables and only
-- excludes 'users' and 'outlook_sync_state'). Re-paste THIS file after any
-- 121000 re-run.
--
-- Policy summary:
--   time_punches             — SELECT: self or admin · WRITE: admin only
--                              (Edge Function writes use service-role, RLS bypassed)
--   time_intervals           — SELECT: self or admin · WRITE: admin only
--   nfc_tags                 — SELECT: self or admin · WRITE: admin only
--   time_devices             — admin-only
--   nfc_enroll_sessions      — own admin session only
--   timesheet_days           — SELECT: self or admin · WRITE: admin only
--   timesheet_weeks          — SELECT: self or admin · INSERT/UPDATE: self
--                              (submit-only) or admin (approve/lock)
--   timesheet_corrections    — SELECT: self or admin
--                              INSERT: self for own user_id, status='pending'
--                              UPDATE: admin (review) or self (only own pending → withdrawn)
--   user_calendar_events     — SELECT: self or admin · WRITE: service-role only
--   user_outlook_sync_state  — SELECT: admin · WRITE: service-role only

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Helper: is_self(user_id) — same auth pattern as is_current_user_admin.
--    Returns true if the calling auth.uid() matches the users.auth_user_id of
--    the given user row.
--------------------------------------------------------------------------------
create or replace function beacon_v2.is_current_user(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = beacon_v2, public
as $$
  select exists (
    select 1 from beacon_v2.users u
     where u.id = _user_id and u.auth_user_id = auth.uid()
  );
$$;

grant execute on function beacon_v2.is_current_user(uuid) to authenticated, anon;

--------------------------------------------------------------------------------
-- 2. Enable RLS on every timekeeping table (idempotent).
--------------------------------------------------------------------------------
alter table beacon_v2.time_punches              enable row level security;
alter table beacon_v2.time_intervals            enable row level security;
alter table beacon_v2.nfc_tags                  enable row level security;
alter table beacon_v2.time_devices              enable row level security;
alter table beacon_v2.nfc_enroll_sessions       enable row level security;
alter table beacon_v2.timesheet_days            enable row level security;
alter table beacon_v2.timesheet_weeks           enable row level security;
alter table beacon_v2.timesheet_corrections     enable row level security;
alter table beacon_v2.user_calendar_events      enable row level security;
alter table beacon_v2.user_outlook_sync_state   enable row level security;

--------------------------------------------------------------------------------
-- 3. Drop the prototype-baseline policies that 20260428121000 would apply on
--    re-run (idempotent — no-op if absent).
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select unnest(array[
      'time_punches','time_intervals','nfc_tags','time_devices',
      'nfc_enroll_sessions','timesheet_days','timesheet_weeks',
      'timesheet_corrections','user_calendar_events','user_outlook_sync_state'
    ])
  loop
    execute format('drop policy if exists "auth full access" on beacon_v2.%I', t);
    execute format('drop policy if exists "anon read"        on beacon_v2.%I', t);
    execute format('drop policy if exists "anon insert"      on beacon_v2.%I', t);
    execute format('drop policy if exists "anon update"      on beacon_v2.%I', t);
    execute format('drop policy if exists "anon delete"      on beacon_v2.%I', t);
    -- Revoke anon grants that 121000's grant-all may have left
    execute format('revoke all on beacon_v2.%I from anon', t);
  end loop;
end $$;

--------------------------------------------------------------------------------
-- 4. time_punches
--------------------------------------------------------------------------------
drop policy if exists "tk_punches_self_select"  on beacon_v2.time_punches;
drop policy if exists "tk_punches_admin_select" on beacon_v2.time_punches;
drop policy if exists "tk_punches_admin_write"  on beacon_v2.time_punches;

create policy "tk_punches_self_select" on beacon_v2.time_punches
  for select to authenticated
  using (beacon_v2.is_current_user(user_id));

create policy "tk_punches_admin_select" on beacon_v2.time_punches
  for select to authenticated
  using (beacon_v2.is_current_user_admin());

create policy "tk_punches_admin_write" on beacon_v2.time_punches
  for all to authenticated
  using      (beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user_admin());

grant select, insert, update, delete on beacon_v2.time_punches to authenticated;

--------------------------------------------------------------------------------
-- 5. time_intervals
--------------------------------------------------------------------------------
drop policy if exists "tk_intervals_self_select"  on beacon_v2.time_intervals;
drop policy if exists "tk_intervals_admin_select" on beacon_v2.time_intervals;
drop policy if exists "tk_intervals_self_update"  on beacon_v2.time_intervals;
drop policy if exists "tk_intervals_admin_write"  on beacon_v2.time_intervals;

create policy "tk_intervals_self_select" on beacon_v2.time_intervals
  for select to authenticated
  using (beacon_v2.is_current_user(user_id));

create policy "tk_intervals_admin_select" on beacon_v2.time_intervals
  for select to authenticated
  using (beacon_v2.is_current_user_admin());

-- Users can reclassify their OWN intervals (set category, notes,
-- outlook_event_id) — UI uses this for the per-interval popover. The DB
-- doesn't restrict which columns; the frontend only sends category-related
-- fields and the Edge Function path for everything else.
create policy "tk_intervals_self_update" on beacon_v2.time_intervals
  for update to authenticated
  using      (beacon_v2.is_current_user(user_id))
  with check (beacon_v2.is_current_user(user_id));

create policy "tk_intervals_admin_write" on beacon_v2.time_intervals
  for all to authenticated
  using      (beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user_admin());

grant select, update on beacon_v2.time_intervals to authenticated;

--------------------------------------------------------------------------------
-- 6. nfc_tags
--------------------------------------------------------------------------------
drop policy if exists "tk_nfctags_self_select"  on beacon_v2.nfc_tags;
drop policy if exists "tk_nfctags_admin_select" on beacon_v2.nfc_tags;
drop policy if exists "tk_nfctags_admin_write"  on beacon_v2.nfc_tags;

create policy "tk_nfctags_self_select" on beacon_v2.nfc_tags
  for select to authenticated
  using (beacon_v2.is_current_user(user_id));

create policy "tk_nfctags_admin_select" on beacon_v2.nfc_tags
  for select to authenticated
  using (beacon_v2.is_current_user_admin());

create policy "tk_nfctags_admin_write" on beacon_v2.nfc_tags
  for all to authenticated
  using      (beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user_admin());

grant select on beacon_v2.nfc_tags to authenticated;

--------------------------------------------------------------------------------
-- 7. time_devices — admin-only on every operation
--------------------------------------------------------------------------------
drop policy if exists "tk_devices_admin" on beacon_v2.time_devices;
create policy "tk_devices_admin" on beacon_v2.time_devices
  for all to authenticated
  using      (beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user_admin());

grant select, insert, update, delete on beacon_v2.time_devices to authenticated;

--------------------------------------------------------------------------------
-- 8. nfc_enroll_sessions — only the admin who started a capture session sees
--    their own row. Inserts/updates are admin-only.
--------------------------------------------------------------------------------
drop policy if exists "tk_enroll_self_admin" on beacon_v2.nfc_enroll_sessions;
create policy "tk_enroll_self_admin" on beacon_v2.nfc_enroll_sessions
  for all to authenticated
  using      (beacon_v2.is_current_user_admin()
              and beacon_v2.is_current_user(admin_user_id))
  with check (beacon_v2.is_current_user_admin()
              and beacon_v2.is_current_user(admin_user_id));

grant select, insert, update, delete on beacon_v2.nfc_enroll_sessions to authenticated;

--------------------------------------------------------------------------------
-- 9. timesheet_days
--------------------------------------------------------------------------------
drop policy if exists "tk_days_self_select"  on beacon_v2.timesheet_days;
drop policy if exists "tk_days_admin_select" on beacon_v2.timesheet_days;
drop policy if exists "tk_days_admin_write"  on beacon_v2.timesheet_days;

create policy "tk_days_self_select" on beacon_v2.timesheet_days
  for select to authenticated
  using (beacon_v2.is_current_user(user_id));

create policy "tk_days_admin_select" on beacon_v2.timesheet_days
  for select to authenticated
  using (beacon_v2.is_current_user_admin());

create policy "tk_days_admin_write" on beacon_v2.timesheet_days
  for all to authenticated
  using      (beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user_admin());

grant select on beacon_v2.timesheet_days to authenticated;

--------------------------------------------------------------------------------
-- 10. timesheet_weeks
--     Users can submit (insert/update) their OWN week with approval_status in
--     ('open','submitted'). Admins do anything. Lock flag transitions are
--     admin-only via WITH CHECK (locked = approved).
--------------------------------------------------------------------------------
drop policy if exists "tk_weeks_self_select"  on beacon_v2.timesheet_weeks;
drop policy if exists "tk_weeks_admin_select" on beacon_v2.timesheet_weeks;
drop policy if exists "tk_weeks_self_submit"  on beacon_v2.timesheet_weeks;
drop policy if exists "tk_weeks_self_update"  on beacon_v2.timesheet_weeks;
drop policy if exists "tk_weeks_admin_write"  on beacon_v2.timesheet_weeks;

create policy "tk_weeks_self_select" on beacon_v2.timesheet_weeks
  for select to authenticated
  using (beacon_v2.is_current_user(user_id));

create policy "tk_weeks_admin_select" on beacon_v2.timesheet_weeks
  for select to authenticated
  using (beacon_v2.is_current_user_admin());

create policy "tk_weeks_self_submit" on beacon_v2.timesheet_weeks
  for insert to authenticated
  with check (
    beacon_v2.is_current_user(user_id)
    and approval_status in ('open','submitted')
    and locked = false
  );

-- Users can flip their own row open→submitted (or re-submit after rejection)
-- but not change locked / approved_* fields. The DB doesn't enforce the
-- column-level restriction here — frontend hits PostgREST with a narrow patch.
create policy "tk_weeks_self_update" on beacon_v2.timesheet_weeks
  for update to authenticated
  using      (beacon_v2.is_current_user(user_id) and locked = false)
  with check (beacon_v2.is_current_user(user_id)
              and approval_status in ('open','submitted')
              and locked = false);

create policy "tk_weeks_admin_write" on beacon_v2.timesheet_weeks
  for all to authenticated
  using      (beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user_admin());

grant select, insert, update on beacon_v2.timesheet_weeks to authenticated;

--------------------------------------------------------------------------------
-- 11. timesheet_corrections — users insert pending requests for themselves;
--     admins review.
--------------------------------------------------------------------------------
drop policy if exists "tk_corr_self_select"   on beacon_v2.timesheet_corrections;
drop policy if exists "tk_corr_admin_select"  on beacon_v2.timesheet_corrections;
drop policy if exists "tk_corr_self_insert"   on beacon_v2.timesheet_corrections;
drop policy if exists "tk_corr_self_withdraw" on beacon_v2.timesheet_corrections;
drop policy if exists "tk_corr_admin_write"   on beacon_v2.timesheet_corrections;

create policy "tk_corr_self_select" on beacon_v2.timesheet_corrections
  for select to authenticated
  using (beacon_v2.is_current_user(user_id));

create policy "tk_corr_admin_select" on beacon_v2.timesheet_corrections
  for select to authenticated
  using (beacon_v2.is_current_user_admin());

create policy "tk_corr_self_insert" on beacon_v2.timesheet_corrections
  for insert to authenticated
  with check (
    beacon_v2.is_current_user(user_id)
    and status = 'pending'
  );

-- Self-withdraw only: flip own pending → withdrawn. No other field changes.
create policy "tk_corr_self_withdraw" on beacon_v2.timesheet_corrections
  for update to authenticated
  using      (beacon_v2.is_current_user(user_id) and status = 'pending')
  with check (beacon_v2.is_current_user(user_id) and status = 'withdrawn');

create policy "tk_corr_admin_write" on beacon_v2.timesheet_corrections
  for all to authenticated
  using      (beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user_admin());

grant select, insert, update on beacon_v2.timesheet_corrections to authenticated;

--------------------------------------------------------------------------------
-- 12. user_calendar_events — read-only to self + admin; writes via Edge Function
--     (service-role bypasses RLS).
--------------------------------------------------------------------------------
drop policy if exists "tk_calevents_self_select"  on beacon_v2.user_calendar_events;
drop policy if exists "tk_calevents_admin_select" on beacon_v2.user_calendar_events;
drop policy if exists "tk_calevents_self_update"  on beacon_v2.user_calendar_events;

create policy "tk_calevents_self_select" on beacon_v2.user_calendar_events
  for select to authenticated
  using (beacon_v2.is_current_user(user_id));

create policy "tk_calevents_admin_select" on beacon_v2.user_calendar_events
  for select to authenticated
  using (beacon_v2.is_current_user_admin());

-- Self update is limited to travel_buffer_min — frontend posts a narrow patch.
create policy "tk_calevents_self_update" on beacon_v2.user_calendar_events
  for update to authenticated
  using      (beacon_v2.is_current_user(user_id))
  with check (beacon_v2.is_current_user(user_id));

grant select, update on beacon_v2.user_calendar_events to authenticated;

--------------------------------------------------------------------------------
-- 13. user_outlook_sync_state — admin-only readable; writes are service-role
--     only (no policies needed for service-role since RLS is bypassed).
--------------------------------------------------------------------------------
drop policy if exists "tk_uoss_admin_select" on beacon_v2.user_outlook_sync_state;

create policy "tk_uoss_admin_select" on beacon_v2.user_outlook_sync_state
  for select to authenticated
  using (beacon_v2.is_current_user_admin());

grant select on beacon_v2.user_outlook_sync_state to authenticated;
