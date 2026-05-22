-- MSMM Beacon v2 — timekeeping intervals + day rollup + weekly approval +
-- corrections + the reconcile/lock triggers.
--
-- Derived from time_punches (the source of truth in 20260601120000). Each
-- punch toggles state: closes the open interval, opens a new one. The
-- classifier in this file applies time-of-day rules synchronously; the
-- timeclock-classify Edge Function asynchronously enriches with Outlook
-- events (those writes set category_source='outlook' so subsequent rule
-- passes don't overwrite them).
--
-- Business timezone is hardcoded to 'America/Chicago' here (MSMM is in
-- Louisiana) so functions can be created without depending on the
-- app_settings additions in 20260601120300. A later refactor migration can
-- swap the literal for a setting lookup if MSMM ever expands beyond CT.
--
-- Edge Function calls fn_rebuild_user_day(user_id, date) after admin
-- back-dated edits or correction approvals to re-derive a day from punches
-- while preserving user/admin overrides matched by (start_at, end_at).
--
-- Approval state machine on timesheet_weeks (Plan §8):
--   open --user Submit--> submitted --admin Approve--> approved (locked=true)
--                                  --admin Reject---> rejected
--   rejected --user re-Submit--> submitted

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Enums (idempotent)
--------------------------------------------------------------------------------
do $$ begin create type beacon_v2.interval_category_enum as enum
  ('work','lunch','break','meeting','travel','eod','meeting_untagged',
   'vacation','holiday','off');
exception when duplicate_object then null; end $$;

do $$ begin create type beacon_v2.classification_source_enum as enum
  ('auto','rule','outlook','user','admin');
exception when duplicate_object then null; end $$;

do $$ begin create type beacon_v2.timesheet_day_status_enum as enum
  ('open','pending','approved','rejected','flagged');
exception when duplicate_object then null; end $$;

do $$ begin create type beacon_v2.timesheet_week_status_enum as enum
  ('open','submitted','approved','rejected');
exception when duplicate_object then null; end $$;

do $$ begin create type beacon_v2.correction_kind_enum as enum
  ('add_punch','edit_punch','delete_punch','reclassify_interval','note');
exception when duplicate_object then null; end $$;

do $$ begin create type beacon_v2.correction_status_enum as enum
  ('pending','approved','rejected','withdrawn');
exception when duplicate_object then null; end $$;

--------------------------------------------------------------------------------
-- 2. time_intervals — derived per (start punch, end punch) pair.
--    Currently-in interval has end_at IS NULL.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.time_intervals (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references beacon_v2.users(id) on delete cascade,
  start_at               timestamptz not null,
  end_at                 timestamptz,                    -- null = currently open
  start_punch_id         uuid references beacon_v2.time_punches(id) on delete set null,
  end_punch_id           uuid references beacon_v2.time_punches(id) on delete set null,
  category               beacon_v2.interval_category_enum not null default 'work',
  category_source        beacon_v2.classification_source_enum not null default 'auto',
  outlook_event_id       text,                            -- per-user; not FK (added in next migration)
  outlook_event_subject  text,                            -- snapshot for stale-link resilience
  outlook_event_location text,
  notes                  text,
  computed_at            timestamptz not null default now(),
  check (end_at is null or end_at >= start_at)
);

create index if not exists time_intervals_user_start_idx
  on beacon_v2.time_intervals (user_id, start_at desc);

create index if not exists time_intervals_user_end_idx
  on beacon_v2.time_intervals (user_id, end_at desc nulls first);

-- At most one open interval per user (the partial unique constraint replaces
-- the heavier exclude-using-gist approach; non-overlap of closed intervals
-- holds by construction of the append-only trigger flow).
create unique index if not exists time_intervals_one_open_per_user
  on beacon_v2.time_intervals (user_id) where end_at is null;

--------------------------------------------------------------------------------
-- 3. timesheet_days — per (user, date) rollup. Maintained by
--    fn_recompute_day; the frontend reads it directly to render week summaries
--    and totals.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.timesheet_days (
  user_id           uuid not null references beacon_v2.users(id) on delete cascade,
  date              date not null,
  minutes_work      int not null default 0,
  minutes_lunch     int not null default 0,
  minutes_break     int not null default 0,
  minutes_meeting   int not null default 0,
  minutes_travel    int not null default 0,
  minutes_untagged  int not null default 0,
  minutes_off       int not null default 0,
  first_in          timestamptz,
  last_out          timestamptz,
  approval_status   beacon_v2.timesheet_day_status_enum not null default 'open',
  notes             text,
  flags             jsonb not null default '{}'::jsonb,
                    -- {"missing_out": bool, "overtime_min": int,
                    --  "off_hours_punch": bool, "untagged_meeting": bool}
  updated_at        timestamptz not null default now(),
  primary key (user_id, date)
);

create index if not exists timesheet_days_date_idx
  on beacon_v2.timesheet_days (date desc);
create index if not exists timesheet_days_pending_idx
  on beacon_v2.timesheet_days (date desc) where approval_status = 'pending';

drop trigger if exists touch_timesheet_days on beacon_v2.timesheet_days;
create trigger touch_timesheet_days before update on beacon_v2.timesheet_days
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- 4. timesheet_weeks — one row per (user, week_start). week_start is the
--    Monday of the week in business tz. Admin approval locks the week.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.timesheet_weeks (
  user_id           uuid not null references beacon_v2.users(id) on delete cascade,
  week_start        date not null,                       -- Monday
  submitted_at      timestamptz,
  submitted_by      uuid references beacon_v2.users(id) on delete set null,
  approval_status   beacon_v2.timesheet_week_status_enum not null default 'open',
  approved_at       timestamptz,
  approved_by       uuid references beacon_v2.users(id) on delete set null,
  reject_reason     text,
  locked            boolean not null default false,
  totals            jsonb not null default '{}'::jsonb,  -- snapshot at approval
  primary key (user_id, week_start)
);

create index if not exists timesheet_weeks_status_idx
  on beacon_v2.timesheet_weeks (approval_status, week_start desc);

--------------------------------------------------------------------------------
-- 5. timesheet_corrections — user-submitted edits awaiting admin review.
--    Approving applies the payload via the timeclock-admin Edge Function
--    (service-role) so RLS doesn't block.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.timesheet_corrections (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references beacon_v2.users(id) on delete cascade,
  date              date not null,
  kind              beacon_v2.correction_kind_enum not null,
  payload           jsonb not null,                       -- shape depends on kind
  reason            text not null,
  status            beacon_v2.correction_status_enum not null default 'pending',
  submitted_at      timestamptz not null default now(),
  reviewed_at       timestamptz,
  reviewed_by       uuid references beacon_v2.users(id) on delete set null,
  review_note       text
);

create index if not exists timesheet_corrections_pending_idx
  on beacon_v2.timesheet_corrections (status, submitted_at)
  where status = 'pending';
create index if not exists timesheet_corrections_user_date_idx
  on beacon_v2.timesheet_corrections (user_id, date desc);

--------------------------------------------------------------------------------
-- 6. fn_classify_interval — rule-based synchronous classifier. Applied to
--    each interval as it closes. The async timeclock-classify Edge Function
--    refines with Outlook event correlation later.
--
--    Rule precedence (only when category_source IN ('auto','rule')):
--      A. duration <= 5 min                        → 'break'
--      B. start_hour in lunch window AND
--         duration 20–90 min                       → 'lunch'  (source='rule')
--      C. start_hour >= 16 (CT)                    → 'eod'    (source='rule')
--      D. start_hour < 16 (CT) AND closed gap      → 'meeting_untagged' (source='rule')
--      E. open interval / fallback                 → leave as 'work'
--
--    Skipping: if category_source IN ('outlook','user','admin'), bail out.
--------------------------------------------------------------------------------
create or replace function beacon_v2.fn_classify_interval(_interval_id uuid)
returns void
language plpgsql
as $$
declare
  _iv          beacon_v2.time_intervals%rowtype;
  _dur_min     int;
  _start_hour  int;
  _start_min   int;
  _new_cat     beacon_v2.interval_category_enum;
  _new_src     beacon_v2.classification_source_enum;
begin
  select * into _iv from beacon_v2.time_intervals where id = _interval_id;
  if not found then return; end if;

  if _iv.category_source in ('outlook','user','admin') then
    return;
  end if;

  -- Open interval = "currently in" — always 'work' until it closes.
  if _iv.end_at is null then
    if _iv.category <> 'work' or _iv.category_source <> 'auto' then
      update beacon_v2.time_intervals
         set category = 'work', category_source = 'auto', computed_at = now()
       where id = _interval_id;
    end if;
    return;
  end if;

  _dur_min := extract(epoch from (_iv.end_at - _iv.start_at))::int / 60;
  _start_hour := extract(hour   from (_iv.start_at at time zone 'America/Chicago'));
  _start_min  := extract(minute from (_iv.start_at at time zone 'America/Chicago'));

  -- A. trivial gap
  if _dur_min <= 5 then
    _new_cat := 'break'; _new_src := 'auto';

  -- B. lunch window (11:30 – 13:30) AND 20–90 min duration
  elsif (_start_hour = 11 and _start_min >= 30)
     or (_start_hour = 12)
     or (_start_hour = 13 and _start_min <= 30)
  then
    if _dur_min between 20 and 90 then
      _new_cat := 'lunch'; _new_src := 'rule';
    else
      _new_cat := 'meeting_untagged'; _new_src := 'rule';
    end if;

  -- C. EOD window (16:00+ CT) — treat closed gaps as "went home"
  elsif _start_hour >= 16 then
    _new_cat := 'eod'; _new_src := 'rule';

  -- D. before 16:00 CT, no calendar match yet → tag as untagged-meeting
  else
    _new_cat := 'meeting_untagged'; _new_src := 'rule';
  end if;

  update beacon_v2.time_intervals
     set category = _new_cat, category_source = _new_src, computed_at = now()
   where id = _interval_id;
end;
$$;

--------------------------------------------------------------------------------
-- 7. fn_recompute_day — aggregate time_intervals into timesheet_days for one
--    (user, date) in business timezone. Auto-flags missing_out (currently-in
--    interval crossing midnight without a close) and overtime_min.
--------------------------------------------------------------------------------
create or replace function beacon_v2.fn_recompute_day(_user_id uuid, _date date)
returns void
language plpgsql
as $$
declare
  _tz           constant text := 'America/Chicago';
  _day_start    timestamptz := (_date::text || ' 00:00')::timestamp at time zone _tz;
  _day_end      timestamptz := _day_start + interval '1 day';
  _m_work       int := 0;
  _m_lunch      int := 0;
  _m_break      int := 0;
  _m_meeting    int := 0;
  _m_travel     int := 0;
  _m_untagged   int := 0;
  _m_off        int := 0;
  _first_in     timestamptz;
  _last_out     timestamptz;
  _has_open     boolean := false;
  _ot_min       int;
  _flags        jsonb := '{}'::jsonb;
begin
  -- Clamp each interval to the day window and accumulate per-category minutes.
  select
    coalesce(sum(case when iv.category = 'work'             then m else 0 end), 0),
    coalesce(sum(case when iv.category = 'lunch'            then m else 0 end), 0),
    coalesce(sum(case when iv.category = 'break'            then m else 0 end), 0),
    coalesce(sum(case when iv.category = 'meeting'          then m else 0 end), 0),
    coalesce(sum(case when iv.category = 'travel'           then m else 0 end), 0),
    coalesce(sum(case when iv.category = 'meeting_untagged' then m else 0 end), 0),
    coalesce(sum(case when iv.category in ('vacation','holiday','off') then m else 0 end), 0)
  into _m_work, _m_lunch, _m_break, _m_meeting, _m_travel, _m_untagged, _m_off
  from (
    select
      i.category,
      extract(epoch from (
        least(coalesce(i.end_at, now()), _day_end) -
        greatest(i.start_at, _day_start)
      ))::int / 60 as m
    from beacon_v2.time_intervals i
    where i.user_id = _user_id
      and i.start_at < _day_end
      and coalesce(i.end_at, now()) > _day_start
  ) iv
  where iv.m > 0;

  select min(start_at), max(end_at), bool_or(end_at is null)
    into _first_in, _last_out, _has_open
    from beacon_v2.time_intervals
   where user_id = _user_id
     and start_at < _day_end
     and coalesce(end_at, now()) > _day_start;

  _ot_min := greatest(_m_work + _m_meeting + _m_travel - 480, 0);  -- OT past 8h
  if _has_open and _date < (now() at time zone _tz)::date then
    _flags := _flags || jsonb_build_object('missing_out', true);
  end if;
  if _ot_min > 0 then
    _flags := _flags || jsonb_build_object('overtime_min', _ot_min);
  end if;
  if _m_untagged > 0 then
    _flags := _flags || jsonb_build_object('untagged_meeting', true);
  end if;

  insert into beacon_v2.timesheet_days (
    user_id, date,
    minutes_work, minutes_lunch, minutes_break, minutes_meeting,
    minutes_travel, minutes_untagged, minutes_off,
    first_in, last_out,
    approval_status, flags, updated_at
  ) values (
    _user_id, _date,
    _m_work, _m_lunch, _m_break, _m_meeting,
    _m_travel, _m_untagged, _m_off,
    _first_in, _last_out,
    'pending', _flags, now()
  )
  on conflict (user_id, date) do update set
    minutes_work     = excluded.minutes_work,
    minutes_lunch    = excluded.minutes_lunch,
    minutes_break    = excluded.minutes_break,
    minutes_meeting  = excluded.minutes_meeting,
    minutes_travel   = excluded.minutes_travel,
    minutes_untagged = excluded.minutes_untagged,
    minutes_off      = excluded.minutes_off,
    first_in         = excluded.first_in,
    last_out         = excluded.last_out,
    flags            = excluded.flags,
    updated_at       = now()
  where beacon_v2.timesheet_days.approval_status not in ('approved');
end;
$$;

--------------------------------------------------------------------------------
-- 8. fn_punch_reconcile — fires after each time_punches insert. Proper TOGGLE
--    semantics: if the user has an open interval, this punch closes it (they
--    were IN, now they're OUT); otherwise this punch opens a new interval
--    (they were OUT, now they're IN). Never both.
--
--    Append-only forward-direction semantics: only operates on the user's
--    currently-open interval and the just-inserted punch. Back-dated admin
--    edits flow through fn_rebuild_user_day (the timeclock-admin Edge Function
--    calls it after correction approvals).
--------------------------------------------------------------------------------
create or replace function beacon_v2.fn_punch_reconcile()
returns trigger
language plpgsql
as $$
declare
  _open_id uuid;
  _date    date;
begin
  select id into _open_id
    from beacon_v2.time_intervals
   where user_id = new.user_id and end_at is null
   order by start_at desc
   limit 1
   for update;

  if _open_id is not null then
    -- User was IN → this punch toggles them OUT. Close the open interval.
    -- DO NOT open a new one.
    update beacon_v2.time_intervals
       set end_at       = new.punched_at,
           end_punch_id = new.id,
           computed_at  = now()
     where id = _open_id;
    perform beacon_v2.fn_classify_interval(_open_id);
  else
    -- User was OUT → this punch toggles them IN. Open a new interval.
    insert into beacon_v2.time_intervals
      (user_id, start_at, start_punch_id, category, category_source)
    values
      (new.user_id, new.punched_at, new.id, 'work', 'auto');
  end if;

  _date := (new.punched_at at time zone 'America/Chicago')::date;
  perform beacon_v2.fn_recompute_day(new.user_id, _date);

  return new;
end;
$$;

drop trigger if exists trg_time_punches_reconcile on beacon_v2.time_punches;
create trigger trg_time_punches_reconcile
  after insert on beacon_v2.time_punches
  for each row execute function beacon_v2.fn_punch_reconcile();

--------------------------------------------------------------------------------
-- 9. fn_rebuild_user_day — full re-derivation for a (user, date) from punches,
--    preserving user/admin classification overrides by (start_at, end_at)
--    boundary match. Called by the timeclock-admin Edge Function after admin
--    back-dated edits / correction approvals.
--------------------------------------------------------------------------------
create or replace function beacon_v2.fn_rebuild_user_day(_user_id uuid, _date date)
returns void
language plpgsql
as $$
declare
  _tz         constant text := 'America/Chicago';
  _day_start  timestamptz := (_date::text || ' 00:00')::timestamp at time zone _tz;
  _day_end    timestamptz := _day_start + interval '1 day';
  _overrides  jsonb;
  _punches    record;
  _prev_punch beacon_v2.time_punches%rowtype;
  _new_id     uuid;
  _idx        int := 0;
begin
  -- Snapshot overrides keyed by (start_at, end_at) → {category, source, notes}
  select coalesce(
    jsonb_object_agg(
      to_char(start_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') ||
      coalesce('|' || to_char(end_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF'), '|open'),
      jsonb_build_object('category', category::text,
                         'source', category_source::text,
                         'notes', notes,
                         'outlook_event_id', outlook_event_id,
                         'outlook_event_subject', outlook_event_subject,
                         'outlook_event_location', outlook_event_location)
    ),
    '{}'::jsonb
  ) into _overrides
  from beacon_v2.time_intervals
  where user_id = _user_id
    and category_source in ('user','admin','outlook')
    and start_at < _day_end
    and coalesce(end_at, now()) > _day_start;

  -- Wipe existing intervals for this day
  delete from beacon_v2.time_intervals
   where user_id = _user_id
     and start_at >= _day_start
     and start_at <  _day_end;

  -- Pair punches: odd index (1st, 3rd, 5th, ...) = IN (start of an interval);
  -- even index (2nd, 4th, 6th, ...) = OUT (end of the previous interval).
  -- An odd total leaves a trailing IN as the user's currently-open interval.
  _prev_punch := null;
  for _punches in
    select * from beacon_v2.time_punches
     where user_id = _user_id
       and punched_at >= _day_start
       and punched_at <  _day_end
     order by punched_at asc
  loop
    _idx := _idx + 1;
    if _idx % 2 = 0 then
      -- OUT punch: pair with the previous IN to make a closed interval.
      insert into beacon_v2.time_intervals
        (user_id, start_at, end_at, start_punch_id, end_punch_id,
         category, category_source)
      values
        (_user_id, _prev_punch.punched_at, _punches.punched_at,
         _prev_punch.id, _punches.id, 'work', 'auto')
      returning id into _new_id;
      perform beacon_v2.fn_classify_interval(_new_id);
      _prev_punch := null;
    else
      -- IN punch: remember for pairing on the next iteration.
      _prev_punch := _punches;
    end if;
  end loop;

  -- Odd count → an unpaired IN punch. Open the trailing interval ONLY if it's
  -- the user's globally most-recent punch (no later punch crossed into the
  -- next day after a missing OUT). Cross-day "forgot to OUT" cases get flagged
  -- via timesheet_days.flags.missing_out and resolved through admin
  -- corrections.
  if _prev_punch.id is not null
     and not exists (
       select 1 from beacon_v2.time_punches
        where user_id = _user_id and punched_at > _prev_punch.punched_at
     )
  then
    insert into beacon_v2.time_intervals
      (user_id, start_at, start_punch_id, category, category_source)
    values
      (_user_id, _prev_punch.punched_at, _prev_punch.id, 'work', 'auto');
  end if;

  -- Re-apply overrides by exact (start_at, end_at) match
  if _overrides <> '{}'::jsonb then
    update beacon_v2.time_intervals iv
       set category               = (o.value->>'category')::beacon_v2.interval_category_enum,
           category_source        = (o.value->>'source')::beacon_v2.classification_source_enum,
           notes                  = o.value->>'notes',
           outlook_event_id       = o.value->>'outlook_event_id',
           outlook_event_subject  = o.value->>'outlook_event_subject',
           outlook_event_location = o.value->>'outlook_event_location',
           computed_at            = now()
      from jsonb_each(_overrides) o
     where iv.user_id = _user_id
       and (
         to_char(iv.start_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF') ||
         coalesce('|' || to_char(iv.end_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF'), '|open')
       ) = o.key;
  end if;

  perform beacon_v2.fn_recompute_day(_user_id, _date);
end;
$$;

--------------------------------------------------------------------------------
-- 10. fn_block_locked_writes — BEFORE-trigger that blocks non-admin writes to
--     time_punches in a date that falls inside an approved (locked) week.
--     Service-role calls (Edge Functions) bypass RLS entirely AND
--     is_current_user_admin() returns false for them (auth.uid() is null), so
--     we use a settings GUC to let admin Edge Functions explicitly override.
--
--     Override mechanism: a session-local GUC `beacon_v2.timekeeping_bypass_lock`
--     set to 'on' by the timeclock-admin function before privileged writes.
--------------------------------------------------------------------------------
create or replace function beacon_v2.fn_block_locked_writes()
returns trigger
language plpgsql
as $$
declare
  _date     date;
  _wk_start date;
  _locked   boolean;
  _bypass   text;
begin
  _date := (coalesce(new.punched_at, old.punched_at) at time zone 'America/Chicago')::date;
  _wk_start := date_trunc('week', _date)::date;  -- Monday in CT

  select locked into _locked from beacon_v2.timesheet_weeks
   where user_id = coalesce(new.user_id, old.user_id)
     and week_start = _wk_start;

  if not coalesce(_locked, false) then
    return coalesce(new, old);
  end if;

  -- Allow if caller is Admin via session JWT...
  if beacon_v2.is_current_user_admin() then
    return coalesce(new, old);
  end if;

  -- ...or explicit bypass (service-role call from timeclock-admin)
  begin
    _bypass := current_setting('beacon_v2.timekeeping_bypass_lock', true);
  exception when others then
    _bypass := null;
  end;
  if _bypass = 'on' then
    return coalesce(new, old);
  end if;

  raise exception 'timesheet week % is locked; submit a correction request',
    _wk_start using errcode = 'check_violation';
end;
$$;

drop trigger if exists trg_punches_lock_guard on beacon_v2.time_punches;
create trigger trg_punches_lock_guard
  before insert or update or delete on beacon_v2.time_punches
  for each row execute function beacon_v2.fn_block_locked_writes();

--------------------------------------------------------------------------------
-- 11. Expose helpers to PostgREST so the frontend can call them after
--     submit/approve actions.
--------------------------------------------------------------------------------
grant execute on function beacon_v2.fn_classify_interval(uuid)         to authenticated, service_role;
grant execute on function beacon_v2.fn_recompute_day(uuid, date)       to authenticated, service_role;
grant execute on function beacon_v2.fn_rebuild_user_day(uuid, date)    to authenticated, service_role;
