-- Allow anon (unauthenticated browser clients) to READ all beacon tables.
-- This is the minimum needed for the prototype frontend to boot before
-- Supabase Auth sign-in is wired up. Writes are still restricted to
-- `authenticated` by the baseline policy from the initial migration.
--
-- Tighten later: once Auth is in place, drop this policy and require JWT.

do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'beacon'
  loop
    execute format('drop policy if exists "anon read" on beacon.%I', t);
    execute format(
      'create policy "anon read" on beacon.%I for select to anon using (true)',
      t
    );
    -- Also grant table-level SELECT to anon (required in addition to RLS).
    execute format('grant select on beacon.%I to anon', t);
  end loop;
end $$;

-- Allow anon to resolve embedded FK joins by reading lookup rows.
grant usage on schema beacon to anon;
