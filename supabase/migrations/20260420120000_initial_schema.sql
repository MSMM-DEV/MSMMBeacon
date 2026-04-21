-- MSMM Beacon — initial schema
-- Idempotent: safe to re-run (uses IF NOT EXISTS / ON CONFLICT / DO blocks).
-- Target: Supabase (Postgres 15+, auth schema present)

--------------------------------------------------------------------------------
-- Schema
-- All MSMM Beacon objects live in the 'beacon' schema.
-- Supabase auth.users stays in 'auth'; extensions stay in 'extensions'/public.
-- After running this migration, expose the 'beacon' schema in Supabase:
--   Dashboard → Settings → API → Exposed schemas → add "beacon".
--------------------------------------------------------------------------------
create schema if not exists beacon;

grant usage on schema beacon to anon, authenticated, service_role;
grant all on all tables    in schema beacon to anon, authenticated, service_role;
grant all on all sequences in schema beacon to anon, authenticated, service_role;
grant all on all routines  in schema beacon to anon, authenticated, service_role;
alter default privileges in schema beacon grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema beacon grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema beacon grant all on routines  to anon, authenticated, service_role;

set search_path = beacon, public, extensions;

--------------------------------------------------------------------------------
-- Extensions
--------------------------------------------------------------------------------
create extension if not exists pgcrypto;
create extension if not exists citext;

--------------------------------------------------------------------------------
-- Enums
--------------------------------------------------------------------------------
do $$ begin create type org_type_enum      as enum ('City','State','Federal','Local','Parish','Regional','Other'); exception when duplicate_object then null; end $$;
do $$ begin create type probability_enum   as enum ('High','Medium','Low'); exception when duplicate_object then null; end $$;
do $$ begin create type project_role_enum  as enum ('Prime','Sub'); exception when duplicate_object then null; end $$;
do $$ begin create type invoice_type_enum  as enum ('ENG','PM'); exception when duplicate_object then null; end $$;
do $$ begin create type event_status_enum  as enum ('Happened','Booked'); exception when duplicate_object then null; end $$;
do $$ begin create type event_type_enum    as enum ('Partner','AI','Project','Meetings','Event'); exception when duplicate_object then null; end $$;
do $$ begin create type recurrence_enum    as enum ('one_time','weekly','biweekly','monthly','custom'); exception when duplicate_object then null; end $$;
do $$ begin create type alert_subject_enum as enum ('potential','awaiting','awarded','closed_out','invoice','event'); exception when duplicate_object then null; end $$;

--------------------------------------------------------------------------------
-- Shared helpers
--------------------------------------------------------------------------------
create or replace function beacon.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

--------------------------------------------------------------------------------
-- Lookup: awarded stages (extensible — add rows from the app)
--------------------------------------------------------------------------------
create table if not exists beacon.awarded_stages (
  id          smallserial primary key,
  name        text not null unique,
  created_at  timestamptz not null default now()
);

insert into beacon.awarded_stages (name) values
  ('Multi-Use Contract'),
  ('Single Use Contract (Project)'),
  ('AE Selected List')
on conflict (name) do nothing;

--------------------------------------------------------------------------------
-- Users
-- Decoupled from auth.users so we can seed the roster now and link on first login.
-- A trigger on auth.users matches by email and backfills auth_user_id.
--------------------------------------------------------------------------------
create table if not exists beacon.users (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid unique references auth.users(id) on delete set null,
  login_name     text unique,
  first_name     text,
  last_name      text,
  display_name   text,
  short_name     text,          -- tag display; disambiguates duplicates (e.g. "Scott C.")
  email          citext not null unique,
  department     text,
  employee_type  text,
  location       text,
  is_enabled     boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists touch_users on beacon.users;
create trigger touch_users before update on beacon.users
  for each row execute function beacon.touch_updated_at();

create or replace function beacon.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = beacon, public, auth as $$
begin
  update beacon.users
     set auth_user_id = new.id, updated_at = now()
   where lower(email::text) = lower(new.email)
     and auth_user_id is null;
  if not found then
    insert into beacon.users (auth_user_id, email, display_name)
    values (new.id, new.email, split_part(new.email,'@',1))
    on conflict (email) do update set auth_user_id = excluded.auth_user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function beacon.handle_new_auth_user();

-- Seed the 30 users from the Replicon export.
-- short_name is set for disambiguation where display_name collides
-- (two Scotts, two Davids), and for the legacy tag "Phil" → Philip Meric.
insert into beacon.users (login_name, first_name, last_name, display_name, short_name, email, department, employee_type, location) values
  ('sdouglas',   'Scott',     'Douglas',   'Scott',     'Scott D.',  'scott@msmmeng.com',                    'Engineering',         'Full Time Salary',  'New Orleans'),
  ('bbertucci',  'Benjamin',  'Bertucci',  'Ben',       'Ben',       'BBertucci@msmmeng.com',                'Engineering',         'Full Time Salary',  'New Orleans'),
  ('manish',     'Manish',    'Mardia',    'Manish',    'Manish',    'mmardia@msmmeng.com',                  'Engineering',         'Full Time Salary',  'New Orleans'),
  ('milan',      'Milan',     'Mardia',    'Milan',     'Milan',     'Milan@msmmeng.com',                    'Engineering',         'Full Time Salary',  'New York'),
  ('mayank',     'Mayank',    'Mardia',    'Mayank',    'Mayank',    'Mayank@msmmeng.com',                   'Engineering',         'Full Time Salary',  'New York'),
  ('mwingate',   'Mark',      'Wingate',   'Mark',      'Mark',      'mwingate@msmmeng.com',                 'Engineering',         'Full Time Salary',  'New Orleans'),
  ('rmehta',     'Raj',       'Mehta',     'Raj',       'Raj',       'rmehta@msmmeng.com',                   'Engineering',         'Full Time Salary',  'New Orleans'),
  ('schehardy',  'Scott',     'Chehardy',  'Scott',     'Scott C.',  'schehardy@msmmeng.com',                'Engineering',         'Full Time Salary',  'Memphis'),
  ('ecurson',    'Eric',      'Curson',    'Eric',      'Eric',      'ecurson@msmmeng.com',                  'Engineering',         'Full Time Salary',  'New Orleans'),
  ('jwilson',    'Jim',       'Wilson',    'Jim',       'Jim',       'jwilson@msmmeng.com',                  'Engineering',         'Full Time Salary',  'New Orleans'),
  ('pmansfield', 'Patrick',   'Mansfield', 'Patrick',   'Patrick',   'pmansfield@msmmeng.com',               'Engineering',         'Full Time Salary',  'New Orleans'),
  ('arichards',  'Autumn',    'Richards',  'Autumn',    'Autumn',    'ARichards@msmmeng.com',                'Engineering',         'Full Time Salary',  'New Orleans'),
  ('dalexander', 'Dani',      'Alexander', 'Dani',      'Dani',      'dalexander@msmmeng.com',               'Project Management',  'Full Time Salary',  'New Orleans'),
  ('cerwin',     'Cierra',    'Erwin',     'Cierra',    'Cierra',    'cerwin@msmmeng.com',                   'Project Management',  'Full Time Salary',  'New Orleans'),
  ('rroessler',  'Ryan',      'Roessler',  'Ryan',      'Ryan',      'Rroessler@msmmeng.com',                'Project Management',  'Full Time Salary',  'New Orleans'),
  ('ccarriere',  'Chantrell', 'Carriere',  'Chantrell', 'Chantrell', 'ccarriere@msmmeng.com',                'Project Management',  'Full Time Salary',  'New Orleans'),
  ('dshulman',   'David',     'Shulman',   'David',     'David S.',  'dshulman@msmmeng.com',                 'Project Management',  'Full Time Salary',  'New Orleans'),
  ('cmills',     'Chris',     'Mills',     'Chris',     'Chris',     'cmills@msmmeng.com',                   'Engineering',         'Full Time Salary',  'New Orleans'),
  ('sseiler',    'Stuart',    'Seiler',    'Stuart',    'Stuart',    'SSeiler@msmmeng.com',                  'Engineering',         'Full Time Salary',  'New Orleans'),
  ('binh',       'Binh',      'Li',        'Binh',      'Binh',      'Binh@msmmeng.com',                     'Engineering',         'Full Time Hourly',  'New Orleans'),
  ('cray',       'Clay',      'Ray',       'Clay',      'Clay',      'cray@msmmeng.com',                     'Engineering',         'Full Time Salary',  'New Orleans'),
  ('pmeric',     'Philip',    'Meric',     'Philip',    'Phil',      'pmeric@msmmeng.com',                   'Project Management',  'Full Time Salary',  'New Orleans'),
  ('ggrimes',    'George',    'Grimes',    'George',    'George',    'GGrimes@msmmeng.com',                  'Engineering',         'Part Time Hourly',  'New Orleans'),
  ('sbobeck',    'Steve',     'Bobeck',    'Steve',     'Steve',     'sbobeck@msmmeng.com',                  'Engineering',         'Part Time Hourly',  'New Orleans'),
  ('djones',     'David',     'Jones',     'David',     'David J.',  'DJones@msmmeng.com',                   'Engineering',         'Part Time Hourly',  'New Orleans'),
  ('dsmith',     'Dominque',  'Smith',     'Dominque',  'Dominque',  'dsmith@msmmeng.com',                   'Project Management',  'Full Time Salary',  'New Orleans'),
  ('mharden',    'Mike',      'Harden',    'Mike',      'Mike',      'mrhardenllc@bellsouth.net',            'Project Management',  'Part Time Hourly',  'New Orleans'),
  ('lwalker',    'Lee',       'Walker',    'Lee',       'Lee',       'lee.walker@fieldsec.com',              'Project Management',  'Part Time Hourly',  'New Orleans'),
  ('cbrannon',   'Chuck',     'Brannon',   'Brannon',   'Chuck',     'charles.brannon@b2controlsolutions.com','Project Management', 'Part Time Hourly',  'New Orleans'),
  ('sleonard',   'Stephen',   'Leonard',   'Stephen',   'Stephen',   'SLeonard@msmmeng.com',                 'Engineering',         'Part Time Hourly',  'New Orleans')
on conflict (email) do nothing;

--------------------------------------------------------------------------------
-- Clients
--   name+district unique; org_type moved off project rows to here (1:1 with client).
--   For USACE-style rows, ingest splits "USACE-MVN-New Orleans District"
--     → name="USACE", district="MVN-New Orleans District".
--------------------------------------------------------------------------------
create table if not exists beacon.clients (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  district       text,
  org_type       org_type_enum,
  contact_person text,
  email          citext,
  phone          text,
  address        text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index if not exists clients_name_district_uniq
  on beacon.clients (name, coalesce(district, ''));

drop trigger if exists touch_clients on beacon.clients;
create trigger touch_clients before update on beacon.clients
  for each row execute function beacon.touch_updated_at();

--------------------------------------------------------------------------------
-- Companies
--   Dedup by name. MSMM is a real row; is_msmm flag enforces singleton.
--   Invariant (enforced in app): MSMM can be prime OR in subs, never both on one row.
--------------------------------------------------------------------------------
create table if not exists beacon.companies (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  is_msmm        boolean not null default false,
  contact_person text,
  email          citext,
  phone          text,
  address        text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists companies_single_msmm
  on beacon.companies ((1)) where is_msmm;

drop trigger if exists touch_companies on beacon.companies;
create trigger touch_companies before update on beacon.companies
  for each row execute function beacon.touch_updated_at();

insert into beacon.companies (name, is_msmm) values ('MSMM', true)
on conflict (name) do nothing;

--------------------------------------------------------------------------------
-- Stage 1 — Potential Projects
--   role can be NULL for legacy rows that never had Prime/Sub filled in.
--   When role='Prime', MSMM is the prime; prime_company_id is NULL by convention.
--   When role='Sub', prime_company_id points to the external prime firm.
--------------------------------------------------------------------------------
create table if not exists beacon.potential_projects (
  id                    uuid primary key default gen_random_uuid(),
  year                  int not null,
  project_name          text not null,
  role                  project_role_enum,
  client_id             uuid references beacon.clients(id)   on delete restrict,
  prime_company_id      uuid references beacon.companies(id) on delete restrict,
  total_contract_amount numeric(14,2),
  msmm_amount           numeric(14,2),
  notes                 text,
  next_action_date      date,
  next_action_note      text,
  project_number        text,
  probability           probability_enum,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint potential_role_prime_consistency check (
    role is null
    or (role = 'Prime' and prime_company_id is null)
    or (role = 'Sub'   and prime_company_id is not null)
  )
);

create index if not exists potential_projects_year_idx on beacon.potential_projects(year);
create index if not exists potential_projects_client_idx on beacon.potential_projects(client_id);

drop trigger if exists touch_potential_projects on beacon.potential_projects;
create trigger touch_potential_projects before update on beacon.potential_projects
  for each row execute function beacon.touch_updated_at();

create table if not exists beacon.potential_project_subs (
  id                   uuid primary key default gen_random_uuid(),
  potential_project_id uuid not null references beacon.potential_projects(id) on delete cascade,
  ord                  int,
  company_id           uuid references beacon.companies(id) on delete restrict,
  discipline           text,
  amount               numeric(14,2),
  created_at           timestamptz not null default now()
);
create index if not exists potential_project_subs_parent_idx
  on beacon.potential_project_subs(potential_project_id);

create table if not exists beacon.potential_project_pms (
  potential_project_id uuid not null references beacon.potential_projects(id) on delete cascade,
  user_id              uuid not null references beacon.users(id) on delete cascade,
  primary key (potential_project_id, user_id)
);

--------------------------------------------------------------------------------
-- Stage 2 — Awaiting Verdict
--------------------------------------------------------------------------------
create table if not exists beacon.awaiting_verdict (
  id                     uuid primary key default gen_random_uuid(),
  source_potential_id    uuid references beacon.potential_projects(id) on delete set null,
  year                   int not null,
  project_name           text not null,
  client_id              uuid references beacon.clients(id)   on delete restrict,
  prime_company_id       uuid references beacon.companies(id) on delete restrict,
  project_number         text,
  notes                  text,
  date_submitted         date,
  client_contract_number text,
  msmm_contract_number   text,
  msmm_used              numeric(14,2),
  msmm_remaining         numeric(14,2),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists awaiting_verdict_year_idx on beacon.awaiting_verdict(year);
create index if not exists awaiting_verdict_client_idx on beacon.awaiting_verdict(client_id);

drop trigger if exists touch_awaiting_verdict on beacon.awaiting_verdict;
create trigger touch_awaiting_verdict before update on beacon.awaiting_verdict
  for each row execute function beacon.touch_updated_at();

create table if not exists beacon.awaiting_verdict_subs (
  awaiting_verdict_id uuid not null references beacon.awaiting_verdict(id) on delete cascade,
  company_id          uuid not null references beacon.companies(id) on delete restrict,
  primary key (awaiting_verdict_id, company_id)
);

create table if not exists beacon.awaiting_verdict_pms (
  awaiting_verdict_id uuid not null references beacon.awaiting_verdict(id) on delete cascade,
  user_id             uuid not null references beacon.users(id) on delete cascade,
  primary key (awaiting_verdict_id, user_id)
);

--------------------------------------------------------------------------------
-- Stage 3a — Awarded Projects
--------------------------------------------------------------------------------
create table if not exists beacon.awarded_projects (
  id                     uuid primary key default gen_random_uuid(),
  source_awaiting_id     uuid references beacon.awaiting_verdict(id) on delete set null,
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
  contract_expiry_date   date,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists awarded_projects_year_idx on beacon.awarded_projects(year);
create index if not exists awarded_projects_client_idx on beacon.awarded_projects(client_id);

drop trigger if exists touch_awarded_projects on beacon.awarded_projects;
create trigger touch_awarded_projects before update on beacon.awarded_projects
  for each row execute function beacon.touch_updated_at();

create table if not exists beacon.awarded_project_subs (
  awarded_project_id uuid not null references beacon.awarded_projects(id) on delete cascade,
  company_id         uuid not null references beacon.companies(id) on delete restrict,
  primary key (awarded_project_id, company_id)
);

create table if not exists beacon.awarded_project_pms (
  awarded_project_id uuid not null references beacon.awarded_projects(id) on delete cascade,
  user_id            uuid not null references beacon.users(id) on delete cascade,
  primary key (awarded_project_id, user_id)
);

--------------------------------------------------------------------------------
-- Stage 3b — Closed Out Projects
--------------------------------------------------------------------------------
create table if not exists beacon.closed_out_projects (
  id                     uuid primary key default gen_random_uuid(),
  source_awaiting_id     uuid references beacon.awaiting_verdict(id) on delete set null,
  year                   int not null,
  project_name           text not null,
  client_id              uuid references beacon.clients(id)   on delete restrict,
  prime_company_id       uuid references beacon.companies(id) on delete restrict,
  project_number         text,
  date_submitted         date,
  client_contract_number text,
  msmm_contract_number   text,
  notes                  text,
  date_closed            date,
  reason_for_closure     text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

drop trigger if exists touch_closed_out_projects on beacon.closed_out_projects;
create trigger touch_closed_out_projects before update on beacon.closed_out_projects
  for each row execute function beacon.touch_updated_at();

create table if not exists beacon.closed_out_project_pms (
  closed_out_project_id uuid not null references beacon.closed_out_projects(id) on delete cascade,
  user_id               uuid not null references beacon.users(id) on delete cascade,
  primary key (closed_out_project_id, user_id)
);

--------------------------------------------------------------------------------
-- Table 4 — Anticipated Invoice (one row per awarded project per billing year)
--   All 12 months are stored as numeric. Actual/Projection is NOT stored —
--   it is derived at read time from CURRENT_DATE via the view below.
--------------------------------------------------------------------------------
create table if not exists beacon.anticipated_invoice (
  id                                uuid primary key default gen_random_uuid(),
  source_awarded_id                 uuid references beacon.awarded_projects(id) on delete set null,
  year                              int not null,
  project_number                    text,
  project_name                      text not null,
  contract_amount                   numeric(14,2),
  type                              invoice_type_enum,
  msmm_remaining_to_bill_year_start numeric(14,2),
  jan_amount                        numeric(14,2),
  feb_amount                        numeric(14,2),
  mar_amount                        numeric(14,2),
  apr_amount                        numeric(14,2),
  may_amount                        numeric(14,2),
  jun_amount                        numeric(14,2),
  jul_amount                        numeric(14,2),
  aug_amount                        numeric(14,2),
  sep_amount                        numeric(14,2),
  oct_amount                        numeric(14,2),
  nov_amount                        numeric(14,2),
  dec_amount                        numeric(14,2),
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now(),
  unique (source_awarded_id, year)
);

create index if not exists anticipated_invoice_year_idx on beacon.anticipated_invoice(year);

drop trigger if exists touch_anticipated_invoice on beacon.anticipated_invoice;
create trigger touch_anticipated_invoice before update on beacon.anticipated_invoice
  for each row execute function beacon.touch_updated_at();

create table if not exists beacon.anticipated_invoice_pms (
  anticipated_invoice_id uuid not null references beacon.anticipated_invoice(id) on delete cascade,
  user_id                uuid not null references beacon.users(id) on delete cascade,
  primary key (anticipated_invoice_id, user_id)
);

-- Per-month Actual/Projection view (kind is derived from CURRENT_DATE)
create or replace view beacon.v_anticipated_invoice_months as
with months(month_num) as (values (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12))
select
  i.id as invoice_id,
  i.year,
  m.month_num,
  case
    when i.year < extract(year from current_date)::int then 'Actual'
    when i.year > extract(year from current_date)::int then 'Projection'
    when m.month_num <= extract(month from current_date)::int then 'Actual'
    else 'Projection'
  end as kind,
  case m.month_num
    when 1  then i.jan_amount when 2  then i.feb_amount when 3  then i.mar_amount
    when 4  then i.apr_amount when 5  then i.may_amount when 6  then i.jun_amount
    when 7  then i.jul_amount when 8  then i.aug_amount when 9  then i.sep_amount
    when 10 then i.oct_amount when 11 then i.nov_amount when 12 then i.dec_amount
  end as amount
from beacon.anticipated_invoice i
cross join months m;

-- YTD totals view
create or replace view beacon.v_anticipated_invoice_totals as
select
  m.invoice_id,
  max(i.year) as year,
  sum(case when m.kind = 'Actual'     then coalesce(m.amount,0) else 0 end) as ytd_actual,
  sum(case when m.kind = 'Projection' then coalesce(m.amount,0) else 0 end) as projected_remaining
from beacon.v_anticipated_invoice_months m
join beacon.anticipated_invoice i on i.id = m.invoice_id
group by m.invoice_id;

--------------------------------------------------------------------------------
-- Table 5 — Events and Other (standalone)
--------------------------------------------------------------------------------
create table if not exists beacon.events (
  id             uuid primary key default gen_random_uuid(),
  event_date     date,
  status         event_status_enum,
  type           event_type_enum,
  title          text not null,
  event_datetime timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists touch_events on beacon.events;
create trigger touch_events before update on beacon.events
  for each row execute function beacon.touch_updated_at();

create table if not exists beacon.event_attendees (
  event_id uuid not null references beacon.events(id) on delete cascade,
  user_id  uuid not null references beacon.users(id)  on delete cascade,
  primary key (event_id, user_id)
);

--------------------------------------------------------------------------------
-- Alerts (polymorphic — one table for all row-level alerts across stages 1-5)
--------------------------------------------------------------------------------
create table if not exists beacon.alerts (
  id              uuid primary key default gen_random_uuid(),
  subject_table   alert_subject_enum not null,
  subject_row_id  uuid not null,
  first_fire_at   timestamptz not null,
  recurrence      recurrence_enum not null default 'one_time',
  recurrence_rule text,          -- iCal RRULE when recurrence='custom'
  message         text,
  created_by      uuid references beacon.users(id) on delete set null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists alerts_subject_idx on beacon.alerts(subject_table, subject_row_id);

drop trigger if exists touch_alerts on beacon.alerts;
create trigger touch_alerts before update on beacon.alerts
  for each row execute function beacon.touch_updated_at();

create table if not exists beacon.alert_recipients (
  alert_id uuid not null references beacon.alerts(id) on delete cascade,
  user_id  uuid not null references beacon.users(id)  on delete cascade,
  primary key (alert_id, user_id)
);

create table if not exists beacon.alert_fires (
  id            uuid primary key default gen_random_uuid(),
  alert_id      uuid not null references beacon.alerts(id) on delete cascade,
  scheduled_at  timestamptz not null,
  fired_at      timestamptz,
  status        text not null default 'pending',  -- pending | sent | failed | skipped
  error_message text,
  created_at    timestamptz not null default now()
);

create index if not exists alert_fires_due_idx
  on beacon.alert_fires(scheduled_at) where status = 'pending';

--------------------------------------------------------------------------------
-- RLS — internal-tool baseline: authenticated users have full CRUD.
-- Tighten per-role later if/when role distinctions are introduced.
--------------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'beacon'
      and tablename not in ('schema_migrations')
  loop
    execute format('alter table beacon.%I enable row level security', t);
    execute format('drop policy if exists "auth full access" on beacon.%I', t);
    execute format(
      'create policy "auth full access" on beacon.%I for all to authenticated using (true) with check (true)',
      t
    );
  end loop;
end $$;
