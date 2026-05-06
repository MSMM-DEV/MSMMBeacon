-- Per-month MSMM override columns on anticipated_invoice.
--
-- The frontend now displays MSMM values as derived by default
--   MSMM = Total − Σ(subs)
-- both for the contract value and for each of the 12 monthly amounts.
--
-- These 12 columns hold the OVERRIDE — when NULL, the UI shows the
-- auto-calc; when the user types a value the override is stored, and
-- clearing the cell writes NULL to resume auto-calc. This mirrors the
-- existing `ytd_actual_override` / `rollforward_override` pattern.
--
-- The contract-level MSMM override (`anticipated_invoice.msmm_amount`,
-- added in 20260507120000_invoice_msmm_amount.sql) follows the same
-- semantics under the new UX — no schema change needed there.

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.anticipated_invoice
  add column if not exists msmm_jan_amount numeric(14,2),
  add column if not exists msmm_feb_amount numeric(14,2),
  add column if not exists msmm_mar_amount numeric(14,2),
  add column if not exists msmm_apr_amount numeric(14,2),
  add column if not exists msmm_may_amount numeric(14,2),
  add column if not exists msmm_jun_amount numeric(14,2),
  add column if not exists msmm_jul_amount numeric(14,2),
  add column if not exists msmm_aug_amount numeric(14,2),
  add column if not exists msmm_sep_amount numeric(14,2),
  add column if not exists msmm_oct_amount numeric(14,2),
  add column if not exists msmm_nov_amount numeric(14,2),
  add column if not exists msmm_dec_amount numeric(14,2);
