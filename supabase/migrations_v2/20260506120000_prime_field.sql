-- Prime contractor as a first-class field on projects.
--
-- Before: `prime_company_id` doubled as the role discriminator — the
-- consistency check forced role='Prime' ⟺ prime_company_id IS NULL, so a
-- Prime-role row could not record who the prime *was* (typically MSMM, or a
-- joint-venture partner). The Awarded UI worked around this by conflating
-- the prime firm into the Client column on Sub-role rows, which loses
-- information whenever a project has both an end-client and an external
-- prime.
--
-- After: Prime is independent of role. It can point at either a company
-- (`prime_company_id`, existing) or a client (`prime_client_id`, new) — at
-- most one of the two is set. The role/prime consistency check is dropped.
--
-- Existing data is unaffected: every Sub-role row already has
-- `prime_company_id` set; every Prime-role row has it NULL. Both states
-- remain valid under the relaxed rules.

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.projects
  drop constraint if exists projects_potential_role_company_consistency;

alter table beacon_v2.projects
  add column if not exists prime_client_id uuid
    references beacon_v2.clients(id) on delete restrict;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'projects_prime_at_most_one'
       and conrelid = 'beacon_v2.projects'::regclass
  ) then
    alter table beacon_v2.projects
      add constraint projects_prime_at_most_one
        check (prime_company_id is null or prime_client_id is null);
  end if;
end $$;

create index if not exists projects_prime_client_idx
  on beacon_v2.projects (prime_client_id);
