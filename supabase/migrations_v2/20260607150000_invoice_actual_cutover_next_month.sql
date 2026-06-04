-- Same-month vs next-month Actual/Projection cutover for the Invoice tab.
--
-- 20260607130000 made the cutover DAY configurable (the current month flips
-- from Projection to Actual on day N of the SAME month). This adds the second
-- dimension: whether that cutover lands in the same month or the FOLLOWING
-- month, so a month can be held as a Projection until it actually ends.
--
-- `invoice_actual_cutover_next_month`:
--   • false (default): current month flips to Actual on `invoice_actual_cutover_day`
--     of the same month (legacy behavior; day=1 = flips on the 1st).
--   • true: a month flips to Actual on `invoice_actual_cutover_day` of the NEXT
--     month — e.g. day=1 means June stays Projection through June and becomes
--     Actual on July 1.
--
-- Defaults to false so existing workspaces are unaffected. Read by
-- adaptAppSettings → actualThruMonth(day, nextMonth) in data.js; written by the
-- Admin → Targets "Move to Actual on" card.

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.app_settings
  add column if not exists invoice_actual_cutover_next_month boolean not null default false;

notify pgrst, 'reload schema';
