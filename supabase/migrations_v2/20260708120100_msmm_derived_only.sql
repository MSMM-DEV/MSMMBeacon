-- 20260708120100_msmm_derived_only.sql
-- MSMM invoice values are now PURELY DERIVED — never a stored override.
--
-- The MSMM row (the first/parent row of each project on the Invoice tab) always
-- equals Total − Σ subs, recomputed live on EVERY total or sub change:
--     MSMM portion  = Total Contract Value − Σ(kind='sub') sub contract
--     MSMM month i  = month total[i]       − Σ(kind='sub') sub month[i]
-- The frontend (InvoiceTable, the Engineering/PM cash-flow charts, and the
-- "Print for Manish" xlsx export) computes this directly and no longer reads or
-- writes the msmm_amount / msmm_{jan..dec}_amount override columns; the MSMM
-- cells are read-only for everyone. This guarantees MSMM is recalculated and
-- overwritten on every total/sub change, regardless of any prior value.
--
-- This one-time reset NULLs any lingering MSMM overrides so the stored columns
-- match the derived reality (a re-run of 20260608160000 part 2, in case an
-- admin created an override since). The admin-only MSMM guard
-- (guard_msmm_admin_only) is intentionally LEFT in place as defense-in-depth:
-- the app never writes these columns now, but the guard still blocks a
-- non-admin from writing them via direct PostgREST. The service-role / no-JWT
-- (Studio) exemption added in 20260608160000 lets THIS reset run.
-- msmm_remaining_to_bill_year_start (a billing starting balance, not
-- "Total − subs") is intentionally left untouched.
--
-- Idempotent / re-runnable. DB-only — no Edge Function redeploy.

set search_path = beacon_v2, public, extensions;

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
