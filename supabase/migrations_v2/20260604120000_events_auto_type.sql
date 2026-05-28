-- MSMM Beacon v2 — Events auto-type from title.
--
-- Auto-classifies beacon_v2.events.type from the event's title whenever a
-- row is inserted or updated with type = NULL. User-explicit choices (any
-- non-NULL type) are preserved; clearing the type back to NULL is the
-- explicit "re-derive from title" signal.
--
-- Why a DB trigger rather than frontend logic:
--   • Outlook-synced events insert via the outlook-sync Edge Function
--     which explicitly sets type=null (Outlook calendar invites have no
--     equivalent field). A trigger gives them a sensible default
--     automatically — a board meeting invite becomes Board Meetings, a
--     "1:1 with X" becomes Meetings, etc. — without the Edge Function
--     having to know about the rules.
--   • Manual creates (CreateModal) and inline edits (App.jsx patchTable)
--     both pass through the same trigger, so the rules can't drift
--     between code paths.
--   • The one-time backfill for legacy untyped rows is a single UPDATE
--     against the same function — no script, no deploy.
--
-- Rules in priority order (most specific wins so "AI Strategy Meeting"
-- becomes AI, not Meetings):
--   1. /board\s+meeting/i             -> Board Meetings
--   2. /\bai\b/i                      -> AI
--   3. /\bpartner(ship)?s?\b/i        -> Partner
--   4. /\b(project|kick.?off|RFP|RFQ|proposal)\b/i -> Project
--   5. /\b(meeting|mtg|1:1|sync|standup|call)\b/i  -> Meetings
--   6. (fallback)                     -> Event
--
-- The \m..\M POSIX word-boundary anchors prevent false positives like
-- matching "ai" inside "main"/"sail"/"train"/"airport".

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Inference function — pure, IMMUTABLE so the planner can short-circuit
--    repeated calls in the backfill UPDATE. Callable from both the trigger
--    below and the backfill statement at the bottom.
--------------------------------------------------------------------------------
create or replace function beacon_v2.fn_infer_event_type(_title text)
returns beacon_v2.event_type_enum
language plpgsql
immutable
as $$
declare
  _t text := coalesce(_title, '');
begin
  if btrim(_t) = '' then
    return 'Event';
  end if;

  -- 1) Board Meetings — must come BEFORE generic Meetings so a title like
  --    "Q3 Board Meeting" doesn't fall through to Meetings.
  if _t ~* '\mboard\s+meeting' then
    return 'Board Meetings';
  end if;

  -- 2) AI — word-boundary anchors so "AI" matches as a whole word and NOT
  --    inside "main", "sail", "train", "airport", "raid", etc. Case-insensitive
  --    via ~* so "AI", "Ai", "ai" all match.
  if _t ~* '\mai\M' then
    return 'AI';
  end if;

  -- 3) Partner / Partnership / Partners
  if _t ~* '\mpartner(ship)?s?\M' then
    return 'Partner';
  end if;

  -- 4) Project family — project, kickoff/kick-off/kick off, RFP, RFQ, proposal
  if _t ~* '\mproject\M'
     or _t ~* '\mkick.?off\M'
     or _t ~* '\mrf[pq]\M'
     or _t ~* '\mproposal\M' then
    return 'Project';
  end if;

  -- 5) Meetings family — meeting(s), mtg, 1:1, sync, standup, call
  if _t ~* '\mmeetings?\M'
     or _t ~* '\mmtg\M'
     or _t ~* '\m1:1\M'
     or _t ~* '\msync\M'
     or _t ~* '\mstandup\M'
     or _t ~* '\mcall\M' then
    return 'Meetings';
  end if;

  -- 6) Fallback
  return 'Event';
end;
$$;

--------------------------------------------------------------------------------
-- 2. Trigger function — auto-set type when NULL on INSERT or UPDATE.
--
-- Listens on UPDATE OF (title, type) — not just title — so the trigger also
-- fires when the user explicitly clears type back to NULL (the "re-derive"
-- signal). If type is non-NULL, the trigger is a no-op so user-explicit
-- choices (including "Event" picked manually) survive title edits.
--------------------------------------------------------------------------------
create or replace function beacon_v2.fn_events_auto_type()
returns trigger
language plpgsql
as $$
begin
  if NEW.type is null then
    NEW.type := beacon_v2.fn_infer_event_type(NEW.title);
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_events_auto_type on beacon_v2.events;
create trigger trg_events_auto_type
  before insert or update of title, type on beacon_v2.events
  for each row execute function beacon_v2.fn_events_auto_type();

--------------------------------------------------------------------------------
-- 3. One-time backfill for rows inserted before the trigger existed.
--    Idempotent: only touches NULL-type rows, so re-running this migration
--    after the user has manually typed some events won't overwrite their
--    work. Safe to re-paste in Studio.
--------------------------------------------------------------------------------
update beacon_v2.events
   set type = beacon_v2.fn_infer_event_type(title)
 where type is null;

--------------------------------------------------------------------------------
-- 4. Reload PostgREST so the new function is callable + the just-backfilled
--    values are visible immediately without an API restart.
--------------------------------------------------------------------------------
notify pgrst, 'reload schema';
