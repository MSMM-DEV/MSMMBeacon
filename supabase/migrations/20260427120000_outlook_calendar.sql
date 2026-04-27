--------------------------------------------------------------------------------
-- Outlook calendar sync — adds provenance + external-attendee snapshot
-- columns to beacon.events, plus a singleton outlook_sync_state row that
-- holds the Microsoft Graph delta cursor and last-run telemetry.
--
-- Direction: one-way Outlook → Supabase. The mailbox `beacon@msmmeng.com`
-- is the canonical source; the outlook-sync Edge Function pulls deltas via
-- the Graph /calendarView/delta endpoint every 15 minutes (cron in
-- .github/workflows/outlook-sync-tick.yml). Synced fields (title, start/end
-- datetimes, internal attendees) are authoritative from Outlook.
-- Beacon-extras (`type`, `status`, `notes`) remain user-editable and sticky
-- across syncs — the Edge Function never touches them on UPDATE.
--
-- Idempotent. Safe to re-run.
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- 1. Provenance + Outlook-shaped fields on events.
--    `source` is a check-constrained text rather than a new enum so future
--    sources (e.g. 'google') are an additive value-list change, not a
--    schema-altering enum addition. NOT VALID skips the legacy backfill —
--    every existing row defaults to 'manual' and no constraint check fires
--    until the next mutation on that row.
--------------------------------------------------------------------------------
alter table beacon.events
  add column if not exists source                     text        not null default 'manual',
  add column if not exists outlook_event_id           text,
  add column if not exists outlook_ical_uid           text,
  add column if not exists outlook_etag               text,
  add column if not exists outlook_end_datetime       timestamptz,
  add column if not exists outlook_external_attendees jsonb       not null default '[]'::jsonb,
  add column if not exists outlook_organizer          jsonb,
  add column if not exists outlook_web_link           text,
  add column if not exists outlook_last_synced_at     timestamptz,
  add column if not exists outlook_is_cancelled       boolean     not null default false;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'events_source_chk'
       and conrelid = 'beacon.events'::regclass
  ) then
    alter table beacon.events
      add constraint events_source_chk
        check (source in ('manual','outlook')) not valid;
  end if;
end $$;

create unique index if not exists events_outlook_event_id_key
  on beacon.events(outlook_event_id)
  where outlook_event_id is not null;

create index if not exists events_source_idx
  on beacon.events(source);

--------------------------------------------------------------------------------
-- 2. Singleton sync-state row. id is forced to 1 by the check constraint so
--    `select * from beacon.outlook_sync_state where id = 1` is the canonical
--    read; no risk of accumulating stale rows.
--    delta_link is the URL Graph hands back at the end of a delta page-set;
--    the next tick GETs it directly to receive only changes since then.
--------------------------------------------------------------------------------
create table if not exists beacon.outlook_sync_state (
  id                 int primary key default 1,
  mailbox            text not null,
  delta_link         text,
  last_full_sync_at  timestamptz,
  last_run_at        timestamptz,
  last_run_summary   jsonb,
  constraint outlook_sync_state_singleton check (id = 1)
);

insert into beacon.outlook_sync_state(id, mailbox)
  values (1, 'beacon@msmmeng.com')
  on conflict (id) do nothing;

--------------------------------------------------------------------------------
-- 3. RLS — the sync-state row is read-open (matches every other beacon table)
--    but writes only flow through service_role (the outlook-sync Edge
--    Function). No insert/update/delete policies for authenticated or anon →
--    direct PostgREST mutation is blocked.
--------------------------------------------------------------------------------
alter table beacon.outlook_sync_state enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'beacon'
       and tablename  = 'outlook_sync_state'
       and policyname = 'auth read sync state'
  ) then
    create policy "auth read sync state" on beacon.outlook_sync_state
      for select to authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'beacon'
       and tablename  = 'outlook_sync_state'
       and policyname = 'anon read sync state'
  ) then
    create policy "anon read sync state" on beacon.outlook_sync_state
      for select to anon using (true);
  end if;
end $$;

grant select on beacon.outlook_sync_state to anon, authenticated;
