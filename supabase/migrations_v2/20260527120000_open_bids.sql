-- ============================================================================
-- 20260527120000_open_bids.sql
--   Open Bids — pre-Awaiting-Verdict pipeline stage.
--   Tracks RFQ/RFPs the firm is evaluating before deciding to submit. Once an
--   Open Bid is admin-approved, it can be moved forward to Awaiting Verdict
--   (which mints a new beacon_v2.projects row with status='awaiting'; the
--   open_bids row stays as the historical breadcrumb, linked via
--   moved_to_project_id).
--
-- RLS posture mirrors the rest of beacon_v2:
--   * SELECT / INSERT / UPDATE / DELETE — permissive-for-authenticated.
--   * A BEFORE UPDATE trigger rejects writes to approval_status / approved_by /
--     approved_at unless the caller is an Admin. Defense-in-depth on top of
--     the UI gate (App.jsx hides the thumbs-up/down for non-admins).
--
-- Idempotent — safe to re-run. Uses `do $$ ... end $$` guards for enum +
-- constraint creation (PG ≤ 15 has no `add constraint if not exists`).
-- ============================================================================

--------------------------------------------------------------------------------
-- 1. Enums
--------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t
                  join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'beacon_v2' and t.typname = 'bid_service_enum') then
    create type beacon_v2.bid_service_enum as enum (
      'Civil Engineering Design Services',
      'Drainage and Stormwater Engineering',
      'Roadway and Infrastructure Design',
      'Water and Sewer Engineering Services',
      'Construction Engineering and Inspection',
      'Project Management Services',
      'Engineering Planning and Feasibility Studies',
      'Environmental and Coastal Engineering',
      'Traffic and Transportation Engineering',
      'Site Development Engineering',
      'Utility Infrastructure Engineering',
      'Flood Mitigation and Resilience Planning',
      'Surveying and Mapping Services',
      'Grant Support and Technical Assistance',
      'On-Call Engineering Services'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type t
                  join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'beacon_v2' and t.typname = 'bid_approval_enum') then
    create type beacon_v2.bid_approval_enum as enum ('pending','approved','rejected');
  end if;
end $$;

--------------------------------------------------------------------------------
-- 2. Table
--------------------------------------------------------------------------------
create table if not exists beacon_v2.open_bids (
  id                    uuid primary key default gen_random_uuid(),
  rfq_rfp_number        text not null,
  client_id             uuid references beacon_v2.clients(id) on delete set null,
  service_description   beacon_v2.bid_service_enum,
  due_at                timestamptz,
  pdf_file_path         text,
  pdf_file_name         text,
  web_link              text,
  notes                 text,
  approval_status       beacon_v2.bid_approval_enum not null default 'pending',
  approved_by           uuid references beacon_v2.users(id) on delete set null,
  approved_at           timestamptz,
  moved_to_project_id   uuid references beacon_v2.projects(id) on delete set null,
  created_by            uuid references beacon_v2.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Approval state stays internally consistent — non-pending implies both
-- approver + timestamp are recorded; pending implies both are null.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'open_bids_approval_consistent'
       and conrelid = 'beacon_v2.open_bids'::regclass
  ) then
    alter table beacon_v2.open_bids
      add constraint open_bids_approval_consistent
      check (
        (approval_status = 'pending'  and approved_by is null     and approved_at is null)
        or
        (approval_status in ('approved','rejected') and approved_by is not null and approved_at is not null)
      );
  end if;
end $$;

create index if not exists open_bids_client_idx       on beacon_v2.open_bids(client_id);
create index if not exists open_bids_due_idx          on beacon_v2.open_bids(due_at);
create index if not exists open_bids_approval_idx     on beacon_v2.open_bids(approval_status);

--------------------------------------------------------------------------------
-- 3. updated_at trigger
--------------------------------------------------------------------------------
create or replace function beacon_v2.tg_open_bids_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists open_bids_set_updated_at on beacon_v2.open_bids;
create trigger open_bids_set_updated_at
before update on beacon_v2.open_bids
for each row execute function beacon_v2.tg_open_bids_set_updated_at();

--------------------------------------------------------------------------------
-- 4. Approval-gate trigger
--   Rejects writes to approval_status / approved_by / approved_at when the
--   caller is not an Admin. The is_current_user_admin() helper already
--   exists from 20260428121000_grants_rls.sql.
--   Service-role callers bypass RLS but still execute triggers — the helper
--   returns false for service_role (no auth.uid()), so a service-role
--   migration that needs to flip approvals must use `set local role = 'postgres'`
--   or call this via a SECURITY DEFINER wrapper.
--------------------------------------------------------------------------------
create or replace function beacon_v2.tg_open_bids_guard_approval()
returns trigger language plpgsql as $$
begin
  if (new.approval_status is distinct from old.approval_status)
     or (new.approved_by   is distinct from old.approved_by)
     or (new.approved_at   is distinct from old.approved_at)
  then
    if not beacon_v2.is_current_user_admin() then
      raise exception 'open_bids approval can only be changed by an Admin'
        using errcode = '42501';  -- insufficient_privilege
    end if;
  end if;
  return new;
end $$;

drop trigger if exists open_bids_guard_approval on beacon_v2.open_bids;
create trigger open_bids_guard_approval
before update on beacon_v2.open_bids
for each row execute function beacon_v2.tg_open_bids_guard_approval();

--------------------------------------------------------------------------------
-- 5. RLS
--------------------------------------------------------------------------------
alter table beacon_v2.open_bids enable row level security;

drop policy if exists "open_bids_auth_select" on beacon_v2.open_bids;
drop policy if exists "open_bids_auth_insert" on beacon_v2.open_bids;
drop policy if exists "open_bids_auth_update" on beacon_v2.open_bids;
drop policy if exists "open_bids_auth_delete" on beacon_v2.open_bids;

create policy "open_bids_auth_select" on beacon_v2.open_bids
  for select to authenticated using (true);
create policy "open_bids_auth_insert" on beacon_v2.open_bids
  for insert to authenticated with check (true);
create policy "open_bids_auth_update" on beacon_v2.open_bids
  for update to authenticated using (true) with check (true);
create policy "open_bids_auth_delete" on beacon_v2.open_bids
  for delete to authenticated using (true);

grant select, insert, update, delete on beacon_v2.open_bids to authenticated;

--------------------------------------------------------------------------------
-- 6. Storage — bid-rfqs bucket for uploaded RFQ/RFP PDFs.
--   Private bucket; access via signed URLs only (same pattern as the
--   `invoices` bucket — see 20260430130000_invoices_storage_policies.sql).
--   Authenticated users can read/write any object in the bucket; the
--   open_bids row's pdf_file_path is what connects a bucket object back
--   to a specific bid.
--------------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('bid-rfqs', 'bid-rfqs', false)
on conflict (id) do nothing;

drop policy if exists "bid_rfqs_auth_select" on storage.objects;
drop policy if exists "bid_rfqs_auth_insert" on storage.objects;
drop policy if exists "bid_rfqs_auth_update" on storage.objects;
drop policy if exists "bid_rfqs_auth_delete" on storage.objects;

create policy "bid_rfqs_auth_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'bid-rfqs');

create policy "bid_rfqs_auth_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'bid-rfqs');

create policy "bid_rfqs_auth_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'bid-rfqs')
  with check (bucket_id = 'bid-rfqs');

create policy "bid_rfqs_auth_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'bid-rfqs');

--------------------------------------------------------------------------------
-- 7. PostgREST schema-cache reload.
--    Supabase usually auto-detects CREATE TABLE and reloads PostgREST, but
--    there's a brief window (sometimes ~30s) where the new table 404s from
--    the API. NOTIFY forces an immediate reload so the frontend can insert
--    into open_bids the moment this migration finishes running.
--------------------------------------------------------------------------------
notify pgrst, 'reload schema';

