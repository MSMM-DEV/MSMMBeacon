-- MSMM Beacon v2 — the consolidated `projects` table.
--
-- One row per project, identified by `status` ∈
-- (potential | awaiting | awarded | closed_out). Replaces five v1 tables:
-- potential_projects, awaiting_verdict, awarded_projects, closed_out_projects,
-- and (dropped) soq.
--
-- Move-forward semantics under v2:
--   awaiting → awarded     : UPDATE status, set stage_id/details/pool/contract_expiry_date.
--   awaiting → closed_out  : UPDATE status, set date_closed/reason_for_closure.
--   awarded  → potential   : INSERT new row with status='potential' and source_project_id = the awarded row's id (COPY semantics — original stays).
--   awarded  → invoice     : INSERT into anticipated_invoice with source_project_id = the awarded row's id.
--   potential→ invoice     : INSERT into anticipated_invoice with source_project_id = the potential row's id.
--
-- Stage gating is enforced by CHECK constraints so a malformed write
-- (probability set on an awarded row, anticipated_result_date set on a
-- closed row, etc.) is rejected at the database, not just the app.

set search_path = beacon_v2, public, extensions;

create table if not exists beacon_v2.projects (
  id                                 uuid primary key default gen_random_uuid(),
  status                             beacon_v2.project_status_enum not null,

  -- Lineage. NULL for projects that originated at this stage. For COPY
  -- transitions (awarded → potential) this points at the source project so
  -- both rows stay queryable. ON DELETE SET NULL keeps history when the
  -- ancestor is removed.
  source_project_id                  uuid references beacon_v2.projects(id) on delete set null,

  -- Universal identity (every status carries these).
  year                               int not null,
  project_name                       text not null,
  project_number                     text,
  client_id                          uuid references beacon_v2.clients(id)   on delete restrict,
  prime_company_id                   uuid references beacon_v2.companies(id) on delete restrict,
  notes                              text,

  -- Potential-stage fields (NULL for other statuses, gated below).
  role                               beacon_v2.project_role_enum,
  total_contract_amount              numeric(14,2),
  msmm_amount                        numeric(14,2),
  probability                        beacon_v2.probability_enum,
  next_action_date                   date,
  next_action_note                   text,
  anticipated_invoice_start_month    smallint,

  -- Contract fields (populated post-Potential; gated to non-potential below).
  date_submitted                     date,
  client_contract_number             text,
  msmm_contract_number               text,
  msmm_used                          numeric(14,2),
  msmm_remaining                     numeric(14,2),

  -- Awaiting-only.
  anticipated_result_date            date,

  -- Awarded-only.
  stage_id                           smallint references beacon_v2.awarded_stages(id) on delete restrict,
  details                            text,
  pool                               text,
  contract_expiry_date               date,

  -- Closed-out-only.
  date_closed                        date,
  reason_for_closure                 text,

  created_at                         timestamptz not null default now(),
  updated_at                         timestamptz not null default now(),

  ------------------------------------------------------------------------
  -- Stage gates — each block of stage-specific fields is allowed only on
  -- its owning status. NULL is always allowed (gives the app room to leave
  -- a field blank without forcing a status change).
  ------------------------------------------------------------------------
  constraint projects_potential_role_company_consistency check (
    role is null
    or (role = 'Prime' and prime_company_id is null)
    or (role = 'Sub'   and prime_company_id is not null)
  ),
  constraint projects_role_only_on_potential check (
    role is null or status = 'potential'
  ),
  constraint projects_total_contract_only_on_potential check (
    total_contract_amount is null or status = 'potential'
  ),
  constraint projects_msmm_amount_only_on_potential check (
    msmm_amount is null or status = 'potential'
  ),
  constraint projects_probability_only_on_potential check (
    probability is null or status = 'potential'
  ),
  constraint projects_next_action_date_only_on_potential check (
    next_action_date is null or status = 'potential'
  ),
  constraint projects_next_action_note_only_on_potential check (
    next_action_note is null or status = 'potential'
  ),
  constraint projects_invoice_start_month_only_on_potential check (
    anticipated_invoice_start_month is null
    or (status = 'potential'
        and anticipated_invoice_start_month between 1 and 12)
  ),
  constraint projects_anticipated_result_only_on_awaiting check (
    anticipated_result_date is null or status = 'awaiting'
  ),
  constraint projects_stage_id_only_on_awarded check (
    stage_id is null or status = 'awarded'
  ),
  constraint projects_details_only_on_awarded check (
    details is null or status = 'awarded'
  ),
  constraint projects_pool_only_on_awarded check (
    pool is null or status = 'awarded'
  ),
  constraint projects_contract_expiry_only_on_awarded check (
    contract_expiry_date is null or status = 'awarded'
  ),
  constraint projects_date_closed_only_on_closed check (
    date_closed is null or status = 'closed_out'
  ),
  constraint projects_reason_only_on_closed check (
    reason_for_closure is null or status = 'closed_out'
  )
);

create index if not exists projects_status_year_idx     on beacon_v2.projects (status, year);
create index if not exists projects_status_client_idx   on beacon_v2.projects (status, client_id);
create index if not exists projects_client_idx          on beacon_v2.projects (client_id);
create index if not exists projects_prime_company_idx   on beacon_v2.projects (prime_company_id);
create index if not exists projects_year_idx            on beacon_v2.projects (year);
create index if not exists projects_source_idx          on beacon_v2.projects (source_project_id) where source_project_id is not null;

drop trigger if exists touch_projects on beacon_v2.projects;
create trigger touch_projects before update on beacon_v2.projects
  for each row execute function beacon_v2.touch_updated_at();
