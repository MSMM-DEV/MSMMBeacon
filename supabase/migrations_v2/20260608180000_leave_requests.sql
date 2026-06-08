-- Leave requests — submit · approve · deduct · revert.
--
-- Builds the request lifecycle on top of the existing balance tracker
-- (20260608170000_leave_balances.sql). An employee submits a leave request
-- (a date range, hours-per-day, vacation|sick, reason). It lands 'pending'.
-- An admin approves (deducts the balance + bumps `used`), rejects (no balance
-- change), or — for an already-approved request — reverts (adds the hours
-- back). All approve/reject/revert math is done in SECURITY DEFINER RPCs that
-- are internally admin-gated, so the balance can never be moved by a non-admin
-- and the status guards make approve/revert symmetric + double-apply-safe.
--
-- Balance math touches only *_balance / *_used, NEVER as_of_date — accrual
-- since as_of_date is preserved, so v_leave_balances / computeLeaveAvailable
-- (= balance + accrued) drops/restores by exactly total_hours. Over-balance
-- approvals are allowed (balances may go negative) per product direction.
--
-- Day counting (weekdays minus company holidays) is computed CLIENT-SIDE and
-- snapshotted into business_days / total_hours at submit time, so a later
-- holiday-list edit can't silently re-price an in-flight request.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Enums.
--------------------------------------------------------------------------------
do $$ begin
  create type beacon_v2.leave_kind_enum as enum ('vacation','sick');
exception when duplicate_object then null; end $$;

do $$ begin
  create type beacon_v2.leave_status_enum as enum ('pending','approved','rejected','cancelled');
exception when duplicate_object then null; end $$;

--------------------------------------------------------------------------------
-- 2. The request table.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.leave_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references beacon_v2.users(id) on delete cascade,
  leave_type    beacon_v2.leave_kind_enum not null,
  date_start    date not null,
  date_end      date not null,
  hours_per_day numeric(5,2)  not null default 8,   -- 8 full · 4 half · custom
  business_days int           not null default 0,   -- snapshot: eligible weekdays minus holidays
  total_hours   numeric(8,2)  not null default 0,   -- snapshot = business_days * hours_per_day
  reason        text,
  status        beacon_v2.leave_status_enum not null default 'pending',
  requested_at  timestamptz not null default now(),
  reviewed_by   uuid references beacon_v2.users(id) on delete set null,
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (date_end >= date_start)
);

create index if not exists leave_requests_pending_idx
  on beacon_v2.leave_requests (status, requested_at) where status = 'pending';
create index if not exists leave_requests_user_idx
  on beacon_v2.leave_requests (user_id, date_start desc);
create index if not exists leave_requests_approved_range_idx
  on beacon_v2.leave_requests (date_start, date_end) where status = 'approved';

drop trigger if exists trg_leave_requests_touch on beacon_v2.leave_requests;
create trigger trg_leave_requests_touch
  before update on beacon_v2.leave_requests
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- 3. RLS — self-or-admin read; self-insert-pending; self-cancel-own-pending;
--    admin full write. Mirrors the retired timesheet_corrections idiom.
--    Service-role bypasses RLS; the approve/reject/revert RPCs are SECURITY
--    DEFINER so they move balances regardless of the caller's table grants.
--------------------------------------------------------------------------------
alter table beacon_v2.leave_requests enable row level security;

drop policy if exists "leave_req_self_select"   on beacon_v2.leave_requests;
drop policy if exists "leave_req_admin_select"   on beacon_v2.leave_requests;
drop policy if exists "leave_req_self_insert"    on beacon_v2.leave_requests;
drop policy if exists "leave_req_self_cancel"    on beacon_v2.leave_requests;
drop policy if exists "leave_req_admin_write"    on beacon_v2.leave_requests;

create policy "leave_req_self_select" on beacon_v2.leave_requests
  for select to authenticated
  using (beacon_v2.is_current_user(user_id));
create policy "leave_req_admin_select" on beacon_v2.leave_requests
  for select to authenticated
  using (beacon_v2.is_current_user_admin());

create policy "leave_req_self_insert" on beacon_v2.leave_requests
  for insert to authenticated
  with check (beacon_v2.is_current_user(user_id) and status = 'pending');

-- A user may cancel ONLY their own still-pending request (pending → cancelled).
create policy "leave_req_self_cancel" on beacon_v2.leave_requests
  for update to authenticated
  using      (beacon_v2.is_current_user(user_id) and status = 'pending')
  with check (beacon_v2.is_current_user(user_id) and status = 'cancelled');

create policy "leave_req_admin_write" on beacon_v2.leave_requests
  for all to authenticated
  using      (beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user_admin());

grant select, insert, update on beacon_v2.leave_requests to authenticated;

--------------------------------------------------------------------------------
-- 4. Approve / reject / revert RPCs. Admin-gated; balance side-effects atomic.
--------------------------------------------------------------------------------

-- Ensure a balances row exists for a user (deducting into a missing row would
-- be a no-op). Created with as_of_date = today so no spurious back-accrual.
create or replace function beacon_v2._ensure_leave_balance(_user_id uuid)
returns void
language sql
security definer
set search_path = beacon_v2, public
as $$
  insert into beacon_v2.leave_balances (user_id, as_of_date)
  values (_user_id, current_date)
  on conflict (user_id) do nothing;
$$;

-- Approve a pending request: flip status, stamp the reviewer, and move the
-- balance. vacation → vacation_*; sick → sick_*.
create or replace function beacon_v2.approve_leave_request(p_id uuid, p_note text default null)
returns beacon_v2.leave_requests
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  r        beacon_v2.leave_requests;
  v_admin  uuid;
begin
  if not beacon_v2.is_current_user_admin() then
    raise exception 'only an administrator can approve leave' using errcode = '42501';
  end if;

  select id into v_admin from beacon_v2.users where auth_user_id = auth.uid();

  select * into r from beacon_v2.leave_requests where id = p_id for update;
  if not found then
    raise exception 'leave request % not found', p_id;
  end if;
  if r.status <> 'pending' then
    raise exception 'leave request is % (only pending requests can be approved)', r.status
      using errcode = '22023';
  end if;

  perform beacon_v2._ensure_leave_balance(r.user_id);
  if r.leave_type = 'vacation' then
    update beacon_v2.leave_balances
       set vacation_balance = vacation_balance - r.total_hours,
           vacation_used    = vacation_used    + r.total_hours
     where user_id = r.user_id;
  else
    update beacon_v2.leave_balances
       set sick_balance = sick_balance - r.total_hours,
           sick_used    = sick_used    + r.total_hours
     where user_id = r.user_id;
  end if;

  update beacon_v2.leave_requests
     set status = 'approved', reviewed_by = v_admin, reviewed_at = now(),
         review_note = coalesce(p_note, review_note)
   where id = p_id
   returning * into r;
  return r;
end;
$$;

-- Reject a pending request: status only, no balance change.
create or replace function beacon_v2.reject_leave_request(p_id uuid, p_note text default null)
returns beacon_v2.leave_requests
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  r       beacon_v2.leave_requests;
  v_admin uuid;
begin
  if not beacon_v2.is_current_user_admin() then
    raise exception 'only an administrator can reject leave' using errcode = '42501';
  end if;
  select id into v_admin from beacon_v2.users where auth_user_id = auth.uid();

  select * into r from beacon_v2.leave_requests where id = p_id for update;
  if not found then raise exception 'leave request % not found', p_id; end if;
  if r.status <> 'pending' then
    raise exception 'leave request is % (only pending requests can be rejected)', r.status
      using errcode = '22023';
  end if;

  update beacon_v2.leave_requests
     set status = 'rejected', reviewed_by = v_admin, reviewed_at = now(),
         review_note = coalesce(p_note, review_note)
   where id = p_id
   returning * into r;
  return r;
end;
$$;

-- Revert an approved request: add the hours back and return it to pending so
-- the admin can re-decide. Symmetric to approve; the status guard prevents a
-- double restore.
create or replace function beacon_v2.revert_leave_request(p_id uuid)
returns beacon_v2.leave_requests
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  r beacon_v2.leave_requests;
begin
  if not beacon_v2.is_current_user_admin() then
    raise exception 'only an administrator can revert leave' using errcode = '42501';
  end if;

  select * into r from beacon_v2.leave_requests where id = p_id for update;
  if not found then raise exception 'leave request % not found', p_id; end if;
  if r.status <> 'approved' then
    raise exception 'leave request is % (only approved requests can be reverted)', r.status
      using errcode = '22023';
  end if;

  perform beacon_v2._ensure_leave_balance(r.user_id);
  if r.leave_type = 'vacation' then
    update beacon_v2.leave_balances
       set vacation_balance = vacation_balance + r.total_hours,
           vacation_used    = vacation_used    - r.total_hours
     where user_id = r.user_id;
  else
    update beacon_v2.leave_balances
       set sick_balance = sick_balance + r.total_hours,
           sick_used    = sick_used    - r.total_hours
     where user_id = r.user_id;
  end if;

  update beacon_v2.leave_requests
     set status = 'pending', reviewed_by = null, reviewed_at = null
   where id = p_id
   returning * into r;
  return r;
end;
$$;

revoke all on function beacon_v2.approve_leave_request(uuid, text) from public, anon;
revoke all on function beacon_v2.reject_leave_request(uuid, text)  from public, anon;
revoke all on function beacon_v2.revert_leave_request(uuid)        from public, anon;
grant execute on function beacon_v2.approve_leave_request(uuid, text) to authenticated;
grant execute on function beacon_v2.reject_leave_request(uuid, text)  to authenticated;
grant execute on function beacon_v2.revert_leave_request(uuid)        to authenticated;

notify pgrst, 'reload schema';
