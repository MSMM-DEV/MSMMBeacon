-- MSMM Beacon v2 — Team Calendar visibility.
--
-- Adds a permissive SELECT policy on beacon_v2.user_calendar_events so any
-- authenticated user can see other colleagues' non-private, non-cancelled
-- events. Powers the read-only Team Calendar tab (one consolidated UI in
-- place of Outlook's stacked-calendar shared view).
--
-- Privacy posture (preserved):
--   • sensitivity = 'private' or 'confidential' → invisible to everyone
--     except the owner (the existing tk_calevents_self_select policy still
--     covers the owner).
--   • is_cancelled = true → invisible in the team view; owner still sees
--     via self-select.
--   • event body is NEVER stored (see 20260601120200_user_calendar_events.sql).
--     Subject + location are what end up on the Team Calendar tiles.
--
-- RLS combines policies as a UNION ("OR"), so the existing self + admin
-- SELECT policies remain intact — this only widens the read surface for
-- normal-sensitivity events.

set search_path = beacon_v2, public, extensions;

drop policy if exists "tk_calevents_team_select" on beacon_v2.user_calendar_events;

create policy "tk_calevents_team_select" on beacon_v2.user_calendar_events
  for select to authenticated
  using (
    (sensitivity is null or sensitivity = 'normal')
    and is_cancelled = false
  );

-- Nudge PostgREST so the new policy is in effect immediately.
notify pgrst, 'reload schema';
