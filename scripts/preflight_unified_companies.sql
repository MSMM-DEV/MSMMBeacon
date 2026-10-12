-- Read-only preflight for 20261012120000_unified_companies.sql.
-- Run in Supabase Studio before the cutover. Every result set is diagnostic;
-- this script creates or changes nothing.

set search_path = beacon_v2, public, extensions;

-- Baseline counts used to reconcile the post-migration assertions.
select 'counts' as report, jsonb_build_object(
  'clients',          (select count(*) from beacon_v2.clients),
  'companies',        (select count(*) from beacon_v2.companies),
  'contacts',         (select count(*) from beacon_v2.contacts),
  'client_contacts',  (select count(*) from beacon_v2.contacts where client_id is not null),
  'company_contacts', (select count(*) from beacon_v2.contacts where company_id is not null),
  'project_clients',  (select count(*) from beacon_v2.projects where client_id is not null),
  'project_primes_from_clients', (select count(*) from beacon_v2.projects where prime_client_id is not null),
  'lead_clients',     (select count(*) from beacon_v2.leads where client_id is not null),
  'bid_clients',      (select count(*) from beacon_v2.open_bids where client_id is not null),
  'item_clients',     (select count(*) from beacon_v2.project_items where client_id is not null)
) as details;

-- Exact normalized matches are the only automatic merge candidates. A client
-- name shared by several districts is excluded unless the company's name also
-- includes that district.
with client_names as (
  select c.*,
         lower(regexp_replace(btrim(c.name), '[^a-z0-9]+', '', 'gi')) as name_key,
         lower(regexp_replace(btrim(c.name || coalesce(' ' || c.district, '')), '[^a-z0-9]+', '', 'gi')) as display_key,
         count(*) over (
           partition by lower(regexp_replace(btrim(c.name), '[^a-z0-9]+', '', 'gi'))
         ) as same_name_count
    from beacon_v2.clients c
), candidates as (
  select c.id as client_id, c.name as client_name, c.district,
         f.id as company_id, f.name as company_name,
         case
           when lower(regexp_replace(btrim(f.name), '[^a-z0-9]+', '', 'gi')) = c.display_key then 'name_and_district'
           else 'unique_name'
         end as match_reason
    from client_names c
    join beacon_v2.companies f
      on lower(regexp_replace(btrim(f.name), '[^a-z0-9]+', '', 'gi')) = c.display_key
      or (
        c.same_name_count = 1
        and lower(regexp_replace(btrim(f.name), '[^a-z0-9]+', '', 'gi')) = c.name_key
      )
)
select 'automatic_exact_match' as report, *
  from candidates
 order by client_name, district, company_name;

-- Same base name in more than one district is never silently collapsed.
select 'same_name_different_district' as report,
       lower(regexp_replace(btrim(name), '[^a-z0-9]+', '', 'gi')) as normalized_name,
       jsonb_agg(jsonb_build_object('id', id, 'name', name, 'district', district)
                 order by district nulls first) as details
  from beacon_v2.clients
 group by 2
having count(*) > 1
 order by 2;

-- Looser suffix-stripped suggestions are review-only. They never feed the
-- migration map unless an operator adds an explicit override.
with c as (
  select id, name, district,
         regexp_replace(
           lower(regexp_replace(btrim(name), '[^a-z0-9]+', ' ', 'gi')),
           '\m(incorporated|inc|llc|ltd|corporation|corp|company|co)\M', '', 'g'
         ) as loose_key
    from beacon_v2.clients
), f as (
  select id, name,
         regexp_replace(
           lower(regexp_replace(btrim(name), '[^a-z0-9]+', ' ', 'gi')),
           '\m(incorporated|inc|llc|ltd|corporation|corp|company|co)\M', '', 'g'
         ) as loose_key
    from beacon_v2.companies
)
select 'review_suffix_match' as report,
       c.id as client_id, c.name as client_name, c.district,
       f.id as company_id, f.name as company_name
  from c join f on btrim(c.loose_key) = btrim(f.loose_key)
 where lower(regexp_replace(btrim(c.name), '[^a-z0-9]+', '', 'gi'))
    <> lower(regexp_replace(btrim(f.name), '[^a-z0-9]+', '', 'gi'))
 order by c.name, c.district, f.name;

-- A UUID collision prevents preserving the client's UUID and deserves review.
select 'uuid_collision' as report,
       c.id, c.name as client_name, c.district, f.name as company_name
  from beacon_v2.clients c
  join beacon_v2.companies f on f.id = c.id
 order by c.name;

-- Both prime columns populated is legal under old data only when they resolve
-- to the same organization. The migration refuses differing values.
select 'conflicting_prime_columns' as report,
       id, project_name, prime_client_id, prime_company_id
  from beacon_v2.projects
 where prime_client_id is not null
   and prime_company_id is not null
 order by project_name;

-- Contact-primary convergence: these destinations need deterministic primary
-- selection after client contacts move onto an existing company.
with exact_map as (
  select distinct on (c.id) c.id as client_id, f.id as company_id
    from beacon_v2.clients c
    join beacon_v2.companies f
      on lower(regexp_replace(btrim(f.name), '[^a-z0-9]+', '', 'gi')) =
         lower(regexp_replace(btrim(c.name || coalesce(' ' || c.district, '')), '[^a-z0-9]+', '', 'gi'))
    order by c.id, f.id
)
select 'primary_contact_convergence' as report,
       m.company_id,
       jsonb_agg(jsonb_build_object(
         'contact_id', ct.id, 'name', ct.name, 'source',
         case when ct.client_id is null then 'company' else 'client' end
       ) order by ct.created_at) as primaries
  from exact_map m
  join beacon_v2.contacts ct
    on (ct.client_id = m.client_id or ct.company_id = m.company_id)
 where ct.is_primary
 group by m.company_id
having count(*) > 1;

-- Existing orphan checks should all return zero. Non-zero values block cutover.
select 'orphan_counts' as report, jsonb_build_object(
  'project_clients', (select count(*) from beacon_v2.projects p left join beacon_v2.clients c on c.id = p.client_id where p.client_id is not null and c.id is null),
  'project_prime_clients', (select count(*) from beacon_v2.projects p left join beacon_v2.clients c on c.id = p.prime_client_id where p.prime_client_id is not null and c.id is null),
  'lead_clients', (select count(*) from beacon_v2.leads l left join beacon_v2.clients c on c.id = l.client_id where l.client_id is not null and c.id is null),
  'bid_clients', (select count(*) from beacon_v2.open_bids b left join beacon_v2.clients c on c.id = b.client_id where b.client_id is not null and c.id is null),
  'item_clients', (select count(*) from beacon_v2.project_items i left join beacon_v2.clients c on c.id = i.client_id where i.client_id is not null and c.id is null),
  'contact_clients', (select count(*) from beacon_v2.contacts ct left join beacon_v2.clients c on c.id = ct.client_id where ct.client_id is not null and c.id is null)
) as details;

