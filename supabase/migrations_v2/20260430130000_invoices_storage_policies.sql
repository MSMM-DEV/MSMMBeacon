-- MSMM Beacon v2 — Storage policies for the `invoices` bucket.
--
-- The `20260429120000_invoice_files.sql` migration defines RLS for the
-- metadata tables (`prime_invoice_files`, `sub_invoice_files`,
-- `sub_invoices`) but does NOT touch Supabase Storage. The bucket itself
-- has its own RLS layer on `storage.objects`, which Supabase ships with
-- DENY-ALL defaults for `authenticated` and `anon`. Result: uploads from
-- the frontend fail with
--   "storage upload: new row violates row-level security policy"
-- until explicit policies are written for the bucket.
--
-- This file:
--   1. Ensures the `invoices` bucket exists (private — never `public`).
--   2. Grants authenticated users full CRUD on objects whose bucket_id is
--      'invoices', so the in-app file picker, replace, and delete flows
--      work for any signed-in beacon user.
--   3. Leaves anon with no access — these are project PDFs, internal only.
--
-- Tightening later: scope INSERT to a path prefix derived from the user's
-- project access, OR move uploads server-side via an Edge Function with
-- the service-role key (bypasses RLS entirely). For the prototype, "any
-- signed-in user can read/write any invoice file" matches the rest of the
-- v2 RLS posture.

--------------------------------------------------------------------------------
-- 1. Bucket
--------------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', false)
on conflict (id) do nothing;

--------------------------------------------------------------------------------
-- 2. Policies on storage.objects (RLS already enabled by Supabase).
--    Idempotent: drop first so re-runs don't fail.
--------------------------------------------------------------------------------
drop policy if exists "invoices_auth_select" on storage.objects;
drop policy if exists "invoices_auth_insert" on storage.objects;
drop policy if exists "invoices_auth_update" on storage.objects;
drop policy if exists "invoices_auth_delete" on storage.objects;

create policy "invoices_auth_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'invoices');

create policy "invoices_auth_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'invoices');

create policy "invoices_auth_update" on storage.objects
  for update to authenticated
  using      (bucket_id = 'invoices')
  with check (bucket_id = 'invoices');

create policy "invoices_auth_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'invoices');
