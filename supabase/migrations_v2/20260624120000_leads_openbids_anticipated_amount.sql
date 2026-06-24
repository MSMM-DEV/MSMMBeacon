-- 20260624120000_leads_openbids_anticipated_amount.sql
-- Anticipated Amount on the two pre-Proposal trackers.
--
-- Hot Leads (beacon_v2.leads) and Open Bids (beacon_v2.open_bids) get a
-- nullable dollar field `anticipated_amount` — the expected contract value of
-- the opportunity. On move-forward to Proposals the frontend carries this into
-- the new project's "Client Contract" field (client_contract_number), and the
-- Proposals stat card sums it across both trackers.
--
-- NOTE: the Hot Leads "Status" column was dropped from the UI in the same
-- change, but beacon_v2.leads.status (lead_status_enum) is LEFT IN PLACE here
-- on purpose — it still carries a DB default ('Scheduled'), the move-forward
-- Undo path round-trips it, and dropping it would be a destructive, hard-to-
-- reverse schema change for no functional gain. It is simply no longer
-- surfaced by the application.
--
-- Idempotent; DB-only — no Edge Function redeploy.

alter table beacon_v2.leads
  add column if not exists anticipated_amount numeric(14,2);

alter table beacon_v2.open_bids
  add column if not exists anticipated_amount numeric(14,2);

notify pgrst, 'reload schema';
