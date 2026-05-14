-- MSMM Beacon v2 — invoice party-level file attachments.
--
-- Sister to prime_invoice_files / sub_invoice_files (which key on month).
-- This table keys on the firm party itself — so PDFs / contracts / cut
-- sheets that belong to "MSMM on this project", "the prime firm on this
-- project", or "this particular sub firm on this project" live here and
-- aren't tied to any one month.
--
-- party_kind discriminates:
--   * 'msmm'  → the project's MSMM line (singleton per invoice; no company id)
--   * 'prime' → the upstream prime firm (only meaningful when MSMM is Sub)
--   * 'sub'   → any one of the sub firms MSMM hires on this project
-- The check constraint enforces: party_company_id is NULL iff kind='msmm'.
--
-- File binaries live in Supabase Storage bucket `invoices` alongside the
-- existing prime/sub PDFs. Cascade-on-delete keeps the table clean if the
-- invoice (or company) goes away; the frontend still removes the binary
-- from Storage before issuing the DB delete so we don't orphan blobs.

set search_path = beacon_v2, public, extensions;

create table if not exists beacon_v2.invoice_party_files (
  id               uuid primary key default gen_random_uuid(),
  invoice_id       uuid not null references beacon_v2.anticipated_invoice(id) on delete cascade,
  party_kind       text not null check (party_kind in ('msmm','prime','sub')),
  party_company_id uuid references beacon_v2.companies(id) on delete cascade,
  file_path        text not null,
  file_name        text not null,
  notes            text,
  uploaded_by      uuid references beacon_v2.users(id) on delete set null,
  uploaded_at      timestamptz not null default now(),
  -- msmm has no company; prime/sub require one.
  constraint invoice_party_files_company_matches_kind
    check ((party_kind = 'msmm') = (party_company_id is null))
);

create index if not exists invoice_party_files_invoice_idx
  on beacon_v2.invoice_party_files (invoice_id);
create index if not exists invoice_party_files_party_idx
  on beacon_v2.invoice_party_files (invoice_id, party_kind, party_company_id);

alter table beacon_v2.invoice_party_files enable row level security;

do $$
begin
  execute 'drop policy if exists "auth full access" on beacon_v2.invoice_party_files';
  execute 'drop policy if exists "anon read"        on beacon_v2.invoice_party_files';
  execute 'drop policy if exists "anon insert"      on beacon_v2.invoice_party_files';
  execute 'drop policy if exists "anon update"      on beacon_v2.invoice_party_files';
  execute 'drop policy if exists "anon delete"      on beacon_v2.invoice_party_files';

  execute 'create policy "auth full access" on beacon_v2.invoice_party_files for all to authenticated using (true) with check (true)';
  execute 'create policy "anon read"        on beacon_v2.invoice_party_files for select to anon using (true)';
  execute 'create policy "anon insert"      on beacon_v2.invoice_party_files for insert to anon with check (true)';
  execute 'create policy "anon update"      on beacon_v2.invoice_party_files for update to anon using (true) with check (true)';
  execute 'create policy "anon delete"      on beacon_v2.invoice_party_files for delete to anon using (true)';

  execute 'grant select, insert, update, delete on beacon_v2.invoice_party_files to anon, authenticated';
end $$;
