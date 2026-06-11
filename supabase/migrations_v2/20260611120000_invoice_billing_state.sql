-- ============================================================================
-- Invoice billing state — Active / In-Between / Closed (2026-06 IA restructure)
-- ============================================================================
-- The Invoice page splits into three sub-tabs: Invoices (active billing),
-- In-Between (paused projects), and Closed Out. A project "moves to
-- In-Between" by flipping this column — the anticipated_invoice row(s) keep
-- every month amount, sub link, attachment, and note; only the UI surface
-- changes. From In-Between a project resumes to 'active' or closes out.
--
-- 'closed' replaces the old destructive close-out (the frontend used to
-- DELETE the anticipated_invoice row when closing a project from the Invoice
-- tab, orphaning its billing history). Now close-out sets billing_state =
-- 'closed' on every year-row of the project + flips the upstream
-- beacon_v2.projects row to status='closed_out'. Reopening a closed project
-- to Invoice REVIVES the same rows (billing_state → 'active') instead of
-- inserting fresh ones — which also avoids colliding with the
-- anticipated_invoice_source_year_uniq partial unique index.
--
-- The frontend treats a project (= all year-rows merged by project number +
-- type) as a unit: transitions write the same state to every row in the
-- group; the merged row surfaces the most-active state found (active >
-- between > closed) so partial/legacy data degrades safely.
--
-- Idempotent — safe to re-paste.

do $$ begin
  create type beacon_v2.invoice_billing_state_enum as enum ('active','between','closed');
exception when duplicate_object then null; end $$;

alter table beacon_v2.anticipated_invoice
  add column if not exists billing_state beacon_v2.invoice_billing_state_enum
    not null default 'active';

-- The Invoice tabs filter on this constantly; tiny table, but the index is free.
create index if not exists anticipated_invoice_billing_state_idx
  on beacon_v2.anticipated_invoice (billing_state);

notify pgrst, 'reload schema';
