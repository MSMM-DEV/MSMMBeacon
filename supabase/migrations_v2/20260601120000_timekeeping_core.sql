-- MSMM Beacon v2 — timekeeping core: punches, NFC tags, devices.
--
-- The foundation layer of the timekeeping system. Raw punch events are the
-- IMMUTABLE source of truth; everything downstream (intervals, day rollups,
-- weekly approval, classifier-tagged Outlook events) derives from this table.
-- That separation matters because the classifier needs to be re-runnable and
-- human overrides need an audit trail.
--
-- Hardware shape: NFC fobs (personal, 1:1 per user) tapped on a shared Pi at
-- the office entrance, plus a web/mobile fallback in the Beacon UI. The
-- timeclock-punch Edge Function authenticates either a device bearer token
-- (Pi) or a session JWT (web/mobile), resolves the user (via nfc_tags.uid OR
-- auth.uid()), inserts a row here, and the fn_punch_reconcile trigger in
-- 20260601120100 handles interval bookkeeping.
--
-- De-dupe: the unique (user_id, punched_at, source_nfc_uid) index catches
-- double-taps that the Pi's 5-sec debounce didn't filter out (e.g. two
-- different Pi's see the same fob in quick succession). For non-NFC sources
-- the source_nfc_uid is null and the dedupe is handled application-side in
-- the Edge Function (lookup-by-time-window).

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Punch source enum
--------------------------------------------------------------------------------
do $$ begin create type beacon_v2.punch_source_enum as enum
  ('nfc','web','mobile','manual','imported');
exception when duplicate_object then null; end $$;

--------------------------------------------------------------------------------
-- 2. time_punches — raw, append-mostly event log.
--    All edits go through the timeclock-admin Edge Function (service-role
--    writes) so the lock-guard trigger in the next migration sees admin
--    intent via beacon_v2.is_current_user_admin().
--------------------------------------------------------------------------------
create table if not exists beacon_v2.time_punches (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references beacon_v2.users(id) on delete restrict,
  punched_at         timestamptz not null,
  source             beacon_v2.punch_source_enum not null,
  source_device_id   text,                -- e.g. 'pi-front-door' (FK soft to time_devices)
  source_nfc_uid     text,                -- raw fob UID (audit only; binding lives in nfc_tags)
  client_ip          inet,
  user_agent         text,
  geo_lat            numeric(9,6),
  geo_lng            numeric(9,6),
  geo_accuracy_m     numeric(8,2),
  note               text,
  created_at         timestamptz not null default now(),
  created_by         uuid references beacon_v2.users(id) on delete set null
);

create index if not exists time_punches_user_time_idx
  on beacon_v2.time_punches (user_id, punched_at desc);

create index if not exists time_punches_device_time_idx
  on beacon_v2.time_punches (source_device_id, punched_at desc)
  where source_device_id is not null;

-- Backstop dedupe: identical (user, exact-instant, uid) trios collapse to
-- one row. The real time-window dedupe (30 sec) lives in the timeclock-punch
-- Edge Function — we can't second-truncate the timestamp here because
-- timestamptz date_trunc isn't IMMUTABLE (its tz is session-dependent), and
-- non-IMMUTABLE functions aren't allowed in index expressions.
create unique index if not exists time_punches_dedupe_idx
  on beacon_v2.time_punches (user_id, punched_at, source_nfc_uid)
  where source_nfc_uid is not null;

--------------------------------------------------------------------------------
-- 3. nfc_tags — fob ↔ user binding. Retiring a tag keeps the row for audit.
--    last_seen_* updated by the timeclock-punch Edge Function on each tap.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.nfc_tags (
  uid               text primary key,                    -- raw UID from PN532
  user_id           uuid not null references beacon_v2.users(id) on delete restrict,
  label             text,                                -- e.g. "Chris's blue fob"
  active            boolean not null default true,
  enrolled_at       timestamptz not null default now(),
  enrolled_by       uuid references beacon_v2.users(id) on delete set null,
  retired_at        timestamptz,
  last_seen_at      timestamptz,
  last_seen_device  text
);

-- One active tag per user. Replacing a fob: retire the old (active=false,
-- retired_at=now()) then insert the new — the partial unique below permits
-- multiple historic inactive rows.
create unique index if not exists nfc_tags_user_active_unique
  on beacon_v2.nfc_tags (user_id) where active;

create index if not exists nfc_tags_user_idx
  on beacon_v2.nfc_tags (user_id);

--------------------------------------------------------------------------------
-- 4. time_devices — registered Pi (or future kiosk) endpoints. Bearer tokens
--    don't live here (they're Edge Function secrets) — this is just a label /
--    audit layer so we can see which Pi a punch came from.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.time_devices (
  id              text primary key,                      -- 'pi-front-door'
  label           text,
  location        text,
  active          boolean not null default true,
  last_seen_at    timestamptz,
  registered_at   timestamptz not null default now(),
  registered_by   uuid references beacon_v2.users(id) on delete set null
);

--------------------------------------------------------------------------------
-- 5. nfc_enroll_sessions — ephemeral capture state for the admin enrollment
--    UX (Plan §9). When an admin clicks "Capture next tap" in the NFC panel,
--    a row lands here keyed by (admin_user_id). On the next unenrolled UID
--    seen by any Pi, the timeclock-punch Edge Function writes the UID onto
--    the matching row. The frontend polls or Realtime-subscribes to surface
--    the captured UID for confirm-and-bind.
--
--    TTL: 90 sec. The frontend ticks "Cancel capture" on close; a small
--    cleanup pass in the timeclock-classify cron prunes expired rows.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.nfc_enroll_sessions (
  admin_user_id     uuid primary key references beacon_v2.users(id) on delete cascade,
  target_user_id    uuid not null references beacon_v2.users(id) on delete cascade,
  captured_uid      text,
  captured_at       timestamptz,
  started_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '90 seconds'
);

create index if not exists nfc_enroll_sessions_active_idx
  on beacon_v2.nfc_enroll_sessions (expires_at)
  where captured_uid is null;
