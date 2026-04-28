-- MSMM Beacon v2 — RLS + grants.
--
-- Mirrors the live beacon posture as of 20260424120000_admin_only_user_writes:
--   * Every table has RLS enabled.
--   * `authenticated` has full CRUD via "auth full access" — the app-level
--     baseline.
--   * `anon` has full CRUD on every table EXCEPT users (prototype-era; same
--     security note as in v1's 20260421120000_allow_anon_write.sql — drop
--     these policies before going public).
--   * `users` writes are restricted to Admins (via beacon_v2.is_current_user_admin()).
--   * `outlook_sync_state` writes flow only through service_role; reads are
--     open to authenticated + anon (matches the v1 outlook migration).
--
-- IMPORTANT post-step: after pasting this file, go to Supabase Studio →
-- Settings → API → Exposed schemas and add `beacon_v2`. PostgREST won't
-- serve the schema until then.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. is_current_user_admin helper (read auth.uid() → users.role).
--    SECURITY DEFINER so an authenticated caller can read users without RLS
--    blocking them.
--------------------------------------------------------------------------------
create or replace function beacon_v2.is_current_user_admin()
returns boolean
language sql
stable
security definer
set search_path = beacon_v2, public
as $$
  select exists (
    select 1
      from beacon_v2.users u
     where u.auth_user_id = auth.uid()
       and u.role = 'Admin'
  );
$$;

grant execute on function beacon_v2.is_current_user_admin() to authenticated, anon;

--------------------------------------------------------------------------------
-- 2. Enable RLS on every beacon_v2 table.
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'beacon_v2'
  loop
    execute format('alter table beacon_v2.%I enable row level security', t);
  end loop;
end $$;

--------------------------------------------------------------------------------
-- 3. Baseline "auth full access" + "anon read/write" on every table EXCEPT
--    users and outlook_sync_state, which get bespoke policies below.
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
     where schemaname = 'beacon_v2'
       and tablename not in ('users','outlook_sync_state')
  loop
    -- Drop any pre-existing policies of these names so re-runs don't fail.
    execute format('drop policy if exists "auth full access" on beacon_v2.%I', t);
    execute format('drop policy if exists "anon read"        on beacon_v2.%I', t);
    execute format('drop policy if exists "anon insert"      on beacon_v2.%I', t);
    execute format('drop policy if exists "anon update"      on beacon_v2.%I', t);
    execute format('drop policy if exists "anon delete"      on beacon_v2.%I', t);

    execute format(
      'create policy "auth full access" on beacon_v2.%I for all to authenticated using (true) with check (true)', t);
    execute format(
      'create policy "anon read"        on beacon_v2.%I for select to anon using (true)', t);
    execute format(
      'create policy "anon insert"      on beacon_v2.%I for insert to anon with check (true)', t);
    execute format(
      'create policy "anon update"      on beacon_v2.%I for update to anon using (true) with check (true)', t);
    execute format(
      'create policy "anon delete"      on beacon_v2.%I for delete to anon using (true)', t);

    execute format('grant select, insert, update, delete on beacon_v2.%I to anon', t);
    execute format('grant select, insert, update, delete on beacon_v2.%I to authenticated', t);
  end loop;
end $$;

--------------------------------------------------------------------------------
-- 4. users — Admin-only writes; SELECT open to authenticated + anon so PM /
--    attendee pickers work.
--------------------------------------------------------------------------------
drop policy if exists "auth full access"   on beacon_v2.users;
drop policy if exists "users select"       on beacon_v2.users;
drop policy if exists "users admin insert" on beacon_v2.users;
drop policy if exists "users admin update" on beacon_v2.users;
drop policy if exists "users admin delete" on beacon_v2.users;
drop policy if exists "anon read"          on beacon_v2.users;
drop policy if exists "anon insert"        on beacon_v2.users;
drop policy if exists "anon update"        on beacon_v2.users;
drop policy if exists "anon delete"        on beacon_v2.users;

create policy "users select" on beacon_v2.users
  for select to authenticated, anon
  using (true);

create policy "users admin insert" on beacon_v2.users
  for insert to authenticated
  with check (beacon_v2.is_current_user_admin());

create policy "users admin update" on beacon_v2.users
  for update to authenticated
  using      (beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user_admin());

create policy "users admin delete" on beacon_v2.users
  for delete to authenticated
  using (beacon_v2.is_current_user_admin());

grant select on beacon_v2.users to anon, authenticated;

--------------------------------------------------------------------------------
-- 5. outlook_sync_state — read-open, writes only via service_role (the
--    outlook-sync Edge Function bypasses RLS with its service-role key).
--------------------------------------------------------------------------------
drop policy if exists "auth read sync state"   on beacon_v2.outlook_sync_state;
drop policy if exists "anon read sync state"   on beacon_v2.outlook_sync_state;

create policy "auth read sync state" on beacon_v2.outlook_sync_state
  for select to authenticated using (true);
create policy "anon read sync state" on beacon_v2.outlook_sync_state
  for select to anon using (true);

grant select on beacon_v2.outlook_sync_state to anon, authenticated;

--------------------------------------------------------------------------------
-- 6. Sequences — awarded_stages.id is smallserial, so anon needs USAGE+SELECT
--    on its sequence to make INSERTs work.
--------------------------------------------------------------------------------
grant usage, select on all sequences in schema beacon_v2 to anon, authenticated;
alter default privileges in schema beacon_v2 grant usage, select on sequences to anon, authenticated;
