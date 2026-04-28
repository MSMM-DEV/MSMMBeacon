-- MSMM Beacon v2 — data backfill from beacon → beacon_v2.
--
-- Reads every row from the live `beacon` schema and writes the equivalent
-- into `beacon_v2`, applying every shape change v2 introduced:
--   * 5 pipeline tables (potential_projects, awaiting_verdict,
--     awarded_projects, closed_out_projects, soq) → 1 `projects` table with
--     a `status` enum. SOQ is dropped entirely (per the redesign).
--   * 5 *_pms join tables → 1 `project_pms`.
--   * 4 *_subs join tables → 1 `project_subs` (potential's discipline /
--     amount / ord preserved; the others get NULL there).
--   * `anticipated_invoice` had two source FKs (source_awarded_id +
--     source_potential_id, only one populated per row) → single
--     `source_project_id` via COALESCE.
--   * `hot_leads` → `leads`; `hot_lead_attendees` → `lead_attendees`.
--   * `alert_subject_enum` collapsed: 'potential'/'awaiting'/'awarded'/
--     'closed_out' → 'project'; 'hotlead' → 'lead'; 'invoice'/'event'
--     unchanged; alerts with subject_table='soq' are dropped.
--
-- IDs are preserved across schemas wherever possible. Every uuid in beacon
-- is reused in beacon_v2 so:
--   * existing `alert.subject_row_id` references resolve to the same
--     project / invoice / event / lead in v2;
--   * `users.auth_user_id` linkages survive (login keeps working);
--   * lineage chains (source_potential_id, source_awaiting_id) collapse
--     into v2's single `source_project_id` and stay valid because parent
--     IDs were preserved.
--
-- `beacon` is NOT modified. Stays as a backup. This script only writes to
-- `beacon_v2`.
--
-- Re-runnable. Every target table is TRUNCATEd before re-insert, so running
-- this twice produces the same result. (Note: any data the frontend has
-- written to beacon_v2 since the schema migrations were applied gets wiped.)
--
-- Studio runs the whole script in one transaction — any error rolls
-- everything back. Paste, click Run, eyeball the verification queries at
-- the bottom.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 0. TRUNCATE v2 data tables.
--    Preserved (NOT truncated):
--      * awarded_stages — lookup; v1 stage_id is remapped via name join below.
--      * outlook_sync_state — singleton; UPDATEd in step 17 instead.
--    CASCADE handles the projects self-FK + every downstream FK in one shot.
--------------------------------------------------------------------------------
truncate table
  beacon_v2.alert_fires,
  beacon_v2.alert_recipients,
  beacon_v2.alerts,
  beacon_v2.anticipated_invoice_pms,
  beacon_v2.anticipated_invoice,
  beacon_v2.project_pms,
  beacon_v2.project_subs,
  beacon_v2.projects,
  beacon_v2.event_attendees,
  beacon_v2.events,
  beacon_v2.lead_attendees,
  beacon_v2.leads,
  beacon_v2.users,
  beacon_v2.clients,
  beacon_v2.companies
restart identity cascade;

--------------------------------------------------------------------------------
-- 1. users — preserve UUIDs, auth_user_id linkage, role, timestamps.
--    citext (v1) → text (v2): explicit ::text cast.
--------------------------------------------------------------------------------
insert into beacon_v2.users
  (id, auth_user_id, login_name, first_name, last_name, display_name,
   short_name, email, department, employee_type, location, is_enabled,
   role, created_at, updated_at)
select
  id, auth_user_id, login_name, first_name, last_name, display_name,
  short_name, email::text, department, employee_type, location, is_enabled,
  coalesce(role, 'User'),  -- pre-role-migration rows default to 'User'
  created_at, updated_at
from beacon.users;

--------------------------------------------------------------------------------
-- 2. clients — preserve UUIDs; org_type enum re-cast across schemas.
--------------------------------------------------------------------------------
insert into beacon_v2.clients
  (id, name, district, org_type, contact_person, email, phone, address,
   notes, created_at, updated_at)
select
  id, name, district,
  org_type::text::beacon_v2.org_type_enum,
  contact_person, email::text, phone, address,
  notes, created_at, updated_at
from beacon.clients;

--------------------------------------------------------------------------------
-- 3. companies — preserve UUIDs (including MSMM's, so projects' FK references
--    keep resolving). Singleton constraint on is_msmm passes since beacon
--    already enforced it.
--------------------------------------------------------------------------------
insert into beacon_v2.companies
  (id, name, is_msmm, contact_person, email, phone, address, notes,
   created_at, updated_at)
select
  id, name, is_msmm, contact_person, email::text, phone, address, notes,
  created_at, updated_at
from beacon.companies;

--------------------------------------------------------------------------------
-- 4. projects — 4 explicit INSERTs, one per status. Each NULLs out the
--    fields the stage-gate CHECK constraints reject for that status.
--    SOQ is intentionally NOT migrated.
--
--    Source linkage:
--      potential   → source_project_id = NULL (no parent)
--      awaiting    → source_project_id = source_potential_id (link to potential)
--      awarded     → source_project_id = source_awaiting_id   (rarely populated;
--                                                              v1 awaiting→awarded
--                                                              is MOVE so the FK
--                                                              SET NULLs)
--      closed_out  → source_project_id = source_awaiting_id   (same)
--
--    The v1→v2 column count is 30. Both the column list and the SELECT must
--    be 30 wide.
--------------------------------------------------------------------------------

-- 4a. potential → status='potential'
insert into beacon_v2.projects
  (id, status, source_project_id, year, project_name, project_number,
   client_id, prime_company_id, notes,
   role, total_contract_amount, msmm_amount, probability, next_action_date,
   next_action_note, anticipated_invoice_start_month,
   date_submitted, client_contract_number, msmm_contract_number,
   msmm_used, msmm_remaining,
   anticipated_result_date,
   stage_id, details, pool, contract_expiry_date,
   date_closed, reason_for_closure,
   created_at, updated_at)
select
  id,
  'potential'::beacon_v2.project_status_enum,
  null,                                                      -- source_project_id
  year, project_name, project_number,
  client_id, prime_company_id, notes,
  role::text::beacon_v2.project_role_enum,
  total_contract_amount, msmm_amount,
  probability::text::beacon_v2.probability_enum,
  next_action_date, next_action_note, anticipated_invoice_start_month,
  null, null, null, null, null,                              -- contract fields (potential doesn't track them)
  null,                                                      -- anticipated_result_date
  null, null, null, null,                                    -- awarded fields
  null, null,                                                -- closed fields
  created_at, updated_at
from beacon.potential_projects;

-- 4b. awaiting → status='awaiting'
insert into beacon_v2.projects
  (id, status, source_project_id, year, project_name, project_number,
   client_id, prime_company_id, notes,
   role, total_contract_amount, msmm_amount, probability, next_action_date,
   next_action_note, anticipated_invoice_start_month,
   date_submitted, client_contract_number, msmm_contract_number,
   msmm_used, msmm_remaining,
   anticipated_result_date,
   stage_id, details, pool, contract_expiry_date,
   date_closed, reason_for_closure,
   created_at, updated_at)
select
  id,
  'awaiting'::beacon_v2.project_status_enum,
  source_potential_id,                                       -- preserves the potential link
  year, project_name, project_number,
  client_id, prime_company_id, notes,
  null, null, null, null, null, null, null,                  -- 7 potential-only fields
  date_submitted, client_contract_number, msmm_contract_number,
  msmm_used, msmm_remaining,
  anticipated_result_date,
  null, null, null, null,                                    -- 4 awarded-only fields
  null, null,                                                -- 2 closed-only fields
  created_at, updated_at
from beacon.awaiting_verdict;

-- 4c. awarded → status='awarded' (stage_id remapped via name lookup)
insert into beacon_v2.projects
  (id, status, source_project_id, year, project_name, project_number,
   client_id, prime_company_id, notes,
   role, total_contract_amount, msmm_amount, probability, next_action_date,
   next_action_note, anticipated_invoice_start_month,
   date_submitted, client_contract_number, msmm_contract_number,
   msmm_used, msmm_remaining,
   anticipated_result_date,
   stage_id, details, pool, contract_expiry_date,
   date_closed, reason_for_closure,
   created_at, updated_at)
select
  ap.id,
  'awarded'::beacon_v2.project_status_enum,
  ap.source_awaiting_id,
  ap.year, ap.project_name, ap.project_number,
  ap.client_id, ap.prime_company_id,
  null,                                                      -- v1 awarded had no notes column
  null, null, null, null, null, null, null,                  -- 7 potential-only fields
  ap.date_submitted, ap.client_contract_number, ap.msmm_contract_number,
  ap.msmm_used, ap.msmm_remaining,
  null,                                                      -- anticipated_result_date
  v2s.id,                                                    -- v2 stage_id (matched by name)
  ap.details, ap.pool, ap.contract_expiry_date,
  null, null,                                                -- closed-only fields
  ap.created_at, ap.updated_at
from beacon.awarded_projects ap
left join beacon.awarded_stages    v1s on v1s.id = ap.stage_id
left join beacon_v2.awarded_stages v2s on v2s.name = v1s.name;

-- 4d. closed_out → status='closed_out'
insert into beacon_v2.projects
  (id, status, source_project_id, year, project_name, project_number,
   client_id, prime_company_id, notes,
   role, total_contract_amount, msmm_amount, probability, next_action_date,
   next_action_note, anticipated_invoice_start_month,
   date_submitted, client_contract_number, msmm_contract_number,
   msmm_used, msmm_remaining,
   anticipated_result_date,
   stage_id, details, pool, contract_expiry_date,
   date_closed, reason_for_closure,
   created_at, updated_at)
select
  id,
  'closed_out'::beacon_v2.project_status_enum,
  source_awaiting_id,
  year, project_name, project_number,
  client_id, prime_company_id, notes,
  null, null, null, null, null, null, null,                  -- 7 potential-only fields
  date_submitted, client_contract_number, msmm_contract_number,
  null, null,                                                -- v1 closed didn't track msmm_used/msmm_remaining
  null,                                                      -- anticipated_result_date
  null, null, null, null,                                    -- 4 awarded-only fields
  date_closed, reason_for_closure,
  created_at, updated_at
from beacon.closed_out_projects;

--------------------------------------------------------------------------------
-- 5. project_pms — one insert UNION ALL across the 4 v1 PM tables (skip
--    soq_pms). UUIDs are unique across stages so no collision is possible,
--    but ON CONFLICT DO NOTHING is a cheap safety net.
--------------------------------------------------------------------------------
insert into beacon_v2.project_pms (project_id, user_id)
  select potential_project_id,  user_id from beacon.potential_project_pms
  union all
  select awaiting_verdict_id,   user_id from beacon.awaiting_verdict_pms
  union all
  select awarded_project_id,    user_id from beacon.awarded_project_pms
  union all
  select closed_out_project_id, user_id from beacon.closed_out_project_pms
on conflict (project_id, user_id) do nothing;

--------------------------------------------------------------------------------
-- 6. project_subs — potential's uuid + ord/discipline/amount preserved. The
--    other v1 sub tables (composite-PK) get a fresh uuid + NULL extras +
--    now() for created_at since v1 didn't track those.
--------------------------------------------------------------------------------
insert into beacon_v2.project_subs
  (id, project_id, ord, company_id, discipline, amount, created_at)
  select id, potential_project_id, ord, company_id, discipline, amount, created_at
    from beacon.potential_project_subs
union all
  select gen_random_uuid(), awaiting_verdict_id, null, company_id, null, null, now()
    from beacon.awaiting_verdict_subs
union all
  select gen_random_uuid(), awarded_project_id, null, company_id, null, null, now()
    from beacon.awarded_project_subs;

--------------------------------------------------------------------------------
-- 7. anticipated_invoice — collapse the dual source FKs to a single
--    source_project_id. v1 only ever populates one of (source_awarded_id,
--    source_potential_id), so COALESCE is unambiguous.
--------------------------------------------------------------------------------
insert into beacon_v2.anticipated_invoice
  (id, source_project_id, year, project_number, project_name,
   contract_amount, type, msmm_remaining_to_bill_year_start,
   jan_amount, feb_amount, mar_amount, apr_amount, may_amount, jun_amount,
   jul_amount, aug_amount, sep_amount, oct_amount, nov_amount, dec_amount,
   ytd_actual_override, rollforward_override,
   created_at, updated_at)
select
  id,
  coalesce(source_awarded_id, source_potential_id) as source_project_id,
  year, project_number, project_name, contract_amount,
  type::text::beacon_v2.invoice_type_enum,
  msmm_remaining_to_bill_year_start,
  jan_amount, feb_amount, mar_amount, apr_amount, may_amount, jun_amount,
  jul_amount, aug_amount, sep_amount, oct_amount, nov_amount, dec_amount,
  ytd_actual_override, rollforward_override,
  created_at, updated_at
from beacon.anticipated_invoice;

insert into beacon_v2.anticipated_invoice_pms (anticipated_invoice_id, user_id)
select anticipated_invoice_id, user_id
  from beacon.anticipated_invoice_pms;

--------------------------------------------------------------------------------
-- 8. events + event_attendees — direct copy. v1 and v2 events have the same
--    shape (Outlook columns + provenance baked into v2 from day one).
--------------------------------------------------------------------------------
insert into beacon_v2.events
  (id, event_date, status, type, title, event_datetime, notes, source,
   outlook_event_id, outlook_ical_uid, outlook_etag, outlook_end_datetime,
   outlook_external_attendees, outlook_organizer, outlook_web_link,
   outlook_last_synced_at, outlook_is_cancelled, created_at, updated_at)
select
  id, event_date,
  status::text::beacon_v2.event_status_enum,
  type::text::beacon_v2.event_type_enum,
  title, event_datetime, notes, source,
  outlook_event_id, outlook_ical_uid, outlook_etag, outlook_end_datetime,
  outlook_external_attendees, outlook_organizer, outlook_web_link,
  outlook_last_synced_at, outlook_is_cancelled,
  created_at, updated_at
from beacon.events;

insert into beacon_v2.event_attendees (event_id, user_id)
select event_id, user_id from beacon.event_attendees;

--------------------------------------------------------------------------------
-- 9. leads (renamed from hot_leads) + lead_attendees.
--------------------------------------------------------------------------------
insert into beacon_v2.leads
  (id, title, date_time, client_id, prime_company_id, status, notes,
   created_at, updated_at)
select
  id, title, date_time, client_id, prime_company_id,
  status::text::beacon_v2.lead_status_enum,
  notes, created_at, updated_at
from beacon.hot_leads;

insert into beacon_v2.lead_attendees (lead_id, user_id)
select hot_lead_id, user_id from beacon.hot_lead_attendees;

--------------------------------------------------------------------------------
-- 10. alerts — collapse 8-value subject_table to 4. Drop alerts whose
--     subject_table is 'soq' (along with their recipients/fires).
--------------------------------------------------------------------------------
insert into beacon_v2.alerts
  (id, subject_table, subject_row_id, first_fire_at, recurrence,
   recurrence_rule, message, anchor_field, anchor_offset_minutes,
   timezone, created_by, is_active, created_at, updated_at)
select
  id,
  case subject_table::text
    when 'potential'  then 'project'
    when 'awaiting'   then 'project'
    when 'awarded'    then 'project'
    when 'closed_out' then 'project'
    when 'invoice'    then 'invoice'
    when 'event'      then 'event'
    when 'hotlead'    then 'lead'
  end::beacon_v2.alert_subject_enum,
  subject_row_id, first_fire_at,
  recurrence::text::beacon_v2.recurrence_enum,
  recurrence_rule, message, anchor_field, anchor_offset_minutes,
  coalesce(timezone, 'America/Chicago'),  -- pre-anchor-migration alerts had no tz
  created_by, is_active, created_at, updated_at
from beacon.alerts
where subject_table::text != 'soq';

-- recipients + fires: filter to alerts that actually got migrated (drops
-- the SOQ-alert children with them).
insert into beacon_v2.alert_recipients (alert_id, user_id)
select r.alert_id, r.user_id
  from beacon.alert_recipients r
 where r.alert_id in (select id from beacon_v2.alerts);

insert into beacon_v2.alert_fires
  (id, alert_id, scheduled_at, fired_at, status, error_message,
   attempts, created_at)
select
  f.id, f.alert_id, f.scheduled_at, f.fired_at, f.status, f.error_message,
  coalesce(f.attempts, 0),  -- pre-attempts-migration rows had no value
  f.created_at
from beacon.alert_fires f
where f.alert_id in (select id from beacon_v2.alerts);

--------------------------------------------------------------------------------
-- 11. outlook_sync_state — singleton. UPSERT on id=1 so this works whether
--     migration 06 already inserted the row (typical) or not (paranoid).
--------------------------------------------------------------------------------
insert into beacon_v2.outlook_sync_state
  (id, mailbox, delta_link, last_full_sync_at, last_run_at, last_run_summary)
select
  id, mailbox, delta_link, last_full_sync_at, last_run_at, last_run_summary
from beacon.outlook_sync_state
on conflict (id) do update
  set mailbox            = excluded.mailbox,
      delta_link         = excluded.delta_link,
      last_full_sync_at  = excluded.last_full_sync_at,
      last_run_at        = excluded.last_run_at,
      last_run_summary   = excluded.last_run_summary;

--------------------------------------------------------------------------------
-- Done. Run the verification queries below in SQL Editor as a separate paste
-- to confirm row counts line up. v1 and v2 should agree everywhere except
-- SOQ (which is dropped) and the alerts table (which is v1 minus SOQ alerts).
--
--   select 'users v1',           count(*) from beacon.users               union all
--   select 'users v2',           count(*) from beacon_v2.users            union all
--   select 'clients v1',         count(*) from beacon.clients             union all
--   select 'clients v2',         count(*) from beacon_v2.clients          union all
--   select 'companies v1',       count(*) from beacon.companies           union all
--   select 'companies v2',       count(*) from beacon_v2.companies        union all
--   select 'potential v1',       count(*) from beacon.potential_projects  union all
--   select 'potential v2',       count(*) from beacon_v2.projects where status='potential'  union all
--   select 'awaiting v1',        count(*) from beacon.awaiting_verdict    union all
--   select 'awaiting v2',        count(*) from beacon_v2.projects where status='awaiting'   union all
--   select 'awarded v1',         count(*) from beacon.awarded_projects    union all
--   select 'awarded v2',         count(*) from beacon_v2.projects where status='awarded'    union all
--   select 'closed v1',          count(*) from beacon.closed_out_projects union all
--   select 'closed v2',          count(*) from beacon_v2.projects where status='closed_out' union all
--   select 'invoice v1',         count(*) from beacon.anticipated_invoice union all
--   select 'invoice v2',         count(*) from beacon_v2.anticipated_invoice              union all
--   select 'events v1',          count(*) from beacon.events              union all
--   select 'events v2',          count(*) from beacon_v2.events           union all
--   select 'leads v1',           count(*) from beacon.hot_leads           union all
--   select 'leads v2',           count(*) from beacon_v2.leads            union all
--   select 'alerts v1',          count(*) from beacon.alerts              union all
--   select 'alerts v1 ex-soq',   count(*) from beacon.alerts where subject_table::text != 'soq' union all
--   select 'alerts v2',          count(*) from beacon_v2.alerts;
--------------------------------------------------------------------------------
