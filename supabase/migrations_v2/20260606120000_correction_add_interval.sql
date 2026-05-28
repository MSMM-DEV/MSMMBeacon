-- 20260606120000_correction_add_interval.sql
--
-- Adds the 'add_interval' correction kind — an ATOMIC "I was away (or working)
-- for this sub-range" request. Backs the Worked/Away toggle on the
-- "Add New Time" block in CorrectionModal.
--
-- Why a new kind instead of reusing add_punch: carving a lunch/away block out
-- of a forgotten-punch-out day requires inserting BOTH boundary punches (the
-- model toggles presence on every punch, so two punches split one interval into
-- three with the middle one flipped). The old flow emitted two SEPARATE
-- add_punch corrections, so an admin could approve only one and flip the entire
-- rest of the day to the opposite presence. 'add_interval' is one correction
-- row carrying { start_at, end_at, is_out, category, note } — approved or
-- rejected as a single unit. The resolver (timeclock-admin) inserts both
-- punches, rebuilds the day, then stamps the carved interval's category with
-- category_source='user' so it survives every later rebuild.
--
-- Idempotent: ADD VALUE IF NOT EXISTS is a no-op if already present. Note that
-- a freshly-added enum value cannot be USED in the same transaction it is added
-- in; this migration only declares it (the value is first used later, at
-- runtime, by the Edge Function), so there is no in-transaction-use hazard here.

alter type beacon_v2.correction_kind_enum add value if not exists 'add_interval';

notify pgrst, 'reload schema';
