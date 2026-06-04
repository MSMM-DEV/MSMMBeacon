-- Per-month INVOICE NUMBER on the prime (MSMM-as-Prime) "Project total" row.
--
-- Each month's project total can be billed under its own invoice number — the
-- number printed on the PDF that gets attached to that month's total cell.
-- January's total invoice number is independent of February's, so this is a
-- per-(project, month) value, exactly like the per-month paid flags added in
-- 20260606120300_prime_invoice_paid.sql.
--
-- Stored as 12 text columns directly on anticipated_invoice rather than on
-- prime_invoice_files: the number is a property of the month's total bill, not
-- of any single attachment (a month can carry several PDFs that all share the
-- one invoice number). Each anticipated_invoice row is already year-scoped
-- (it carries `year`), so jan..dec are inherently that row's year — no
-- separate year key needed.
--
-- NULL = no invoice number captured yet (the chip is hidden on that cell).
-- The frontend writes one column per edit (mirrors updateInvoicePrimePaid):
-- the InvoiceFilesModal prime variant exposes an "Invoice number" field that
-- patches anticipated_invoice.{mon}_invoice_number; adaptInvoice surfaces the
-- 12 values as invoiceNumbers[12]; the InvoiceTable renders a chip per cell.

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.anticipated_invoice
  add column if not exists jan_invoice_number text,
  add column if not exists feb_invoice_number text,
  add column if not exists mar_invoice_number text,
  add column if not exists apr_invoice_number text,
  add column if not exists may_invoice_number text,
  add column if not exists jun_invoice_number text,
  add column if not exists jul_invoice_number text,
  add column if not exists aug_invoice_number text,
  add column if not exists sep_invoice_number text,
  add column if not exists oct_invoice_number text,
  add column if not exists nov_invoice_number text,
  add column if not exists dec_invoice_number text;

notify pgrst, 'reload schema';
