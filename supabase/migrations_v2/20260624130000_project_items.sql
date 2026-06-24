-- ============================================================================
-- 20260624130000_project_items.sql
--   Projects — a tree-structured work-breakdown feature, distinct from the
--   pipeline `beacon_v2.projects` table (the opportunity pipeline). A
--   `project_items` row is a NODE in a tree: a Project (root), a Phase, a
--   Subphase, or any deeper level. Self-referencing via `parent_id`
--   (a root has parent_id = NULL).
--
--   IDENTITY MODEL (revised — scoped local IDs):
--     * Each row has an internal surrogate `id uuid` PRIMARY KEY. Children
--       reference the PARENT'S uuid via `parent_id`.
--     * `local_id text` is the human-entered ID shown in the UI and is unique
--       only WITHIN its scope:
--         - ROOT projects: `local_id` is unique across the whole system
--           (e.g. `202311`)  — enforced by a partial unique index where
--           parent_id IS NULL.
--         - PHASES / SUBPHASES: `local_id` is unique only among siblings
--           (same parent) — e.g. project `202311` may have phases `1`,`2`,`0`,
--           `1.1`; a DIFFERENT project may reuse `1`,`2`,… — enforced by a
--           unique index on (parent_id, local_id).
--       local_id is free-form text so any numeric format works (`1`, `2`,
--       `2.1`, `2.1.1`). Because the PK is the surrogate uuid, local_id is
--       freely RENAMEABLE without breaking child links.
--
--   Reuses the directory (clients / companies), exactly like the pipeline
--   `projects` table: a single Client/Prime picker routes to client_id OR
--   prime_company_id; subs are 0..N companies via project_item_subs. The
--   single Manager is manager_user_id on the row; Additional PMs ride the
--   project_item_pms join.
--
--   item_type ∈ (main | standard). Main = parent-level container; time &
--   expenses cannot be logged against it. Standard = active work item; time &
--   expenses CAN be logged against it. (No time/expense entry feature exists
--   yet — this stores + enforces the rule as a property only.)
--
--   Cost / billing columns (total_labor_cost, total_expense_cost, the three
--   billed components + the total) are carried from the accounting export so
--   the Excel importer (scripts/import_projects_xlsx.py) can preserve them.
--
--   Contract roll-up rule (TOP-DOWN, enforced by fn_project_item_validate):
--     * sum of a parent's DIRECT children's contract_amount ≤ the parent's
--       contract_amount (NULL parent amount = no cap);
--     * a node's contract_amount ≥ the sum already allocated to its children;
--     * a node can't become its own ancestor (cycle guard).
--
-- RLS: permissive-for-authenticated (open_bids posture); no anon.
--
-- This file SUPERSEDES the first cut of project_items (which used a text PK).
-- It drops + recreates the three tables + enums up front, so re-pasting it
-- cleanly rebuilds the structure. SAFE because project_items is brand-new /
-- unreleased — no production data lives here yet. Idempotent / re-runnable.
-- ============================================================================

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 0. Drop the prior cut (text-PK model) so this re-applies cleanly.
--------------------------------------------------------------------------------
drop table if exists beacon_v2.project_item_pms  cascade;
drop table if exists beacon_v2.project_item_subs cascade;
drop table if exists beacon_v2.project_items     cascade;

--------------------------------------------------------------------------------
-- 1. Enums (recreated; guarded for first-run idempotency).
--------------------------------------------------------------------------------
do $$ begin
  create type beacon_v2.project_item_type_enum   as enum ('main','standard');
exception when duplicate_object then null; end $$;

do $$ begin
  create type beacon_v2.project_item_status_enum as enum ('active','between','closed_out');
exception when duplicate_object then null; end $$;

-- Contract structure. Values are stable machine keys; the UI carries the
-- human labels (see CONTRACT_TYPE_OPTIONS in frontend/src/data.js). The Excel
-- importer maps Fixed→fixed, Hourly→hourly, HNTE→hourly_nte, Overhead→overhead.
do $$ begin
  create type beacon_v2.project_item_contract_type_enum as enum (
    'hourly',                 -- Hourly
    'fixed',                  -- Fixed
    'hourly_nte',             -- Hourly Not to Exceed (HNTE)
    'overhead',               -- Overhead
    'percentage',             -- Percentage
    'recurring',              -- Recurring
    'cost_plus_percentage',   -- Cost + Percentage
    'cost_plus_recurring',    -- Cost + Recurring
    'recurring_plus_hourly'   -- Recurring + Hourly
  );
exception when duplicate_object then null; end $$;

--------------------------------------------------------------------------------
-- 2. Table — project_items (the tree node)
--------------------------------------------------------------------------------
create table if not exists beacon_v2.project_items (
  id                uuid primary key default gen_random_uuid(),
  parent_id         uuid references beacon_v2.project_items(id) on delete cascade,
  local_id          text not null,        -- scoped ID: unique among siblings
  name              text not null,

  -- Client / Prime — exactly one of these is set (mirrors projects.prime_*):
  -- a clients row OR a companies row, chosen from one merged picker.
  client_id         uuid references beacon_v2.clients(id)   on delete set null,
  prime_company_id  uuid references beacon_v2.companies(id) on delete set null,

  item_type         beacon_v2.project_item_type_enum   not null default 'standard',

  -- Address
  address_line1     text,
  address_line2     text,
  city              text,
  state             text,
  pin_code          text,

  contract_type     beacon_v2.project_item_contract_type_enum,
  contract_amount   numeric(14,2),

  -- Accounting figures carried from the import (informational).
  total_labor_cost     numeric(14,2),
  total_expense_cost   numeric(14,2),
  billed_services      numeric(14,2),   -- [A] TotalBilled(Services) Paid
  billed_expenses      numeric(14,2),   -- [B] TotalBilled(Expenses) Paid
  billed_taxes         numeric(14,2),   -- [C] TotalBilled(Taxes) Paid
  total_billed_paid    numeric(14,2),   -- [A+B+C] Total Billed / Paid

  start_date        date,
  due_date          date,
  percent_complete  numeric(5,2) default 0,

  manager_user_id   uuid references beacon_v2.users(id) on delete set null,

  status            beacon_v2.project_item_status_enum not null default 'active',
  notes             text,
  sort_ord          int,

  created_by        uuid references beacon_v2.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Scoped local_id uniqueness:
--   roots (parent_id IS NULL) — local_id unique system-wide;
--   non-roots — local_id unique among siblings (same parent_id).
-- (A plain UNIQUE(parent_id, local_id) would NOT constrain roots, since SQL
--  treats NULLs as distinct — hence the two partial indexes.)
create unique index if not exists project_items_root_local_uniq
  on beacon_v2.project_items (local_id) where parent_id is null;
create unique index if not exists project_items_sibling_local_uniq
  on beacon_v2.project_items (parent_id, local_id) where parent_id is not null;

-- Client/Prime is at most one of the two pools (mirrors projects_prime_at_most_one).
do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'project_items_client_prime_at_most_one'
                    and conrelid = 'beacon_v2.project_items'::regclass) then
    alter table beacon_v2.project_items
      add constraint project_items_client_prime_at_most_one
      check (client_id is null or prime_company_id is null);
  end if;
end $$;

-- Percent complete in [0,100].
do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'project_items_percent_range'
                    and conrelid = 'beacon_v2.project_items'::regclass) then
    alter table beacon_v2.project_items
      add constraint project_items_percent_range
      check (percent_complete is null or (percent_complete >= 0 and percent_complete <= 100));
  end if;
end $$;

-- A node can't be its own direct parent (the trigger catches deeper cycles).
do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'project_items_no_self_parent'
                    and conrelid = 'beacon_v2.project_items'::regclass) then
    alter table beacon_v2.project_items
      add constraint project_items_no_self_parent
      check (parent_id is distinct from id);
  end if;
end $$;

create index if not exists project_items_parent_idx  on beacon_v2.project_items(parent_id);
create index if not exists project_items_manager_idx on beacon_v2.project_items(manager_user_id);
create index if not exists project_items_status_idx  on beacon_v2.project_items(status);
create index if not exists project_items_client_idx  on beacon_v2.project_items(client_id);

--------------------------------------------------------------------------------
-- 3. Join tables — subs (companies) + additional PMs (users).
--    item_id → project_items.id (uuid). Cascade-delete with the parent node.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.project_item_subs (
  item_id      uuid not null references beacon_v2.project_items(id) on delete cascade,
  company_id   uuid not null references beacon_v2.companies(id)     on delete cascade,
  discipline   text,
  amount       numeric(14,2),
  ord          int,
  primary key (item_id, company_id)
);
create index if not exists project_item_subs_company_idx on beacon_v2.project_item_subs(company_id);

create table if not exists beacon_v2.project_item_pms (
  item_id      uuid not null references beacon_v2.project_items(id) on delete cascade,
  user_id      uuid not null references beacon_v2.users(id)         on delete cascade,
  primary key (item_id, user_id)
);
create index if not exists project_item_pms_user_idx on beacon_v2.project_item_pms(user_id);

--------------------------------------------------------------------------------
-- 4. updated_at trigger (reuse the shared helper from 20260428120000)
--------------------------------------------------------------------------------
drop trigger if exists project_items_set_updated_at on beacon_v2.project_items;
create trigger project_items_set_updated_at
before update on beacon_v2.project_items
for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- 5. Contract roll-up + cycle validation trigger
--    Fires BEFORE INSERT/UPDATE. Raises 23514 (check_violation) so the
--    frontend can surface a friendly message. The frontend ALSO validates
--    client-side for instant feedback; this is the authoritative backstop.
--    (local_id uniqueness is enforced by the indexes above, not here.)
--------------------------------------------------------------------------------
create or replace function beacon_v2.fn_project_item_validate()
returns trigger language plpgsql as $$
declare
  v_parent_amt   numeric(14,2);
  v_sibling_sum  numeric(14,2);
  v_child_sum    numeric(14,2);
  v_cursor       uuid;
  v_guard        int := 0;
  v_eps          numeric := 0.005;  -- penny tolerance for fp money math
begin
  -- Guarantee the surrogate id is present so the cycle guard + sibling-sum
  -- self-exclusion below key on a real uuid on INSERT (where a client-omitted
  -- id would otherwise be NULL until the column DEFAULT fires) and UPDATE alike.
  if new.id is null then new.id := gen_random_uuid(); end if;

  -- (a) Cycle guard (UPDATE/re-parent): walking up from parent_id must never
  --     reach this node. (On INSERT the node has no descendants yet, so a
  --     cycle is impossible; the no_self_parent CHECK covers the direct case.)
  if new.parent_id is not null then
    v_cursor := new.parent_id;
    while v_cursor is not null loop
      v_guard := v_guard + 1;
      if v_guard > 5000 then
        raise exception 'project hierarchy too deep or cyclic at %', new.local_id
          using errcode = '23514';
      end if;
      if v_cursor = new.id then
        raise exception 'circular parent reference: % cannot be a descendant of itself', new.local_id
          using errcode = '23514';
      end if;
      select parent_id into v_cursor from beacon_v2.project_items where id = v_cursor;
    end loop;
  end if;

  -- (b) Top-down cap: siblings (incl. this row) must fit inside the parent's
  --     contract amount. Skipped when the parent has no amount (= no cap).
  if new.parent_id is not null and new.contract_amount is not null then
    select contract_amount into v_parent_amt
      from beacon_v2.project_items where id = new.parent_id;
    if v_parent_amt is not null then
      select coalesce(sum(contract_amount), 0) into v_sibling_sum
        from beacon_v2.project_items
       where parent_id = new.parent_id
         and id <> new.id;
      if v_sibling_sum + new.contract_amount > v_parent_amt + v_eps then
        raise exception
          'child contract totals (%) exceed the parent contract amount (%)',
          to_char(v_sibling_sum + new.contract_amount, 'FM999999990.00'),
          to_char(v_parent_amt, 'FM999999990.00')
          using errcode = '23514';
      end if;
    end if;
  end if;

  -- (c) Floor: this node's amount can't drop below what's already allocated to
  --     its direct children.
  if new.contract_amount is not null then
    select coalesce(sum(contract_amount), 0) into v_child_sum
      from beacon_v2.project_items where parent_id = new.id;
    if v_child_sum > new.contract_amount + v_eps then
      raise exception
        'contract amount (%) is below the total already allocated to child items (%)',
        to_char(new.contract_amount, 'FM999999990.00'),
        to_char(v_child_sum, 'FM999999990.00')
        using errcode = '23514';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists project_items_validate on beacon_v2.project_items;
create trigger project_items_validate
before insert or update on beacon_v2.project_items
for each row execute function beacon_v2.fn_project_item_validate();

--------------------------------------------------------------------------------
-- 6. RLS — permissive-for-authenticated (open_bids posture). No anon.
--------------------------------------------------------------------------------
alter table beacon_v2.project_items     enable row level security;
alter table beacon_v2.project_item_subs enable row level security;
alter table beacon_v2.project_item_pms  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['project_items','project_item_subs','project_item_pms'] loop
    execute format('drop policy if exists "%1$s_auth_select" on beacon_v2.%1$I', t);
    execute format('drop policy if exists "%1$s_auth_insert" on beacon_v2.%1$I', t);
    execute format('drop policy if exists "%1$s_auth_update" on beacon_v2.%1$I', t);
    execute format('drop policy if exists "%1$s_auth_delete" on beacon_v2.%1$I', t);

    execute format('create policy "%1$s_auth_select" on beacon_v2.%1$I for select to authenticated using (true)', t);
    execute format('create policy "%1$s_auth_insert" on beacon_v2.%1$I for insert to authenticated with check (true)', t);
    execute format('create policy "%1$s_auth_update" on beacon_v2.%1$I for update to authenticated using (true) with check (true)', t);
    execute format('create policy "%1$s_auth_delete" on beacon_v2.%1$I for delete to authenticated using (true)', t);

    execute format('grant select, insert, update, delete on beacon_v2.%1$I to authenticated', t);
  end loop;
end $$;

--------------------------------------------------------------------------------
-- 7. PostgREST schema-cache reload.
--------------------------------------------------------------------------------
notify pgrst, 'reload schema';
