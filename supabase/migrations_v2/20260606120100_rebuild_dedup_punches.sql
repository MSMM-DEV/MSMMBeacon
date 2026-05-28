-- 20260606120100_rebuild_dedup_punches.sql
--
-- Hardens fn_rebuild_user_day against DUPLICATE-INSTANT punches.
--
-- The day is rebuilt by walking punches in time order and TOGGLING presence on
-- each one (1st interval IN, 2nd OUT, 3rd IN, …). Presence is therefore a pure
-- function of cumulative punch parity. If two punches land on the EXACT same
-- timestamp — which can happen when overlapping corrections insert/edit punches
-- onto the same instant (e.g. an add_interval boundary colliding with an
-- edit_punch or a separate add_punch) — the pair produces a ZERO-LENGTH
-- interval that still consumes a parity slot, flipping the IN/OUT of every
-- interval after it. Symptom: an "away" block renders green (IN) and the
-- following block renders red/untagged (OUT).
--
-- Fix: one instant = one toggle. `select distinct on (punched_at)` collapses
-- same-timestamp punches to a single row before the walk, so a zero-length
-- interval can never be emitted and parity stays correct. Everything else in
-- the function is byte-identical to 20260605120000_timekeeping_out_intervals.sql.
--
-- Idempotent (create or replace). Safe to re-paste.

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
  -- DISTINCT ON (punched_at): collapse same-instant punches to one toggle, so
  -- a zero-length interval can never consume a parity slot and shift IN/OUT.
  _prev_punch := null;
  for _punches in
    select distinct on (punched_at) * from beacon_v2.time_punches
     where user_id = _user_id
       and punched_at >= _day_start
       and punched_at <  _day_end
     order by punched_at asc, id asc
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

notify pgrst, 'reload schema';
