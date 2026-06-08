-- MSMM values are admin-only — DB-level enforcement of the Invoice UI gate.
--
-- On the Invoice tab the MSMM/parent row's dollar figures are AUTO-CALCULATED
-- (MSMM portion = Total Contract Value − Σ subs; MSMM month = month total − Σ
-- sub months). Regular users bill by editing the Total or a sub; the MSMM
-- numbers derive from those. Only an Admin may override an MSMM value directly.
-- The frontend already blocks non-admins (the MSMM cells render read-only with
-- a "edit the Total instead" toast — canEditMsmm/onBlockedMsmmEdit in App.jsx +
-- InvoiceTable), but the UI is not a security boundary; this trigger makes the
-- lock real against direct PostgREST.
--
-- Mirrors the paid-invoice lock pattern (20260607140000): a BEFORE UPDATE
-- trigger raises 42501 when a NON-admin's update would CHANGE any MSMM column.
-- It fires only on an actual value change (IS DISTINCT FROM), so:
--   • a user editing the Total (contract_amount / {mon}_amount /
--     total_remaining_to_bill_year_start) or a sub (sub_invoices) never touches
--     these columns → passes untouched;
--   • the frontend sends column-scoped PATCHes (only changed keys), so a
--     legitimate non-MSMM edit doesn't even name these columns.
-- is_current_user_admin() returns false for the service-role, but no Edge
-- Function and neither merge RPC writes MSMM columns, so nothing legitimate is
-- blocked. INSERTs (orange-reconciliation, year-row minting) are unaffected —
-- this is UPDATE-only.

set search_path = beacon_v2, public, extensions;

create or replace function beacon_v2.guard_msmm_admin_only()
returns trigger
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
begin
  -- Admins may edit MSMM values freely.
  if beacon_v2.is_current_user_admin() then
    return new;
  end if;

  -- Non-admins: reject the update if it changes any MSMM-portion column.
  if (new.msmm_amount                        is distinct from old.msmm_amount)
  or (new.msmm_remaining_to_bill_year_start  is distinct from old.msmm_remaining_to_bill_year_start)
  or (new.msmm_jan_amount is distinct from old.msmm_jan_amount)
  or (new.msmm_feb_amount is distinct from old.msmm_feb_amount)
  or (new.msmm_mar_amount is distinct from old.msmm_mar_amount)
  or (new.msmm_apr_amount is distinct from old.msmm_apr_amount)
  or (new.msmm_may_amount is distinct from old.msmm_may_amount)
  or (new.msmm_jun_amount is distinct from old.msmm_jun_amount)
  or (new.msmm_jul_amount is distinct from old.msmm_jul_amount)
  or (new.msmm_aug_amount is distinct from old.msmm_aug_amount)
  or (new.msmm_sep_amount is distinct from old.msmm_sep_amount)
  or (new.msmm_oct_amount is distinct from old.msmm_oct_amount)
  or (new.msmm_nov_amount is distinct from old.msmm_nov_amount)
  or (new.msmm_dec_amount is distinct from old.msmm_dec_amount)
  then
    raise exception 'Only an administrator can edit MSMM values (they are auto-calculated; edit the Total or a sub instead)'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists tg_guard_msmm_admin_only on beacon_v2.anticipated_invoice;
create trigger tg_guard_msmm_admin_only
  before update on beacon_v2.anticipated_invoice
  for each row execute function beacon_v2.guard_msmm_admin_only();

notify pgrst, 'reload schema';
