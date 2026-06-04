-- Stop duplicate sub rows on a project (e.g. "SVS" appearing 2–3× on 202309).
--
-- THE BUG: project_subs only had a uniqueness guard for kind='prime'
-- (project_subs_one_prime_uniq, added in 20260429120200). kind='sub' rows had
-- none — yet the whole app treats (project_id, company_id, kind) as the
-- natural key: updateProjectSub / removeProjectSub filter on exactly that
-- tuple, and the sub_invoices matrix is keyed on (project, company, kind).
-- So addProjectSub's blind INSERT (no existence check) could leave two+ rows
-- for the same company, and every update/remove then hit ALL of them. The
-- duplicates persisted in the DB and accumulated over repeated adds.
--
-- The original schema comment claimed the uuid PK "lets the same company
-- appear twice (different disciplines / split amounts)", but that capability
-- was never actually supported by the app (update/remove are keyed on
-- company, not on the row id), so enforcing one-row-per-(project,company,kind)
-- matches how the code has always behaved.
--
-- This migration (1) merges existing duplicates into a single surviving row,
-- preserving amount/discipline, then (2) adds the unique index that makes
-- future duplicates impossible — even under a double-submit race. NULL
-- company_id rows (draft subs) are left alone: they're excluded from the
-- dedupe and, because NULLs are distinct in a unique index, several drafts
-- per project remain allowed. Idempotent / re-runnable.

set search_path = beacon_v2, public, extensions;

-- 1a. Backfill the surviving row's null fields from its duplicates so no
--     amount/discipline is lost when the losers are deleted. The survivor is
--     the richest row (has amount, then discipline, then earliest created).
with grp as (
  select project_id, company_id, kind,
         (array_agg(id order by (amount is not null) desc,
                               (discipline is not null) desc,
                               created_at asc, id asc))[1]            as keep_id,
         max(amount)                                                  as merged_amount,
         (array_agg(discipline order by (discipline is not null) desc,
                                        created_at asc, id asc))[1]   as merged_discipline
  from beacon_v2.project_subs
  where company_id is not null
  group by project_id, company_id, kind
  having count(*) > 1
)
update beacon_v2.project_subs ps
set amount     = coalesce(ps.amount, g.merged_amount),
    discipline = coalesce(ps.discipline, g.merged_discipline)
from grp g
where ps.id = g.keep_id;

-- 1b. Delete the duplicate (non-surviving) rows. sub_invoices are keyed on
--     (project, company, kind) — NOT on project_subs.id — so removing extra
--     project_subs rows never orphans any billing data.
with grp as (
  select project_id, company_id, kind,
         (array_agg(id order by (amount is not null) desc,
                               (discipline is not null) desc,
                               created_at asc, id asc))[1] as keep_id
  from beacon_v2.project_subs
  where company_id is not null
  group by project_id, company_id, kind
  having count(*) > 1
)
delete from beacon_v2.project_subs ps
using grp g
where ps.project_id = g.project_id
  and ps.company_id = g.company_id
  and ps.kind       = g.kind
  and ps.id <> g.keep_id;

-- 2. Enforce one row per (project, company, kind) going forward. Complements
--    the existing prime-only index. company_id NULLs stay distinct → draft
--    subs (no company picked yet) are unaffected.
create unique index if not exists project_subs_proj_company_kind_uniq
  on beacon_v2.project_subs (project_id, company_id, kind);

notify pgrst, 'reload schema';
