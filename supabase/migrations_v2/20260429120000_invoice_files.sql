-- MSMM Beacon v2 — sub invoices + invoice file attachments.
--
-- Adds three tables that ride on top of the existing anticipated_invoice +
-- project_subs structure to track:
--   * Each sub's monthly invoice amount per project (sub_invoices)
--   * The PDFs (or any file) backing each sub-invoice (sub_invoice_files)
--   * The PDFs backing each prime-invoice month (prime_invoice_files)
--
-- File binaries live in Supabase Storage bucket `invoices`. These tables
-- only store the file path + display name. RLS posture mirrors the rest of
-- beacon_v2 (auth full + anon CRUD prototype).

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. sub_invoices — per-(project, sub, year, month) row.
--    The amount cell is editable inline like prime invoice cells.
--    UNIQUE constraint enforces "one row per sub per month per year"; multiple
--    invoices uploaded for the same month are tracked via sub_invoice_files.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.sub_invoices (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references beacon_v2.projects(id)   on delete cascade,
  company_id  uuid not null references beacon_v2.companies(id) on delete restrict,
  year        int not null,
  month       smallint not null check (month between 1 and 12),
  amount      numeric(14,2),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, company_id, year, month)
);
create index if not exists sub_invoices_project_year_idx on beacon_v2.sub_invoices (project_id, year);
create index if not exists sub_invoices_company_idx       on beacon_v2.sub_invoices (company_id);

drop trigger if exists touch_sub_invoices on beacon_v2.sub_invoices;
create trigger touch_sub_invoices before update on beacon_v2.sub_invoices
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- 2. sub_invoice_files — 0..N attachments per sub_invoices row.
--    Cascade delete: removing the sub_invoice removes its files (the binaries
--    in Storage are deleted by the frontend before the DB delete).
--------------------------------------------------------------------------------
create table if not exists beacon_v2.sub_invoice_files (
  id             uuid primary key default gen_random_uuid(),
  sub_invoice_id uuid not null references beacon_v2.sub_invoices(id) on delete cascade,
  file_path      text not null,
  file_name      text not null,
  notes          text,
  uploaded_by    uuid references beacon_v2.users(id) on delete set null,
  uploaded_at    timestamptz not null default now()
);
create index if not exists sub_invoice_files_parent_idx on beacon_v2.sub_invoice_files (sub_invoice_id);

--------------------------------------------------------------------------------
-- 3. prime_invoice_files — 0..N attachments per (anticipated_invoice, month).
--    The amount lives on anticipated_invoice.{month}_amount; this table is
--    only a side-channel for the actual PDF.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.prime_invoice_files (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references beacon_v2.anticipated_invoice(id) on delete cascade,
  month       smallint not null check (month between 1 and 12),
  file_path   text not null,
  file_name   text not null,
  notes       text,
  uploaded_by uuid references beacon_v2.users(id) on delete set null,
  uploaded_at timestamptz not null default now()
);
create index if not exists prime_invoice_files_parent_idx on beacon_v2.prime_invoice_files (invoice_id, month);

--------------------------------------------------------------------------------
-- 4. RLS — match the rest of beacon_v2's prototype posture.
--------------------------------------------------------------------------------
alter table beacon_v2.sub_invoices         enable row level security;
alter table beacon_v2.sub_invoice_files    enable row level security;
alter table beacon_v2.prime_invoice_files  enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array['sub_invoices','sub_invoice_files','prime_invoice_files'])
  loop
    execute format('drop policy if exists "auth full access" on beacon_v2.%I', t);
    execute format('drop policy if exists "anon read"        on beacon_v2.%I', t);
    execute format('drop policy if exists "anon insert"      on beacon_v2.%I', t);
    execute format('drop policy if exists "anon update"      on beacon_v2.%I', t);
    execute format('drop policy if exists "anon delete"      on beacon_v2.%I', t);

    execute format(
      'create policy "auth full access" on beacon_v2.%I for all to authenticated using (true) with check (true)', t);
    execute format(
      'create policy "anon read"        on beacon_v2.%I for select to anon using (true)', t);
    execute format(
      'create policy "anon insert"      on beacon_v2.%I for insert to anon with check (true)', t);
    execute format(
      'create policy "anon update"      on beacon_v2.%I for update to anon using (true) with check (true)', t);
    execute format(
      'create policy "anon delete"      on beacon_v2.%I for delete to anon using (true)', t);

    execute format('grant select, insert, update, delete on beacon_v2.%I to anon, authenticated', t);
  end loop;
end $$;
