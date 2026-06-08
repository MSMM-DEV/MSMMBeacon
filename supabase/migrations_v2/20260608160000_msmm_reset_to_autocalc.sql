-- Reset every project's MSMM values to the live auto-calc (Total − subs), and
-- fix the MSMM guard so trusted backends aren't blocked from maintenance.
--
-- Two parts:
--
-- 1. GUARD FIX. 20260608150000 added tg_guard_msmm_admin_only to make MSMM
--    columns admin-only. It exempted only is_current_user_admin(), which is
--    FALSE for the service-role and for a no-JWT Studio/superuser connection —
--    so it also blocked legitimate backend maintenance (Edge Functions, the
--    reset job below, direct SQL). This rewrites the guard to additionally
--    exempt:
--       • the service-role JWT  (Edge Functions / maintenance scripts), and
--       • a no-request-JWT context (Studio SQL editor / direct superuser).
--    Authenticated NON-admins and anon are still blocked from changing MSMM —
--    which is the actual point of the lock (the frontend already gates them).
--
-- 2. DATA RESET. NULL the MSMM override columns on every anticipated_invoice
--    row so the frontend auto-calc governs every project's MSMM:
--        MSMM portion = Total Contract Value − Σ(kind='sub') sub contract
--        MSMM month i = month total[i]       − Σ(kind='sub') sub month[i]
--        (no subs → Total − 0 = Total)
--    The app already computes exactly this whenever the override is NULL
--    (msmmContractAuto / msmmAtDesc in tables.jsx). Clearing the overrides
--    makes MSMM = Total − subs for EVERY project and keeps it correct as totals
--    / subs change — unlike freezing a value, which would go stale on the next
--    edit. msmm_remaining_to_bill_year_start (a billing-progress starting
--    balance, not "Total − subs") is intentionally left untouched.
--
-- The repo also ships scripts/reset_msmm_to_autocalc.py (service-role,
-- dry-run/--apply) as the re-runnable equivalent — it works once part (1) here
-- is applied.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Corrected guard — exempt trusted backend contexts.
--------------------------------------------------------------------------------
create or replace function beacon_v2.guard_msmm_admin_only()
returns trigger
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  -- '' when there is no request JWT (Studio SQL editor / direct superuser);
  -- otherwise the caller's JWT role ('anon' | 'authenticated' | 'service_role').
  jwt_role text := coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'role', '');
begin
  -- Trusted backends + frontend admins may write MSMM columns freely.
  if jwt_role = 'service_role'
     or jwt_role = ''
     or beacon_v2.is_current_user_admin()
  then
    return new;
  end if;

  -- Authenticated non-admins / anon: reject any change to an MSMM column.
  if (new.msmm_amount                       is distinct from old.msmm_amount)
  or (new.msmm_remaining_to_bill_year_start is distinct from old.msmm_remaining_to_bill_year_start)
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

-- (Trigger tg_guard_msmm_admin_only from 20260608150000 already points at this
--  function; CREATE OR REPLACE above swaps the body in place.)

--------------------------------------------------------------------------------
-- 2. One-time data reset — clear MSMM contract + monthly overrides everywhere.
--------------------------------------------------------------------------------
update beacon_v2.anticipated_invoice
   set msmm_amount     = null,
       msmm_jan_amount = null, msmm_feb_amount = null, msmm_mar_amount = null,
       msmm_apr_amount = null, msmm_may_amount = null, msmm_jun_amount = null,
       msmm_jul_amount = null, msmm_aug_amount = null, msmm_sep_amount = null,
       msmm_oct_amount = null, msmm_nov_amount = null, msmm_dec_amount = null
 where msmm_amount     is not null
    or msmm_jan_amount is not null or msmm_feb_amount is not null or msmm_mar_amount is not null
    or msmm_apr_amount is not null or msmm_may_amount is not null or msmm_jun_amount is not null
    or msmm_jul_amount is not null or msmm_aug_amount is not null or msmm_sep_amount is not null
    or msmm_oct_amount is not null or msmm_nov_amount is not null or msmm_dec_amount is not null;

notify pgrst, 'reload schema';
