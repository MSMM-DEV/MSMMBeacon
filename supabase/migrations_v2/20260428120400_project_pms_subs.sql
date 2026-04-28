-- MSMM Beacon v2 — project_pms + project_subs.
--
-- One PM join, one sub join, both keyed on project_id. Replaces ten v1 tables
-- (5× *_pms + 4× *_subs + the variant uuid-PK shape on potential_project_subs).
--
-- Sub rows carry discipline / amount / ord on every status (matches the live
-- potential_project_subs shape). For non-potential statuses these will
-- typically be NULL, but the columns are kept so a Potential's sub data
-- isn't lost when it moves forward via a status flip.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- project_pms — composite PK so a PM can be on a project at most once.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.project_pms (
  project_id uuid not null references beacon_v2.projects(id) on delete cascade,
  user_id    uuid not null references beacon_v2.users(id)    on delete cascade,
  primary key (project_id, user_id)
);
create index if not exists project_pms_user_idx on beacon_v2.project_pms (user_id);

--------------------------------------------------------------------------------
-- project_subs — uuid PK + ord lets the same company appear twice on one
-- project (different disciplines or split amounts) and lets the UI preserve
-- ordering. company_id is nullable so a row can hold a draft sub before a
-- company is picked.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.project_subs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references beacon_v2.projects(id)   on delete cascade,
  ord         int,
  company_id  uuid references beacon_v2.companies(id) on delete restrict,
  discipline  text,
  amount      numeric(14,2),
  created_at  timestamptz not null default now()
);
create index if not exists project_subs_project_idx on beacon_v2.project_subs (project_id);
create index if not exists project_subs_company_idx on beacon_v2.project_subs (company_id);
