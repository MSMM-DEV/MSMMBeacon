-- Wires the alerts feature end-to-end. Safe to re-run; every DDL statement
-- uses IF NOT EXISTS / CREATE OR REPLACE.
--
-- What this adds:
--   * `'soq'` on alert_subject_enum (SOQ shipped after the enum was written).
--   * Per-alert anchor metadata + stored timezone so recurrence math survives
--     DST transitions.
--   * `attempts` counter on alert_fires so permanently-failing fires can't
--     loop forever.
--   * `claim_pending_fires` RPC — FOR UPDATE SKIP LOCKED so concurrent cron
--     ticks can't double-send. Rows come back atomically marked 'processing'.
--   * `complete_fire` RPC — flips status and, for simple recurrences, spawns
--     the next pending fire in ONE transaction so a half-committed series
--     can't orphan itself. 'custom' RRULE recurrences are handed back to the
--     Edge Function (rrule library does the math there).
--   * Generic polymorphic row-delete cleanup: one helper function + one
--     BEFORE DELETE trigger per pipeline table, wired by a name map. Keeps
--     alert history (no cascade); stops future fires against orphaned rows.
--
-- The RLS baseline (`auth full access`, `anon read`, `anon write`) already
-- covers beacon.alerts / alert_recipients / alert_fires from the initial
-- migration's do-block — nothing to add. The send-alert Edge Function uses
-- SUPABASE_SERVICE_ROLE_KEY which bypasses RLS entirely.

--------------------------------------------------------------------------------
-- 1. Enum catch-up
--------------------------------------------------------------------------------
alter type beacon.alert_subject_enum add value if not exists 'soq';

--------------------------------------------------------------------------------
-- 2. Column additions
--------------------------------------------------------------------------------
alter table beacon.alerts
  add column if not exists anchor_field          text,
  add column if not exists anchor_offset_minutes integer,
  add column if not exists timezone              text not null default 'America/Chicago';

alter table beacon.alert_fires
  add column if not exists attempts int not null default 0;

--------------------------------------------------------------------------------
-- 3. claim_pending_fires — atomic "give me up to N fires and mark them
--    processing". Concurrent callers are safe: SKIP LOCKED means neither
--    blocks the other nor claims the same row.
--------------------------------------------------------------------------------
create or replace function beacon.claim_pending_fires(_limit int default 50)
returns setof beacon.alert_fires
language sql
security definer
set search_path = beacon, public
as $$
  with claimed as (
    select id
      from beacon.alert_fires
     where status = 'pending' and scheduled_at <= now()
     order by scheduled_at
     limit _limit
     for update skip locked
  )
  update beacon.alert_fires f
     set status   = 'processing',
         attempts = f.attempts + 1
    from claimed c
   where f.id = c.id
  returning f.*;
$$;

--------------------------------------------------------------------------------
-- 4. complete_fire — finalize a fire and (for simple recurrences) spawn the
--    next one atomically. `_status` is one of 'sent' | 'failed' | 'skipped'.
--    Returns the id of the newly-inserted next fire, or NULL if none.
--
--    Timezone-aware math: interval addition happens inside the alert's stored
--    timezone, so weekly/biweekly/monthly recurrences keep wall-clock time
--    across DST. 'custom' RRULE handling is deferred to the Edge Function
--    (PG has no RRULE parser built in).
--------------------------------------------------------------------------------
create or replace function beacon.complete_fire(
  _fire_id       uuid,
  _status        text,
  _error_message text default null
) returns uuid
language plpgsql
security definer
set search_path = beacon, public
as $$
declare
  _fire    beacon.alert_fires%rowtype;
  _alert   beacon.alerts%rowtype;
  _next    timestamptz;
  _new_id  uuid;
begin
  update beacon.alert_fires
     set status        = _status,
         fired_at      = now(),
         error_message = _error_message
   where id = _fire_id
  returning * into _fire;

  if not found then
    return null;
  end if;

  -- Only spawn a next fire on a successful send of a still-active alert.
  if _status <> 'sent' then
    return null;
  end if;

  select * into _alert from beacon.alerts where id = _fire.alert_id;
  if not found or not _alert.is_active or _alert.recurrence = 'one_time' then
    return null;
  end if;

  _next := case _alert.recurrence
    when 'weekly'   then ((_fire.scheduled_at at time zone _alert.timezone) + interval '7 days')  at time zone _alert.timezone
    when 'biweekly' then ((_fire.scheduled_at at time zone _alert.timezone) + interval '14 days') at time zone _alert.timezone
    when 'monthly'  then ((_fire.scheduled_at at time zone _alert.timezone) + interval '1 month') at time zone _alert.timezone
    else null  -- 'custom' → Edge Function uses rrule lib to compute next
  end;

  if _next is null then
    return null;
  end if;

  insert into beacon.alert_fires (alert_id, scheduled_at, status)
  values (_alert.id, _next, 'pending')
  returning id into _new_id;

  return _new_id;
end;
$$;

--------------------------------------------------------------------------------
-- 5. Polymorphic row-delete cleanup.
--    One helper function + one generic trigger handler + a loop that wires
--    it to every pipeline table that can be an alert subject. We deactivate
--    (not cascade) so the history in alert_fires is preserved.
--------------------------------------------------------------------------------
create or replace function beacon.deactivate_alerts_for(
  _table beacon.alert_subject_enum,
  _id    uuid
) returns void language sql as $$
  update beacon.alerts
     set is_active = false
   where subject_table = _table and subject_row_id = _id;
$$;

create or replace function beacon._deactivate_alerts_trigger()
returns trigger
language plpgsql
as $$
begin
  perform beacon.deactivate_alerts_for(
    tg_argv[0]::beacon.alert_subject_enum,
    old.id
  );
  return old;
end;
$$;

do $$
declare
  pair record;
begin
  for pair in
    select * from (values
      ('potential_projects',   'potential'),
      ('awaiting_verdict',     'awaiting'),
      ('awarded_projects',     'awarded'),
      ('soq',                  'soq'),
      ('closed_out_projects',  'closed_out'),
      ('anticipated_invoice',  'invoice'),
      ('events',               'event')
    ) as t(tbl, subj)
  loop
    execute format(
      'drop trigger if exists deactivate_alerts on beacon.%I', pair.tbl
    );
    execute format(
      'create trigger deactivate_alerts before delete on beacon.%I
         for each row execute function beacon._deactivate_alerts_trigger(%L)',
      pair.tbl, pair.subj
    );
  end loop;
end $$;

--------------------------------------------------------------------------------
-- 6. Expose the new RPCs to PostgREST + anon (same policy as the rest of
--    the schema under the "prototype anon write" period).
--------------------------------------------------------------------------------
grant execute on function beacon.claim_pending_fires(int) to anon, authenticated, service_role;
grant execute on function beacon.complete_fire(uuid, text, text) to anon, authenticated, service_role;
grant execute on function beacon.deactivate_alerts_for(beacon.alert_subject_enum, uuid) to anon, authenticated, service_role;
