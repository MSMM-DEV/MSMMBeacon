-- MSMM Beacon v2 — staged preparation for the canonical-company cutover.
--
-- Apply this small migration first, then run the read-only preflight. When an
-- automatic match is ambiguous, an operator may record the reviewed mapping
-- here before applying 20261012130000_unified_companies.sql.

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.companies add column if not exists district text;
alter table beacon_v2.companies add column if not exists org_type beacon_v2.org_type_enum;
alter table beacon_v2.companies add column if not exists website text;

do $$
begin
  if to_regclass('beacon_v2.company_unification_overrides') is null then
    if to_regclass('beacon_v2.clients') is null then
      raise exception 'company prep requires the legacy beacon_v2.clients table';
    end if;
    execute $create$
      create table beacon_v2.company_unification_overrides (
        client_id uuid primary key references beacon_v2.clients(id) on delete cascade,
        company_id uuid not null references beacon_v2.companies(id) on delete restrict,
        created_at timestamptz not null default now()
      )
    $create$;
  end if;
end;
$$;

revoke all on table beacon_v2.company_unification_overrides from public, anon, authenticated;

comment on table beacon_v2.company_unification_overrides is
  'Operator-reviewed legacy client to canonical company mappings used only by the staged 2026-10 cutover.';

notify pgrst, 'reload schema';
