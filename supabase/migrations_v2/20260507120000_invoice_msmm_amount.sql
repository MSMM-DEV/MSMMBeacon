-- MSMM portion as a first-class field on anticipated_invoice rows.
--
-- Before: anticipated_invoice.contract_amount was the only money column
-- on the row, and the InvoiceTable rendered it as "Contract" — which
-- users misread as MSMM's earnings. The value actually represents the
-- TOTAL project contract (MSMM portion + every sub's portion).
--
-- After: contract_amount is reframed as Total Contract Value (no
-- structural change), and a new msmm_amount column holds MSMM's piece
-- of that total explicitly. The expand row in the UI shows the
-- breakdown:
--
--   Total Contract Value = MSMM Portion + Σ project_subs.amount
--
-- Invariant is enforced soft in the UI (a mismatch chip) — no DB CHECK,
-- because data entry is iterative (user enters Total first, then MSMM,
-- then each sub one at a time).

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.anticipated_invoice
  add column if not exists msmm_amount numeric(14,2);
