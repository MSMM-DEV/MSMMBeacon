-- MSMM Beacon — adds:
--   1. "Board Meetings" as a valid event_type_enum value (for the Events tab).
--   2. awaiting_verdict.anticipated_result_date — surfaced in the Quad Sheet
--      and used as a secondary column in Awaiting Verdict itself.
--   3. A new SOQ table (Statement of Qualifications) that mirrors
--      awarded_projects and adds start_date + recurring. SOQs are a parallel
--      pipeline track — not fed by the move-forward flow.
--
-- ALTER TYPE ADD VALUE IF NOT EXISTS is supported on Supabase (PG15+).

--------------------------------------------------------------------------------
-- 1. Board Meetings event type
--------------------------------------------------------------------------------
alter type beacon.event_type_enum add value if not exists 'Board Meetings';

--------------------------------------------------------------------------------
-- 2. Anticipated result date on Awaiting Verdict
--------------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'beacon'
      and table_name   = 'awaiting_verdict'
      and column_name  = 'anticipated_result_date'
  ) then
    alter table beacon.awaiting_verdict
      add column anticipated_result_date date;
  end if;
end $$;

--------------------------------------------------------------------------------
-- 3. Recurring vocabulary for SOQ rows (text-with-check — simpler to evolve
--    than a PG enum, no ALTER TYPE hazards when the board adds values later).
--------------------------------------------------------------------------------
-- (No standalone CHECK here; we inline it on beacon.soq.recurring below.)

--------------------------------------------------------------------------------
-- 4. SOQ — Statement of Qualifications
--    Shape mirrors awarded_projects. Extras:
--      * start_date           — when the SOQ engagement window opens
--      * recurring            — Yes / No / Maybe / In Talks
--      * contract_expiry_date — reused as the end / expiration date
--    No source_awaiting_id: SOQs are parallel to the pipeline, not downstream.
--------------------------------------------------------------------------------
create table if not exists beacon.soq (
  id                     uuid primary key default gen_random_uuid(),
  year                   int not null,
  project_name           text not null,
  client_id              uuid references beacon.clients(id)   on delete restrict,
  prime_company_id       uuid references beacon.companies(id) on delete restrict,
  project_number         text,
  date_submitted         date,
  client_contract_number text,
  msmm_contract_number   text,
  msmm_used              numeric(14,2),
  msmm_remaining         numeric(14,2),
  stage_id               smallint references beacon.awarded_stages(id) on delete restrict,
  details                text,
  pool                   text,
  start_date             date,
  contract_expiry_date   date,
  recurring              text
    check (recurring is null or recurring in ('Yes','No','Maybe','In Talks')),
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists soq_year_idx   on beacon.soq(year);
create index if not exists soq_client_idx on beacon.soq(client_id);

drop trigger if exists touch_soq on beacon.soq;
create trigger touch_soq before update on beacon.soq
  for each row execute function beacon.touch_updated_at();

create table if not exists beacon.soq_subs (
  soq_id     uuid not null references beacon.soq(id) on delete cascade,
  company_id uuid not null references beacon.companies(id) on delete restrict,
  primary key (soq_id, company_id)
);

create table if not exists beacon.soq_pms (
  soq_id  uuid not null references beacon.soq(id) on delete cascade,
  user_id uuid not null references beacon.users(id) on delete cascade,
  primary key (soq_id, user_id)
);

--------------------------------------------------------------------------------
-- 5. RLS parity — match the baseline policy used for every other beacon table.
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in values ('soq'), ('soq_subs'), ('soq_pms')
  loop
    execute format('alter table beacon.%I enable row level security', t);
    execute format('drop policy if exists "auth full access" on beacon.%I', t);
    execute format(
      'create policy "auth full access" on beacon.%I for all to authenticated using (true) with check (true)',
      t
    );
    execute format('drop policy if exists "anon read" on beacon.%I', t);
    execute format(
      'create policy "anon read" on beacon.%I for select to anon using (true)',
      t
    );
    execute format('drop policy if exists "anon write" on beacon.%I', t);
    execute format(
      'create policy "anon write" on beacon.%I for all to anon using (true) with check (true)',
      t
    );
  end loop;
end $$;
