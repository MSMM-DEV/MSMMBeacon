-- MSMM Beacon v2 — read-side views for the two-way client/company browse.
--
-- Forward direction needs no view: SELECT * FROM beacon_v2.projects WHERE
-- client_id = $1 (or prime_company_id = $1) is direct.
--
-- Reverse direction (find every project a company appears on, whether as
-- prime or sub) is the only place a UNION is required, since the company
-- can show up in two different columns. v_company_projects centralizes that
-- so the frontend can do a single join.

set search_path = beacon_v2, public, extensions;

create or replace view beacon_v2.v_company_projects as
  select
    p.id              as project_id,
    p.prime_company_id as company_id,
    'prime'::text     as relation
    from beacon_v2.projects p
   where p.prime_company_id is not null
union all
  select
    s.project_id,
    s.company_id,
    'sub'::text       as relation
    from beacon_v2.project_subs s
   where s.company_id is not null;

comment on view beacon_v2.v_company_projects is
  'Reverse-browse helper: each row = one (project, company, relation). Use to find every project a company is attached to, whether as prime or sub. Forward direction (client → projects) does not need a view.';
