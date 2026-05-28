-- MSMM Beacon v2 — leads.type column (Engineering / AI).
--
-- Hot Leads gain a `type` discriminator so the team can separate Engineering
-- opportunities from AI work in the same tracker. Existing rows survive
-- as `type IS NULL` (rendered as "—" in the UI); the user can backfill via
-- the inline select on each row.
--
-- Notify PostgREST at the end so the new column + enum show up immediately
-- without needing a Studio reload of the schema cache.

set search_path = beacon_v2, public, extensions;

-- 1. Enum
do $$
begin
  if not exists (select 1 from pg_type where typname = 'lead_type_enum') then
    create type beacon_v2.lead_type_enum as enum ('Engineering', 'AI');
  end if;
end $$;

-- 2. Column
alter table beacon_v2.leads
  add column if not exists type beacon_v2.lead_type_enum;

-- 3. Reload PostgREST cache so the column is queryable from the frontend
--    without restarting the API.
notify pgrst, 'reload schema';
