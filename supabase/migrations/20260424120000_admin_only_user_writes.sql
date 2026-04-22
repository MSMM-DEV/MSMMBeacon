-- Defense-in-depth for the admin panel.
--
-- UPDATE/DELETE on beacon.users now require the caller to be an Admin. SELECT
-- stays open to authenticated because the frontend needs the full roster for
-- PM pickers / attendee pickers / display lookups.
--
-- The admin-users Edge Function performs its privileged work with the service
-- role and bypasses RLS, so these policies don't affect it. They DO prevent a
-- compromised authenticated user from flipping their own role via direct
-- PostgREST calls.

-- Helper: is the current JWT's user an Admin in beacon.users?
create or replace function beacon.is_current_user_admin()
returns boolean
language sql
stable
security definer
set search_path = beacon, public
as $$
  select exists (
    select 1
      from beacon.users u
     where u.auth_user_id = auth.uid()
       and u.role = 'Admin'
  );
$$;

grant execute on function beacon.is_current_user_admin() to authenticated, anon;

-- Replace the blanket "auth full access" policy on beacon.users only. Other
-- beacon.* tables keep the permissive baseline the initial migration set up.
drop policy if exists "auth full access"       on beacon.users;
drop policy if exists "users select"           on beacon.users;
drop policy if exists "users admin update"     on beacon.users;
drop policy if exists "users admin delete"     on beacon.users;
drop policy if exists "users admin insert"     on beacon.users;

create policy "users select" on beacon.users
  for select to authenticated, anon
  using (true);

-- INSERTs happen only from the Edge Function (service role) or the
-- handle_new_auth_user trigger (security definer). Don't expose a client path.
create policy "users admin insert" on beacon.users
  for insert to authenticated
  with check (beacon.is_current_user_admin());

create policy "users admin update" on beacon.users
  for update to authenticated
  using      (beacon.is_current_user_admin())
  with check (beacon.is_current_user_admin());

create policy "users admin delete" on beacon.users
  for delete to authenticated
  using (beacon.is_current_user_admin());

-- Drop the prototype-era anon write policy on users specifically. The rest of
-- the `anon write` prototype policies on other tables stay until we flip the
-- whole app to authenticated-only (tracked in CLAUDE.md).
drop policy if exists "anon full access" on beacon.users;
drop policy if exists "anon write"       on beacon.users;
