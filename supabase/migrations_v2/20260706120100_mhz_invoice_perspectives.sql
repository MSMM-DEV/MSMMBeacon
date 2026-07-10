-- MSMM Beacon v2 — MHZ invoice perspectives.
--
-- ENG rows remain unchanged. This permits a second auto-created invoice row
-- for the same project/year when the type is MHZ, copies the requested ENG
-- projects into MHZ, and seeds MHZ as the upstream prime relationship on
-- linked project rows so the ENG expanded view can show "MHZ · PRIME".
--
-- 2026-07: project 202310 was reclassified as ENG-only (not an MHZ project) and
-- its MHZ invoice rows were deleted, so it has been dropped from the backfill
-- lists below. The remaining MHZ projects are 202514 / 202419 / 202414 / 202324.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Auto-created invoice uniqueness is per project/year/type.
--------------------------------------------------------------------------------
drop index if exists beacon_v2.anticipated_invoice_source_year_uniq;

create unique index if not exists anticipated_invoice_source_year_type_uniq
  on beacon_v2.anticipated_invoice (source_project_id, year, type)
  where source_project_id is not null;

--------------------------------------------------------------------------------
-- 2. Ensure the MHZ firm exists in the Companies directory.
--------------------------------------------------------------------------------
insert into beacon_v2.companies (name, is_msmm, notes)
values ('MHZ', false, 'Joint venture prime for MHZ invoice perspectives.')
on conflict (name) do update
  set notes = coalesce(beacon_v2.companies.notes, excluded.notes);

--------------------------------------------------------------------------------
-- 3. Copy requested ENG invoice rows into missing MHZ perspective rows.
--    Dynamic column list copies every project-level invoice field except id,
--    type, and timestamps. Re-runnable and tolerant of future invoice columns.
--------------------------------------------------------------------------------
do $$
declare
  _cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into _cols
  from information_schema.columns
  where table_schema = 'beacon_v2'
    and table_name = 'anticipated_invoice'
    and column_name not in ('id', 'type', 'created_at', 'updated_at');

  execute format($sql$
    insert into beacon_v2.anticipated_invoice (%1$s, type)
    select %1$s, 'MHZ'::beacon_v2.invoice_type_enum
      from beacon_v2.anticipated_invoice src
     where src.type = 'ENG'::beacon_v2.invoice_type_enum
       and src.project_number in ('202514','202419','202414','202324')
       and not exists (
         select 1
           from beacon_v2.anticipated_invoice existing
          where existing.type = 'MHZ'::beacon_v2.invoice_type_enum
            and existing.year = src.year
            and (
              (src.source_project_id is not null and existing.source_project_id = src.source_project_id)
              or (
                src.source_project_id is null
                and existing.source_project_id is null
                and coalesce(existing.project_number, '') = coalesce(src.project_number, '')
              )
            )
       )
  $sql$, _cols);
end $$;

--------------------------------------------------------------------------------
-- 4. Copy PM assignments from each ENG row to its MHZ sibling.
--------------------------------------------------------------------------------
insert into beacon_v2.anticipated_invoice_pms (anticipated_invoice_id, user_id)
select mhz.id, pms.user_id
  from beacon_v2.anticipated_invoice eng
  join beacon_v2.anticipated_invoice mhz
    on mhz.type = 'MHZ'::beacon_v2.invoice_type_enum
   and mhz.year = eng.year
   and (
     (eng.source_project_id is not null and mhz.source_project_id = eng.source_project_id)
     or (
       eng.source_project_id is null
       and mhz.source_project_id is null
       and coalesce(mhz.project_number, '') = coalesce(eng.project_number, '')
     )
   )
  join beacon_v2.anticipated_invoice_pms pms
    on pms.anticipated_invoice_id = eng.id
 where eng.type = 'ENG'::beacon_v2.invoice_type_enum
   and eng.project_number in ('202514','202419','202414','202324')
on conflict do nothing;

--------------------------------------------------------------------------------
-- 5. On linked project rows, make MHZ the explicit upstream prime.
--------------------------------------------------------------------------------
with mhz_company as (
  select id from beacon_v2.companies where name = 'MHZ' limit 1
),
target_projects as (
  select distinct source_project_id as project_id
    from beacon_v2.anticipated_invoice
   where project_number in ('202514','202419','202414','202324')
     and source_project_id is not null
  union
  select id
    from beacon_v2.projects
   where project_number in ('202514','202419','202414','202324')
),
eng_amounts as (
  select distinct on (source_project_id)
         source_project_id as project_id,
         contract_amount,
         total_remaining_to_bill_year_start
    from beacon_v2.anticipated_invoice
   where type = 'ENG'::beacon_v2.invoice_type_enum
     and project_number in ('202514','202419','202414','202324')
     and source_project_id is not null
   order by source_project_id, year desc, updated_at desc nulls last
)
update beacon_v2.project_subs ps
   set company_id = (select id from mhz_company),
       discipline = coalesce(nullif(ps.discipline, ''), 'Prime'),
       amount = coalesce(ps.amount, eng_amounts.contract_amount),
       remaining_to_bill_year_start = coalesce(ps.remaining_to_bill_year_start, eng_amounts.total_remaining_to_bill_year_start)
  from target_projects
  left join eng_amounts on eng_amounts.project_id = target_projects.project_id
 where ps.project_id = target_projects.project_id
   and ps.kind = 'prime'
   and exists (select 1 from mhz_company);

with mhz_company as (
  select id from beacon_v2.companies where name = 'MHZ' limit 1
),
target_projects as (
  select distinct source_project_id as project_id
    from beacon_v2.anticipated_invoice
   where project_number in ('202514','202419','202414','202324')
     and source_project_id is not null
  union
  select id
    from beacon_v2.projects
   where project_number in ('202514','202419','202414','202324')
),
eng_amounts as (
  select distinct on (source_project_id)
         source_project_id as project_id,
         contract_amount,
         total_remaining_to_bill_year_start
    from beacon_v2.anticipated_invoice
   where type = 'ENG'::beacon_v2.invoice_type_enum
     and project_number in ('202514','202419','202414','202324')
     and source_project_id is not null
   order by source_project_id, year desc, updated_at desc nulls last
)
insert into beacon_v2.project_subs (
  project_id, ord, company_id, discipline, amount, remaining_to_bill_year_start, kind
)
select tp.project_id,
       0,
       mhz_company.id,
       'Prime',
       eng_amounts.contract_amount,
       eng_amounts.total_remaining_to_bill_year_start,
       'prime'
  from target_projects tp
 cross join mhz_company
  left join eng_amounts on eng_amounts.project_id = tp.project_id
 where not exists (
   select 1
     from beacon_v2.project_subs ps
    where ps.project_id = tp.project_id
      and ps.kind = 'prime'
 );

notify pgrst, 'reload schema';
