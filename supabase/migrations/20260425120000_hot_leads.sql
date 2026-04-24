--------------------------------------------------------------------------------
-- Hot Leads — a lightweight side-channel tracker for potential opportunities
-- that haven't become Potential Projects yet (early conversations, partner
-- intros, trade-show follow-ups). Structurally similar to beacon.events:
-- a title, a datetime, a multi-user attendees list, an optional notes field,
-- and a client/company reference routed through the same two-FK pattern we
-- already use on project tables (client_id OR prime_company_id, never both
-- semantically — app-level routing via routeClientPick picks the right one).
--
-- Orthogonal to the project pipeline: no move-forward plumbing, no link to
-- Potential/Awaiting/Awarded. If a hot lead matures, the user creates a
-- Potential row manually.
--------------------------------------------------------------------------------

create table if not exists beacon.hot_leads (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  date_time         timestamptz,
  client_id         uuid references beacon.clients(id)   on delete set null,
  prime_company_id  uuid references beacon.companies(id) on delete set null,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists hot_leads_datetime_idx on beacon.hot_leads(date_time);
create index if not exists hot_leads_client_idx   on beacon.hot_leads(client_id);

drop trigger if exists touch_hot_leads on beacon.hot_leads;
create trigger touch_hot_leads before update on beacon.hot_leads
  for each row execute function beacon.touch_updated_at();

-- Multi-attendee join — mirrors event_attendees shape exactly.
create table if not exists beacon.hot_lead_attendees (
  hot_lead_id uuid not null references beacon.hot_leads(id) on delete cascade,
  user_id     uuid not null references beacon.users(id)     on delete cascade,
  primary key (hot_lead_id, user_id)
);
create index if not exists hot_lead_attendees_user_idx on beacon.hot_lead_attendees(user_id);

--------------------------------------------------------------------------------
-- RLS: match the prevailing "permissive for authenticated + anon-write-allowed"
-- baseline on every other beacon.* table. When the anon-write policies get
-- dropped per 20260421120000_allow_anon_write.sql's security note, this
-- table should be tightened in the same pass.
--------------------------------------------------------------------------------
alter table beacon.hot_leads           enable row level security;
alter table beacon.hot_lead_attendees  enable row level security;

create policy "auth full access" on beacon.hot_leads
  for all to authenticated using (true) with check (true);
create policy "anon read" on beacon.hot_leads
  for select to anon using (true);
create policy "anon insert" on beacon.hot_leads
  for insert to anon with check (true);
create policy "anon update" on beacon.hot_leads
  for update to anon using (true) with check (true);
create policy "anon delete" on beacon.hot_leads
  for delete to anon using (true);

create policy "auth full access" on beacon.hot_lead_attendees
  for all to authenticated using (true) with check (true);
create policy "anon read" on beacon.hot_lead_attendees
  for select to anon using (true);
create policy "anon insert" on beacon.hot_lead_attendees
  for insert to anon with check (true);
create policy "anon delete" on beacon.hot_lead_attendees
  for delete to anon using (true);
