-- MSMM Beacon v2 — payment status on sub_invoices.
--
-- Each sub_invoice row defaults to pending (paid = false). The frontend
-- exposes an inline toggle on every sub-row cell + a checkbox in the
-- InvoiceFilesModal. paid_at is set to now() when paid flips true and
-- cleared on the way back, so a paid-in-last-N-days query is trivial.

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.sub_invoices
  add column if not exists paid    boolean not null default false,
  add column if not exists paid_at timestamptz;

-- Partial index for fast "paid since X" lookups; the bool index is also
-- useful when a future report wants to count pending-vs-paid in a year.
create index if not exists sub_invoices_paid_idx
  on beacon_v2.sub_invoices (paid);
create index if not exists sub_invoices_paid_at_idx
  on beacon_v2.sub_invoices (paid_at) where paid_at is not null;
