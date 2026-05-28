-- MSMM Beacon v2 — Protect user_calendar_events from null-clobber on UPDATE.
--
-- Root cause discovered 2026-05-29: Microsoft Graph's /calendarView/delta
-- endpoint, when reporting changes to a cancelled occurrence of a recurring
-- meeting, sometimes returns a sparse event payload — `subject`, `location`,
-- and/or `attendees` come back as null even though the user-visible value in
-- Outlook still includes them (Outlook synthesizes "Canceled: <subject>" for
-- display from a cached title). The outlook-sync Edge Function then issued
-- an UPDATE with subject=null, irrecoverably wiping the stored title.
--
-- Defense in depth:
--   1. A BEFORE UPDATE trigger preserves the existing value whenever the
--      incoming UPDATE would null-out or empty-out a meaningful field.
--      This protects all writers — the outlook-sync Edge Function, the
--      timeclock-admin Edge Function, future tooling, and any direct SQL —
--      from the same class of bug.
--   2. A one-time data backfill scans for occurrences (rows sharing an
--      ical_uid) that lost their subject and copies it from a sibling
--      occurrence that still has the title.
--
-- Trade-off: a user can no longer legitimately "rename a meeting to have no
-- title" via UPDATE — the previously-stored title sticks. In practice that's
-- a non-existent workflow; deleting + re-creating is the path to clear.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Trigger function — preserves non-empty existing values when incoming
--    UPDATE would null/empty them.
--------------------------------------------------------------------------------
create or replace function beacon_v2.preserve_user_calendar_event_fields()
returns trigger
language plpgsql
as $$
begin
  if (new.subject is null or new.subject = '')
     and old.subject is not null
     and old.subject <> '' then
    new.subject := old.subject;
  end if;

  if (new.location is null or new.location = '')
     and old.location is not null
     and old.location <> '' then
    new.location := old.location;
  end if;

  if new.organizer is null
     and old.organizer is not null then
    new.organizer := old.organizer;
  end if;

  -- attendees is jsonb. Treat an empty array the same as null — both mean
  -- the incoming payload conveyed no attendees. Preserve when we previously
  -- had at least one.
  if (
       new.attendees is null
       or jsonb_typeof(new.attendees) <> 'array'
       or jsonb_array_length(new.attendees) = 0
     )
     and old.attendees is not null
     and jsonb_typeof(old.attendees) = 'array'
     and jsonb_array_length(old.attendees) > 0 then
    new.attendees := old.attendees;
  end if;

  return new;
end;
$$;

drop trigger if exists preserve_user_calendar_event_fields_trg
  on beacon_v2.user_calendar_events;

create trigger preserve_user_calendar_event_fields_trg
  before update on beacon_v2.user_calendar_events
  for each row
  execute function beacon_v2.preserve_user_calendar_event_fields();

--------------------------------------------------------------------------------
-- 2. One-time recovery — fill in null/empty subjects for any row that shares
--    an ical_uid with a sibling occurrence that still has the subject.
--    Recurring meetings in Microsoft Graph give every occurrence the same
--    ical_uid, so this is the natural sibling key.
--
--    Idempotent: re-running after the trigger is in place is a no-op (any
--    null row that had a sibling has already been recovered).
--------------------------------------------------------------------------------
with sibling_subjects as (
  select ical_uid, subject
  from beacon_v2.user_calendar_events
  where ical_uid is not null
    and ical_uid <> ''
    and subject is not null
    and subject <> ''
  -- DISTINCT ON: pick one sibling subject deterministically per ical_uid.
  -- If two occurrences disagree (rare — would mean the master was renamed
  -- mid-series), the most-recently-synced wins.
  order by ical_uid, last_synced_at desc nulls last
)
update beacon_v2.user_calendar_events u
set subject = s.subject
from (
  select distinct on (ical_uid) ical_uid, subject
  from beacon_v2.user_calendar_events
  where ical_uid is not null
    and ical_uid <> ''
    and subject is not null
    and subject <> ''
  order by ical_uid, last_synced_at desc nulls last
) s
where (u.subject is null or u.subject = '')
  and u.ical_uid is not null
  and u.ical_uid <> ''
  and u.ical_uid = s.ical_uid;

-- Nudge PostgREST so the trigger is in effect for any in-flight schema cache.
notify pgrst, 'reload schema';
