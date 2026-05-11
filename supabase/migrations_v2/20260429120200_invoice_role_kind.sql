-- MSMM Beacon v2 — let projects of any status declare a Prime/Sub role,
-- and let project_subs / sub_invoices carry both kinds (sub firms hired
-- BY the project + the upstream prime firm hiring the project).
--
-- The Invoice tab surfaces this as a Role column on each invoice row:
--   * Prime → multiple sub firms tracked beneath, same as before.
--   * Sub   → exactly one upstream prime firm tracked beneath, with
--             monthly amounts + paid status + files (mirrors sub UX).

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Allow `role` on any project status, not just Potential.
--    The relationship between role and prime_company_id stays — but role='Sub'
--    no longer immediately requires a prime_company_id (the UI lets the user
--    pick one in the next step).
--------------------------------------------------------------------------------
alter table beacon_v2.projects
  drop constraint if exists projects_role_only_on_potential;

alter table beacon_v2.projects
  drop constraint if exists projects_potential_role_company_consistency;

alter table beacon_v2.projects
  add constraint projects_role_company_consistency
  check (
    role is null
    or (role = 'Prime' and prime_company_id is null)
    or (role = 'Sub')
  );

--------------------------------------------------------------------------------
-- 2. project_subs gets a `kind` discriminator. Existing rows default to 'sub'.
--    A partial unique index enforces "at most one prime entry per project".
--------------------------------------------------------------------------------
alter table beacon_v2.project_subs
  add column if not exists kind text not null default 'sub'
    check (kind in ('sub','prime'));

create unique index if not exists project_subs_one_prime_uniq
  on beacon_v2.project_subs (project_id) where kind = 'prime';

--------------------------------------------------------------------------------
-- 3. sub_invoices mirrors the kind so monthly amounts can be tracked for both
--    sub firms (kind='sub') and the upstream prime firm (kind='prime'). The
--    existing unique on (project_id, company_id, year, month) is refit to
--    include kind so the same company can theoretically appear once per kind
--    per cell (rare but legal).
--------------------------------------------------------------------------------
alter table beacon_v2.sub_invoices
  add column if not exists kind text not null default 'sub'
    check (kind in ('sub','prime'));

-- Drop the old unique constraint and rebuild it kind-aware. The auto-generated
-- name is the standard "<table>_<col1>_<col2>_..._key" pattern; IF EXISTS
-- guards against re-runs.
alter table beacon_v2.sub_invoices
  drop constraint if exists sub_invoices_project_id_company_id_year_month_key;

alter table beacon_v2.sub_invoices
  add constraint sub_invoices_kind_uniq
  unique (project_id, kind, company_id, year, month);
