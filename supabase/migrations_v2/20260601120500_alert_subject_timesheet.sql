-- MSMM Beacon v2 — extend alert_subject_enum with 'timesheet' so the existing
-- alerts pipeline (alerts → alert_recipients → alert_fires → send-alert Edge
-- Function → Resend) can deliver "tag your meeting" reminders.
--
-- The classifier (timeclock-classify Edge Function) inserts a row into
-- beacon_v2.alerts with subject_table='timesheet' and
-- subject_row_id=<user_id> (we encode the date inside the message field
-- since alert_subject_enum's row_id column is a single uuid). The
-- send-alert Edge Function gains a new render branch (see
-- 20260601120100's plan §3.4) that builds the email + deep link
-- ?tab=timesheet&date=YYYY-MM-DD.
--
-- ALTER TYPE ... ADD VALUE is idempotent only after PG 14 via IF NOT EXISTS,
-- which Supabase runs. We additionally guard with a do$$ block so a re-run
-- on older PG doesn't blow up.

set search_path = beacon_v2, public, extensions;

do $$
begin
  if not exists (
    select 1 from pg_enum e
      join pg_type t on t.oid = e.enumtypid
     where t.typname = 'alert_subject_enum'
       and t.typnamespace = 'beacon_v2'::regnamespace
       and e.enumlabel = 'timesheet'
  ) then
    alter type beacon_v2.alert_subject_enum add value 'timesheet';
  end if;
end $$;
