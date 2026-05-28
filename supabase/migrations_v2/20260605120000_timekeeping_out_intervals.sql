-- MSMM Beacon v2 — Punched-OUT periods become first-class intervals.
--
-- Problem this fixes: the timekeeping engine only ever stored AT-DESK (IN)
-- sessions as time_intervals rows. A punch-OUT closed the open interval and
-- opened NOTHING — the away period (e.g. 10:00–12:00) was not a row at all,
-- only a computed red overlay on the timeline. So the punch-out "tag your
-- session" prompt had no away-interval to write to and fell back to
-- overwriting the *preceding IN session*, turning a green "Working" block into
-- the punch-out tag.
--
-- New model (MSMM's actual office semantics): punch DIRECTION is the single
-- source of truth.
--   • IN  (at desk / in office)  → is_out=false → counts as worked time, green.
--   • OUT (physically out)       → is_out=true  → NEVER counts as worked time,
--                                                  red, regardless of category.
-- The category on an OUT interval is purely a LABEL ("where is this person")
-- shown on the personal + Team timelines. Every punch now TOGGLES: a punch-out
-- closes the open IN interval and opens an OUT interval; a punch-in does the
-- reverse. The prompt always tags the newly-opened interval.
--
-- Side effect / latent-bug fix: fn_classify_interval previously applied the
-- time-of-day rules (lunch / eod / meeting_untagged) to the just-closed
-- at-desk interval, so any IN session that started before 16:00 CT was being
-- mislabeled 'meeting_untagged'. The rules now apply ONLY to OUT intervals,
-- which is what they were always written for.
--
-- Business timezone stays hardcoded 'America/Chicago' (see the original
-- 20260601120100 header for the rationale). Idempotent; safe to re-paste.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. is_out column. Existing rows default to false (IN) — correct, since only
--    at-desk sessions were ever persisted before this migration.
--------------------------------------------------------------------------------
alter table beacon_v2.time_intervals
  add column if not exists is_out boolean not null default false;

--------------------------------------------------------------------------------
-- 2. fn_classify_interval — rule-based synchronous classifier, now scoped to
--    OUT intervals only. IN intervals are always 'work'. Open OUT intervals
--    ("currently out") are left untouched until they close.
--
--    Rule precedence for OUT intervals (only when category_source IN ('auto','rule')):
--      A. duration <= 5 min                        → 'break'
--      B. start in lunch window AND 20–90 min       → 'lunch'  (else meeting_untagged)
--      C. start_hour >= 16 (CT)                    → 'eod'    (went home)
--      D. start_hour < 16 (CT)                     → 'meeting_untagged'
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

  -- IN (at-desk) intervals are always 'work'. The time-of-day rules only make
  -- sense for OUT (away) periods — they explain WHY the person is out.
  if not _iv.is_out then
    if _iv.category <> 'work' or _iv.category_source <> 'auto' then
      update beacon_v2.time_intervals
         set category = 'work', category_source = 'auto', computed_at = now()
       where id = _interval_id;
    end if;
    return;
  end if;

  -- Open OUT interval = "currently out" — leave its label until it closes.
  if _iv.end_at is null then
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

  -- C. EOD window (16:00+ CT) — treat as "went home"
  elsif _start_hour >= 16 then
    _new_cat := 'eod'; _new_src := 'rule';

  -- D. before 16:00 CT, no calendar match yet → untagged-meeting
  else
    _new_cat := 'meeting_untagged'; _new_src := 'rule';
  end if;

  update beacon_v2.time_intervals
     set category = _new_cat, category_source = _new_src, computed_at = now()
   where id = _interval_id;
end;
$$;

--------------------------------------------------------------------------------
-- 3. fn_recompute_day — worked minutes now come from IN intervals ONLY. OUT
--    intervals feed the per-category informational buckets (so the hero panel
--    can still show "out for meetings 1h30" etc.) but never the worked total
--    or overtime. missing_out fires only for an open IN interval crossing
--    midnight (an open OUT interval overnight = went home, normal).
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
  _has_open_in  boolean := false;
  _ot_min       int;
  _flags        jsonb := '{}'::jsonb;
begin
  -- Clamp each interval to the day window and accumulate per-category minutes.
  -- Worked time = ALL IN minutes (is_out=false); the OUT buckets are split by
  -- category and stay informational.
  select
    coalesce(sum(case when not iv.is_out                                       then m else 0 end), 0),
    coalesce(sum(case when iv.is_out and iv.category = 'lunch'                 then m else 0 end), 0),
    coalesce(sum(case when iv.is_out and iv.category = 'break'                 then m else 0 end), 0),
    coalesce(sum(case when iv.is_out and iv.category = 'meeting'               then m else 0 end), 0),
    coalesce(sum(case when iv.is_out and iv.category = 'travel'                then m else 0 end), 0),
    coalesce(sum(case when iv.is_out and iv.category = 'meeting_untagged'      then m else 0 end), 0),
    coalesce(sum(case when iv.is_out and iv.category in ('vacation','holiday','off','eod') then m else 0 end), 0)
  into _m_work, _m_lunch, _m_break, _m_meeting, _m_travel, _m_untagged, _m_off
  from (
    select
      i.is_out,
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

  select min(start_at), max(end_at), bool_or(end_at is null and not is_out)
    into _first_in, _last_out, _has_open_in
    from beacon_v2.time_intervals
   where user_id = _user_id
     and start_at < _day_end
     and coalesce(end_at, now()) > _day_start;

  _ot_min := greatest(_m_work - 480, 0);  -- OT past 8h of IN (worked) time
  if _has_open_in and _date < (now() at time zone _tz)::date then
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
-- 4. fn_punch_reconcile — fires after each time_punches insert. TOGGLE in BOTH
--    directions now: each punch closes the open interval (if any) AND opens a
--    fresh one of the opposite presence.
--      • open interval exists  → close it; open a new interval with the
--        opposite is_out (IN→OUT or OUT→IN).
--      • no open interval      → the user is arriving; open an IN interval.
--    So after a punch-out the user has an OPEN OUT interval ("currently out");
--    after a punch-in, an open IN interval. The one-open-per-user partial
--    unique index still holds (the close commits before the insert).
--------------------------------------------------------------------------------
create or replace function beacon_v2.fn_punch_reconcile()
returns trigger
language plpgsql
as $$
declare
  _open beacon_v2.time_intervals%rowtype;
  _date date;
begin
  select * into _open
    from beacon_v2.time_intervals
   where user_id = new.user_id and end_at is null
   order by start_at desc
   limit 1
   for update;

  if found then
    -- Close the open interval (they were IN → now OUT, or OUT → now IN).
    update beacon_v2.time_intervals
       set end_at       = new.punched_at,
           end_punch_id = new.id,
           computed_at  = now()
     where id = _open.id;
    perform beacon_v2.fn_classify_interval(_open.id);

    -- Open the opposite-presence interval starting at this punch.
    insert into beacon_v2.time_intervals
      (user_id, start_at, start_punch_id, is_out, category, category_source)
    values
      (new.user_id, new.punched_at, new.id, not _open.is_out,
       (case when _open.is_out then 'work' else 'meeting_untagged' end)::beacon_v2.interval_category_enum,
       'auto');
  else
    -- No open interval → the user is arriving. Open an IN interval.
    insert into beacon_v2.time_intervals
      (user_id, start_at, start_punch_id, is_out, category, category_source)
    values
      (new.user_id, new.punched_at, new.id, false, 'work', 'auto');
  end if;

  _date := (new.punched_at at time zone 'America/Chicago')::date;
  perform beacon_v2.fn_recompute_day(new.user_id, _date);

  return new;
end;
$$;

-- (trigger trg_time_punches_reconcile already bound in 20260601120100; the
--  CREATE OR REPLACE above swaps the body in place.)

--------------------------------------------------------------------------------
-- 5. fn_rebuild_user_day — full re-derivation from punches. Now builds a
--    CONTIGUOUS chain of intervals (one per consecutive punch pair) with
--    alternating presence starting IN, so OUT periods are recreated as
--    first-class rows exactly like the live reconcile path. User/admin/outlook
--    overrides are preserved by (start_at, end_at) boundary match; is_out is
--    re-derived from punch order.
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
  _iv_idx     int := 0;          -- interval ordinal (1-based); even = OUT
  _is_out     boolean;
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

  -- Walk punches in order, emitting a closed interval for every consecutive
  -- pair. Interval ordinal alternates presence: 1st=IN, 2nd=OUT, 3rd=IN, ...
  _prev_punch := null;
  for _punches in
    select * from beacon_v2.time_punches
     where user_id = _user_id
       and punched_at >= _day_start
       and punched_at <  _day_end
     order by punched_at asc
  loop
    if _prev_punch.id is not null then
      _iv_idx := _iv_idx + 1;
      _is_out := (_iv_idx % 2 = 0);
      insert into beacon_v2.time_intervals
        (user_id, start_at, end_at, start_punch_id, end_punch_id,
         is_out, category, category_source)
      values
        (_user_id, _prev_punch.punched_at, _punches.punched_at,
         _prev_punch.id, _punches.id, _is_out,
         (case when _is_out then 'meeting_untagged' else 'work' end)::beacon_v2.interval_category_enum, 'auto')
      returning id into _new_id;
      perform beacon_v2.fn_classify_interval(_new_id);
    end if;
    _prev_punch := _punches;
  end loop;

  -- Trailing unpaired punch → currently-open interval. Open it ONLY if it's the
  -- user's globally most-recent punch (otherwise a cross-day "forgot to OUT" is
  -- handled via timesheet_days.flags.missing_out + admin correction).
  if _prev_punch.id is not null
     and not exists (
       select 1 from beacon_v2.time_punches
        where user_id = _user_id and punched_at > _prev_punch.punched_at
     )
  then
    _iv_idx := _iv_idx + 1;
    _is_out := (_iv_idx % 2 = 0);
    insert into beacon_v2.time_intervals
      (user_id, start_at, start_punch_id, is_out, category, category_source)
    values
      (_user_id, _prev_punch.punched_at, _prev_punch.id, _is_out,
       (case when _is_out then 'meeting_untagged' else 'work' end)::beacon_v2.interval_category_enum, 'auto');
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
-- 6. Reload PostgREST so the new column is queryable immediately.
--------------------------------------------------------------------------------
notify pgrst, 'reload schema';
