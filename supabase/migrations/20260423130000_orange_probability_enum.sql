-- Codifies the `Orange` value on probability_enum. The enum was extended
-- out-of-band in Studio when the Orange bucket shipped (see the
-- 20260422120000_orange_potential.sql companion migration, which added the
-- columns but not the enum value). This migration makes a fresh environment
-- reproducible from migrations alone.
--
-- `add value if not exists` is a no-op on the live DB where the value is
-- already present, and must run outside a transaction — which is fine for
-- Supabase Studio / `supabase db push`, both of which run each migration
-- file as its own script.

alter type beacon.probability_enum add value if not exists 'Orange';
