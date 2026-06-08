-- Team presence visibility — let any authenticated user READ everyone's
-- timekeeping intervals + day rollups so the personal Timesheet tab can show a
-- read-only "where is everyone" board (each colleague's current tag/category +
-- their notes + a day timeline). The office uses this to see who's in, who's at
-- lunch / in a meeting / out, so people can find each other.
--
-- Mirrors the Team-Calendar visibility widening (20260528120000): these are
-- additive permissive SELECT policies that UNION with the existing strict
-- self/admin SELECT policies (Postgres RLS combines permissive policies with
-- OR). Nothing about WRITES changes — only the note's author / an Admin can
-- still insert/update/delete a row, so this view is strictly read-only for
-- everyone. Service-role (Edge Functions) bypasses RLS and is unaffected.
--
-- PRIVACY NOTE: this exposes every user's punch-derived intervals (in/out
-- times, category, and the free-text `notes`) and their per-day minute rollups
-- to ALL signed-in colleagues. That is the intended behavior for an internal
-- office presence board. Raw `time_punches` are deliberately NOT widened. To
-- dial this back later, either drop these policies (reverts to self/admin only)
-- or replace them with a column-limited view.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. time_intervals — team read.
--------------------------------------------------------------------------------
drop policy if exists "tk_intervals_team_select" on beacon_v2.time_intervals;
create policy "tk_intervals_team_select" on beacon_v2.time_intervals
  for select to authenticated using (true);

--------------------------------------------------------------------------------
-- 2. timesheet_days — team read (per-day minute rollups for the totals shown
--    next to each person on the presence board).
--------------------------------------------------------------------------------
drop policy if exists "tk_days_team_select" on beacon_v2.timesheet_days;
create policy "tk_days_team_select" on beacon_v2.timesheet_days
  for select to authenticated using (true);

--------------------------------------------------------------------------------
-- 3. Reload PostgREST so the widened read surface is live immediately.
--------------------------------------------------------------------------------
notify pgrst, 'reload schema';
