-- MSMM Beacon v2 — add MHZ as an Invoice category.
--
-- PostgreSQL enum values cannot reliably be used by later statements in the
-- same transaction that adds them. Keep this migration enum-only; the next
-- timestamped migration backfills MHZ rows after this value has committed.

set search_path = beacon_v2, public, extensions;

do $$
begin
  if not exists (
    select 1
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'beacon_v2'
       and t.typname = 'invoice_type_enum'
       and e.enumlabel = 'MHZ'
  ) then
    alter type beacon_v2.invoice_type_enum add value 'MHZ';
  end if;
end $$;

notify pgrst, 'reload schema';
