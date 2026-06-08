-- Vacation + Sick leave tracker with bi-weekly accrual.
--
-- Each eligible employee accrues paid leave every pay period (bi-weekly — every
-- other Wednesday). We store a per-user NET-AVAILABLE balance "as of" a date,
-- plus a cumulative "used" figure, and derive the live available balance as:
--
--     available = balance + (pay periods since as_of_date) × accrual_per_period
--
-- The pay schedule is deterministic (anchor pay date + 14-day interval), so the
-- accrued amount is COMPUTED, not materialized — every pay period accrues
-- automatically with no cron, and the figure can never drift or double-count.
-- `used` is informational (the seed balances are already net of it); the future
-- request/approval flow will decrement `balance` and increment `used` together.
--
-- Accrual rates are PER PAY PERIOD (26/year): vacation 3.076923077 (= 80 hrs/yr),
-- sick 1.538461538 (= 40 hrs/yr) — matching the source spreadsheet's
-- "80 / 40 hours/year (accrued each pay period)". Eligibility = every employee
-- whose department is NOT '1099' (full-time). All knobs live in app_settings so
-- HR can adjust the schedule / rates without a code change.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Per-user balances.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.leave_balances (
  user_id          uuid primary key references beacon_v2.users(id) on delete cascade,
  -- Net-AVAILABLE balances as of as_of_date (already net of `used`).
  vacation_balance numeric(8,3) not null default 0,
  vacation_used    numeric(8,3) not null default 0,   -- cumulative, informational
  sick_balance     numeric(8,3) not null default 0,
  sick_used        numeric(8,3) not null default 0,
  as_of_date       date         not null default current_date,
  accrues          boolean      not null default true,  -- false = 1099 / non-accruing
  created_at       timestamptz  not null default now(),
  updated_at       timestamptz  not null default now()
);

drop trigger if exists trg_leave_balances_touch on beacon_v2.leave_balances;
create trigger trg_leave_balances_touch
  before update on beacon_v2.leave_balances
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- 2. Pay-schedule + accrual knobs on the app_settings singleton.
--------------------------------------------------------------------------------
alter table beacon_v2.app_settings
  add column if not exists leave_pay_anchor        date         not null default date '2026-06-03',
  add column if not exists leave_pay_interval_days  integer      not null default 14,
  add column if not exists leave_vacation_accrual   numeric(12,9) not null default 3.076923077,
  add column if not exists leave_sick_accrual       numeric(12,9) not null default 1.538461538;

--------------------------------------------------------------------------------
-- 3. Live-balance view. security_invoker so the underlying leave_balances RLS
--    (self-or-admin) applies to whoever queries it — a non-admin sees only
--    their own row. periods = count of pay dates in (as_of_date, current_date].
--------------------------------------------------------------------------------
create or replace view beacon_v2.v_leave_balances
  with (security_invoker = true) as
select
  lb.user_id,
  lb.vacation_balance, lb.vacation_used,
  lb.sick_balance,     lb.sick_used,
  lb.as_of_date, lb.accrues,
  p.periods_accrued,
  round(lb.vacation_balance + case when lb.accrues then p.periods_accrued * s.va else 0 end, 2) as vacation_available,
  round(lb.sick_balance     + case when lb.accrues then p.periods_accrued * s.si else 0 end, 2) as sick_available
from beacon_v2.leave_balances lb
cross join (
  select leave_pay_anchor a, leave_pay_interval_days i,
         leave_vacation_accrual va, leave_sick_accrual si
  from beacon_v2.app_settings where singleton limit 1
) s
cross join lateral (
  select greatest(0,
    floor((current_date  - s.a)::numeric / s.i)
    - floor((lb.as_of_date - s.a)::numeric / s.i)
  )::int as periods_accrued
) p;

--------------------------------------------------------------------------------
-- 4. RLS — self-or-admin read; admin-only write. Service-role (seed script)
--    bypasses RLS. Mirrors the timekeeping self/admin idiom.
--------------------------------------------------------------------------------
alter table beacon_v2.leave_balances enable row level security;

drop policy if exists "leave_self_admin_select" on beacon_v2.leave_balances;
drop policy if exists "leave_admin_insert"      on beacon_v2.leave_balances;
drop policy if exists "leave_admin_update"      on beacon_v2.leave_balances;
drop policy if exists "leave_admin_delete"      on beacon_v2.leave_balances;

create policy "leave_self_admin_select" on beacon_v2.leave_balances
  for select to authenticated
  using (beacon_v2.is_current_user(user_id) or beacon_v2.is_current_user_admin());

create policy "leave_admin_insert" on beacon_v2.leave_balances
  for insert to authenticated with check (beacon_v2.is_current_user_admin());
create policy "leave_admin_update" on beacon_v2.leave_balances
  for update to authenticated
  using (beacon_v2.is_current_user_admin()) with check (beacon_v2.is_current_user_admin());
create policy "leave_admin_delete" on beacon_v2.leave_balances
  for delete to authenticated using (beacon_v2.is_current_user_admin());

grant select, insert, update, delete on beacon_v2.leave_balances to authenticated;
grant select on beacon_v2.v_leave_balances to authenticated;

notify pgrst, 'reload schema';
