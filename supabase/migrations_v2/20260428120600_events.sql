-- MSMM Beacon v2 — events + event_attendees + outlook_sync_state.
--
-- Outlook columns are inline at create time (no separate ALTER migration
-- like v1 had). `source` is a check-constrained text rather than an enum so
-- adding 'google' later is an additive value-list change, not an enum
-- migration.

set search_path = beacon_v2, public, extensions;

create table if not exists beacon_v2.events (
  id                          uuid primary key default gen_random_uuid(),
  event_date                  date,
  status                      beacon_v2.event_status_enum,
  type                        beacon_v2.event_type_enum,
  title                       text not null,
  event_datetime              timestamptz,
  notes                       text,

  -- Outlook provenance + snapshot (matches v1 20260427120000_outlook_calendar.sql).
  source                      text not null default 'manual'
                              check (source in ('manual','outlook')),
  outlook_event_id            text,
  outlook_ical_uid            text,
  outlook_etag                text,
  outlook_end_datetime        timestamptz,
  outlook_external_attendees  jsonb not null default '[]'::jsonb,
  outlook_organizer           jsonb,
  outlook_web_link            text,
  outlook_last_synced_at      timestamptz,
  outlook_is_cancelled        boolean not null default false,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Outlook upserts key on outlook_event_id; manual events have it NULL.
create unique index if not exists events_outlook_event_id_key
  on beacon_v2.events (outlook_event_id)
  where outlook_event_id is not null;

create index if not exists events_source_idx on beacon_v2.events (source);

drop trigger if exists touch_events on beacon_v2.events;
create trigger touch_events before update on beacon_v2.events
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- event_attendees — internal MSMM attendees only. External Outlook invitees
-- live snapshotted on events.outlook_external_attendees (jsonb).
--------------------------------------------------------------------------------
create table if not exists beacon_v2.event_attendees (
  event_id uuid not null references beacon_v2.events(id) on delete cascade,
  user_id  uuid not null references beacon_v2.users(id)  on delete cascade,
  primary key (event_id, user_id)
);
create index if not exists event_attendees_user_idx on beacon_v2.event_attendees (user_id);

--------------------------------------------------------------------------------
-- outlook_sync_state — singleton row holding the Microsoft Graph delta
-- cursor + last-run telemetry. id is forced to 1 by check constraint so
-- there's only ever one row to read/update.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.outlook_sync_state (
  id                 int primary key default 1,
  mailbox            text not null,
  delta_link         text,
  last_full_sync_at  timestamptz,
  last_run_at        timestamptz,
  last_run_summary   jsonb,
  constraint outlook_sync_state_singleton check (id = 1)
);

insert into beacon_v2.outlook_sync_state (id, mailbox)
  values (1, 'beacon@msmmeng.com')
  on conflict (id) do nothing;
