-- MSMM Beacon v2 — contract AMENDMENTS on the Invoice page.
--
-- An amendment is a signed change to a contract's value: one attachment, one
-- dollar amount, and a note. A line's Contract Value becomes
--
--     Contract Value = contract amount + Σ (its amendments)
--
-- and that amended figure is what the whole Invoice page reads — Total Billed,
-- Total Remaining, the MSMM Total − Σ subs auto-calc, the cash-flow charts and
-- every export. An amendment raises the contract, so more of it remains to
-- bill; anything less would leave the Contract Value column disagreeing with
-- the Total Remaining column one cell over.
--
-- TWO SCOPES, one table, discriminated by which key set is populated:
--
--   * PROJECT — `invoice_id` set. Raises the project's Total Contract Value
--     (anticipated_invoice.contract_amount, the figure on the "Project total"
--     row). MSMM is derived as Total − Σ subs, so it absorbs the increase on
--     its own when no sub is amended, and the breakdown still reconciles.
--
--   * SUB — (`project_id`, `company_id`, `kind`) set. Raises that one sub
--     line's contract and nothing else. This mirrors `sub_invoices`' natural
--     key exactly (see 20260429120000 + 20260429120200), which is the key the
--     whole app already treats as sub identity: updateProjectSub,
--     removeProjectSub and the sub-invoice matrix all address a sub this way,
--     and `project_subs_proj_company_kind_uniq` (20260606120600) makes it
--     unique. Keying on project_subs.id instead would have meant threading a
--     new id through both sub-matrix builders for no gain.
--
-- Amendments are deliberately NOT year-scoped. A merged Invoice row folds
-- every year of a project together (mergeInvoiceYears), and an amendment is a
-- fact about the contract, not about a year — so one amendment set serves
-- every year-row. The frontend likewise unions a merged row's group ids with
-- its linked ENG↔MHZ / PM↔MHZ PM perspective siblings when reading, so the two
-- perspectives of one JV project show the same amendments without the row
-- being duplicated per perspective.
--
-- File binaries live in the EXISTING private `invoices` Storage bucket (its
-- authenticated-CRUD object policies from 20260430130000 already cover this);
-- only the path + display name are stored here.
--
-- DB-only — no Edge Function redeploy. Idempotent; safe to re-paste.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. The table.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.invoice_amendments (
  id          uuid primary key default gen_random_uuid(),

  -- PROJECT scope.
  invoice_id  uuid references beacon_v2.anticipated_invoice(id) on delete cascade,

  -- SUB scope. company_id is `restrict` to match project_subs / sub_invoices —
  -- the merge RPCs (20260606130000) repoint references before deleting a loser
  -- company, and restrict is what makes a missed reference roll the merge back
  -- instead of silently dropping financial history.
  project_id  uuid references beacon_v2.projects(id)  on delete cascade,
  company_id  uuid references beacon_v2.companies(id) on delete restrict,
  kind        text check (kind in ('sub','prime')),

  -- The amendment itself: one amount, one note, one attachment.
  amount      numeric(14,2) not null default 0,
  notes       text,
  file_path   text,
  file_name   text,

  created_by  uuid references beacon_v2.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Exactly one scope, fully specified. A half-populated sub key would be
  -- unaddressable by the natural-key lookups the frontend does.
  constraint invoice_amendments_one_scope check (
    (invoice_id is not null
      and project_id is null and company_id is null and kind is null)
    or
    (invoice_id is null
      and project_id is not null and company_id is not null and kind is not null)
  )
);

create index if not exists invoice_amendments_invoice_idx
  on beacon_v2.invoice_amendments (invoice_id) where invoice_id is not null;
create index if not exists invoice_amendments_sub_idx
  on beacon_v2.invoice_amendments (project_id, company_id, kind) where project_id is not null;

drop trigger if exists touch_invoice_amendments on beacon_v2.invoice_amendments;
create trigger touch_invoice_amendments before update on beacon_v2.invoice_amendments
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- 2. RLS — permissive for authenticated, the posture the rest of the invoice
--    surface already uses (anticipated_invoice, sub_invoices, open_bids).
--    Contract and month amounts are edited by anyone on the team today; an
--    amendment is the same class of figure, so gating it harder would be
--    inconsistent rather than safer. No anon access: unlike the older
--    prototype tables, nothing here needs to render signed-out.
--------------------------------------------------------------------------------
alter table beacon_v2.invoice_amendments enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'beacon_v2'
       and tablename  = 'invoice_amendments'
       and policyname = 'invoice_amendments_auth_all'
  ) then
    create policy invoice_amendments_auth_all
      on beacon_v2.invoice_amendments
      for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

grant select, insert, update, delete on beacon_v2.invoice_amendments to authenticated;

notify pgrst, 'reload schema';
