-- MSMM Beacon v2 — alerts + alert_recipients + alert_fires + RPCs + triggers.
--
-- Same wire shape as v1, simplified in two places:
--   1. `alert_subject_enum` collapsed to four values: project / invoice /
--      event / lead. The send-alert Edge Function now branches on
--      `row.status` (loaded from the projects row) for per-stage email
--      phrasing instead of branching on subject_table.
--   2. Only four BEFORE DELETE triggers (one per subject table) instead of
--      eight, since the five v1 pipeline tables collapsed into projects.
--
-- The anchor + recurrence columns + RPCs (claim_pending_fires / complete_fire)
-- are ported byte-for-byte from v1's 20260424120000_alerts_wiring.sql,
-- retargeted at beacon_v2.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Alerts
--------------------------------------------------------------------------------
create table if not exists beacon_v2.alerts (
  id                    uuid primary key default gen_random_uuid(),
  subject_table         beacon_v2.alert_subject_enum not null,
  subject_row_id        uuid not null,
  first_fire_at         timestamptz not null,
  recurrence            beacon_v2.recurrence_enum not null default 'one_time',
  recurrence_rule       text,
  message               text,
  anchor_field          text,
  anchor_offset_minutes integer,
  timezone              text not null default 'America/Chicago',
  created_by            uuid references beacon_v2.users(id) on delete set null,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists alerts_subject_idx on beacon_v2.alerts (subject_table, subject_row_id);

drop trigger if exists touch_alerts on beacon_v2.alerts;
create trigger touch_alerts before update on beacon_v2.alerts
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- 2. Recipients
--------------------------------------------------------------------------------
create table if not exists beacon_v2.alert_recipients (
  alert_id uuid not null references beacon_v2.alerts(id) on delete cascade,
  user_id  uuid not null references beacon_v2.users(id)  on delete cascade,
  primary key (alert_id, user_id)
);

--------------------------------------------------------------------------------
-- 3. Fires (the log table — every dispatch attempt lands here).
--------------------------------------------------------------------------------
create table if not exists beacon_v2.alert_fires (
  id            uuid primary key default gen_random_uuid(),
  alert_id      uuid not null references beacon_v2.alerts(id) on delete cascade,
  scheduled_at  timestamptz not null,
  fired_at      timestamptz,
  status        text not null default 'pending', -- pending | processing | sent | failed | skipped
  error_message text,
  attempts      int not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists alert_fires_due_idx
  on beacon_v2.alert_fires (scheduled_at) where status = 'pending';

--------------------------------------------------------------------------------
-- 4. claim_pending_fires — atomic batch claim, FOR UPDATE SKIP LOCKED so
--    concurrent ticks can't double-send. Marks claimed rows 'processing' and
--    increments attempts.
--------------------------------------------------------------------------------
create or replace function beacon_v2.claim_pending_fires(_limit int default 50)
returns setof beacon_v2.alert_fires
language sql
security definer
set search_path = beacon_v2, public
as $$
  with claimed as (
    select id
      from beacon_v2.alert_fires
     where status = 'pending' and scheduled_at <= now()
     order by scheduled_at
     limit _limit
     for update skip locked
  )
  update beacon_v2.alert_fires f
     set status   = 'processing',
         attempts = f.attempts + 1
    from claimed c
   where f.id = c.id
  returning f.*;
$$;

--------------------------------------------------------------------------------
-- 5. complete_fire — flips status, and on a successful 'sent' for an active
--    simple-recurrence alert, spawns the next pending fire in the same
--    transaction so a half-committed series can't orphan itself. Custom
--    RRULE recurrences are deferred to the Edge Function (PG has no RRULE
--    parser).
--    Timezone-aware interval math: the addition happens inside the alert's
--    stored timezone so weekly/biweekly/monthly recurrences keep wall-clock
--    time across DST.
--------------------------------------------------------------------------------
create or replace function beacon_v2.complete_fire(
  _fire_id       uuid,
  _status        text,
  _error_message text default null
) returns uuid
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  _fire    beacon_v2.alert_fires%rowtype;
  _alert   beacon_v2.alerts%rowtype;
  _next    timestamptz;
  _new_id  uuid;
begin
  update beacon_v2.alert_fires
     set status        = _status,
         fired_at      = now(),
         error_message = _error_message
   where id = _fire_id
  returning * into _fire;

  if not found then
    return null;
  end if;

  if _status <> 'sent' then
    return null;
  end if;

  select * into _alert from beacon_v2.alerts where id = _fire.alert_id;
  if not found or not _alert.is_active or _alert.recurrence = 'one_time' then
    return null;
  end if;

  _next := case _alert.recurrence
    when 'weekly'   then ((_fire.scheduled_at at time zone _alert.timezone) + interval '7 days')  at time zone _alert.timezone
    when 'biweekly' then ((_fire.scheduled_at at time zone _alert.timezone) + interval '14 days') at time zone _alert.timezone
    when 'monthly'  then ((_fire.scheduled_at at time zone _alert.timezone) + interval '1 month') at time zone _alert.timezone
    else null  -- 'custom' → Edge Function uses rrule lib
  end;

  if _next is null then
    return null;
  end if;

  insert into beacon_v2.alert_fires (alert_id, scheduled_at, status)
  values (_alert.id, _next, 'pending')
  returning id into _new_id;

  return _new_id;
end;
$$;

--------------------------------------------------------------------------------
-- 6. Polymorphic delete cleanup. Same pattern as v1: deactivate (don't
--    cascade) so alert_fires history survives the parent row's deletion.
--------------------------------------------------------------------------------
create or replace function beacon_v2.deactivate_alerts_for(
  _table beacon_v2.alert_subject_enum,
  _id    uuid
) returns void language sql as $$
  update beacon_v2.alerts
     set is_active = false
   where subject_table = _table and subject_row_id = _id;
$$;

create or replace function beacon_v2._deactivate_alerts_trigger()
returns trigger
language plpgsql
as $$
begin
  perform beacon_v2.deactivate_alerts_for(
    tg_argv[0]::beacon_v2.alert_subject_enum,
    old.id
  );
  return old;
end;
$$;

-- Wire one BEFORE DELETE trigger per subject table. Four total — projects,
-- anticipated_invoice, events, leads.
do $$
declare
  pair record;
begin
  for pair in
    select * from (values
      ('projects',            'project'),
      ('anticipated_invoice', 'invoice'),
      ('events',              'event'),
      ('leads',               'lead')
    ) as t(tbl, subj)
  loop
    execute format(
      'drop trigger if exists deactivate_alerts on beacon_v2.%I', pair.tbl
    );
    execute format(
      'create trigger deactivate_alerts before delete on beacon_v2.%I
         for each row execute function beacon_v2._deactivate_alerts_trigger(%L)',
      pair.tbl, pair.subj
    );
  end loop;
end $$;

--------------------------------------------------------------------------------
-- 7. Expose RPCs to PostgREST.
--------------------------------------------------------------------------------
grant execute on function beacon_v2.claim_pending_fires(int)                                     to anon, authenticated, service_role;
grant execute on function beacon_v2.complete_fire(uuid, text, text)                              to anon, authenticated, service_role;
grant execute on function beacon_v2.deactivate_alerts_for(beacon_v2.alert_subject_enum, uuid)    to anon, authenticated, service_role;
