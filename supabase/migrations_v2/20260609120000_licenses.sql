-- Licenses & Certifications tracker.
--
-- Tracks every company / individual license + certification, with an
-- expiration date and a per-row list of email addresses to remind when it's
-- about to lapse. "Days until due" is NOT stored — it's a pure function of
-- (expiration_date − today), computed client-side and by the reminder cron, so
-- it can never drift.
--
-- Reminder cadence is milestone-based (see the license-reminders Edge Function):
-- one email when the license first crosses 60 / 30 / 14 / 7 / 1 days out and on
-- the expiry day (band 0). `last_notified_band` records the tightest band we've
-- already emailed for the CURRENT expiration_date; a renewal (expiration_date
-- change) resets it via fn_license_reset_notify so the sequence restarts.
--
-- Color bands (UI only): ≤30 days (incl. expired) = red, 31–60 = amber,
-- ≥61 = green, no expiration = neutral.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. licenses
--------------------------------------------------------------------------------
create table if not exists beacon_v2.licenses (
  id                 uuid primary key default gen_random_uuid(),
  legacy_id          integer unique,                 -- LIC_ID from the source sheet (seed dedupe)
  entity             text not null,                  -- LIC_NAME (firm or person)
  state              text,                           -- free text (LA / TX / USA / N/A / …)
  lic_type           text,                           -- free text (P.E. License / SOS Filing / Other / …)
  license_no         text,
  asce_m_no          text,
  first_issue_date   date,
  expiration_date    date,                           -- NULL = no expiry (never goes red)
  notify_emails      text[] not null default '{}',   -- free-text addresses (may be external)
  email_enabled      boolean not null default true,
  notes              text,
  last_notified_band integer,                         -- tightest milestone already emailed (60/30/14/7/1/0); NULL = none
  last_notified_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists licenses_expiration_idx on beacon_v2.licenses (expiration_date);

drop trigger if exists trg_licenses_touch on beacon_v2.licenses;
create trigger trg_licenses_touch
  before update on beacon_v2.licenses
  for each row execute function beacon_v2.touch_updated_at();

-- Renewal restarts the milestone sequence: when the expiration date moves, the
-- reminder bookkeeping resets so the new cycle fires 60/30/14/7/1/0 again.
create or replace function beacon_v2.fn_license_reset_notify()
returns trigger
language plpgsql
as $$
begin
  if new.expiration_date is distinct from old.expiration_date then
    new.last_notified_band := null;
    new.last_notified_at   := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_licenses_reset_notify on beacon_v2.licenses;
create trigger trg_licenses_reset_notify
  before update on beacon_v2.licenses
  for each row execute function beacon_v2.fn_license_reset_notify();

--------------------------------------------------------------------------------
-- 2. license_files — per-license attachments (scanned PDFs, etc.). Binaries
--    live in the private `license-files` Storage bucket; this row is metadata.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.license_files (
  id          uuid primary key default gen_random_uuid(),
  license_id  uuid not null references beacon_v2.licenses(id) on delete cascade,
  file_path   text not null,
  file_name   text not null,
  uploaded_by uuid references beacon_v2.users(id) on delete set null,
  uploaded_at timestamptz not null default now()
);
create index if not exists license_files_license_idx on beacon_v2.license_files (license_id);

--------------------------------------------------------------------------------
-- 3. RLS — permissive-for-authenticated (matches the open_bids / business-table
--    posture; login is required app-wide). Service-role (seed script + reminder
--    function) bypasses RLS.
--------------------------------------------------------------------------------
alter table beacon_v2.licenses      enable row level security;
alter table beacon_v2.license_files enable row level security;

drop policy if exists "licenses_auth_select" on beacon_v2.licenses;
drop policy if exists "licenses_auth_insert" on beacon_v2.licenses;
drop policy if exists "licenses_auth_update" on beacon_v2.licenses;
drop policy if exists "licenses_auth_delete" on beacon_v2.licenses;
create policy "licenses_auth_select" on beacon_v2.licenses for select to authenticated using (true);
create policy "licenses_auth_insert" on beacon_v2.licenses for insert to authenticated with check (true);
create policy "licenses_auth_update" on beacon_v2.licenses for update to authenticated using (true) with check (true);
create policy "licenses_auth_delete" on beacon_v2.licenses for delete to authenticated using (true);

drop policy if exists "license_files_auth_select" on beacon_v2.license_files;
drop policy if exists "license_files_auth_insert" on beacon_v2.license_files;
drop policy if exists "license_files_auth_update" on beacon_v2.license_files;
drop policy if exists "license_files_auth_delete" on beacon_v2.license_files;
create policy "license_files_auth_select" on beacon_v2.license_files for select to authenticated using (true);
create policy "license_files_auth_insert" on beacon_v2.license_files for insert to authenticated with check (true);
create policy "license_files_auth_update" on beacon_v2.license_files for update to authenticated using (true) with check (true);
create policy "license_files_auth_delete" on beacon_v2.license_files for delete to authenticated using (true);

grant select, insert, update, delete on beacon_v2.licenses      to authenticated;
grant select, insert, update, delete on beacon_v2.license_files to authenticated;

--------------------------------------------------------------------------------
-- 4. Storage — private `license-files` bucket + authenticated CRUD on its
--    objects (same pattern as `invoices` / `bid-rfqs`).
--------------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('license-files', 'license-files', false)
on conflict (id) do nothing;

drop policy if exists "license_files_obj_select" on storage.objects;
drop policy if exists "license_files_obj_insert" on storage.objects;
drop policy if exists "license_files_obj_update" on storage.objects;
drop policy if exists "license_files_obj_delete" on storage.objects;

create policy "license_files_obj_select" on storage.objects
  for select to authenticated using (bucket_id = 'license-files');
create policy "license_files_obj_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'license-files');
create policy "license_files_obj_update" on storage.objects
  for update to authenticated using (bucket_id = 'license-files') with check (bucket_id = 'license-files');
create policy "license_files_obj_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'license-files');

notify pgrst, 'reload schema';
