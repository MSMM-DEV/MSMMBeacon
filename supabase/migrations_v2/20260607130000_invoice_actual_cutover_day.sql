-- Configurable Actual/Projection cutover day for the Invoice tab.
--
-- The Invoice table splits each year's 12 month columns into "Actual"
-- (editable, already-billed) vs "Projection" (forecast). Historically the
-- CURRENT month flipped from Projection to Actual on the 1st (driven by
-- TODAY_MONTH client-side). Some teams don't close a month's billing until a
-- few days into the next month, so this makes the flip day configurable.
--
-- `invoice_actual_cutover_day` (1–31) on the app_settings singleton: the
-- current month stays Projection until this day-of-month, then becomes Actual.
-- Day 1 reproduces the legacy behavior exactly (>= 1 is always true), so
-- existing workspaces are unaffected. Values are clamped to the current
-- month's length client-side, so 31 behaves as "last day of month" in short
-- months. Read by adaptAppSettings → actualThruMonth()/isActualInvoiceMonth()
-- in data.js; written by the Admin → Targets panel.
--
-- NOTE: the read-only convenience view beacon_v2.v_anticipated_invoice_months
-- still derives Actual/Projection from CURRENT_DATE on the 1st and is NOT
-- consulted by the frontend (the app computes the split client-side). Left
-- as-is; the frontend is the source of truth for the displayed split.

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.app_settings
  add column if not exists invoice_actual_cutover_day smallint not null default 1
    check (invoice_actual_cutover_day between 1 and 31);

notify pgrst, 'reload schema';
