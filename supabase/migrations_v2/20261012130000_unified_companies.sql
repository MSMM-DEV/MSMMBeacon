-- MSMM Beacon v2 — one canonical company master.
--
-- Client / Prime / Sub remain relationship roles, but every outside
-- organization now lives in beacon_v2.companies. Run the read-only
-- scripts/preflight_unified_companies.sql first. This migration is one
-- transaction: any unresolved conflict or failed invariant rolls it all back.

begin;
set local search_path = beacon_v2, public, extensions;

alter table beacon_v2.companies add column if not exists district text;
alter table beacon_v2.companies add column if not exists org_type beacon_v2.org_type_enum;
alter table beacon_v2.companies add column if not exists website text;

-- Studio-only operator decisions are staged by the prep migration so they can
-- be reviewed before this transaction starts.
do $$
begin
  if to_regclass('beacon_v2.company_unification_overrides') is null then
    raise exception 'apply 20261012125000_company_unification_prep.sql before the company cutover';
  end if;
end;
$$;
revoke all on table beacon_v2.company_unification_overrides from public, anon, authenticated;

create or replace function beacon_v2.fn_normalize_company_name(p_value text)
returns text
language sql
immutable
parallel safe
as $$
  select lower(regexp_replace(btrim(coalesce(p_value, '')), '[^a-z0-9]+', '', 'gi'));
$$;

do $migration$
declare
  r record;
  v_target uuid;
  v_name text;
  v_suffix int;
  v_contacts_before bigint;
  v_project_clients_before bigint;
  v_lead_clients_before bigint;
  v_bid_clients_before bigint;
  v_item_clients_before bigint;
begin
  -- A completed cutover has no live clients table. Re-pasting is a no-op.
  if to_regclass('beacon_v2.clients') is null then
    return;
  end if;

  select count(*) into v_contacts_before from beacon_v2.contacts;
  select count(*) into v_project_clients_before from beacon_v2.projects where client_id is not null;
  select count(*) into v_lead_clients_before from beacon_v2.leads where client_id is not null;
  select count(*) into v_bid_clients_before from beacon_v2.open_bids where client_id is not null;
  select count(*) into v_item_clients_before from beacon_v2.project_items where client_id is not null;

  create temporary table tmp_company_map (
    client_id uuid primary key,
    company_id uuid not null,
    reason text not null
  ) on commit drop;

  -- Explicit operator decisions win.
  insert into tmp_company_map (client_id, company_id, reason)
  select o.client_id, o.company_id, 'override'
    from beacon_v2.company_unification_overrides o
    join beacon_v2.clients c on c.id = o.client_id
    join beacon_v2.companies f on f.id = o.company_id;

  -- Automatic matches are deliberately strict: name+district, or a base name
  -- that occurs for only one client. Multiple candidate companies are not used.
  with client_names as (
    select c.*,
           beacon_v2.fn_normalize_company_name(c.name) as name_key,
           beacon_v2.fn_normalize_company_name(c.name || coalesce(' ' || c.district, '')) as display_key,
           count(*) over (partition by beacon_v2.fn_normalize_company_name(c.name)) as same_name_count
      from beacon_v2.clients c
  ), candidates as (
    select c.id as client_id, f.id as company_id
      from client_names c
      join beacon_v2.companies f
        on beacon_v2.fn_normalize_company_name(f.name) = c.display_key
        or (c.same_name_count = 1 and beacon_v2.fn_normalize_company_name(f.name) = c.name_key)
     where not exists (select 1 from tmp_company_map m where m.client_id = c.id)
  ), single_match as (
    select client_id, (array_agg(company_id order by company_id))[1] as company_id
      from candidates
     group by client_id
    having count(*) = 1
  )
  insert into tmp_company_map (client_id, company_id, reason)
  select client_id, company_id, 'exact'
    from single_match;

  -- Unmatched clients become companies. Preserve the UUID unless it already
  -- belongs to another company; preserve district identity in the display name
  -- when a plain name would collide.
  for r in
    select c.*
      from beacon_v2.clients c
     where not exists (select 1 from tmp_company_map m where m.client_id = c.id)
     order by c.name, c.district nulls first, c.id
  loop
    v_target := r.id;
    if exists (select 1 from beacon_v2.companies where id = v_target) then
      v_target := gen_random_uuid();
    end if;

    v_name := btrim(r.name);
    if exists (
      select 1 from beacon_v2.companies f
       where beacon_v2.fn_normalize_company_name(f.name) = beacon_v2.fn_normalize_company_name(r.name)
    ) or exists (
      select 1 from beacon_v2.clients c2
       where c2.id <> r.id
         and beacon_v2.fn_normalize_company_name(c2.name) = beacon_v2.fn_normalize_company_name(r.name)
    ) then
      v_name := btrim(r.name) || ' — ' || coalesce(nullif(btrim(r.district), ''), left(v_target::text, 8));
    end if;

    v_suffix := 1;
    while exists (select 1 from beacon_v2.companies where lower(name) = lower(v_name)) loop
      v_suffix := v_suffix + 1;
      v_name := btrim(r.name) || ' — ' || coalesce(nullif(btrim(r.district), ''), left(v_target::text, 8)) || ' ' || v_suffix;
    end loop;

    insert into beacon_v2.companies (
      id, name, is_msmm, district, org_type, contact_person, email, phone,
      address, notes, created_at, updated_at
    ) values (
      v_target, v_name, false, r.district, r.org_type, r.contact_person,
      r.email, r.phone, r.address, r.notes, r.created_at, r.updated_at
    );
    insert into tmp_company_map values (r.id, v_target, 'created');
  end loop;

  if (select count(*) from tmp_company_map) <> (select count(*) from beacon_v2.clients) then
    raise exception 'company cutover: not every client received a company mapping';
  end if;

  -- Profile differences are operator decisions, not migration guesses. The
  -- preflight names every differing field. It must be resolved by editing the
  -- source/canonical row or choosing a different override before cutover.
  if exists (
    select 1
      from tmp_company_map m
      join beacon_v2.clients c on c.id = m.client_id
      join beacon_v2.companies f on f.id = m.company_id
      cross join lateral (values
        ('district', nullif(btrim(f.district), ''), nullif(btrim(c.district), '')),
        ('org_type', f.org_type::text, c.org_type::text),
        ('contact_person', nullif(btrim(f.contact_person), ''), nullif(btrim(c.contact_person), '')),
        ('email', nullif(lower(btrim(f.email)), ''), nullif(lower(btrim(c.email)), '')),
        ('phone', nullif(regexp_replace(f.phone, '\D', '', 'g'), ''), nullif(regexp_replace(c.phone, '\D', '', 'g'), '')),
        ('address', nullif(lower(btrim(f.address)), ''), nullif(lower(btrim(c.address)), '')),
        ('notes', nullif(btrim(f.notes), ''), nullif(btrim(c.notes), ''))
      ) d(field_name, company_value, client_value)
     where d.company_value is not null
       and d.client_value is not null
       and d.company_value <> d.client_value
  ) or exists (
    select 1
      from tmp_company_map m
      join beacon_v2.clients c on c.id = m.client_id
      cross join lateral (values
        ('district', nullif(lower(btrim(c.district)), '')),
        ('org_type', c.org_type::text),
        ('contact_person', nullif(lower(btrim(c.contact_person)), '')),
        ('email', nullif(lower(btrim(c.email)), '')),
        ('phone', nullif(regexp_replace(c.phone, '\D', '', 'g'), '')),
        ('address', nullif(lower(btrim(c.address)), '')),
        ('notes', nullif(btrim(c.notes), ''))
      ) d(field_name, client_value)
     where d.client_value is not null
     group by m.company_id, d.field_name
    having count(distinct d.client_value) > 1
  ) then
    raise exception 'company cutover: conflicting non-empty profile values; resolve the preflight profile_conflict report first';
  end if;

  -- Fill blanks on matched companies deterministically; conflicts were blocked
  -- above, so each aggregate has at most one meaningful value.
  with profile as (
    select m.company_id,
           max(nullif(btrim(c.district), '')) as district,
           max(c.org_type::text)::beacon_v2.org_type_enum as org_type,
           max(nullif(btrim(c.contact_person), '')) as contact_person,
           max(nullif(btrim(c.email), '')) as email,
           max(nullif(btrim(c.phone), '')) as phone,
           max(nullif(btrim(c.address), '')) as address,
           max(nullif(btrim(c.notes), '')) as notes
      from tmp_company_map m
      join beacon_v2.clients c on c.id = m.client_id
     group by m.company_id
  )
  update beacon_v2.companies f
     set district       = coalesce(nullif(f.district, ''), p.district),
         org_type       = coalesce(f.org_type, p.org_type),
         contact_person = coalesce(nullif(f.contact_person, ''), p.contact_person),
         email          = coalesce(nullif(f.email, ''), p.email),
         phone          = coalesce(nullif(f.phone, ''), p.phone),
         address        = coalesce(nullif(f.address, ''), p.address),
         notes          = coalesce(nullif(f.notes, ''), p.notes)
    from profile p
   where f.id = p.company_id;

  -- Conflicting dual-prime rows require an operator decision; do not guess.
  if exists (
    select 1
      from beacon_v2.projects p
      join tmp_company_map m on m.client_id = p.prime_client_id
     where p.prime_company_id is not null
       and p.prime_company_id <> m.company_id
  ) then
    raise exception 'company cutover: conflicting prime_client_id and prime_company_id; resolve the preflight report first';
  end if;

  alter table beacon_v2.projects drop constraint if exists projects_client_id_fkey;
  alter table beacon_v2.projects drop constraint if exists projects_prime_client_id_fkey;
  alter table beacon_v2.leads drop constraint if exists leads_client_id_fkey;
  alter table beacon_v2.open_bids drop constraint if exists open_bids_client_id_fkey;
  alter table beacon_v2.project_items drop constraint if exists project_items_client_id_fkey;
  alter table beacon_v2.contacts drop constraint if exists contacts_client_id_fkey;

  update beacon_v2.projects p set client_id = m.company_id
    from tmp_company_map m where p.client_id = m.client_id;
  update beacon_v2.leads l set client_id = m.company_id
    from tmp_company_map m where l.client_id = m.client_id;
  update beacon_v2.open_bids b set client_id = m.company_id
    from tmp_company_map m where b.client_id = m.client_id;
  update beacon_v2.project_items i set client_id = m.company_id
    from tmp_company_map m where i.client_id = m.client_id;

  update beacon_v2.projects p
     set prime_company_id = coalesce(p.prime_company_id, m.company_id),
         prime_client_id = null
    from tmp_company_map m
   where p.prime_client_id = m.client_id;

  -- Move contacts without violating the one-primary-per-company index. Retain
  -- an existing company primary; otherwise prefer an incoming primary, then ord.
  create temporary table tmp_incoming_contacts on commit drop as
  select ct.id, m.company_id, ct.is_primary as was_primary, ct.ord, ct.created_at
    from beacon_v2.contacts ct
    join tmp_company_map m on m.client_id = ct.client_id;

  update beacon_v2.contacts ct
     set is_primary = false
   where exists (select 1 from tmp_incoming_contacts x where x.id = ct.id)
     and ct.is_primary;

  update beacon_v2.contacts ct
     set company_id = x.company_id,
         client_id = null
    from tmp_incoming_contacts x
   where ct.id = x.id;

  for r in
    select distinct x.company_id
      from tmp_incoming_contacts x
     where not exists (
       select 1 from beacon_v2.contacts ct
        where ct.company_id = x.company_id and ct.is_primary
     )
  loop
    update beacon_v2.contacts
       set is_primary = true
     where id = (
       select x.id
         from tmp_incoming_contacts x
        where x.company_id = r.company_id
        order by x.was_primary desc, x.ord, x.created_at, x.id
        limit 1
     );
  end loop;

  alter table beacon_v2.contacts drop constraint if exists contacts_one_parent;
  drop index if exists beacon_v2.contacts_client_idx;
  drop index if exists beacon_v2.contacts_client_primary_uniq;
  alter table beacon_v2.contacts drop column if exists client_id;
  alter table beacon_v2.contacts alter column company_id set not null;

  alter table beacon_v2.projects drop constraint if exists projects_prime_at_most_one;
  drop index if exists beacon_v2.projects_prime_client_idx;
  alter table beacon_v2.projects drop column if exists prime_client_id;

  alter table beacon_v2.projects
    add constraint projects_client_id_fkey foreign key (client_id)
    references beacon_v2.companies(id) on delete restrict;
  alter table beacon_v2.leads
    add constraint leads_client_id_fkey foreign key (client_id)
    references beacon_v2.companies(id) on delete set null;
  alter table beacon_v2.open_bids
    add constraint open_bids_client_id_fkey foreign key (client_id)
    references beacon_v2.companies(id) on delete set null;
  alter table beacon_v2.project_items
    add constraint project_items_client_id_fkey foreign key (client_id)
    references beacon_v2.companies(id) on delete set null;

  if (select count(*) from beacon_v2.contacts) <> v_contacts_before then
    raise exception 'company cutover: contact count changed';
  end if;
  if (select count(*) from beacon_v2.projects where client_id is not null) <> v_project_clients_before then
    raise exception 'company cutover: project client reference count changed';
  end if;
  if (select count(*) from beacon_v2.leads where client_id is not null) <> v_lead_clients_before then
    raise exception 'company cutover: lead client reference count changed';
  end if;
  if (select count(*) from beacon_v2.open_bids where client_id is not null) <> v_bid_clients_before then
    raise exception 'company cutover: bid client reference count changed';
  end if;
  if (select count(*) from beacon_v2.project_items where client_id is not null) <> v_item_clients_before then
    raise exception 'company cutover: project item client reference count changed';
  end if;
  if exists (
    select company_id from beacon_v2.contacts where is_primary
    group by company_id having count(*) > 1
  ) then
    raise exception 'company cutover: more than one primary contact for a company';
  end if;

  alter table beacon_v2.clients rename to clients_legacy_20261012;
  revoke all on table beacon_v2.clients_legacy_20261012 from public, anon, authenticated;
end;
$migration$;

-- A company can now be the client, prime, or sub on a project. Preserve each
-- contextual role explicitly, even when one company holds two roles.
create or replace view beacon_v2.v_company_projects as
  select p.id as project_id, p.client_id as company_id, 'client'::text as relation
    from beacon_v2.projects p where p.client_id is not null
  union
  select p.id, p.prime_company_id, 'prime'::text
    from beacon_v2.projects p where p.prime_company_id is not null
  union
  select s.project_id, s.company_id, 'sub'::text
    from beacon_v2.project_subs s where s.company_id is not null;

comment on view beacon_v2.v_company_projects is
  'Reverse-browse helper: every project/company relationship as client, prime, or sub.';

-- Company-only contact compatibility mirror.
create or replace function beacon_v2.fn_contacts_mirror_primary()
returns trigger
language plpgsql
as $$
declare
  v_company uuid;
  v_companies uuid[] := '{}';
  r record;
begin
  if tg_op in ('INSERT', 'UPDATE') and new.company_id is not null then
    v_companies := array_append(v_companies, new.company_id);
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.company_id is not null then
    v_companies := array_append(v_companies, old.company_id);
  end if;

  foreach v_company in array v_companies loop
    select c.name, c.email, c.phone into r
      from beacon_v2.contacts c
     where c.company_id = v_company
     order by c.is_primary desc, c.ord, c.created_at
     limit 1;
    if found then
      update beacon_v2.companies
         set contact_person = r.name, email = r.email, phone = r.phone
       where id = v_company
         and (contact_person is distinct from r.name
           or email is distinct from r.email
           or phone is distinct from r.phone);
    else
      update beacon_v2.companies
         set contact_person = null, email = null, phone = null
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

create or replace function beacon_v2.set_primary_contact(p_id uuid)
returns void
language plpgsql
as $$
declare
  v_company uuid;
begin
  select company_id into v_company from beacon_v2.contacts where id = p_id;
  if not found then
    raise exception 'contact % not found', p_id using errcode = 'P0002';
  end if;
  update beacon_v2.contacts set is_primary = false
   where company_id = v_company and is_primary and id <> p_id;
  update beacon_v2.contacts set is_primary = true where id = p_id and not is_primary;
end;
$$;
revoke all on function beacon_v2.set_primary_contact(uuid) from public, anon;
grant execute on function beacon_v2.set_primary_contact(uuid) to authenticated;

-- Replace the old split-model merge RPC. Every organization reference now
-- points at companies, including columns still named client_id because they
-- describe the company's role on that record.
create or replace function beacon_v2.merge_companies(p_survivor uuid, p_losers uuid[])
returns jsonb
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  v_loser uuid;
  v_is_msmm boolean;
  v_merged int := 0;
  v_contacts int := 0;
  v_projects int := 0;
  v_items int := 0;
  v_n int;
begin
  if p_survivor is null then
    raise exception 'merge_companies: survivor id is required';
  end if;
  if p_losers is null or array_length(p_losers, 1) is null then
    raise exception 'merge_companies: at least one loser id is required';
  end if;
  if p_survivor = any(p_losers) then
    raise exception 'merge_companies: survivor cannot also be a loser';
  end if;
  perform 1 from beacon_v2.companies where id = p_survivor;
  if not found then
    raise exception 'merge_companies: survivor % does not exist', p_survivor;
  end if;

  foreach v_loser in array p_losers loop
    select is_msmm into v_is_msmm from beacon_v2.companies where id = v_loser;
    if not found then continue; end if;
    if v_is_msmm then
      raise exception 'merge_companies: the MSMM company (%) cannot be merged away', v_loser;
    end if;

    -- Preserve the survivor's primary. If it has none, the loser's primary may
    -- move intact; subsequent losers are demoted once a primary exists.
    if exists (select 1 from beacon_v2.contacts where company_id = p_survivor and is_primary) then
      update beacon_v2.contacts set is_primary = false
       where company_id = v_loser and is_primary;
    end if;
    update beacon_v2.contacts set company_id = p_survivor where company_id = v_loser;
    get diagnostics v_n = row_count; v_contacts := v_contacts + v_n;

    -- Pipeline project subs: coalesce colliding rows, then repoint the rest.
    update beacon_v2.project_subs s
       set amount        = coalesce(s.amount, l.amount),
           discipline    = coalesce(nullif(s.discipline, ''), l.discipline),
           sub_agreement = s.sub_agreement or l.sub_agreement,
           w9            = s.w9 or l.w9,
           coi           = s.coi or l.coi
      from beacon_v2.project_subs l
     where s.company_id = p_survivor
       and l.company_id = v_loser
       and s.project_id = l.project_id
       and s.kind = l.kind;
    delete from beacon_v2.project_subs l
     using beacon_v2.project_subs s
     where l.company_id = v_loser
       and s.company_id = p_survivor
       and s.project_id = l.project_id
       and s.kind = l.kind;
    update beacon_v2.project_subs set company_id = p_survivor where company_id = v_loser;

    -- Project-tree subs have a primary key on (item_id, company_id).
    update beacon_v2.project_item_subs s
       set discipline = coalesce(nullif(s.discipline, ''), l.discipline),
           amount = coalesce(s.amount, l.amount),
           ord = coalesce(s.ord, l.ord)
      from beacon_v2.project_item_subs l
     where s.company_id = p_survivor
       and l.company_id = v_loser
       and s.item_id = l.item_id;
    delete from beacon_v2.project_item_subs l
     using beacon_v2.project_item_subs s
     where l.company_id = v_loser
       and s.company_id = p_survivor
       and s.item_id = l.item_id;
    update beacon_v2.project_item_subs set company_id = p_survivor where company_id = v_loser;

    -- Monthly sub invoices: preserve attachments before removing a colliding
    -- duplicate cell. The survivor amount is authoritative, matching the
    -- previous merge behavior and avoiding silent double billing.
    update beacon_v2.sub_invoice_files f
       set sub_invoice_id = s.id
      from beacon_v2.sub_invoices l
      join beacon_v2.sub_invoices s
        on s.project_id = l.project_id
       and s.kind = l.kind
       and s.year = l.year
       and s.month = l.month
       and s.company_id = p_survivor
     where f.sub_invoice_id = l.id
       and l.company_id = v_loser;
    update beacon_v2.sub_invoices s
       set amount = coalesce(s.amount, l.amount),
           paid = s.paid or l.paid,
           notes = coalesce(nullif(s.notes, ''), l.notes)
      from beacon_v2.sub_invoices l
     where s.company_id = p_survivor
       and l.company_id = v_loser
       and s.project_id = l.project_id
       and s.kind = l.kind
       and s.year = l.year
       and s.month = l.month;
    delete from beacon_v2.sub_invoices l
     using beacon_v2.sub_invoices s
     where l.company_id = v_loser
       and s.company_id = p_survivor
       and s.project_id = l.project_id
       and s.kind = l.kind
       and s.year = l.year
       and s.month = l.month;
    update beacon_v2.sub_invoices set company_id = p_survivor where company_id = v_loser;

    -- Direct relationship repoints.
    update beacon_v2.projects set client_id = p_survivor where client_id = v_loser;
    get diagnostics v_n = row_count; v_projects := v_projects + v_n;
    update beacon_v2.projects set prime_company_id = p_survivor where prime_company_id = v_loser;
    get diagnostics v_n = row_count; v_projects := v_projects + v_n;
    update beacon_v2.leads set client_id = p_survivor where client_id = v_loser;
    update beacon_v2.leads set prime_company_id = p_survivor where prime_company_id = v_loser;
    update beacon_v2.open_bids set client_id = p_survivor where client_id = v_loser;
    update beacon_v2.project_items set client_id = p_survivor where client_id = v_loser;
    get diagnostics v_n = row_count; v_items := v_items + v_n;
    update beacon_v2.project_items set prime_company_id = p_survivor where prime_company_id = v_loser;
    get diagnostics v_n = row_count; v_items := v_items + v_n;
    update beacon_v2.invoice_party_files set party_company_id = p_survivor where party_company_id = v_loser;
    update beacon_v2.invoice_amendments set company_id = p_survivor where company_id = v_loser;
    update beacon_v2.company_unification_overrides set company_id = p_survivor where company_id = v_loser;
    -- Marketing may have been migrated before this cutover. Keep the function
    -- valid in either migration order while preserving its company relation.
    if to_regclass('beacon_v2.marketing_opportunities') is not null then
      execute 'update beacon_v2.marketing_opportunities set client_id = $1 where client_id = $2'
        using p_survivor, v_loser;
    end if;

    delete from beacon_v2.companies where id = v_loser;
    v_merged := v_merged + 1;
  end loop;

  return jsonb_build_object(
    'kind', 'company', 'survivor', p_survivor, 'merged', v_merged,
    'contacts', v_contacts, 'projects', v_projects, 'project_items', v_items
  );
end;
$$;
revoke all on function beacon_v2.merge_companies(uuid, uuid[]) from public, anon;
grant execute on function beacon_v2.merge_companies(uuid, uuid[]) to authenticated;

-- The split-table client merge is no longer a valid operation.
drop function if exists beacon_v2.merge_clients(uuid, uuid[]);

notify pgrst, 'reload schema';
commit;
