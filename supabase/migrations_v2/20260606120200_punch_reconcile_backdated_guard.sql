-- 20260606120200_punch_reconcile_backdated_guard.sql
--
-- Fixes: "new row for relation \"time_intervals\" violates check constraint
-- \"time_intervals_check\"" when an admin approves an add_interval (or any
-- back-dated add_punch) correction.
--
-- ROOT CAUSE
-- fn_punch_reconcile is an AFTER INSERT trigger on time_punches that assumes
-- punches arrive in REAL TIME (monotonically increasing). On each insert it
-- closes the currently-open interval by setting `end_at = new.punched_at` and
-- opens a fresh opposite-presence interval. That is only valid when the new
-- punch is the user's latest.
--
-- An add_interval correction inserts TWO *back-dated* boundary punches (the
-- start/end of a past sub-range); add_punch can insert one. When such a punch
-- predates the user's currently-open interval, the trigger tries to close that
-- interval at a timestamp BEFORE its start_at — producing end_at < start_at,
-- which trips the table CHECK `end_at is null or end_at >= start_at` (auto-named
-- time_intervals_check). The insert throws, applyCorrection re-raises, and
-- resolveCorrection surfaces it as "apply failed: ...".
--
-- FIX
-- One toggle is only meaningful for the latest punch. When the incoming punch
-- is NOT the user's most-recent (i.e. a back-dated correction insert), skip the
-- incremental toggle entirely and re-derive the whole affected day from punches
-- via fn_rebuild_user_day — which walks punches in time order and can never emit
-- end_at < start_at. timeclock-admin already calls fn_rebuild_user_day again
-- after the correction lands, so this is idempotent. For the real-time path the
-- new punch is the latest, so the open interval's start_at (itself an earlier
-- punch) is always <= new.punched_at and the constraint holds.
--
-- No Edge Function redeploy needed — the fix is entirely in this trigger
-- function. Idempotent (create or replace). Safe to re-paste. Everything in the
-- real-time branch is byte-identical to 20260605120000_timekeeping_out_intervals.sql.

create or replace function beacon_v2.fn_punch_reconcile()
returns trigger
language plpgsql
as $$
declare
  _open beacon_v2.time_intervals%rowtype;
  _date date;
begin
  _date := (new.punched_at at time zone 'America/Chicago')::date;

  -- Back-dated (out-of-order) punch guard. If any punch exists LATER than this
  -- one, the incremental close/open model below is invalid (it would close the
  -- open interval at a time before its start_at → time_intervals_check
  -- violation, or scramble presence). Re-derive the day from punches instead.
  if exists (
       select 1 from beacon_v2.time_punches
        where user_id = new.user_id
          and punched_at > new.punched_at
          and id <> new.id
     ) then
    perform beacon_v2.fn_rebuild_user_day(new.user_id, _date);
    return new;
  end if;

  -- Real-time path: this punch is the user's latest, so closing the open
  -- interval at new.punched_at is always >= its start_at.
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

  perform beacon_v2.fn_recompute_day(new.user_id, _date);

  return new;
end;
$$;

notify pgrst, 'reload schema';
