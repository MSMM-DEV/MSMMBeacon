-- Soft-delete for Leads & Bids (leads, open_bids) and Proposals & Awarded
-- (projects rows with status='awaiting' | 'awarded').
--
-- Deleting a Hot Lead, Open Bid, Proposal, or Awarded project no longer removes
-- the row — it stamps `deleted_at` and the frontend moves the row to that page's
-- "Deleted" sub-tab, where every field is preserved and a one-click Restore
-- clears the stamp. NULL deleted_at = live (the default), so existing rows are
-- unaffected and any query that doesn't filter still sees them.
--
-- The frontend selects `*` and partitions on `deleted_at` client-side, so it
-- degrades gracefully if this migration hasn't been applied yet (the column
-- reads as undefined → every row is treated as live and the Deleted tabs stay
-- empty). Idempotent; DB-only — no Edge Function redeploy.
--
-- NOTE on alerts: the generic BEFORE DELETE trigger `deactivate_alerts_for`
-- (20260428120800) fired on a hard DELETE to stop a removed row's future alert
-- fires. A soft delete is an UPDATE, so that trigger does NOT run — the frontend
-- soft-delete handler deactivates the row's alerts explicitly instead
-- (alerts.is_active = false where subject_row_id = the row). Restore leaves them
-- deactivated (re-arm from the bell if wanted).

alter table beacon_v2.leads      add column if not exists deleted_at timestamptz;
alter table beacon_v2.open_bids  add column if not exists deleted_at timestamptz;
alter table beacon_v2.projects   add column if not exists deleted_at timestamptz;

-- Partial indexes on the live rows keep the default (deleted_at IS NULL) scans
-- fast and small even as the archive grows.
create index if not exists leads_live_idx
  on beacon_v2.leads (date_time)      where deleted_at is null;
create index if not exists open_bids_live_idx
  on beacon_v2.open_bids (due_at)     where deleted_at is null;
create index if not exists projects_live_status_idx
  on beacon_v2.projects (status, year) where deleted_at is null;

notify pgrst, 'reload schema';
