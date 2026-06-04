-- MSMM Beacon v2 — per-line "Remaining to bill at year start" for sub + total.
--
-- The Invoice table's expand breakdown shows a "Remaining Jan 1" column. The
-- MSMM (parent) line already has its own editable value
-- (anticipated_invoice.msmm_remaining_to_bill_year_start). This adds the same
-- editable starting-balance to (a) each SUB line and (b) the PROJECT TOTAL line,
-- so a user can record that part of a contract was already billed in a prior
-- year (Jan-1 remaining < full contract amount).
--
--   * project_subs.remaining_to_bill_year_start            — per sub line
--   * anticipated_invoice.total_remaining_to_bill_year_start — project total line
--
-- NULL = unset → the UI falls back to the row's contract amount, which keeps the
-- existing rollforward (contract − YTD) behavior unchanged until a value is set.
-- Both feed each line's Rollforward = Remaining Jan 1 − YTD. Idempotent;
-- DB-only — no Edge Function redeploy.

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.project_subs
  add column if not exists remaining_to_bill_year_start numeric(14,2);

alter table beacon_v2.anticipated_invoice
  add column if not exists total_remaining_to_bill_year_start numeric(14,2);

notify pgrst, 'reload schema';
