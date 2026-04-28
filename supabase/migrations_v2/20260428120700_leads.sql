-- MSMM Beacon v2 — leads (renamed from hot_leads) + lead_attendees.
--
-- Lightweight side-channel tracker for early-stage opportunities that
-- haven't become Projects yet. Same shape as v1 hot_leads, just renamed —
-- "hot" was inherited from a customer spreadsheet column header and adds
-- nothing semantically.
--
-- Status comes built-in (v1 added it via 20260426120000_hot_leads_alerts.sql).

set search_path = beacon_v2, public, extensions;

create table if not exists beacon_v2.leads (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  date_time         timestamptz,
  client_id         uuid references beacon_v2.clients(id)   on delete set null,
  prime_company_id  uuid references beacon_v2.companies(id) on delete set null,
  status            beacon_v2.lead_status_enum not null default 'Scheduled',
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists leads_datetime_idx on beacon_v2.leads (date_time);
create index if not exists leads_client_idx   on beacon_v2.leads (client_id);

drop trigger if exists touch_leads on beacon_v2.leads;
create trigger touch_leads before update on beacon_v2.leads
  for each row execute function beacon_v2.touch_updated_at();

create table if not exists beacon_v2.lead_attendees (
  lead_id uuid not null references beacon_v2.leads(id)  on delete cascade,
  user_id uuid not null references beacon_v2.users(id) on delete cascade,
  primary key (lead_id, user_id)
);
create index if not exists lead_attendees_user_idx on beacon_v2.lead_attendees (user_id);
