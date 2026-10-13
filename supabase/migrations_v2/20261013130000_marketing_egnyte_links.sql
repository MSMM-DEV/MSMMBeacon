-- 20261013130000_marketing_egnyte_links.sql
--
-- Sales (Marketing) opportunity ↔ Egnyte links.
--
-- One row = one pointer from an opportunity to an Egnyte cloud path
-- (`/Shared/...`) — either a single FILE or a whole FOLDER. Folder links are
-- rendered as a lazily-loaded tree in the opportunity's "Files & History"
-- section; nothing about the folder's contents is stored here (Egnyte stays
-- the source of truth, read through the sign-in-gated Vercel API).
--
-- Removing a link deletes only this row. Nothing in Egnyte is ever touched.
--
-- size_bytes / modified_at are a metadata snapshot taken at link time for
-- FILE links, so the card can show them without spending an Egnyte API call
-- on every open (the service account shares one daily API quota).
--
-- Posture matches the other marketing_* relation tables
-- (20261012120000_marketing_pipeline.sql): collaborative CRUD for
-- authenticated users, no anon access.
--
-- Idempotent; safe to re-paste.

create table if not exists beacon_v2.marketing_egnyte_links (
  id              uuid primary key default gen_random_uuid(),
  opportunity_id  uuid not null references beacon_v2.marketing_opportunities(id) on delete cascade,
  egnyte_path     text not null check (egnyte_path like '/Shared/%' and egnyte_path !~ '(^|/)\.\.?(/|$)'),
  kind            text not null check (kind in ('file', 'folder')),
  name            text,
  size_bytes      bigint check (size_bytes is null or size_bytes >= 0),
  modified_at     timestamptz,
  created_by      uuid references beacon_v2.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (opportunity_id, egnyte_path)
);

create index if not exists marketing_egnyte_links_opportunity_idx
  on beacon_v2.marketing_egnyte_links(opportunity_id, created_at);

alter table beacon_v2.marketing_egnyte_links enable row level security;

drop policy if exists marketing_egnyte_links_auth_all on beacon_v2.marketing_egnyte_links;
create policy marketing_egnyte_links_auth_all on beacon_v2.marketing_egnyte_links
  for all to authenticated using (true) with check (true);

revoke all on beacon_v2.marketing_egnyte_links from anon;
grant select, insert, update, delete on beacon_v2.marketing_egnyte_links to authenticated;

notify pgrst, 'reload schema';
