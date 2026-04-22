-- Adds per-user role metadata to beacon.users.
-- 'Admin' users can do anything; 'User' is the default. Roles are enforced in
-- the app layer today (DB RLS stays permissive-for-authenticated) and can be
-- tightened once specific admin-only tables/actions are defined.
--
-- The authoritative role lives on beacon.users.role. On login the frontend
-- fetches the current user's row and routes Admin-only UI based on it. The
-- separate seed_auth_users.py script also mirrors the role into the auth.users
-- raw_app_meta_data bag so JWTs carry it for future RLS policies.

alter table beacon.users
  add column if not exists role text
    check (role is null or role in ('Admin','User'))
    default 'User';

-- Anyone missing a role (legacy rows) gets 'User'.
update beacon.users
   set role = 'User'
 where role is null;

-- Make Raj an Admin. The match is case-insensitive since email is citext but
-- being explicit keeps this migration readable.
update beacon.users
   set role = 'Admin'
 where lower(email::text) = 'rmehta@msmmeng.com';
