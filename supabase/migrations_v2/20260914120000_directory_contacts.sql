-- MSMM Beacon v2 — Directory contacts: MANY contact people per client / company.
--
-- Until now each beacon_v2.clients / beacon_v2.companies row carried exactly one
-- contact (contact_person / email / phone as scalar columns). A client or firm
-- routinely has several people we deal with (PM, accounts payable, principal…),
-- so this migration introduces `beacon_v2.contacts` — one row per PERSON, hung
-- off either a client or a company (exactly one parent, CHECK-enforced).
--
-- Compatibility: the legacy scalar columns on clients / companies are LEFT IN
-- PLACE and kept in sync with the PRIMARY contact by a trigger (the primary,
-- or the first contact when no primary is flagged). Anything that still reads
-- `contact_person` / `email` / `phone` on the parent (legacy ingest scripts,
-- ad-hoc SQL, the merge preview) keeps working — but the frontend now reads and
-- writes `contacts` only. The parent columns are effectively read-only mirrors.
--
-- The one-time backfill turns every existing contact_person / email / phone
-- into a primary contact row, so nothing is lost at cutover.
--
-- Idempotent — safe to re-paste. Ends with `notify pgrst` so PostgREST serves
-- the new table immediately.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Table
--------------------------------------------------------------------------------
create table if not exists beacon_v2.contacts (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references beacon_v2.clients(id)   on delete cascade,
  company_id  uuid references beacon_v2.companies(id) on delete cascade,
  name        text not null,
  title       text,              -- role at the org: "Project Manager", "Accounts Payable"…
  email       text,
  phone       text,
  notes       text,
  is_primary  boolean not null default false,
  ord         integer not null default 0,   -- display order within the parent
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Exactly one parent.
  constraint contacts_one_parent check ((client_id is null) <> (company_id is null))
);

create index if not exists contacts_client_idx
  on beacon_v2.contacts (client_id, ord) where client_id is not null;
create index if not exists contacts_company_idx
  on beacon_v2.contacts (company_id, ord) where company_id is not null;
-- At most one primary contact per parent.
create unique index if not exists contacts_client_primary_uniq
  on beacon_v2.contacts (client_id) where is_primary and client_id is not null;
create unique index if not exists contacts_company_primary_uniq
  on beacon_v2.contacts (company_id) where is_primary and company_id is not null;

drop trigger if exists touch_contacts on beacon_v2.contacts;
create trigger touch_contacts before update on beacon_v2.contacts
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- 2. Mirror the primary contact back onto the parent's legacy scalar columns.
--    Runs after every insert / update / delete on contacts and re-derives the
--    parent(s) touched (both OLD and NEW parents on a re-parenting update).
--------------------------------------------------------------------------------
create or replace function beacon_v2.fn_contacts_mirror_primary()
returns trigger language plpgsql as $$
declare
  v_client   uuid;
  v_company  uuid;
  v_clients  uuid[] := '{}';
  v_companies uuid[] := '{}';
  r record;
begin
  if tg_op in ('INSERT','UPDATE') then
    if new.client_id  is not null then v_clients   := array_append(v_clients,   new.client_id);  end if;
    if new.company_id is not null then v_companies := array_append(v_companies, new.company_id); end if;
  end if;
  if tg_op in ('UPDATE','DELETE') then
    if old.client_id  is not null then v_clients   := array_append(v_clients,   old.client_id);  end if;
    if old.company_id is not null then v_companies := array_append(v_companies, old.company_id); end if;
  end if;

  foreach v_client in array v_clients loop
    select c.name, c.email, c.phone into r
      from beacon_v2.contacts c
     where c.client_id = v_client
     order by c.is_primary desc, c.ord, c.created_at
     limit 1;
    if found then
      update beacon_v2.clients set contact_person = r.name, email = r.email, phone = r.phone
       where id = v_client
         and (contact_person is distinct from r.name or email is distinct from r.email or phone is distinct from r.phone);
    else
      update beacon_v2.clients set contact_person = null, email = null, phone = null
       where id = v_client
         and (contact_person is not null or email is not null or phone is not null);
    end if;
  end loop;

  foreach v_company in array v_companies loop
    select c.name, c.email, c.phone into r
      from beacon_v2.contacts c
     where c.company_id = v_company
     order by c.is_primary desc, c.ord, c.created_at
     limit 1;
    if found then
      update beacon_v2.companies set contact_person = r.name, email = r.email, phone = r.phone
       where id = v_company
         and (contact_person is distinct from r.name or email is distinct from r.email or phone is distinct from r.phone);
    else
      update beacon_v2.companies set contact_person = null, email = null, phone = null
       where id = v_company
         and (contact_person is not null or email is not null or phone is not null);
    end if;
  end loop;

  return null;
end;
$$;

drop trigger if exists trg_contacts_mirror_primary on beacon_v2.contacts;
create trigger trg_contacts_mirror_primary
  after insert or update or delete on beacon_v2.contacts
  for each row execute function beacon_v2.fn_contacts_mirror_primary();

--------------------------------------------------------------------------------
-- 3. set_primary_contact(p_id) — atomically flip the primary flag within the
--    contact's parent (unset the old primary, set the new one) so callers never
--    trip the partial-unique index with a two-step update.
--------------------------------------------------------------------------------
create or replace function beacon_v2.set_primary_contact(p_id uuid)
returns void language plpgsql as $$
declare
  v_client  uuid;
  v_company uuid;
begin
  select client_id, company_id into v_client, v_company
    from beacon_v2.contacts where id = p_id;
  if not found then
    raise exception 'contact % not found', p_id using errcode = 'P0002';
  end if;
  if v_client is not null then
    update beacon_v2.contacts set is_primary = false
     where client_id = v_client and is_primary and id <> p_id;
  else
    update beacon_v2.contacts set is_primary = false
     where company_id = v_company and is_primary and id <> p_id;
  end if;
  update beacon_v2.contacts set is_primary = true where id = p_id and not is_primary;
end;
$$;

revoke all on function beacon_v2.set_primary_contact(uuid) from public, anon;
grant execute on function beacon_v2.set_primary_contact(uuid) to authenticated;

--------------------------------------------------------------------------------
-- 4. One-time backfill — every parent that has legacy contact data but no
--    contact rows yet gets ONE primary contact carrying that data.
--------------------------------------------------------------------------------
insert into beacon_v2.contacts (client_id, name, email, phone, is_primary, ord)
select c.id,
       coalesce(nullif(btrim(c.contact_person), ''), nullif(btrim(c.email), ''), 'Main contact'),
       nullif(btrim(c.email), ''),
       nullif(btrim(c.phone), ''),
       true, 0
  from beacon_v2.clients c
 where (nullif(btrim(c.contact_person), '') is not null
     or nullif(btrim(c.email), '') is not null
     or nullif(btrim(c.phone), '') is not null)
   and not exists (select 1 from beacon_v2.contacts x where x.client_id = c.id);

insert into beacon_v2.contacts (company_id, name, email, phone, is_primary, ord)
select c.id,
       coalesce(nullif(btrim(c.contact_person), ''), nullif(btrim(c.email), ''), 'Main contact'),
       nullif(btrim(c.email), ''),
       nullif(btrim(c.phone), ''),
       true, 0
  from beacon_v2.companies c
 where (nullif(btrim(c.contact_person), '') is not null
     or nullif(btrim(c.email), '') is not null
     or nullif(btrim(c.phone), '') is not null)
   and not exists (select 1 from beacon_v2.contacts x where x.company_id = c.id);

--------------------------------------------------------------------------------
-- 5. RLS — permissive for authenticated (the clients / companies posture: any
--    signed-in teammate maintains the Directory). No anon access.
--------------------------------------------------------------------------------
alter table beacon_v2.contacts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'beacon_v2' and tablename = 'contacts' and policyname = 'contacts_auth_all'
  ) then
    create policy contacts_auth_all on beacon_v2.contacts
      for all to authenticated using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on beacon_v2.contacts to authenticated;

notify pgrst, 'reload schema';
