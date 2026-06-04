-- Per-sub compliance-document flags on project_subs.
--
-- For every sub a project hires, MSMM tracks whether three onboarding
-- documents have been collected:
--   • sub_agreement — the signed subcontractor agreement
--   • w9           — the sub's W-9 tax form
--   • coi          — the sub's Certificate of Insurance
--
-- These are properties of the (project, sub, kind) relationship, so they
-- live on project_subs alongside `amount` / `discipline`. The Invoice tab's
-- expand view renders three toggle chips per sub row; each click flips one
-- boolean via the existing updateProjectSub path (keyed on
-- project_id + company_id + kind). NOT NULL DEFAULT false → existing rows
-- read as "not yet collected" with no backfill.

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.project_subs
  add column if not exists sub_agreement boolean not null default false,
  add column if not exists w9            boolean not null default false,
  add column if not exists coi           boolean not null default false;

notify pgrst, 'reload schema';
