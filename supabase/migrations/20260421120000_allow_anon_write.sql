-- Grant `anon` INSERT / UPDATE / DELETE on every beacon.* table so the
-- frontend can create rows (New X modal) and persist edits before Supabase
-- Auth sign-in is wired up. Paired with 20260420140000_allow_anon_read.sql
-- which granted anon SELECT. Together they give anon full CRUD.
--
-- SECURITY NOTE — this is prototype-only.
-- Before deploying this to a public URL:
--   1. Drop the three "anon ..." policies below (and the anon SELECT policy
--      from 20260420140000) on any table that should be sign-in-gated.
--   2. Wire Supabase Auth (signInWithPassword / magic-link) on the frontend.
--   3. The baseline "auth full access" policy (from the initial migration)
--      will then gate writes to authenticated users.

do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'beacon'
  loop
    execute format('drop policy if exists "anon insert" on beacon.%I', t);
    execute format('drop policy if exists "anon update" on beacon.%I', t);
    execute format('drop policy if exists "anon delete" on beacon.%I', t);

    execute format(
      'create policy "anon insert" on beacon.%I for insert to anon with check (true)',
      t
    );
    execute format(
      'create policy "anon update" on beacon.%I for update to anon using (true) with check (true)',
      t
    );
    execute format(
      'create policy "anon delete" on beacon.%I for delete to anon using (true)',
      t
    );

    execute format('grant insert, update, delete on beacon.%I to anon', t);
  end loop;
end $$;

-- Sequences — gen_random_uuid() is used for UUID PKs, but awarded_stages
-- has a smallserial. Grant anon USAGE + SELECT so inserts don't fail on the
-- sequence default.
grant usage, select on all sequences in schema beacon to anon;
alter default privileges in schema beacon grant usage, select on sequences to anon;
