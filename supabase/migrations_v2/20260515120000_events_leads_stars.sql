-- ============================================================================
-- 20260515120000_events_leads_stars.sql
--   Stars rating (1-5, 5 = highest) on events + leads, mirroring the role
--   probability plays on projects. NULL = "Unrated". The frontend uses the
--   value for row-color stripes + primary-group sorting in the Events &
--   Other and Hot Leads tabs.
-- ============================================================================

alter table beacon_v2.events
  add column if not exists stars smallint;

alter table beacon_v2.events
  drop constraint if exists events_stars_range;
alter table beacon_v2.events
  add constraint events_stars_range
  check (stars is null or (stars between 1 and 5));

alter table beacon_v2.leads
  add column if not exists stars smallint;

alter table beacon_v2.leads
  drop constraint if exists leads_stars_range;
alter table beacon_v2.leads
  add constraint leads_stars_range
  check (stars is null or (stars between 1 and 5));
