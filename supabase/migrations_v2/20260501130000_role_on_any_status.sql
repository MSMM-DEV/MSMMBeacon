-- MSMM Beacon v2 — allow projects.role on any status, not just 'potential'.
--
-- The original `projects_role_only_on_potential` check came from v1's
-- isolation between potential_projects and awarded_projects (role lived
-- only on the Potential table). v2 collapsed those into one table but
-- kept the constraint, which made the Invoice tab's Prime/Sub toggle
-- fail at the DB whenever the linked project was awarded/closed (or a
-- freshly auto-created stub, which is status='awarded').
--
-- Role (Prime / Sub) is a real-world fact about the project — we either
-- are or aren't the prime contractor, and that's true at every stage.
-- Drop the stage gate; keep the consistency check
-- (`projects_potential_role_company_consistency`: Prime → no
-- prime_company_id; Sub → must have one).

set search_path = beacon_v2, public;

alter table beacon_v2.projects
  drop constraint if exists projects_role_only_on_potential;
