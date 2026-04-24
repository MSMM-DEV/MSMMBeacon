--------------------------------------------------------------------------------
-- Hot Leads: status (Scheduled | Happened) + row-level alerts.
--
-- Why two separate pieces in one migration:
--   * They ship together — the alerts pipeline needs the enum value AND the
--     status column so the email body can say "Status: Scheduled" the same
--     way it does for events ("Status: Booked").
--   * The deactivate-on-delete trigger for alerts depends on the enum value.
--
-- `hot_lead_status_enum` deliberately uses 'Scheduled' instead of the events
-- vocabulary ('Booked'). 'Booking' implies a confirmed calendar slot (the
-- event is on the books). Hot leads are conversations that may or may not
-- have a firm time yet — 'Scheduled' reads more naturally for the domain
-- even when the `date_time` field is blank.
--
-- Safe to re-run: every DDL uses IF NOT EXISTS / add-value-if-not-exists /
-- drop-then-recreate for the trigger.
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. Status enum + column
--------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                  where t.typname = 'hot_lead_status_enum' and n.nspname = 'beacon') then
    create type beacon.hot_lead_status_enum as enum ('Scheduled', 'Happened');
  end if;
end $$;

alter table beacon.hot_leads
  add column if not exists status beacon.hot_lead_status_enum not null default 'Scheduled';

--------------------------------------------------------------------------------
-- 2. Alert subject enum catch-up
--    Postgres won't let `add value` run inside the same transaction that
--    then uses the new value, so this must land in its own migration (or at
--    least before any statement below references 'hotlead'). The deactivate
--    trigger that references it runs in the same migration but in a later
--    statement, which is fine — by then the enum commit has taken.
--------------------------------------------------------------------------------
alter type beacon.alert_subject_enum add value if not exists 'hotlead';

--------------------------------------------------------------------------------
-- 3. Row-delete cleanup trigger.
--    Mirrors the pattern in 20260424120000_alerts_wiring.sql §5: when a
--    hot_leads row is deleted, deactivate every alert pointed at it so
--    future fires stop. alert_fires history is preserved (no cascade).
--------------------------------------------------------------------------------
drop trigger if exists deactivate_alerts on beacon.hot_leads;
create trigger deactivate_alerts before delete on beacon.hot_leads
  for each row execute function beacon._deactivate_alerts_trigger('hotlead');
