-- Category/presence policy for timekeeping intervals.
--
-- Stored category and stored presence are separate on purpose: meetings can be
-- either IN (at desk) or OUT (away). Some tags, however, imply one side:
--   work                                    -> IN / green
--   travel (UI label: Site visit), lunch,
--   break, eod, vacation, holiday, off,
--   meeting_untagged                       -> OUT / red
--
-- This migration fixes existing drift such as "Working" rows still marked OUT,
-- then keeps future direct writes in line with the same rule.

create or replace function beacon_v2.fn_time_interval_presence_policy()
returns trigger
language plpgsql
as $$
begin
  if new.category = 'work' then
    new.is_out := false;
  elsif new.category in ('travel','lunch','break','eod','vacation','holiday','off','meeting_untagged') then
    new.is_out := true;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_time_intervals_presence_policy on beacon_v2.time_intervals;
create trigger trg_time_intervals_presence_policy
before insert or update of category, is_out
on beacon_v2.time_intervals
for each row
execute function beacon_v2.fn_time_interval_presence_policy();

do $$
declare
  _row record;
begin
  for _row in
    with changed as (
      update beacon_v2.time_intervals
         set is_out = case
           when category = 'work' then false
           else true
         end,
         computed_at = now()
       where (category = 'work' and is_out)
          or (category in ('travel','lunch','break','eod','vacation','holiday','off','meeting_untagged') and not is_out)
      returning user_id, (start_at at time zone 'America/Chicago')::date as day_date
    )
    select distinct user_id, day_date from changed
  loop
    perform beacon_v2.fn_recompute_day(_row.user_id, _row.day_date);
  end loop;
end $$;

notify pgrst, 'reload schema';
