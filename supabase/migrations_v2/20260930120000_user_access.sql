-- MSMM Beacon v2 — Per-user interface access (workflow → page → tab → sub-tab).
--
-- One row per user describing what that user can SEE in Beacon. The node keys
-- and every resolution rule live in ONE place on the frontend —
-- frontend/src/access.js (ACCESS_TREE) — so this table only stores the choice:
--
--   mode   'full'   → everything a User could see before this feature
--                     (identical to having no row at all)
--          'custom' → only the node keys listed in `grants`
--   grants text[]  → granted node keys, e.g. {workflow.engineering,
--                     page.proposals, tab.awaiting}
--   seen   text[]  → every node key that existed when the Admin saved. Nodes
--                     added to Beacon later are resolved against it (a user
--                     who had a WHOLE page/workflow picks up its new tabs; a
--                     hand-picked subset stays as picked). See access.js.
--
-- Backwards compatible by construction: NO ROW = FULL ACCESS, and this
-- migration inserts no rows, so every existing user keeps exactly what they
-- see today until an Admin restricts them from Admin → User Management.
-- Admins always see everything regardless of their row (enforced in the app).
-- Time & Leave is always visible to everyone (enforced in the app).
--
-- Security scope: this is INTERFACE access control — it decides which
-- workflows / pages / tabs appear. It does not change RLS on the underlying
-- data tables (still permissive-for-authenticated, per 20260428121000).
--
-- RLS on this table: a user may READ their own row (the app needs it at
-- login); Admins read and write every row. Anon gets nothing.
-- GOTCHA: re-applying 20260428121000_grants_rls.sql loops over every
-- beacon_v2 table and re-creates permissive policies — re-paste this file
-- afterwards to restore the strict ones (same as the timekeeping tables).
--
-- Idempotent — safe to re-paste. Ends with `notify pgrst`.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Table
--------------------------------------------------------------------------------
create table if not exists beacon_v2.user_access (
  user_id     uuid primary key references beacon_v2.users(id) on delete cascade,
  mode        text not null default 'full',
  grants      text[] not null default '{}'::text[],
  seen        text[] not null default '{}'::text[],
  updated_at  timestamptz not null default now(),
  updated_by  uuid references beacon_v2.users(id) on delete set null
);

do $$ begin
  alter table beacon_v2.user_access
    add constraint user_access_mode_chk check (mode in ('full', 'custom'));
exception when duplicate_object then null;
end $$;

drop trigger if exists user_access_touch_updated_at on beacon_v2.user_access;
create trigger user_access_touch_updated_at
  before update on beacon_v2.user_access
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- 2. Grants + RLS (strict: self-read, admin-write)
--------------------------------------------------------------------------------
alter table beacon_v2.user_access enable row level security;

revoke all on beacon_v2.user_access from anon;
grant select, insert, update, delete on beacon_v2.user_access to authenticated;

-- Drop any policy a blanket loop may have created, then (re)create ours.
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
     where schemaname = 'beacon_v2' and tablename = 'user_access'
  loop
    execute format('drop policy %I on beacon_v2.user_access', p.policyname);
  end loop;
end $$;

create policy user_access_select on beacon_v2.user_access
  for select to authenticated
  using (beacon_v2.is_current_user(user_id) or beacon_v2.is_current_user_admin());

create policy user_access_admin_insert on beacon_v2.user_access
  for insert to authenticated
  with check (beacon_v2.is_current_user_admin());

create policy user_access_admin_update on beacon_v2.user_access
  for update to authenticated
  using (beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user_admin());

create policy user_access_admin_delete on beacon_v2.user_access
  for delete to authenticated
  using (beacon_v2.is_current_user_admin());

notify pgrst, 'reload schema';
