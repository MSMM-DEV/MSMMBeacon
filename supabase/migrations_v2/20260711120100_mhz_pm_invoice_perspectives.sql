-- MSMM Beacon v2 — MHZ PM invoice perspectives (the PM analogue of MHZ↔ENG).
--
-- MHZ PM is to PM exactly what MHZ is to ENG: the MHZ / JV-prime perspective of
-- a PM project, in which MSMM appears as a sub. The uniqueness rule is already
-- (source_project_id, year, type) (20260706120100) and the MHZ firm already
-- exists (same migration), so this migration only needs to backfill MHZ PM
-- sibling rows for existing PM projects whose name looks like an HZ/MHZ project.
--
-- Detection mirrors the client-side projectNameSuggestsMhz() regex
-- (/(^|[^a-z0-9])m?hz([^a-z0-9]|$)/i): "HZ" or "MHZ" as a whole token. Going
-- forward, new/edited PM rows get their MHZ PM sibling created through the
-- in-app prompt (maybeCreateHzInvoiceSibling); this seeds the ones that already
-- exist so they are linked immediately.
--
-- Idempotent + re-runnable: each step skips PM rows that already have an MHZ PM
-- sibling. No project_subs "prime = MHZ" seeding is needed — unlike the original
-- MHZ pass, the base (PM) view no longer renders the HZ prime line, and the
-- MSMM-as-sub line in the MHZ PM view is injected client-side from the linked
-- PM sibling (withPerspectiveRows), so nothing here depends on it.

set search_path = beacon_v2, public, extensions;

-- The HZ/MHZ name token, matching frontend projectNameSuggestsMhz().
-- (Kept in one place so the copy + PM steps agree.)

--------------------------------------------------------------------------------
-- 1. Copy qualifying PM invoice rows into missing MHZ PM perspective rows.
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
    select %1$s, 'MHZ PM'::beacon_v2.invoice_type_enum
      from beacon_v2.anticipated_invoice src
     where src.type = 'PM'::beacon_v2.invoice_type_enum
       and coalesce(src.project_name, '') ~* '(^|[^a-z0-9])m?hz([^a-z0-9]|$)'
       and not exists (
         select 1
           from beacon_v2.anticipated_invoice existing
          where existing.type = 'MHZ PM'::beacon_v2.invoice_type_enum
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
-- 2. Copy PM assignments from each PM row to its MHZ PM sibling.
--------------------------------------------------------------------------------
insert into beacon_v2.anticipated_invoice_pms (anticipated_invoice_id, user_id)
select mhz.id, pms.user_id
  from beacon_v2.anticipated_invoice pm
  join beacon_v2.anticipated_invoice mhz
    on mhz.type = 'MHZ PM'::beacon_v2.invoice_type_enum
   and mhz.year = pm.year
   and (
     (pm.source_project_id is not null and mhz.source_project_id = pm.source_project_id)
     or (
       pm.source_project_id is null
       and mhz.source_project_id is null
       and coalesce(mhz.project_number, '') = coalesce(pm.project_number, '')
     )
   )
  join beacon_v2.anticipated_invoice_pms pms
    on pms.anticipated_invoice_id = pm.id
 where pm.type = 'PM'::beacon_v2.invoice_type_enum
   and coalesce(pm.project_name, '') ~* '(^|[^a-z0-9])m?hz([^a-z0-9]|$)'
on conflict do nothing;

notify pgrst, 'reload schema';
