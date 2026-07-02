-- 20260702120000_leads_three_star_rating.sql
--   Hot Leads now use a 3-star rating scale: 1 / 2 / 3 / unrated.
--   Events keep their existing 5-star range.

alter table beacon_v2.leads
  drop constraint if exists leads_stars_range;

alter table beacon_v2.leads
  add constraint leads_stars_range
  check (stars is null or (stars between 1 and 3));

notify pgrst, 'reload schema';
