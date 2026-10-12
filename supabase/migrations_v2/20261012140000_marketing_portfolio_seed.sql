-- MSMM Beacon v2 — Marketing portfolio context + initial 14-row portfolio.
--
-- The marketing lead's source wording is retained in source_sales_phase while
-- stage remains one of Beacon's seven canonical Marketing stages. The stable
-- source_record_key makes this seed rerunnable without overwriting later edits.

begin;
set local search_path = beacon_v2, public, extensions;

alter table beacon_v2.marketing_opportunities add column if not exists source_record_key text;
alter table beacon_v2.marketing_opportunities add column if not exists assigned_to_summary text;
alter table beacon_v2.marketing_opportunities add column if not exists task_order text;
alter table beacon_v2.marketing_opportunities add column if not exists delivery_status text;
alter table beacon_v2.marketing_opportunities add column if not exists project_progress numeric(5,2);
alter table beacon_v2.marketing_opportunities add column if not exists source_sales_phase text;

do $$ begin
  alter table beacon_v2.marketing_opportunities
    add constraint marketing_project_progress_range
    check (project_progress is null or project_progress between 0 and 100);
exception when duplicate_object then null;
end $$;

create unique index if not exists marketing_opportunities_source_record_key_uniq
  on beacon_v2.marketing_opportunities(source_record_key);

-- This seed targets the post-cutover Directory model: every contact belongs
-- to one canonical company and the legacy clients table no longer exists.
do $$
begin
  if to_regclass('beacon_v2.clients') is not null then
    raise exception 'Apply 20261012130000_unified_companies.sql before the Marketing portfolio seed';
  end if;
end;
$$;

create temporary table tmp_marketing_portfolio_seed (
  source_record_key text primary key,
  product text not null,
  project_name text not null,
  lead_source text,
  client_name text not null,
  assigned_to text not null,
  task_order text,
  delivery_status text,
  project_progress numeric(5,2) not null,
  source_sales_phase text,
  sales_percent numeric(5,2) not null,
  beacon_stage beacon_v2.marketing_stage_enum not null
) on commit drop;

insert into tmp_marketing_portfolio_seed values
  ('portfolio-01', 'Parish Intelligence', 'HSDRRS', null, 'USACE', 'RAJ', null, 'Waiting for Contract', 20, 'Verified BANT and Economic Buyer Approval', 90, 'Verbal Approval to Proceed'),
  ('portfolio-02', 'Parish Intelligence', 'Bayou Sauvage', null, 'US Fish and Wildlife', 'RAJ', null, 'Yet to talk about Contract', 70, 'Qualified Proposal / Solution Fit', 75, 'BANT - Budget Authority Need Time'),
  ('portfolio-03', 'Parish Intelligence', 'St. Bernard Parish', null, 'St. Bernard Parish', 'RAJ', null, 'Yet to talk about Contract', 40, 'Qualified Proposal / Solution Fit', 75, 'BANT - Budget Authority Need Time'),
  ('portfolio-04', 'Parish Intelligence', 'Coastal Environmental Innovations', null, 'Coastal Environmental Innovations', 'RAJ', null, 'Initial Kickoff', 0, 'IQM - Prospect', 25, 'IQM - Initial Qualified Meeting'),
  ('portfolio-05', 'Parish Intelligence', 'CWPPRA', null, 'USACE', 'PHIL', null, 'Completed - Being Used by USACE', 100, 'Proposal Term and Conditions / Task Order', 100, 'Legal and Contract Negotiation'),
  ('portfolio-06', 'Parish Intelligence', 'St. Tammany', null, 'St. Tammany', 'RANDY', null, 'Target', 0, null, 20, 'Initial meeting to showcase products and qualify prospect'),
  ('portfolio-07', 'Parish Intelligence', 'St. Helena Parish', null, 'St. Helena Parish', 'RANDY', null, 'Initial Meeting', 0, 'IQM - Prospect', 25, 'IQM - Initial Qualified Meeting'),
  ('portfolio-08', 'BluePrint AI', 'CAD AI', null, 'Sewerage and Water Board of New Orleans', 'PARIXIT', null, 'Contract Awarded', 40, 'Verified BANT/Economic Buyer Approval', 90, 'Verbal Approval to Proceed'),
  ('portfolio-09', 'Fulcrum', 'Fulcrum AI', null, 'Internal MSMM', 'RAJ', null, 'In Progress', 10, 'NOT A SALES CONTRACT', 0, 'Intro to Target or prospect'),
  ('portfolio-10', 'Beacon', 'MSMM Beacon', null, 'Internal MSMM', 'RAJ', null, 'Completed', 85, 'NOT A SALES CONTRACT', 0, 'Intro to Target or prospect'),
  ('portfolio-11', 'GeoTagger', 'Image Tagger Mobile App', null, 'Internal MSMM', 'RAJ', null, 'Waiting on Apple Developer Account Approval', 50, 'NOT A SALES CONTRACT', 0, 'Intro to Target or prospect'),
  ('portfolio-12', 'TBD', 'Financial Dashboard', null, 'Port of New Orleans', 'PHIL', null, 'Waiting for Contract', 0, 'Verified BANT and Economic Buyer Approval', 90, 'Verbal Approval to Proceed'),
  ('portfolio-13', 'Parish Intelligence', 'Parish Intelligence', 'LCECS', 'JV Burkes', 'KASH', null, 'Scheduled meeting', 0, 'Suspect', 10, 'Intro to Target or prospect'),
  ('portfolio-14', 'Parish Intelligence', 'Parish Intelligence', 'LCECS', 'CPRA', 'RAJ / KASH', null, null, 0, 'Suspect', 10, 'Intro to Target or prospect');

insert into beacon_v2.companies (name, is_msmm)
select distinct seed.client_name, false
  from tmp_marketing_portfolio_seed seed
 where not exists (
   select 1 from beacon_v2.companies company
    where lower(btrim(company.name)) = lower(btrim(seed.client_name))
 )
on conflict (name) do nothing;

create temporary table tmp_marketing_portfolio_contacts (
  source_record_key text not null,
  contact_name text not null,
  contact_title text,
  position integer not null,
  primary key (source_record_key, contact_name)
) on commit drop;

insert into tmp_marketing_portfolio_contacts values
  ('portfolio-01', 'Durand Elzey', null, 1),
  ('portfolio-01', 'Vic Landry', null, 2),
  ('portfolio-02', 'Mr. Pon', null, 1),
  ('portfolio-03', 'Steve Price', null, 1),
  ('portfolio-04', 'Mark Schexnayder', null, 1),
  ('portfolio-05', 'Jeff Varisco', null, 1),
  ('portfolio-06', 'Grant Black', 'IT Director', 1),
  ('portfolio-07', 'Dan Gerrity', null, 1),
  ('portfolio-08', 'Christopher Bergeron', null, 1),
  ('portfolio-09', 'Randy Pausina', null, 1),
  ('portfolio-10', 'Randy Pausina', null, 1),
  ('portfolio-11', 'George Grimes', null, 1),
  ('portfolio-12', 'Chris Gilmore', null, 1),
  ('portfolio-13', 'Sean Burkes', null, 1),
  ('portfolio-14', 'Jas Singh', null, 1);

with distinct_contacts as (
  select distinct seed.client_name, contact.contact_name, contact.contact_title
    from tmp_marketing_portfolio_contacts contact
    join tmp_marketing_portfolio_seed seed using (source_record_key)
), missing_contacts as (
  select company.id as company_id, source.contact_name, source.contact_title,
         row_number() over (partition by company.id order by source.contact_name) as new_ord
    from distinct_contacts source
    join beacon_v2.companies company
      on lower(btrim(company.name)) = lower(btrim(source.client_name))
   where not exists (
     select 1 from beacon_v2.contacts existing
      where existing.company_id = company.id
        and lower(btrim(existing.name)) = lower(btrim(source.contact_name))
   )
), company_ord as (
  select company_id, coalesce(max(ord), -1) as max_ord
    from beacon_v2.contacts
   group by company_id
)
insert into beacon_v2.contacts (company_id, name, title, is_primary, ord)
select missing.company_id, missing.contact_name, missing.contact_title, false,
       coalesce(existing.max_ord, -1) + missing.new_ord
  from missing_contacts missing
  left join company_ord existing using (company_id);

create temporary table tmp_inserted_marketing_opportunities (
  id uuid primary key,
  source_record_key text not null unique
) on commit drop;

with inserted as (
  insert into beacon_v2.marketing_opportunities (
    source_record_key, title, client_id, owner_id, stage, probability,
    product_tags, source, assigned_to_summary, task_order, delivery_status,
    project_progress, source_sales_phase
  )
  select seed.source_record_key, seed.project_name, company.id, owner.id,
         seed.beacon_stage, seed.sales_percent, array[seed.product],
         seed.lead_source, seed.assigned_to, seed.task_order,
         seed.delivery_status, seed.project_progress, seed.source_sales_phase
    from tmp_marketing_portfolio_seed seed
    join beacon_v2.companies company
      on lower(btrim(company.name)) = lower(btrim(seed.client_name))
    left join lateral (
      select user_row.id
        from beacon_v2.users user_row
       where upper(coalesce(user_row.display_name, '')) = case
               when seed.assigned_to in ('RAJ', 'RAJ / KASH') then 'RAJ'
               when seed.assigned_to = 'PHIL' then 'PHILIP'
               else seed.assigned_to
             end
          or upper(coalesce(user_row.short_name, '')) = split_part(seed.assigned_to, ' / ', 1)
       order by user_row.is_enabled desc, user_row.created_at, user_row.id
       limit 1
    ) owner on true
  on conflict (source_record_key) do nothing
  returning id, source_record_key
)
insert into tmp_inserted_marketing_opportunities (id, source_record_key)
select id, source_record_key from inserted;

insert into beacon_v2.marketing_opportunity_contacts (
  opportunity_id, contact_id, role, is_primary
)
select opportunity.id, directory_contact.id, 'Champion', source_contact.position = 1
  from tmp_inserted_marketing_opportunities opportunity
  join tmp_marketing_portfolio_contacts source_contact using (source_record_key)
  join tmp_marketing_portfolio_seed seed using (source_record_key)
  join beacon_v2.companies company
    on lower(btrim(company.name)) = lower(btrim(seed.client_name))
  join beacon_v2.contacts directory_contact
    on directory_contact.company_id = company.id
   and lower(btrim(directory_contact.name)) = lower(btrim(source_contact.contact_name))
on conflict (opportunity_id, contact_id) do nothing;

-- Existing installations already have the update RPC, so replace it here to
-- allow the five editable portfolio-context fields without requiring a replay
-- of the full original Marketing migration.
create or replace function beacon_v2.update_marketing_opportunity(
  _id uuid,
  _expected_version integer,
  _patch jsonb
) returns beacon_v2.marketing_opportunities
language plpgsql
security definer
set search_path = beacon_v2, pg_temp
as $$
declare
  v_old beacon_v2.marketing_opportunities;
  v_patch beacon_v2.marketing_opportunities;
  v_new beacon_v2.marketing_opportunities;
  v_actor uuid;
  v_unknown text[];
  v_allowed constant text[] := array[
    'title','client_id','owner_id','probability','expected_close_date','estimated_value','currency',
    'product_tags','source','assigned_to_summary','task_order','delivery_status','project_progress','source_sales_phase',
    'introducer','summary','next_action','next_action_due_at',
    'showcase_meeting_at','showcase_location','showcase_products','showcase_attendees_summary','showcase_fit','showcase_outcome',
    'problem_statement','desired_outcome','solution_fit','clarifying_questions','clarifying_owner_id','clarifying_due_at','clarifying_answers_status','draft_sow_status',
    'budget_amount','budget_status','budget_notes','authority_contact_id','authority_notes','need_summary','timing_summary','decision_process',
    'proposal_version','proposal_value','proposal_sent_at','scope_summary','anticipated_decision_date',
    'verbal_approval_at','verbal_approver_contact_id','verbal_terms','target_signature_date','signature_risks','resource_planning_note',
    'msa_status','sow_status','legal_owner_id','customer_legal_contact_id','redline_status','legal_issues','latest_document_version',
    'competitor','lesson_learned','archived_at','archived_by'
  ];
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  select * into v_old from beacon_v2.marketing_opportunities where id = _id for update;
  if not found then
    raise exception 'Marketing opportunity % not found', _id using errcode = 'P0002';
  end if;
  if v_old.version <> _expected_version then
    raise exception 'Marketing opportunity changed (expected version %, current %)', _expected_version, v_old.version
      using errcode = '40001';
  end if;
  select array_agg(key) into v_unknown
    from jsonb_object_keys(coalesce(_patch, '{}'::jsonb)) as keys(key)
   where not (key = any(v_allowed));
  if v_unknown is not null then
    raise exception 'Unsupported Marketing fields: %', array_to_string(v_unknown, ', ')
      using errcode = '22023';
  end if;
  select * into v_patch from jsonb_populate_record(v_old, coalesce(_patch, '{}'::jsonb));
  select id into v_actor from beacon_v2.users where auth_user_id = auth.uid() limit 1;

  update beacon_v2.marketing_opportunities set
    title = v_patch.title, client_id = v_patch.client_id, owner_id = v_patch.owner_id,
    probability = v_patch.probability, expected_close_date = v_patch.expected_close_date,
    estimated_value = v_patch.estimated_value, currency = v_patch.currency,
    product_tags = v_patch.product_tags, source = v_patch.source,
    assigned_to_summary = v_patch.assigned_to_summary, task_order = v_patch.task_order,
    delivery_status = v_patch.delivery_status, project_progress = v_patch.project_progress,
    source_sales_phase = v_patch.source_sales_phase, introducer = v_patch.introducer,
    summary = v_patch.summary, next_action = v_patch.next_action, next_action_due_at = v_patch.next_action_due_at,
    showcase_meeting_at = v_patch.showcase_meeting_at, showcase_location = v_patch.showcase_location,
    showcase_products = v_patch.showcase_products, showcase_attendees_summary = v_patch.showcase_attendees_summary,
    showcase_fit = v_patch.showcase_fit, showcase_outcome = v_patch.showcase_outcome,
    problem_statement = v_patch.problem_statement, desired_outcome = v_patch.desired_outcome,
    solution_fit = v_patch.solution_fit, clarifying_questions = v_patch.clarifying_questions,
    clarifying_owner_id = v_patch.clarifying_owner_id, clarifying_due_at = v_patch.clarifying_due_at,
    clarifying_answers_status = v_patch.clarifying_answers_status, draft_sow_status = v_patch.draft_sow_status,
    budget_amount = v_patch.budget_amount, budget_status = v_patch.budget_status, budget_notes = v_patch.budget_notes,
    authority_contact_id = v_patch.authority_contact_id, authority_notes = v_patch.authority_notes,
    need_summary = v_patch.need_summary, timing_summary = v_patch.timing_summary, decision_process = v_patch.decision_process,
    proposal_version = v_patch.proposal_version, proposal_value = v_patch.proposal_value,
    proposal_sent_at = v_patch.proposal_sent_at, scope_summary = v_patch.scope_summary,
    anticipated_decision_date = v_patch.anticipated_decision_date,
    verbal_approval_at = v_patch.verbal_approval_at, verbal_approver_contact_id = v_patch.verbal_approver_contact_id,
    verbal_terms = v_patch.verbal_terms, target_signature_date = v_patch.target_signature_date,
    signature_risks = v_patch.signature_risks, resource_planning_note = v_patch.resource_planning_note,
    msa_status = v_patch.msa_status, sow_status = v_patch.sow_status, legal_owner_id = v_patch.legal_owner_id,
    customer_legal_contact_id = v_patch.customer_legal_contact_id, redline_status = v_patch.redline_status,
    legal_issues = v_patch.legal_issues, latest_document_version = v_patch.latest_document_version,
    competitor = v_patch.competitor, lesson_learned = v_patch.lesson_learned,
    archived_at = v_patch.archived_at, archived_by = v_patch.archived_by, updated_by = v_actor
  where id = _id
  returning * into v_new;
  return v_new;
end;
$$;

revoke all on function beacon_v2.update_marketing_opportunity(uuid,integer,jsonb) from public, anon;
grant execute on function beacon_v2.update_marketing_opportunity(uuid,integer,jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
