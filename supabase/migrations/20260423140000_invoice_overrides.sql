-- Per-row manual overrides for the two derived columns shown in the Invoice
-- table: YTD Actual (sum Jan..current-month) and Rollforward (remainingStart -
-- totalAll, clamped ≥ 0). Both remain auto-calculated on the frontend; these
-- columns only hold user edits.
--
-- Semantics:
--   NULL     → display the auto-calculated value.
--   NOT NULL → display this value verbatim; user has frozen the number.
--
-- Clearing the cell in the UI (empty + Enter) writes NULL, restoring auto.
-- No clamp on rollforward_override — users may enter any value; the clamp
-- was a safety net for the auto-calc, not a business rule.

alter table beacon.anticipated_invoice
  add column if not exists ytd_actual_override  numeric(14,2),
  add column if not exists rollforward_override numeric(14,2);
