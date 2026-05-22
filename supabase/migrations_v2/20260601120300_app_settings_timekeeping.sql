-- MSMM Beacon v2 — extend the app_settings singleton with timekeeping knobs.
--
-- Workspace-wide knobs that steer the classifier + UI for everyone. Same
-- singleton pattern as the existing monthly_invoice_benchmark; same RLS
-- posture (read open, admin-only writes inherited from 20260430120000).
--
-- The trigger functions in 20260601120100 hardcode 'America/Chicago' for the
-- business timezone to keep them creatable without a circular dependency on
-- these columns. The Edge Functions (timeclock-punch, timeclock-classify)
-- and the frontend read tk_business_tz live so admins can change it from the
-- gear drawer; a future refactor migration can swap the triggers' hardcoded
-- value for a settings lookup.

set search_path = beacon_v2, public, extensions;

alter table beacon_v2.app_settings
  add column if not exists tk_enabled                  boolean      not null default false,
  add column if not exists tk_business_tz              text         not null default 'America/Chicago',
  add column if not exists tk_workday_hours            numeric(4,2) not null default 8.0,
  add column if not exists tk_overtime_threshold_min   int          not null default 480,    -- 8h
  add column if not exists tk_eod_window_start         time         not null default '16:00',
  add column if not exists tk_eod_window_end           time         not null default '19:00',
  add column if not exists tk_lunch_window_start       time         not null default '11:30',
  add column if not exists tk_lunch_window_end         time         not null default '13:30',
  add column if not exists tk_untagged_alert_after_min int          not null default 30,
  add column if not exists tk_office_ip_cidr           text[]       not null default '{}'::text[],
  add column if not exists tk_holidays                 jsonb        not null default '[]'::jsonb,
                                                                                            -- ["2026-07-04", ...]
  add column if not exists tk_default_travel_buffer_min int        not null default 30;
