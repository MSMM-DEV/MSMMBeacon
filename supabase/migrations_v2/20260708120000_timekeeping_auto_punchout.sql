-- 20260708120000_timekeeping_auto_punchout.sql
-- Auto punch-out at end of day (default 7:00 PM America/Chicago).
--
-- If a user is still punched IN when the workday's EOD boundary passes
-- (app_settings.tk_eod_window_end, default 19:00 CT), the system automatically
-- punches them OUT and marks the resulting open interval 'eod' ("done for the
-- day"). ONLY users who are CURRENTLY punched in AND whose open IN interval
-- started earlier the SAME CT day (before the EOD boundary) are affected —
-- people who already punched out, never punched in, have no activity, or
-- deliberately clocked in AFTER the boundary are left untouched.
--
-- Mechanics: inserting a real OUT punch at the EOD instant fires the existing
-- fn_punch_reconcile trigger, which closes the open IN interval and opens a
-- fresh OUT interval; we then relabel that OUT interval 'eod'/'admin' (a frozen
-- classification source, so the rule + Outlook classifiers never overwrite it).
-- A durable punch is required (not a bare interval close) so a later
-- fn_rebuild_user_day re-derivation keeps the punch-out.
--
-- Idempotent: once out, the user has an open OUT interval (is_out=true) and no
-- longer matches the detection query, so re-running is a no-op. The RPC also
-- self-gates on tk_enabled + tk_auto_punchout_enabled + CT wall-clock >=
-- tk_eod_window_end, so calling it before the boundary does nothing.
--
-- Driven by the timeclock-eod-sweep Edge Function on a frequent evening cron.
-- Idempotent / re-runnable.

set search_path = beacon_v2, public, extensions;

-- Admin kill switch for the auto punch-out sweep (defaults on).
alter table beacon_v2.app_settings
  add column if not exists tk_auto_punchout_enabled boolean not null default true;

create or replace function beacon_v2.auto_punch_out_eod(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  _tz           text;
  _enabled      boolean;
  _auto_on      boolean;
  _eod_time     time;
  _ct_today     date;
  _eod_instant  timestamptz;
  _rec          record;
  _count        int := 0;
begin
  select coalesce(tk_business_tz, 'America/Chicago'),
         coalesce(tk_enabled, false),
         coalesce(tk_auto_punchout_enabled, true),
         coalesce(tk_eod_window_end, '19:00'::time)
    into _tz, _enabled, _auto_on, _eod_time
    from beacon_v2.app_settings
   where singleton = true;

  -- No settings row, timekeeping off, or the sweep disabled → nothing to do.
  if not found or not _enabled or not _auto_on then
    return 0;
  end if;

  _tz          := coalesce(_tz, 'America/Chicago');
  _ct_today    := (p_now at time zone _tz)::date;
  _eod_instant := ((_ct_today + _eod_time)) at time zone _tz;

  -- Self-gate: nothing to do before the EOD boundary in business-local time.
  if p_now < _eod_instant then
    return 0;
  end if;

  -- Serialize concurrent invocations (e.g. a manual admin "run now" overlapping
  -- a cron tick) so the same user can't be punched out twice. Transaction-scoped
  -- advisory lock — auto-released on commit; a second caller waits, then finds
  -- no open IN interval and no-ops.
  perform pg_advisory_xact_lock(hashtext('beacon_v2.auto_punch_out_eod'));

  -- Defensive: allow the write even if some historical week were locked
  -- (approval/lock was retired, but a guard function may still exist).
  perform set_config('beacon_v2.timekeeping_bypass_lock', 'on', true);

  for _rec in
    select ti.user_id
      from beacon_v2.time_intervals ti
      join beacon_v2.users u on u.id = ti.user_id
     where ti.end_at is null                                   -- open interval
       and ti.is_out = false                                   -- currently punched IN
       and coalesce(u.is_enabled, true)                        -- skip disabled accounts
       and (ti.start_at at time zone _tz)::date = _ct_today    -- started today (CT)
       and ti.start_at < _eod_instant                          -- ...before the EOD boundary
  loop
    -- 1) Real OUT punch at the EOD instant. The AFTER INSERT reconcile trigger
    --    closes the open IN interval and opens a fresh OUT interval.
    insert into beacon_v2.time_punches (user_id, punched_at, source, note, created_by)
    values (_rec.user_id, _eod_instant, 'manual', 'Auto punch-out (end of day)', null);

    -- 2) Label the just-opened OUT interval "done for the day" and freeze it so
    --    the rule / Outlook classifiers won't relabel it.
    update beacon_v2.time_intervals
       set category        = 'eod',
           category_source = 'admin',
           notes           = coalesce(nullif(notes, ''), 'Auto-punched out at end of day'),
           computed_at     = now()
     where user_id = _rec.user_id
       and end_at is null;

    -- 3) Refresh the day rollup so the timesheet totals + flags reflect it.
    perform beacon_v2.fn_recompute_day(_rec.user_id, _ct_today);

    _count := _count + 1;
  end loop;

  return _count;
end;
$$;

-- Cron / Edge Functions call this as service-role; keep it off the public API.
revoke all on function beacon_v2.auto_punch_out_eod(timestamptz) from public, anon, authenticated;
grant execute on function beacon_v2.auto_punch_out_eod(timestamptz) to service_role;

notify pgrst, 'reload schema';
