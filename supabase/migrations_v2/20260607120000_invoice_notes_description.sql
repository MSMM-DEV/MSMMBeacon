-- Per-project NOTES + DESCRIPTION on the Invoice row — anticipated_invoice.
--
-- The Invoice tab's project rows had no place to capture free-text context:
-- billing notes (e.g. "hold Apr invoice until change order signed") and a
-- longer project description / scope blurb. These two text columns back the
-- pair of chips that render under the project name in InvoiceTable — the chip
-- shows only the label (filled vs empty state); clicking it opens a small
-- editor with the full text.
--
-- Stored on anticipated_invoice (not the linked projects row) because the note
-- is a property of the *invoice/billing* view of the project — an invoice row
-- may be linked to an auto-created stub project, and the billing-side note is
-- conceptually distinct from any project-pipeline note. Both are plain nullable
-- text: NULL / '' = empty (chip renders in its ghost state). Writes go through
-- the existing INVOICE_COL_MAP whitelist in App.jsx (updateInvoice), so no
-- Edge Function changes are needed.

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.anticipated_invoice
  add column if not exists notes       text,
  add column if not exists description text;

notify pgrst, 'reload schema';
