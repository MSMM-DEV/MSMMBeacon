-- MSMM Beacon v2 — per-user Outlook calendar mirror + per-user delta cursors.
--
-- This is distinct from beacon_v2.events (that table is the shared MSMM
-- beacon@msmmeng.com calendar for BD events surfacing in the Events tab).
-- This one is the INTERNAL per-user mirror that drives the timekeeping
-- classifier: when a user taps OUT and an Outlook event overlaps the gap, the
-- timeclock-classify Edge Function tags the interval against the event.
--
-- The extended outlook-sync Edge Function iterates user_outlook_sync_state
-- rows (one per @msmmeng.com user with enabled=true) and pulls
-- /v1.0/users/{mailbox}/calendarView/delta into this table.
--
-- Privacy: event body is NEVER stored — only subject, location, times,
-- attendees, organizer. The `sensitivity` column carries Graph's flag
-- ('normal'|'private'|'confidential') so admin views can redact when the
-- value is non-normal.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. user_calendar_events — composite PK (user_id, outlook_event_id). One row
--    per Graph event per mailbox.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.user_calendar_events (
  user_id            uuid not null references beacon_v2.users(id) on delete cascade,
  outlook_event_id   text not null,
  ical_uid           text,
  subject            text,
  start_at           timestamptz not null,
  end_at             timestamptz not null,
  location           text,
  is_all_day         boolean not null default false,
  is_cancelled       boolean not null default false,
  sensitivity        text,                          -- 'normal'|'private'|'confidential'
  show_as            text,                          -- 'busy'|'tentative'|'oof'|'free'|'workingElsewhere'
  organizer          jsonb,                         -- {name, email}
  attendees          jsonb,                         -- [{name, email, response, type}]
  travel_buffer_min  int not null default 30,       -- editable per-event
  outlook_web_link   text,
  last_synced_at     timestamptz not null default now(),
  primary key (user_id, outlook_event_id)
);

create index if not exists user_cal_events_user_time_idx
  on beacon_v2.user_calendar_events (user_id, start_at, end_at);

-- Index used by the classifier to find candidate events around a punch time.
-- A range type would be more idiomatic, but a plain (start_at, end_at) pair
-- with the user_id leading column keeps Studio diffs simple.
create index if not exists user_cal_events_user_end_idx
  on beacon_v2.user_calendar_events (user_id, end_at);

--------------------------------------------------------------------------------
-- 2. user_outlook_sync_state — per-user delta cursor. Mirrors
--    beacon_v2.outlook_sync_state but keyed by user_id. The extended
--    outlook-sync Edge Function reads/writes this with the service-role key,
--    so RLS is read-open-to-admin only.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.user_outlook_sync_state (
  user_id           uuid primary key references beacon_v2.users(id) on delete cascade,
  mailbox           text not null,                  -- e.g. 'chris@msmmeng.com'
  delta_link        text,                           -- Graph delta token
  enabled           boolean not null default true,
  last_run_at       timestamptz,
  last_run_summary  jsonb                           -- {pages, upserts, deletes, ms, error?}
);

create index if not exists user_outlook_sync_state_enabled_idx
  on beacon_v2.user_outlook_sync_state (enabled, last_run_at);
