-- ============================================================================
-- Awarded ↔ Invoice project links, keyed on the invoice PROJECT NUMBER
-- ============================================================================
-- An Awarded contract (esp. an IDIQ / multi-use award) can spawn several
-- billable projects in the Invoice table. The Invoice table's natural key is
-- the project number — mergeInvoiceYears already folds per-year
-- anticipated_invoice rows into one project per (type, project_number) — so
-- the link targets the NUMBER, not an anticipated_invoice.id (an id would pin
-- one year-row; the number spans every year of the project).
--
-- One awarded row ↔ many invoice project numbers; the same number may also be
-- linked from several awarded rows (e.g. a re-award). The Awarded table's
-- "Proj #" column renders these as chips; clicking one opens the live invoice
-- project card (contract, billed YTD, billing state) and can jump to the
-- Invoice tab.
--
-- ON DELETE CASCADE: deleting the project drops its links. There is no FK to
-- anticipated_invoice — numbers are user-managed text; a link to a number
-- with no invoice rows simply renders as "not found" in the UI (harmless,
-- self-healing once the invoice row gains that number).
--
-- Idempotent — safe to re-paste.

create table if not exists beacon_v2.project_invoice_links (
  project_id     uuid not null references beacon_v2.projects(id) on delete cascade,
  -- Stored btrim'd; the frontend also matches case-insensitively.
  project_number text not null check (btrim(project_number) <> ''),
  created_at     timestamptz not null default now(),
  primary key (project_id, project_number)
);

create index if not exists project_invoice_links_number_idx
  on beacon_v2.project_invoice_links (project_number);

-- RLS — permissive for any signed-in user (the open_bids posture; login is
-- mandatory in the app, anon gets nothing).
alter table beacon_v2.project_invoice_links enable row level security;

do $$ begin
  create policy "pil auth select" on beacon_v2.project_invoice_links
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "pil auth insert" on beacon_v2.project_invoice_links
    for insert to authenticated with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "pil auth update" on beacon_v2.project_invoice_links
    for update to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "pil auth delete" on beacon_v2.project_invoice_links
    for delete to authenticated using (true);
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on beacon_v2.project_invoice_links to authenticated;

-- ----------------------------------------------------------------------------
-- One-time backfill: any awarded project whose own project_number matches an
-- invoice project number starts out linked to it. Re-runnable (ON CONFLICT
-- DO NOTHING); never invents links for numbers with no invoice rows.
-- ----------------------------------------------------------------------------
insert into beacon_v2.project_invoice_links (project_id, project_number)
select distinct p.id, btrim(p.project_number)
  from beacon_v2.projects p
 where p.status = 'awarded'
   and nullif(btrim(coalesce(p.project_number, '')), '') is not null
   and exists (
     select 1
       from beacon_v2.anticipated_invoice ai
      where lower(btrim(coalesce(ai.project_number, ''))) = lower(btrim(p.project_number))
   )
on conflict do nothing;

notify pgrst, 'reload schema';
