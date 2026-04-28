-- MSMM Beacon v2 — anticipated_invoice + invoice_pms + read views.
--
-- Single source FK (`source_project_id`) replaces v1's dual-FK setup
-- (source_awarded_id + source_potential_id). The unique partial index on
-- (source_project_id, year) preserves v1's invariant: at most one auto-created
-- invoice per source-project per year. Invoices created without a source
-- (manual entries) skip the index.
--
-- 12 month columns + ytd_actual_override + rollforward_override stay
-- byte-identical to v1.
-- Actual vs Projection is derived at read time from CURRENT_DATE in the
-- views below — never stored.

set search_path = beacon_v2, public, extensions;

create table if not exists beacon_v2.anticipated_invoice (
  id                                uuid primary key default gen_random_uuid(),
  source_project_id                 uuid references beacon_v2.projects(id) on delete set null,
  year                              int not null,
  project_number                    text,
  project_name                      text not null,
  contract_amount                   numeric(14,2),
  type                              beacon_v2.invoice_type_enum,
  msmm_remaining_to_bill_year_start numeric(14,2),
  jan_amount                        numeric(14,2),
  feb_amount                        numeric(14,2),
  mar_amount                        numeric(14,2),
  apr_amount                        numeric(14,2),
  may_amount                        numeric(14,2),
  jun_amount                        numeric(14,2),
  jul_amount                        numeric(14,2),
  aug_amount                        numeric(14,2),
  sep_amount                        numeric(14,2),
  oct_amount                        numeric(14,2),
  nov_amount                        numeric(14,2),
  dec_amount                        numeric(14,2),
  ytd_actual_override               numeric(14,2),
  rollforward_override              numeric(14,2),
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now()
);

-- Auto-created invoices: one per (source_project, year). Manual invoices
-- (source_project_id IS NULL) are exempt.
create unique index if not exists anticipated_invoice_source_year_uniq
  on beacon_v2.anticipated_invoice (source_project_id, year)
  where source_project_id is not null;

create index if not exists anticipated_invoice_year_idx
  on beacon_v2.anticipated_invoice (year);

drop trigger if exists touch_anticipated_invoice on beacon_v2.anticipated_invoice;
create trigger touch_anticipated_invoice before update on beacon_v2.anticipated_invoice
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- invoice_pms — same shape as v1.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.anticipated_invoice_pms (
  anticipated_invoice_id uuid not null references beacon_v2.anticipated_invoice(id) on delete cascade,
  user_id                uuid not null references beacon_v2.users(id) on delete cascade,
  primary key (anticipated_invoice_id, user_id)
);
create index if not exists anticipated_invoice_pms_user_idx
  on beacon_v2.anticipated_invoice_pms (user_id);

--------------------------------------------------------------------------------
-- Per-month Actual/Projection view. `kind` is derived from CURRENT_DATE so
-- it advances on the 1st of each month with no manual toggle.
--------------------------------------------------------------------------------
create or replace view beacon_v2.v_anticipated_invoice_months as
with months(month_num) as (values (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12))
select
  i.id as invoice_id,
  i.year,
  m.month_num,
  case
    when i.year < extract(year from current_date)::int then 'Actual'
    when i.year > extract(year from current_date)::int then 'Projection'
    when m.month_num <= extract(month from current_date)::int then 'Actual'
    else 'Projection'
  end as kind,
  case m.month_num
    when 1  then i.jan_amount when 2  then i.feb_amount when 3  then i.mar_amount
    when 4  then i.apr_amount when 5  then i.may_amount when 6  then i.jun_amount
    when 7  then i.jul_amount when 8  then i.aug_amount when 9  then i.sep_amount
    when 10 then i.oct_amount when 11 then i.nov_amount when 12 then i.dec_amount
  end as amount
from beacon_v2.anticipated_invoice i
cross join months m;

--------------------------------------------------------------------------------
-- YTD totals (Actual sum + Projection sum). Frontend can short-circuit either
-- with the *_override columns on the base table.
--------------------------------------------------------------------------------
create or replace view beacon_v2.v_anticipated_invoice_totals as
select
  m.invoice_id,
  max(i.year) as year,
  sum(case when m.kind = 'Actual'     then coalesce(m.amount,0) else 0 end) as ytd_actual,
  sum(case when m.kind = 'Projection' then coalesce(m.amount,0) else 0 end) as projected_remaining
from beacon_v2.v_anticipated_invoice_months m
join beacon_v2.anticipated_invoice i on i.id = m.invoice_id
group by m.invoice_id;
