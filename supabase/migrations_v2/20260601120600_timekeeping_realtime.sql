-- MSMM Beacon v2 — enable Supabase Realtime for timekeeping state-change
-- subscriptions used by subscribeMyTimeState() and subscribeEnrollSession()
-- in frontend/src/data.js.
--
-- Without this, the frontend's `.on("postgres_changes", ...)` channels
-- silently never fire — every reload appears correct, but cross-tab updates,
-- Pi-tap updates while the user has the Timesheet tab open, and async
-- classifier updates all go unseen until the user manually refreshes.
--
-- supabase_realtime is the default publication Supabase ships with. We add
-- the timekeeping read tables (every table the frontend subscribes to) and
-- set REPLICA IDENTITY FULL so the WAL payload carries enough column data
-- for the RLS-aware realtime broker to evaluate the row filter.
--
-- The DO block is fully idempotent — safe to re-run after any future
-- re-paste of the v2 migrations in Studio.

set search_path = beacon_v2, public, extensions;

do $$
declare
  _tables constant text[] := array[
    'time_intervals',
    'timesheet_days',
    'nfc_enroll_sessions'
  ];
  _t text;
  _qualified text;
begin
  -- Bail gracefully if the publication doesn't exist (e.g. a future Supabase
  -- migration renamed it). Without it, realtime subscriptions stay silent
  -- but the rest of the app keeps working.
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present; skipping';
    return;
  end if;

  foreach _t in array _tables loop
    _qualified := format('beacon_v2.%I', _t);

    -- Add to publication if not already a member
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'beacon_v2'
        and tablename = _t
    ) then
      execute format('alter publication supabase_realtime add table %s', _qualified);
    end if;

    -- Ensure REPLICA IDENTITY FULL so RLS row filters can evaluate against
    -- the OLD row on UPDATE/DELETE (default REPLICA IDENTITY is the PK only,
    -- which doesn't carry user_id for time_intervals — meaning the user_id
    -- filter wouldn't match).
    execute format('alter table %s replica identity full', _qualified);
  end loop;
end $$;
