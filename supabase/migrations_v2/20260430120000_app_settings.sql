-- MSMM Beacon v2 — app_settings (workspace-wide knobs).
--
-- Singleton row that holds whole-workspace configuration values that need to
-- live in the database (not localStorage) because they steer derived UI for
-- everyone — i.e. they're not personal tweaks. The first knob is the
-- Quad Sheet's monthly invoice benchmark: each month bar on the executive
-- dashboard renders green when its total ≥ this value, red when below.
--
-- Singleton enforcement: a `singleton boolean PRIMARY KEY DEFAULT true` with
-- a CHECK that pins it true. Inserts past the first one fail on the PK
-- conflict, so callers always upsert by `singleton=true`.
--
-- RLS posture: read open to authenticated + anon (the value steers the chart
-- rendered for every signed-in user, and the anon fallback lets the
-- pre-login boot reach a sensible state). Writes are Admin-only — the
-- benchmark is a board-facing target and changing it is a privileged act.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Table
--------------------------------------------------------------------------------
create table if not exists beacon_v2.app_settings (
  singleton                  boolean primary key default true,
  monthly_invoice_benchmark  numeric(14, 2),  -- null = no benchmark set yet
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references beacon_v2.users(id) on delete set null,
  constraint app_settings_singleton_lock check (singleton = true)
);

-- Seed the lone row so the rest of the app can always select-by-pk.
insert into beacon_v2.app_settings (singleton)
values (true)
on conflict (singleton) do nothing;

--------------------------------------------------------------------------------
-- 2. RLS
--------------------------------------------------------------------------------
alter table beacon_v2.app_settings enable row level security;

drop policy if exists "auth full access"            on beacon_v2.app_settings;
drop policy if exists "anon read"                   on beacon_v2.app_settings;
drop policy if exists "anon insert"                 on beacon_v2.app_settings;
drop policy if exists "anon update"                 on beacon_v2.app_settings;
drop policy if exists "anon delete"                 on beacon_v2.app_settings;
drop policy if exists "app_settings select"         on beacon_v2.app_settings;
drop policy if exists "app_settings admin update"   on beacon_v2.app_settings;
drop policy if exists "app_settings admin insert"   on beacon_v2.app_settings;

create policy "app_settings select" on beacon_v2.app_settings
  for select to authenticated, anon
  using (true);

create policy "app_settings admin update" on beacon_v2.app_settings
  for update to authenticated
  using      (beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user_admin());

-- INSERT is rarely used (the seed row is created above), but the policy is
-- here so an Admin can re-seed if the table is wiped without falling back to
-- service_role. The CHECK constraint above caps the table at one row.
create policy "app_settings admin insert" on beacon_v2.app_settings
  for insert to authenticated
  with check (beacon_v2.is_current_user_admin());

grant select on beacon_v2.app_settings to anon, authenticated;
grant insert, update on beacon_v2.app_settings to authenticated;
