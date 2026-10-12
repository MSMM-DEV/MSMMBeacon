-- MSMM Beacon v2 — dedicated Marketing pipeline for SaaS and AI sales.
--
-- The seven enum values below are product copy and persistent identifiers.
-- Never rename or abbreviate them. Opportunities remain in Marketing when
-- Won/Lost; this migration creates no downstream project-pipeline linkage.
-- Idempotent and safe to re-paste in Supabase Studio.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Enums
--------------------------------------------------------------------------------
do $$ begin create type beacon_v2.marketing_stage_enum as enum (
  'Intro to Target or prospect',
  'Initial meeting to showcase products and qualify prospect',
  'IQM - Initial Qualified Meeting',
  'BANT - Budget Authority Need Time',
  'Verbal Approval to Proceed',
  'Legal and Contract Negotiation',
  'Contract Signed Won or Lost'
); exception when duplicate_object then null; end $$;

do $$ begin create type beacon_v2.marketing_outcome_enum as enum ('won','lost'); exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.marketing_loss_reason_enum as enum (
  'Price','Did not meet their needs','Timing was not right','Competitor','Internal build','Other'
); exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.marketing_contact_role_enum as enum (
  'Champion','Decision-maker','Budget owner','Legal contact','Technical evaluator','Other'
); exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.marketing_activity_type_enum as enum (
  'Meeting','Call','Email','Demonstration','Proposal','Legal update','Note'
); exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.marketing_task_priority_enum as enum ('low','normal','high','urgent'); exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.marketing_task_state_enum as enum ('open','completed'); exception when duplicate_object then null; end $$;
do $$ begin create type beacon_v2.marketing_document_type_enum as enum ('Proposal','SOW','MSA','Contract','Supporting'); exception when duplicate_object then null; end $$;

--------------------------------------------------------------------------------
-- 2. Core opportunity record
--------------------------------------------------------------------------------
create table if not exists beacon_v2.marketing_opportunities (
  id                          uuid primary key default gen_random_uuid(),
  title                       text not null check (btrim(title) <> ''),
  client_id                   uuid references beacon_v2.companies(id) on delete set null,
  owner_id                    uuid references beacon_v2.users(id) on delete set null,
  created_by                  uuid references beacon_v2.users(id) on delete set null,
  updated_by                  uuid references beacon_v2.users(id) on delete set null,

  stage                       beacon_v2.marketing_stage_enum not null default 'Intro to Target or prospect',
  stage_entered_at            timestamptz not null default now(),
  probability                 numeric(5,2) not null default 5,
  expected_close_date         date,
  estimated_value             numeric(14,2),
  currency                    text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  product_tags                text[] not null default '{}',
  source                      text,
  source_record_key           text,
  assigned_to_summary         text,
  task_order                  text,
  delivery_status             text,
  project_progress            numeric(5,2),
  source_sales_phase          text,
  introducer                  text,
  summary                     text,
  next_action                 text,
  next_action_due_at          timestamptz,
  last_activity_at            timestamptz,

  showcase_meeting_at         timestamptz,
  showcase_location           text,
  showcase_products           text[] not null default '{}',
  showcase_attendees_summary  text,
  showcase_fit                text,
  showcase_outcome            text,

  problem_statement           text,
  desired_outcome             text,
  solution_fit                text,
  clarifying_questions        text,
  clarifying_owner_id         uuid references beacon_v2.users(id) on delete set null,
  clarifying_due_at           timestamptz,
  clarifying_answers_status   text,
  draft_sow_status            text,

  budget_amount               numeric(14,2),
  budget_status               text,
  budget_notes                text,
  authority_contact_id        uuid references beacon_v2.contacts(id) on delete set null,
  authority_notes             text,
  need_summary                text,
  timing_summary              text,
  decision_process            text,
  proposal_version            text,
  proposal_value              numeric(14,2),
  proposal_sent_at            timestamptz,
  scope_summary               text,
  anticipated_decision_date   date,

  verbal_approval_at          timestamptz,
  verbal_approver_contact_id  uuid references beacon_v2.contacts(id) on delete set null,
  verbal_terms                text,
  target_signature_date       date,
  signature_risks             text,
  resource_planning_note      text,

  msa_status                  text,
  sow_status                  text,
  legal_owner_id              uuid references beacon_v2.users(id) on delete set null,
  customer_legal_contact_id   uuid references beacon_v2.contacts(id) on delete set null,
  redline_status              text,
  legal_issues                text,
  latest_document_version     text,

  outcome                     beacon_v2.marketing_outcome_enum,
  signed_at                   date,
  final_contract_value        numeric(14,2),
  loss_reason                 beacon_v2.marketing_loss_reason_enum,
  loss_detail                 text,
  competitor                  text,
  lesson_learned              text,
  last_transition_note        text,

  archived_at                 timestamptz,
  archived_by                 uuid references beacon_v2.users(id) on delete set null,
  version                     integer not null default 1 check (version > 0),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint marketing_probability_range check (probability between 0 and 100),
  constraint marketing_project_progress_range check (project_progress is null or project_progress between 0 and 100),
  constraint marketing_estimated_value_nonnegative check (estimated_value is null or estimated_value >= 0),
  constraint marketing_budget_nonnegative check (budget_amount is null or budget_amount >= 0),
  constraint marketing_proposal_nonnegative check (proposal_value is null or proposal_value >= 0),
  constraint marketing_final_value_nonnegative check (final_contract_value is null or final_contract_value >= 0),
  constraint marketing_terminal_consistency check (
    (stage <> 'Contract Signed Won or Lost' and outcome is null and signed_at is null and loss_reason is null)
    or (stage = 'Contract Signed Won or Lost' and outcome = 'won' and probability = 100 and signed_at is not null and final_contract_value is not null and loss_reason is null)
    or (stage = 'Contract Signed Won or Lost' and outcome = 'lost' and probability = 0 and loss_reason is not null and signed_at is null)
  )
);

-- Keep the migration re-runnable as an upgrade for databases where the first
-- Marketing release was already applied before portfolio context was added.
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

create index if not exists marketing_opportunities_stage_idx on beacon_v2.marketing_opportunities(stage) where archived_at is null;
create index if not exists marketing_opportunities_owner_idx on beacon_v2.marketing_opportunities(owner_id) where archived_at is null;
create index if not exists marketing_opportunities_client_idx on beacon_v2.marketing_opportunities(client_id);
create index if not exists marketing_opportunities_close_idx on beacon_v2.marketing_opportunities(expected_close_date) where archived_at is null;
create index if not exists marketing_opportunities_action_idx on beacon_v2.marketing_opportunities(next_action_due_at) where archived_at is null;
create index if not exists marketing_opportunities_activity_idx on beacon_v2.marketing_opportunities(last_activity_at) where archived_at is null;
create unique index if not exists marketing_opportunities_source_record_key_uniq
  on beacon_v2.marketing_opportunities(source_record_key);

--------------------------------------------------------------------------------
-- 3. Contacts, activities and participants
--------------------------------------------------------------------------------
create table if not exists beacon_v2.marketing_opportunity_contacts (
  opportunity_id uuid not null references beacon_v2.marketing_opportunities(id) on delete cascade,
  contact_id     uuid not null references beacon_v2.contacts(id) on delete cascade,
  role           beacon_v2.marketing_contact_role_enum not null default 'Other',
  is_primary     boolean not null default false,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (opportunity_id, contact_id)
);
with ranked as (
  select opportunity_id, contact_id,
         row_number() over (partition by opportunity_id order by created_at, contact_id) as position
    from beacon_v2.marketing_opportunity_contacts
   where is_primary
)
update beacon_v2.marketing_opportunity_contacts target
   set is_primary = false
  from ranked
 where target.opportunity_id = ranked.opportunity_id
   and target.contact_id = ranked.contact_id
   and ranked.position > 1;
create unique index if not exists marketing_contacts_one_primary
  on beacon_v2.marketing_opportunity_contacts(opportunity_id) where is_primary;

create table if not exists beacon_v2.marketing_activities (
  id              uuid primary key default gen_random_uuid(),
  opportunity_id  uuid not null references beacon_v2.marketing_opportunities(id) on delete cascade,
  activity_type   beacon_v2.marketing_activity_type_enum not null,
  occurred_at     timestamptz not null,
  author_id       uuid references beacon_v2.users(id) on delete set null,
  summary         text not null check (btrim(summary) <> ''),
  outcome         text,
  next_step       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists marketing_activities_opportunity_idx on beacon_v2.marketing_activities(opportunity_id, occurred_at desc);

create table if not exists beacon_v2.marketing_activity_users (
  activity_id uuid not null references beacon_v2.marketing_activities(id) on delete cascade,
  user_id     uuid not null references beacon_v2.users(id) on delete cascade,
  primary key (activity_id, user_id)
);

create table if not exists beacon_v2.marketing_activity_contacts (
  activity_id uuid not null references beacon_v2.marketing_activities(id) on delete cascade,
  contact_id  uuid not null references beacon_v2.contacts(id) on delete cascade,
  primary key (activity_id, contact_id)
);

--------------------------------------------------------------------------------
-- 4. Tasks, private document metadata and stage history
--------------------------------------------------------------------------------
create table if not exists beacon_v2.marketing_tasks (
  id              uuid primary key default gen_random_uuid(),
  opportunity_id  uuid not null references beacon_v2.marketing_opportunities(id) on delete cascade,
  title           text not null check (btrim(title) <> ''),
  assignee_id     uuid references beacon_v2.users(id) on delete set null,
  due_at          timestamptz,
  priority        beacon_v2.marketing_task_priority_enum not null default 'normal',
  status          beacon_v2.marketing_task_state_enum not null default 'open',
  notes           text,
  alert_id        uuid references beacon_v2.alerts(id) on delete set null,
  completed_at    timestamptz,
  completed_by    uuid references beacon_v2.users(id) on delete set null,
  created_by      uuid references beacon_v2.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint marketing_task_completion_consistency check (
    (status = 'open' and completed_at is null and completed_by is null)
    or (status = 'completed' and completed_at is not null)
  )
);
create index if not exists marketing_tasks_due_idx on beacon_v2.marketing_tasks(opportunity_id, status, due_at);

create table if not exists beacon_v2.marketing_documents (
  id              uuid primary key default gen_random_uuid(),
  opportunity_id  uuid not null references beacon_v2.marketing_opportunities(id) on delete cascade,
  document_type   beacon_v2.marketing_document_type_enum not null default 'Supporting',
  file_path       text not null unique,
  file_name       text not null,
  mime_type       text,
  size_bytes      bigint check (size_bytes is null or size_bytes >= 0),
  uploaded_by     uuid references beacon_v2.users(id) on delete set null,
  uploaded_at     timestamptz not null default now()
);
create index if not exists marketing_documents_opportunity_idx on beacon_v2.marketing_documents(opportunity_id, uploaded_at desc);

create table if not exists beacon_v2.marketing_stage_history (
  id                    uuid primary key default gen_random_uuid(),
  opportunity_id        uuid not null references beacon_v2.marketing_opportunities(id) on delete cascade,
  from_stage             beacon_v2.marketing_stage_enum,
  to_stage               beacon_v2.marketing_stage_enum not null,
  previous_probability   numeric(5,2),
  new_probability        numeric(5,2) not null,
  previous_outcome       beacon_v2.marketing_outcome_enum,
  new_outcome            beacon_v2.marketing_outcome_enum,
  transition_note        text,
  changed_by             uuid references beacon_v2.users(id) on delete set null,
  changed_at             timestamptz not null default now()
);
create index if not exists marketing_history_opportunity_idx on beacon_v2.marketing_stage_history(opportunity_id, changed_at desc);

--------------------------------------------------------------------------------
-- 5. Touch/version/history/activity triggers and atomic transition RPC
--------------------------------------------------------------------------------
create or replace function beacon_v2.fn_marketing_opportunity_before_update()
returns trigger language plpgsql as $$
begin
  if (
    new.stage is distinct from old.stage
    or new.outcome is distinct from old.outcome
    or new.signed_at is distinct from old.signed_at
    or new.final_contract_value is distinct from old.final_contract_value
    or new.loss_reason is distinct from old.loss_reason
    or new.loss_detail is distinct from old.loss_detail
  ) and coalesce(current_setting('beacon_v2.marketing_transition_rpc', true), '') <> 'on' then
    raise exception 'Stage and outcome changes must use transition_marketing_opportunity'
      using errcode = '42501';
  end if;
  if new.stage is distinct from old.stage then
    new.stage_entered_at := now();
  else
    -- A note belongs to the stage move that supplied it. Prevent a later
    -- probability-only edit from reusing a stale transition note.
    new.last_transition_note := null;
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_marketing_opportunity_before_update on beacon_v2.marketing_opportunities;
create trigger trg_marketing_opportunity_before_update
  before update on beacon_v2.marketing_opportunities
  for each row execute function beacon_v2.fn_marketing_opportunity_before_update();

create or replace function beacon_v2.fn_marketing_history()
returns trigger
language plpgsql
security definer
set search_path = beacon_v2, pg_temp
as $$
declare
  v_changed_by uuid;
  v_note text;
begin
  if new.stage is not distinct from old.stage
     and new.probability is not distinct from old.probability
     and new.outcome is not distinct from old.outcome then
    if new.archived_at is distinct from old.archived_at then
      v_note := case when new.archived_at is null then 'Opportunity restored' else 'Opportunity archived' end;
    elsif (to_jsonb(new) - array['version','updated_at','updated_by','last_activity_at','last_transition_note'])
          is distinct from
          (to_jsonb(old) - array['version','updated_at','updated_by','last_activity_at','last_transition_note']) then
      v_note := 'Opportunity details updated';
    else
      return new;
    end if;
  end if;
  v_changed_by := new.updated_by;
  if v_changed_by is null and auth.uid() is not null then
    select id into v_changed_by from beacon_v2.users where auth_user_id = auth.uid() limit 1;
  end if;
  insert into beacon_v2.marketing_stage_history (
    opportunity_id, from_stage, to_stage, previous_probability, new_probability,
    previous_outcome, new_outcome, transition_note, changed_by
  ) values (
    new.id, old.stage, new.stage, old.probability, new.probability,
    old.outcome, new.outcome, coalesce(new.last_transition_note, v_note), v_changed_by
  );
  return new;
end;
$$;

revoke all on function beacon_v2.fn_marketing_history() from public, anon, authenticated;

drop trigger if exists trg_marketing_history on beacon_v2.marketing_opportunities;
create trigger trg_marketing_history
  after update on beacon_v2.marketing_opportunities
  for each row execute function beacon_v2.fn_marketing_history();

create or replace function beacon_v2.fn_marketing_refresh_last_activity()
returns trigger
language plpgsql
security definer
set search_path = beacon_v2, pg_temp
as $$
declare
  v_opportunity uuid;
begin
  v_opportunity := case when tg_op = 'DELETE' then old.opportunity_id else new.opportunity_id end;
  update beacon_v2.marketing_opportunities
     set last_activity_at = (
       select max(occurred_at) from beacon_v2.marketing_activities where opportunity_id = v_opportunity
     )
   where id = v_opportunity;
  if tg_op = 'UPDATE' and old.opportunity_id is distinct from new.opportunity_id then
    update beacon_v2.marketing_opportunities
       set last_activity_at = (
         select max(occurred_at) from beacon_v2.marketing_activities where opportunity_id = old.opportunity_id
       )
     where id = old.opportunity_id;
  end if;
  return null;
end;
$$;

revoke all on function beacon_v2.fn_marketing_refresh_last_activity() from public, anon, authenticated;

drop trigger if exists trg_marketing_activity_refresh on beacon_v2.marketing_activities;
create trigger trg_marketing_activity_refresh
  after insert or update or delete on beacon_v2.marketing_activities
  for each row execute function beacon_v2.fn_marketing_refresh_last_activity();

drop trigger if exists touch_marketing_contacts on beacon_v2.marketing_opportunity_contacts;
create trigger touch_marketing_contacts before update on beacon_v2.marketing_opportunity_contacts
  for each row execute function beacon_v2.touch_updated_at();
drop trigger if exists touch_marketing_activities on beacon_v2.marketing_activities;
create trigger touch_marketing_activities before update on beacon_v2.marketing_activities
  for each row execute function beacon_v2.touch_updated_at();
drop trigger if exists touch_marketing_tasks on beacon_v2.marketing_tasks;
create trigger touch_marketing_tasks before update on beacon_v2.marketing_tasks
  for each row execute function beacon_v2.touch_updated_at();

create or replace function beacon_v2.fn_marketing_task_history()
returns trigger
language plpgsql
security definer
set search_path = beacon_v2, pg_temp
as $$
declare
  v_opportunity beacon_v2.marketing_opportunities;
  v_actor uuid;
  v_note text;
begin
  if tg_op <> 'UPDATE' or new.status is not distinct from old.status then
    return new;
  end if;
  select * into v_opportunity from beacon_v2.marketing_opportunities where id = new.opportunity_id;
  v_actor := new.completed_by;
  if v_actor is null and auth.uid() is not null then
    select id into v_actor from beacon_v2.users where auth_user_id = auth.uid() limit 1;
  end if;
  v_note := case when new.status = 'completed' then 'Task completed: ' else 'Task reopened: ' end || new.title;
  insert into beacon_v2.marketing_stage_history (
    opportunity_id, from_stage, to_stage, previous_probability, new_probability,
    previous_outcome, new_outcome, transition_note, changed_by
  ) values (
    new.opportunity_id, v_opportunity.stage, v_opportunity.stage,
    v_opportunity.probability, v_opportunity.probability,
    v_opportunity.outcome, v_opportunity.outcome, v_note, v_actor
  );
  return new;
end;
$$;

revoke all on function beacon_v2.fn_marketing_task_history() from public, anon, authenticated;
drop trigger if exists trg_marketing_task_history on beacon_v2.marketing_tasks;
create trigger trg_marketing_task_history
  after update on beacon_v2.marketing_tasks
  for each row execute function beacon_v2.fn_marketing_task_history();

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

create or replace function beacon_v2.transition_marketing_opportunity(
  _id uuid,
  _expected_version integer,
  _stage beacon_v2.marketing_stage_enum,
  _probability numeric,
  _outcome beacon_v2.marketing_outcome_enum default null,
  _signed_at date default null,
  _final_contract_value numeric default null,
  _loss_reason beacon_v2.marketing_loss_reason_enum default null,
  _loss_detail text default null,
  _transition_note text default null
) returns beacon_v2.marketing_opportunities
language plpgsql security definer
set search_path = beacon_v2, public, extensions
as $$
declare
  v_old beacon_v2.marketing_opportunities;
  v_new beacon_v2.marketing_opportunities;
  v_actor uuid;
begin
  select * into v_old from beacon_v2.marketing_opportunities where id = _id for update;
  if not found then
    raise exception 'Marketing opportunity % not found', _id using errcode = 'P0002';
  end if;
  if v_old.version <> _expected_version then
    raise exception 'Marketing opportunity changed (expected version %, current %)', _expected_version, v_old.version
      using errcode = '40001';
  end if;
  if auth.uid() is not null then
    select id into v_actor from beacon_v2.users where auth_user_id = auth.uid() limit 1;
  end if;

  perform set_config('beacon_v2.marketing_transition_rpc', 'on', true);

  if _stage = 'Contract Signed Won or Lost' and _outcome = 'won' then
    _probability := 100;
    _loss_reason := null;
    _loss_detail := null;
  elsif _stage = 'Contract Signed Won or Lost' and _outcome = 'lost' then
    _probability := 0;
    _signed_at := null;
    _final_contract_value := null;
  elsif _stage <> 'Contract Signed Won or Lost' then
    _outcome := null;
    _signed_at := null;
    _final_contract_value := null;
    _loss_reason := null;
    _loss_detail := null;
  end if;

  update beacon_v2.marketing_opportunities
     set stage = _stage,
         probability = _probability,
         outcome = _outcome,
         signed_at = _signed_at,
         final_contract_value = _final_contract_value,
         loss_reason = _loss_reason,
         loss_detail = nullif(btrim(_loss_detail), ''),
         last_transition_note = nullif(btrim(_transition_note), ''),
         updated_by = v_actor
   where id = _id
  returning * into v_new;
  return v_new;
end;
$$;

revoke all on function beacon_v2.transition_marketing_opportunity(uuid,integer,beacon_v2.marketing_stage_enum,numeric,beacon_v2.marketing_outcome_enum,date,numeric,beacon_v2.marketing_loss_reason_enum,text,text) from public, anon;
grant execute on function beacon_v2.transition_marketing_opportunity(uuid,integer,beacon_v2.marketing_stage_enum,numeric,beacon_v2.marketing_outcome_enum,date,numeric,beacon_v2.marketing_loss_reason_enum,text,text) to authenticated, service_role;

--------------------------------------------------------------------------------
-- 6. Workspace setting + existing alerts pipeline
--------------------------------------------------------------------------------
alter table beacon_v2.app_settings
  add column if not exists marketing_stalled_after_days integer not null default 14;

do $$ begin
  alter table beacon_v2.app_settings add constraint app_settings_marketing_stalled_days
    check (marketing_stalled_after_days between 1 and 365);
exception when duplicate_object then null; end $$;

do $$
begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'alert_subject_enum'
       and t.typnamespace = 'beacon_v2'::regnamespace
       and e.enumlabel = 'marketing'
  ) then
    alter type beacon_v2.alert_subject_enum add value if not exists 'marketing';
  end if;
end $$;

drop trigger if exists deactivate_alerts on beacon_v2.marketing_opportunities;
create trigger deactivate_alerts before delete on beacon_v2.marketing_opportunities
  for each row execute function beacon_v2._deactivate_alerts_trigger('marketing');

--------------------------------------------------------------------------------
-- 7. RLS and grants — collaborative for authenticated users, no anon access
--------------------------------------------------------------------------------
alter table beacon_v2.marketing_opportunities enable row level security;
alter table beacon_v2.marketing_opportunity_contacts enable row level security;
alter table beacon_v2.marketing_activities enable row level security;
alter table beacon_v2.marketing_activity_users enable row level security;
alter table beacon_v2.marketing_activity_contacts enable row level security;
alter table beacon_v2.marketing_tasks enable row level security;
alter table beacon_v2.marketing_documents enable row level security;
alter table beacon_v2.marketing_stage_history enable row level security;

drop policy if exists marketing_opportunities_auth_all on beacon_v2.marketing_opportunities;
drop policy if exists marketing_opportunities_auth_select on beacon_v2.marketing_opportunities;
drop policy if exists marketing_opportunities_auth_insert on beacon_v2.marketing_opportunities;
create policy marketing_opportunities_auth_select on beacon_v2.marketing_opportunities
  for select to authenticated using (true);
create policy marketing_opportunities_auth_insert on beacon_v2.marketing_opportunities
  for insert to authenticated with check (
    stage = 'Intro to Target or prospect' and outcome is null and archived_at is null
  );
drop policy if exists marketing_opportunity_contacts_auth_all on beacon_v2.marketing_opportunity_contacts;
create policy marketing_opportunity_contacts_auth_all on beacon_v2.marketing_opportunity_contacts for all to authenticated using (true) with check (true);
drop policy if exists marketing_activities_auth_all on beacon_v2.marketing_activities;
create policy marketing_activities_auth_all on beacon_v2.marketing_activities for all to authenticated using (true) with check (true);
drop policy if exists marketing_activity_users_auth_all on beacon_v2.marketing_activity_users;
create policy marketing_activity_users_auth_all on beacon_v2.marketing_activity_users for all to authenticated using (true) with check (true);
drop policy if exists marketing_activity_contacts_auth_all on beacon_v2.marketing_activity_contacts;
create policy marketing_activity_contacts_auth_all on beacon_v2.marketing_activity_contacts for all to authenticated using (true) with check (true);
drop policy if exists marketing_tasks_auth_all on beacon_v2.marketing_tasks;
create policy marketing_tasks_auth_all on beacon_v2.marketing_tasks for all to authenticated using (true) with check (true);
drop policy if exists marketing_documents_auth_all on beacon_v2.marketing_documents;
create policy marketing_documents_auth_all on beacon_v2.marketing_documents for all to authenticated using (true) with check (true);
drop policy if exists marketing_history_auth_all on beacon_v2.marketing_stage_history;
drop policy if exists marketing_history_auth_select on beacon_v2.marketing_stage_history;
create policy marketing_history_auth_select on beacon_v2.marketing_stage_history
  for select to authenticated using (true);

grant select, insert on beacon_v2.marketing_opportunities to authenticated;
revoke update, delete on beacon_v2.marketing_opportunities from authenticated;
grant select, insert, update, delete on beacon_v2.marketing_opportunity_contacts to authenticated;
grant select, insert, update, delete on beacon_v2.marketing_activities to authenticated;
grant select, insert, update, delete on beacon_v2.marketing_activity_users to authenticated;
grant select, insert, update, delete on beacon_v2.marketing_activity_contacts to authenticated;
grant select, insert, update, delete on beacon_v2.marketing_tasks to authenticated;
grant select, insert, update, delete on beacon_v2.marketing_documents to authenticated;
revoke insert, update, delete on beacon_v2.marketing_stage_history from authenticated;
grant select on beacon_v2.marketing_stage_history to authenticated;

--------------------------------------------------------------------------------
-- 8. Private Marketing document bucket
--------------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('marketing-documents', 'marketing-documents', false)
on conflict (id) do update set public = false;

drop policy if exists marketing_documents_obj_select on storage.objects;
drop policy if exists marketing_documents_obj_insert on storage.objects;
drop policy if exists marketing_documents_obj_update on storage.objects;
drop policy if exists marketing_documents_obj_delete on storage.objects;
create policy marketing_documents_obj_select on storage.objects
  for select to authenticated using (bucket_id = 'marketing-documents');
create policy marketing_documents_obj_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'marketing-documents');
create policy marketing_documents_obj_update on storage.objects
  for update to authenticated using (bucket_id = 'marketing-documents') with check (bucket_id = 'marketing-documents');
create policy marketing_documents_obj_delete on storage.objects
  for delete to authenticated using (bucket_id = 'marketing-documents');

notify pgrst, 'reload schema';
