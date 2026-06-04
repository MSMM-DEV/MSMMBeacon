-- Per-month PAID flags on the prime (MSMM) invoice — anticipated_invoice.
--
-- Subs already track paid status per (project, company, month) on
-- beacon_v2.sub_invoices.paid (see 20260429120100_sub_invoices_paid.sql),
-- which drives the green "paid" cell on each sub row in the InvoiceTable.
-- The prime/total invoice (MSMM as Prime) had NO equivalent — its monthly
-- amount lives in anticipated_invoice.{jan..dec}_amount and its PDFs in
-- prime_invoice_files, but there was no way to mark a month "paid".
--
-- These 12 booleans give the "Project total" row the same three-state
-- signal as subs:  attachment → submitted (yellow) · paid tick → green ·
-- amount only → unpaid (red).  Each anticipated_invoice row is already
-- year-scoped (it carries `year`), so jan_paid..dec_paid are inherently
-- that row's year — no separate year key needed (unlike sub_invoices).
--
-- NOT NULL DEFAULT false so existing rows read as "pending" with no
-- backfill. The frontend flips a single column per toggle (mirrors the
-- updateInvoiceMsmmCell per-month column-patch path).

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.anticipated_invoice
  add column if not exists jan_paid boolean not null default false,
  add column if not exists feb_paid boolean not null default false,
  add column if not exists mar_paid boolean not null default false,
  add column if not exists apr_paid boolean not null default false,
  add column if not exists may_paid boolean not null default false,
  add column if not exists jun_paid boolean not null default false,
  add column if not exists jul_paid boolean not null default false,
  add column if not exists aug_paid boolean not null default false,
  add column if not exists sep_paid boolean not null default false,
  add column if not exists oct_paid boolean not null default false,
  add column if not exists nov_paid boolean not null default false,
  add column if not exists dec_paid boolean not null default false;

notify pgrst, 'reload schema';
