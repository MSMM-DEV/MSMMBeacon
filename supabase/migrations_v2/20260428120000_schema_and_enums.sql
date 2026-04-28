-- MSMM Beacon v2 — schema + enums + shared helpers
--
-- Target: a fresh `beacon_v2` schema living alongside the live `beacon`
-- schema. Apply by pasting this and the sibling files in order into Supabase
-- Studio's SQL Editor, then add `beacon_v2` to Settings → API → Exposed
-- schemas. All v2 files are idempotent (IF NOT EXISTS / DO blocks).
--
-- Why v2: the live schema has 5 parallel pipeline tables (potential_projects,
-- awaiting_verdict, awarded_projects, closed_out_projects, soq) sharing ~70%
-- of their columns plus 6 byte-identical *_pms join tables. v2 collapses the
-- pipeline into one `projects` table keyed on a `status` enum, drops SOQ,
-- renames hot_leads → leads, and collapses the alert subject enum to four
-- values (project, invoice, event, lead).

--------------------------------------------------------------------------------
-- 1. Schema + grants
--------------------------------------------------------------------------------
create schema if not exists beacon_v2;

grant usage on schema beacon_v2 to anon, authenticated, service_role;
grant all on all tables    in schema beacon_v2 to anon, authenticated, service_role;
grant all on all sequences in schema beacon_v2 to anon, authenticated, service_role;
grant all on all routines  in schema beacon_v2 to anon, authenticated, service_role;
alter default privileges in schema beacon_v2 grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema beacon_v2 grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema beacon_v2 grant all on routines  to anon, authenticated, service_role;

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 2. Extensions (no-op if already present from beacon)
--    Only pgcrypto is required (for gen_random_uuid()). v2 deliberately
--    avoids citext — Supabase installs extensions in different schemas
--    across projects, and resolving `citext` unqualified across separate
--    SQL Editor pastes is fragile. Email columns use plain text + a
--    lower(email) unique index instead.
--------------------------------------------------------------------------------
create extension if not exists pgcrypto;

--------------------------------------------------------------------------------
-- 3. Enums
--    Every enum lives in beacon_v2 so v2 can be dropped without touching v1.
--------------------------------------------------------------------------------
do $$ begin create type beacon_v2.org_type_enum         as enum ('City','State','Federal','Local','Parish','Regional','Other'); exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.probability_enum      as enum ('High','Medium','Low','Orange');                                exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.project_role_enum     as enum ('Prime','Sub');                                                  exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.project_status_enum   as enum ('potential','awaiting','awarded','closed_out');                  exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.invoice_type_enum     as enum ('ENG','PM');                                                     exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.event_status_enum     as enum ('Happened','Booked');                                            exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.event_type_enum       as enum ('Partner','AI','Project','Meetings','Event','Board Meetings');   exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.lead_status_enum      as enum ('Scheduled','Happened');                                         exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.recurrence_enum       as enum ('one_time','weekly','biweekly','monthly','custom');              exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.alert_subject_enum    as enum ('project','invoice','event','lead');                             exception when duplicate_object then null; end $$;

--------------------------------------------------------------------------------
-- 4. Shared updated_at helper
--------------------------------------------------------------------------------
create or replace function beacon_v2.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
