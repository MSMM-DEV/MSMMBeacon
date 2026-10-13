-- Sales (Marketing) pipeline — fail fast instead of hanging on a locked row.
--
-- Both write RPCs begin with `select … for update` on the opportunity row. When
-- another session held a lock on that row (2026-10-13: a lingering open
-- transaction), every stage move waited on the lock until the role's statement
-- timeout fired, surfacing as a generic error on the Kanban board — and callers
-- without a statement timeout (service_role) parked API pool connections until
-- PostgREST reported PGRST003 for the whole app.
--
-- A function-level `lock_timeout` makes a blocked row fail within 3 s with
-- SQLSTATE 55P03, which the frontend maps to a clear "busy, try again" message.
-- Signatures, bodies, and grants are unchanged. Idempotent; safe to re-paste.

alter function beacon_v2.transition_marketing_opportunity(
  uuid, integer, beacon_v2.marketing_stage_enum, numeric,
  beacon_v2.marketing_outcome_enum, date, numeric,
  beacon_v2.marketing_loss_reason_enum, text, text
) set lock_timeout = '3s';

alter function beacon_v2.update_marketing_opportunity(uuid, integer, jsonb)
  set lock_timeout = '3s';

notify pgrst, 'reload schema';
