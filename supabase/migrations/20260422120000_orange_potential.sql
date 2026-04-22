-- Adds support for the "Orange" probability bucket on potential projects.
-- An Orange project is a pre-awarded pipeline item the firm is already
-- invoicing against, so creating one auto-creates an Anticipated Invoice row.
--
-- Two schema additions:
--   1. potential_projects.anticipated_invoice_start_month  (1..12, nullable)
--   2. anticipated_invoice.source_potential_id             (FK → potential_projects)

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'beacon'
      and table_name   = 'potential_projects'
      and column_name  = 'anticipated_invoice_start_month'
  ) then
    alter table beacon.potential_projects
      add column anticipated_invoice_start_month smallint
      check (anticipated_invoice_start_month is null
             or (anticipated_invoice_start_month between 1 and 12));
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'beacon'
      and table_name   = 'anticipated_invoice'
      and column_name  = 'source_potential_id'
  ) then
    alter table beacon.anticipated_invoice
      add column source_potential_id uuid
      references beacon.potential_projects(id) on delete set null;
    create index if not exists anticipated_invoice_source_potential_idx
      on beacon.anticipated_invoice(source_potential_id);
  end if;
end $$;

-- The existing unique (source_awarded_id, year) constraint doesn't cover
-- orange-origin rows (source_awarded_id is NULL). Add a matching uniqueness
-- so we don't double-create an invoice row for the same (potential, year).
create unique index if not exists
  anticipated_invoice_source_potential_year_uniq
  on beacon.anticipated_invoice(source_potential_id, year)
  where source_potential_id is not null;
