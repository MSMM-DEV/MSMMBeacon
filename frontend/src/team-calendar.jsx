// =============================================================================
// Team Calendar — read-only consolidated view of every colleague's Outlook
// calendar, color-coded per person. Replaces Outlook's stacked-calendar UX
// (which renders one column per shared calendar) with a single grid where
// everyone's busy time is overlaid.
//
// Data source: beacon_v2.user_calendar_events (the per-user Outlook mirror
// populated by the outlook-sync Edge Function's Pass B). The
// tk_calevents_team_select RLS policy lets any authenticated user read each
// other's non-private, non-cancelled events.
//
// What this view deliberately is NOT:
//   • No event editing — calendars are authored in Outlook, mirrored here.
//   • No slot-click create — there is no "new event" affordance.
//   • No drag/drop, no reschedule, no inline rename. Clicking an event opens
//     a read-only dialog with the metadata that's already on the row.
//
// Presentation notes (ui-v2.0)
// ---------------------------------------------------------------------------
// PEOPLE ARE THE ROWS, NOT THE EVENTS.
//
// A week/day TIME GRID is a one-person primitive. Overlaying sixteen people's
// calendars on a single shared time axis makes every concurrent event fight
// for the same horizontal space: on the real roster a Monday mid-morning has
// thirty concurrent events, which rbc's stock `overlap` layout renders as
// thirty 8-to-18px slivers. Measured on that data, 54 of 188 week blocks came
// out with ZERO legible characters: the 3px identity rule plus the hairline
// plus the 9px of padding consumed the whole box, and `overflow: hidden` ate
// the rest. Those were the user's "unlabelled bordered boxes". Capping the
// columns only converted the slivers into a "+55 more" slab.
//
// So Day, Week and Month are CUSTOM react-big-calendar views (the `views`
// prop takes a component, and `Calendar` hands it every prop it was given):
//
//   day    one horizontal LANE per selected person, time on the X axis. Two
//          events can only ever collide if ONE person is double-booked, which
//          is real information, and that case stacks into sub-rows inside the
//          lane. A person with nothing booked still gets a lane, which is how
//          this view answers "who is free at 2pm".
//   week   a real <table>, one row per person, seven day columns. Each cell
//          is a compact busy strip plus the day's load, so sixteen people are
//          one screen and one pass.
//   month  a real <table> of days, each carrying how much of the TEAM is busy
//          or out, rather than a pile of per-person chips.
//   agenda react-big-calendar's own list view, unchanged. It already worked.
//
// `onNavigate`, `onView`, `onSelectEvent`, `onDrillDown` and the toolbar all
// still run through `Calendar`; the custom views copy rbc's own `navigate`,
// `range` and `title` statics verbatim, so the date window logic in
// `windowForView` and every label is byte-identical to before.
//
// Most events carry NO SUBJECT. They are Outlook busy blocks: no subject, no
// attendees, no location. `smartTitle` names those honestly from `showAs`
// ("Busy", "Tentative"), because a block that says "Untitled event" spends
// its most valuable space saying nothing. For those events the information is
// WHO and WHEN, and the lane header is what carries the who.
//
// The chrome is built entirely from the Beacon kit in `@/ui`. Everything that
// cannot be reached with a utility class (rbc's agenda internals, the lane
// geometry, the container queries that thin a block out) is themed in ONE
// clearly-bannered block in src/styles.css, scoped under `.bx-teamcal` plus
// this page's `.bxtc-*` skins, which cannot be nested under `.bx-teamcal`
// because the event dialog is portalled to <body>.
//
// Per-person colour is DELIBERATELY QUIET, and with lanes it does even less
// than before: the lane header carries the swatch AND the full name, so the
// hue inside a block is pure continuity, never the signal. Colour is never
// the only signal anywhere on this page.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import {
  format, parse, startOfWeek, getDay,
  differenceInMinutes, startOfMonth, endOfMonth,
  startOfWeek as dfnsStartOfWeek, endOfWeek as dfnsEndOfWeek,
  startOfDay, endOfDay, addDays,
} from "date-fns";
import { enUS } from "date-fns/locale";
// react-big-calendar's stylesheet is NOT imported here. A JS-side CSS
// import lands UNLAYERED, and an unlayered declaration outranks every
// layered one regardless of specificity, so the library's defaults would
// beat our theming. It is pulled into layer(legacy) in design/index.css.

import { Icon } from "./icons.jsx";
import {
  getUsers, loadTeamCalendarEvents, userColorTokens,
  runOutlookSyncNow, isAdmin as getIsAdmin,
} from "./data.js";
import {
  Alert, Badge, Button, EmptyState, InputGroup, Separator, Skeleton,
  Tabs, TabsList, TabsTrigger,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
  Popover, PopoverTrigger, PopoverContent,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
  Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle,
  Tooltip, TooltipProvider,
} from "@/ui";

const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({
  format, parse,
  startOfWeek: (d) => startOfWeek(d, { weekStartsOn: 0 }),
  getDay, locales,
});

const VIEW_LABEL = { month: "Month", week: "Week", day: "Day", agenda: "Agenda" };
const DESKTOP_VIEWS = ["month", "week", "day", "agenda"];

// LocalStorage keys — namespaced so they don't collide with other tabs.
// .v2 suffix on the selection key forces a fresh "Engineering by default"
// roll-out for users who'd previously saved the all-internal default.
const LS_SELECTED   = "beacon.teamCalendar.selectedUserIds.v2";
const LS_VIEW       = "beacon.teamCalendar.view";

// Department name used to anchor the default selection. Stored verbatim in
// beacon_v2.users.department; case-insensitive match below.
const DEFAULT_DEPARTMENT = "Engineering";

const INTERNAL_EMAIL_RE = /@msmmeng\.com$/i;

// Placeholder for an empty cell. En dash, per the design contract.
const EMPTY = "–";

// ----- Outlook attendee response → display chip mapping -------------------
// Graph values: 'none' | 'organizer' | 'tentativelyAccepted' | 'accepted'
//             | 'declined' | 'notResponded'
const RESPONSE_CHIPS = {
  accepted:            { label: "Accepted",  cls: "is-accepted",  sort: 1 },
  organizer:           { label: "Organizer", cls: "is-organizer", sort: 0 },
  tentativelyAccepted: { label: "Tentative", cls: "is-tentative", sort: 2 },
  notResponded:        { label: "Awaiting",  cls: "is-noresp",    sort: 3 },
  none:                { label: "Awaiting",  cls: "is-noresp",    sort: 3 },
  declined:            { label: "Declined",  cls: "is-declined",  sort: 4 },
};
function responseChip(response) {
  return RESPONSE_CHIPS[response] || RESPONSE_CHIPS.none;
}

// Presentation-only mapping from the response class onto a Beacon badge tone.
// Product-wide semantics: sage = approved, clay = rejected, ochre = awaiting,
// steel = in-between. "Organizer" is not a response, so it stays neutral.
const RESPONSE_TONE = {
  "is-organizer": "outline",
  "is-accepted":  "success",
  "is-tentative": "info",
  "is-noresp":    "brand",
  "is-declined":  "danger",
};

// ----- Outlook free/busy status → honest block copy ------------------------
// Graph `showAs`: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere'
// | 'unknown'. On the real roster the majority of events are subject-less
// busy blocks, so this is what most blocks on the page actually say. It is UI
// copy derived from a column already on the row; nothing is fetched, adapted
// or stored differently because of it.
const SHOW_AS_LABEL = {
  busy:             "Busy",
  tentative:        "Tentative",
  oof:              "Out of office",
  workingElsewhere: "Working elsewhere",
  free:             "Free",
};

// ----- Smart subject fallback ---------------------------------------------
// When Graph returns null/empty `subject` (private events, app-permission
// limits, or genuinely untitled meetings), use the rest of the event payload
// to surface something more useful than "(no subject)".
//
// Cancelled events get a "Cancelled: " prefix to match Outlook's display
// — Outlook itself synthesizes that prefix in its UI from the underlying
// subject, and users expect to see the same in Beacon.
function smartTitle(r) {
  const subj = (r.subject || "").trim();
  if (r.isCancelled) {
    return subj ? `Cancelled: ${subj}` : "Cancelled meeting";
  }
  if (subj) return subj;
  if (r.sensitivity === "private")      return "Private appointment";
  if (r.sensitivity === "confidential") return "Confidential meeting";
  if (r.showAs === "oof")                return "Out of office";
  if (r.isAllDay)                        return "All-day block";
  const ownerEmail = (r._user?.email || "").toLowerCase();
  const others = (r.attendees || []).filter(a => {
    const e = (a?.email || "").toLowerCase();
    return e && e !== ownerEmail;
  });
  if (others.length === 1) {
    const a = others[0];
    return `Meeting with ${a.name || a.email.split("@")[0]}`;
  }
  if (others.length > 1) {
    return `Meeting · ${others.length + 1} people`;
  }
  if (r.location) return r.location;
  if (SHOW_AS_LABEL[r.showAs]) return SHOW_AS_LABEL[r.showAs];
  // Last resort, and on the live roster it is the COMMON case: 192 of the 224
  // rows in a sample week carry no subject, no showAs and no sensitivity at
  // all. Those rows are not "untitled" in any meaningful sense, they are
  // records that only ever captured a person and a time range, so the one
  // thing we can say truthfully is that the person is occupied. Saying "Busy"
  // is honest; "Untitled event" implies a title went missing from an
  // otherwise-complete record, which misdescribes the data.
  return "Busy";
}

function useIsMobile(breakpoint = 640) {
  const [m, setM] = useState(
    typeof window !== "undefined" && window.innerWidth <= breakpoint
  );
  useEffect(() => {
    const onResize = () => setM(window.innerWidth <= breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return m;
}

// Compute the ISO window to load for a given view+date. Padded with a
// neighbor week/day so the calendar can scroll without re-fetching.
function windowForView(date, view) {
  if (view === "month") {
    const ms = startOfMonth(date);
    const me = endOfMonth(date);
    // Month grid actually renders the bracketing week's leading/trailing days.
    const start = dfnsStartOfWeek(ms, { weekStartsOn: 0 });
    const end   = dfnsEndOfWeek(me,   { weekStartsOn: 0 });
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (view === "week") {
    const start = dfnsStartOfWeek(date, { weekStartsOn: 0 });
    const end   = dfnsEndOfWeek(date,   { weekStartsOn: 0 });
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (view === "day") {
    return { start: startOfDay(date).toISOString(), end: endOfDay(date).toISOString() };
  }
  // agenda: rbc default length is 30 days from the focus date
  return {
    start: startOfDay(date).toISOString(),
    end:   endOfDay(addDays(date, 30)).toISOString(),
  };
}

// Persist a value as JSON, swallowing quota errors (private-mode browsers).
function lsWrite(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* noop */ }
}
function lsRead(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

// Compact "X ago" formatter for the freshness indicator. nowMs is taken from
// a periodically-bumped state value so the label re-renders as time passes.
function timeAgo(date, nowMs) {
  if (!date) return "";
  const diff = Math.max(0, Math.floor((nowMs - date.getTime()) / 1000));
  if (diff < 5)        return "just now";
  if (diff < 60)       return `${diff}s ago`;
  const m = Math.floor(diff / 60);
  if (m < 60)          return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)          return `${h}h ago`;
  return date.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Per-person identity colour.
//
// WHICH palette slot a person gets is decided in data.js (`userColorTokens`,
// rotated per department) and is not touched here. What that slot RENDERS AS
// is decided here, and that is the whole point of this section: the raw slot
// is a fully-saturated hue, and twenty fully-saturated hues sharing one week
// grid is a barcode, not information.
//
// The projection below keeps the slot's hue exactly, and keeps its *rank* on
// the two other axes (a slot more saturated than its neighbours stays more
// saturated; a darker slot stays darker) but compresses both ranks into a
// narrow, deliberately dull band. The hue then only ever appears as a 3px
// rule, a small initials tile, or an all-day outline, while the event body
// sits on a near-neutral wash of the same hue.
//
// Measured across all 30 slots in both themes: --u-ink on --u-tint is 7.1:1
// at worst, --u-ink on --u-chip 5.4:1, --text-muted on --u-tint 5.1:1, and
// the --u-key rule holds 3.3:1 against whatever it sits on.
//
// Four values are emitted per theme; `.bxtc-ident` in styles.css picks the
// matching pair, so nothing downstream needs a `dark:` variant.
// ---------------------------------------------------------------------------
const IDENT = "bxtc-ident";

// `userColorTokens().stripe` is the slot's raw `hsl(H S% L%)`. Hue also comes
// back on its own; saturation and lightness are only available through this
// string, so a parse failure falls back to mid chroma and mid tone, which
// still leaves the hue doing the separating.
const SLOT_HSL_RE = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const hslStr = (h, s, l) =>
  `hsl(${h} ${Math.round(s * 10) / 10}% ${Math.round(l * 10) / 10}%)`;

function identityVars(userId) {
  const c = userColorTokens(userId);
  const m = SLOT_HSL_RE.exec(c.stripe || "");
  const h = m ? Number(m[1]) : (c.hue ?? 0);
  const s = m ? Number(m[2]) : 55;
  const l = m ? Number(m[3]) : 48;
  // Rank of this slot within the source palette's own range (S 22–88, L 30–72).
  const cr = clamp01((s - 22) / 66);
  const tr = clamp01((l - 30) / 42);
  return {
    "--u-key-l":  hslStr(h, 20 + 34 * cr, 29 + 17 * tr),
    "--u-key-d":  hslStr(h, 22 + 30 * cr, 54 + 15 * tr),
    "--u-ink-l":  hslStr(h, 20 + 18 * cr, 23 + 6 * tr),
    "--u-ink-d":  hslStr(h, 22 + 20 * cr, 76 + 6 * tr),
    "--u-tint-l": hslStr(h, 30 + 22 * cr, 96),
    "--u-tint-d": hslStr(h, 14 + 10 * cr, 17),
    "--u-chip-l": hslStr(h, 28 + 22 * cr, 89),
    "--u-chip-d": hslStr(h, 18 + 12 * cr, 26),
  };
}

// Someone who is not on the roster (an external attendee) gets the neutral
// surface ramp rather than a colour they do not own.
const NEUTRAL_IDENT = {
  "--u-key-l":  "var(--border-strong)", "--u-key-d":  "var(--border-strong)",
  "--u-ink-l":  "var(--text-muted)",    "--u-ink-d":  "var(--text-muted)",
  "--u-tint-l": "var(--surface-2)",     "--u-tint-d": "var(--surface-2)",
  "--u-chip-l": "var(--surface-3)",     "--u-chip-d": "var(--surface-3)",
};

/**
 * The identity a block should wear for its owner.
 *
 * An event can outlive its owner's place on the roster: `roster` drops anyone
 * disabled, but the saved selection still carries their id, so their events
 * still load and the id no longer resolves to a person. The old code rendered
 * `··` for that case, which on a narrow block that had already dropped its
 * title left a fully-bordered box with nothing legible inside it. That was the
 * stray empty box. Unknown owners now get the neutral ramp and a real glyph,
 * so a block is never contentless.
 */
const UNKNOWN_OWNER = "Not on the roster";

function ownerIdentity(r) {
  const u = r?._user;
  if (u) {
    return {
      style: identityVars(r.userId),
      initials: u.initials || "?",
      name: u.name || UNKNOWN_OWNER,
    };
  }
  return { style: NEUTRAL_IDENT, initials: "?", name: UNKNOWN_OWNER };
}

/**
 * Initials tile in the owner's colour. `aria-hidden` because the owner's
 * name is always rendered (or announced) alongside it: colour is never the
 * only signal. Skin lives in `.bxtc-swatch`; only the size varies per site.
 */
function Swatch({ initials, className = "" }) {
  return (
    <span className={`bxtc-swatch ${className}`} aria-hidden="true">
      {initials || "··"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// People picker — a Popover holding the search + department/location Selects
// + the full roster list, plus an always-visible legend strip of whoever is
// currently on the calendar. The legend doubles as the colour key: swatch,
// initials and full name together, so nobody is identified by hue alone.
// ---------------------------------------------------------------------------
function PeopleBar({ users, selected, onToggle, onSelectAll, onClearAll, onSetMany }) {
  const [query, setQuery] = useState("");
  const [department, setDepartment] = useState("All");
  const [location, setLocation]     = useState("All");

  // Unique department + location lists for the filter dropdowns. Derived
  // from the active roster so they stay in sync with whoever is enrolled.
  const departments = useMemo(() => {
    const set = new Set(users.map(u => u._department).filter(Boolean));
    return ["All", ...Array.from(set).sort()];
  }, [users]);
  const locations = useMemo(() => {
    const set = new Set(users.map(u => u._location).filter(Boolean));
    return ["All", ...Array.from(set).sort()];
  }, [users]);

  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter(u => {
      if (department !== "All" && u._department !== department) return false;
      if (location   !== "All" && u._location   !== location)   return false;
      if (q && !u.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [users, query, department, location]);

  const totalSelected = selected.size;
  const selectedUsers = users.filter(u => selected.has(u.id));

  return (
    <section className="flex min-w-0 flex-col gap-2.5" aria-label="Colleagues on the calendar">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="default" size="md" className="shrink-0">
              <Icon name="users" size={15} stroke={1.9} />
              <span>People</span>
              <span className="num rounded-[var(--radius-full)] bg-[var(--surface-3)] px-1.5 py-px text-[length:var(--fs-2xs)] font-semibold text-[var(--text-muted)]">
                {totalSelected}/{users.length}
              </span>
              <Icon name="chevronDown" size={14} stroke={2} />
            </Button>
          </PopoverTrigger>

          <PopoverContent
            align="start"
            className="w-[min(400px,calc(100vw-24px))] p-0"
          >
            <div className="flex max-h-[min(70dvh,520px)] min-h-0 flex-col">
              <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2.5">
                <div className="min-w-0">
                  <p className="m-0 text-[length:var(--fs-sm)] font-semibold text-[var(--text)]">
                    Who is on the calendar
                  </p>
                  <p className="m-0 text-[length:var(--fs-2xs)] text-[var(--text-muted)]">
                    <span className="num">{totalSelected}</span> of{" "}
                    <span className="num">{users.length}</span> selected
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Selection shortcuts">
                      <Icon name="more" size={16} stroke={2} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Bulk select</DropdownMenuLabel>
                    <DropdownMenuItem
                      onSelect={() => onSetMany(visibleUsers.map(u => u.id))}
                      disabled={visibleUsers.length === 0}
                    >
                      <Icon name="filter" size={15} />
                      <span>Select the {visibleUsers.length} shown</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={onSelectAll}>
                      <Icon name="checkAll" size={15} />
                      <span>Select everyone</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={onClearAll}>
                      <Icon name="close" size={15} />
                      <span>Clear selection</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div className="flex flex-col gap-2 border-b border-[var(--border)] px-3 py-2.5">
                <InputGroup
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find someone"
                  aria-label="Find someone"
                  leading={<Icon name="search" size={14} stroke={2} />}
                  trailing={
                    query ? (
                      <button
                        type="button"
                        onClick={() => setQuery("")}
                        aria-label="Clear search"
                        className={[
                          "grid size-5 place-items-center rounded-[var(--radius-xs)]",
                          "text-[var(--text-soft)] transition-colors duration-[var(--dur-fast)]",
                          "hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
                          "active:bg-[var(--surface-3)]",
                          "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
                        ].join(" ")}
                      >
                        <Icon name="close" size={13} stroke={2.2} />
                      </button>
                    ) : null
                  }
                />
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-[length:var(--fs-2xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
                      Department
                    </span>
                    <Select value={department} onValueChange={setDepartment}>
                      <SelectTrigger size="sm" aria-label="Filter by department">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {departments.map(d => (
                          <SelectItem key={d} value={d}>{d}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-[length:var(--fs-2xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
                      Location
                    </span>
                    <Select value={location} onValueChange={setLocation}>
                      <SelectTrigger size="sm" aria-label="Filter by location">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {locations.map(l => (
                          <SelectItem key={l} value={l}>{l}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                </div>
              </div>

              <div
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-1.5"
                role="group"
                aria-label="Team members"
              >
                {visibleUsers.length === 0 ? (
                  <p className="m-0 px-2 py-6 text-center text-[length:var(--fs-sm)] text-[var(--text-muted)]">
                    Nobody matches that filter. Clear the search or widen the
                    department and location filters.
                  </p>
                ) : (
                  visibleUsers.map(u => {
                    const isSel = selected.has(u.id);
                    const meta = [u._department, u._location].filter(Boolean).join(" · ");
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => onToggle(u.id)}
                        aria-pressed={isSel}
                        style={identityVars(u.id)}
                        className={[
                          IDENT,
                          "flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-[var(--radius-sm)]",
                          "px-2 py-1.5 text-left",
                          "transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                          "hover:bg-[var(--surface-2)]",
                          "active:bg-[var(--surface-3)]",
                          "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
                          "aria-pressed:bg-[var(--surface-2)]",
                        ].join(" ")}
                      >
                        <Swatch initials={u.initials} className="size-6 text-[10px]" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[length:var(--fs-sm)] font-medium text-[var(--text)]">
                            {u.name}
                          </span>
                          <span className="block truncate text-[length:var(--fs-2xs)] text-[var(--text-muted)]">
                            {meta || EMPTY}
                          </span>
                        </span>
                        <span
                          className={[
                            "grid size-4 shrink-0 place-items-center rounded-[var(--radius-xs)] border",
                            isSel
                              ? "border-[var(--accent-solid)] bg-[var(--accent-solid)] text-[var(--accent-on)]"
                              : "border-[var(--border-strong)] text-transparent",
                          ].join(" ")}
                          aria-hidden="true"
                        >
                          <Icon name="check" size={11} stroke={3} />
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {/* Legend / colour key. Every chip is the SAME control: neutral
            surface, one hairline, one type size. Only the swatch carries the
            person's hue, and it carries their initials with it, so the row
            reads as one component rather than as nine coloured buttons.
            Scrolls sideways inside itself so a full roster can never widen
            the page. */}
        {selectedUsers.length === 0 ? (
          <p className="m-0 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
            Nobody selected yet.
          </p>
        ) : (
          <ul className="bx-scroll-x m-0 flex min-w-0 flex-1 list-none items-center gap-1.5 p-0 pb-1">
            {selectedUsers.map(u => (
              <li key={u.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => onToggle(u.id)}
                  aria-pressed="true"
                  style={identityVars(u.id)}
                  title={`${u.name} · ${u._department || EMPTY} · ${u._location || EMPTY}`}
                  className={[
                    IDENT,
                    "group flex h-9 items-center gap-1.5 rounded-[var(--radius-full)] pl-1 pr-1.5 sm:h-8",
                    "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
                    "shadow-[var(--shadow-xs)]",
                    "transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                    "hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]",
                    "active:bg-[var(--surface-3)]",
                    "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
                  ].join(" ")}
                >
                  <Swatch initials={u.initials} className="size-6 text-[9.5px] sm:size-5" />
                  <span className="max-w-[13ch] truncate text-[length:var(--fs-xs)] font-medium sm:max-w-[20ch]">
                    {u.name}
                  </span>
                  <span
                    aria-hidden="true"
                    className={[
                      "grid size-4 shrink-0 place-items-center rounded-[var(--radius-full)]",
                      "text-[var(--text-soft)]",
                      "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]",
                      "group-hover:bg-[var(--surface-3)] group-hover:text-[var(--text)]",
                    ].join(" ")}
                  >
                    <Icon name="close" size={11} stroke={2.4} />
                  </span>
                  <span className="sr-only">Remove {u.name} from the calendar</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared formatting.
//
// Every renderer on this page clips: the outer element is `overflow: hidden`
// and the title truncates, so a long subject can never spill past its slot.
// ---------------------------------------------------------------------------
const fmtTime = (d) => {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = d.getMinutes();
  const hh = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? "am" : "pm";
  return m === 0 ? `${hh}${ampm}` : `${hh}:${String(m).padStart(2, "0")}${ampm}`;
};

// Total attendees on an event (resource shape). The Pass-B mirror stores
// every attendee — internal + external — in a single jsonb array.
function attendeeCount(r) {
  return (r?.attendees || []).filter(a => a?.email).length;
}

// ---------------------------------------------------------------------------
// LOSSLESS ALL-DAY MERGE
//
// Every attendee's Outlook mirror carries its OWN copy of a shared all-day
// event, so "Randy Vacation out of country" arrives four times and the week's
// all-day band renders four identical full-width bars. They are folded into
// one bar that wears every owner's initials.
//
// The identity key is deliberately strict — all-day flag + start + end +
// title, all four — so two genuinely different events that merely share a
// title (two separate "PTO" blocks on different days, or a morning and an
// afternoon "Site visit") can never collapse into each other. Timed events
// are never merged: overlapping timed work is what the column cap below is
// for, and merging it would hide real double-booking.
//
// The merge is presentational only. Nothing is dropped: every input event
// ends up in exactly one output bar's `_members`, which is what the merged
// bar's owner chips and the detail dialog's owner list read from.
// ---------------------------------------------------------------------------
function allDayIdentity(e) {
  return `${+e.start}|${+e.end}|${e.title}`;
}

function mergeAllDayEvents(list) {
  const byKey = new Map();
  const out = [];
  for (const ev of list) {
    if (!ev.allDay) { out.push(ev); continue; }
    const key = allDayIdentity(ev);
    const bar = byKey.get(key);
    if (bar) {
      bar.resource._members.push(ev);
      continue;
    }
    const merged = {
      ...ev,
      id: `bxtc-allday:${key}`,
      resource: { ...ev.resource, _members: [ev] },
    };
    byKey.set(key, merged);
    out.push(merged);
  }
  return out;
}

// Distinct calendar owners behind a merged bar, in the order they merged.
// Returns null for an unmerged event so call sites can fall back to the
// single initials tile.
function mergedOwners(r) {
  const members = r?._members;
  if (!members || members.length < 2) return null;
  const seen = new Set();
  const owners = [];
  for (const m of members) {
    const id = m.resource?.userId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    owners.push({
      id,
      initials: m.resource?._user?.initials || "?",
      name: m.resource?._user?.name || UNKNOWN_OWNER,
    });
  }
  return owners.length > 1 ? owners : null;
}

// ---------------------------------------------------------------------------
// LANE GEOMETRY
//
// Everything the three custom views need to place a rectangle. All of it is
// pure arithmetic over the events already loaded: no fetch, no adapter, no
// stored value is touched, and the per-person colour SLOT still comes from
// data.js exactly as before.
//
// The one invariant worth stating: the extent a block is PACKED at and the
// extent it is DRAWN at are the same interval, so two blocks that share a
// sub-row cannot overlap however narrow the track gets.
// ---------------------------------------------------------------------------
const DAY_MS  = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// The floor on a block's span. 15 minutes is 23px at the day view's minimum
// zoom, which is the point at which a block still reads as a deliberate mark
// rather than a scratch. Applying it to the SPAN rather than to the layout
// afterwards is what keeps packed and drawn geometry identical. It also gives
// the two degenerate shapes Outlook really sends (zero length, and end before
// start) a real rectangle instead of a 0px one.
const MIN_SPAN_MS = 15 * 60 * 1000;

// Default visible window, widened but never narrowed to cover the day.
const WIN_OPEN_H  = 7;
const WIN_CLOSE_H = 19;

// Lane metrics, in px. Mirrored by the same numbers in styles.css; they live
// here too because a lane's height is a function of how deep its stack packs,
// which only JS knows.
const BLOCK_H   = 30;
const BLOCK_GAP = 3;
const LANE_PAD  = 5;
const laneHeight = (rows) => {
  const r = Math.max(1, rows);
  return LANE_PAD * 2 + r * BLOCK_H + (r - 1) * BLOCK_GAP;
};

const dayKey  = (d) => +startOfDay(d);
const sameCalDay = (a, b) => dayKey(a) === dayKey(b);

// An event's span inside one local day, in ms, or null if it never reaches it.
function spanInDay(ev, dayStart, dayEnd) {
  const s0 = +ev.start;
  const e0 = Math.max(+ev.end, s0 + MIN_SPAN_MS);
  const s = Math.max(s0, dayStart);
  const e = Math.min(e0, dayEnd);
  return e > s ? [s, e] : null;
}

// An event that occupies a whole day rather than a slice of one. `oof` is
// called out separately because "out of office" and "booked all day" are
// different answers to "is this person around".
function outKind(ev) {
  if (ev.resource?.showAs === "oof") return "out";
  if (ev.allDay) return "allday";
  return null;
}

// First-fit packing into sub-rows. On a start-sorted list this uses exactly
// the stack's peak concurrency, and it only ever shares a sub-row between two
// items when the earlier one ends at or before the later one starts.
function packRows(items) {
  const rowEnd = [];
  for (const it of items) {
    let row = -1;
    for (let r = 0; r < rowEnd.length; r++) {
      if (rowEnd[r] <= it.s) { row = r; break; }
    }
    if (row === -1) { row = rowEnd.length; rowEnd.push(0); }
    rowEnd[row] = it.e;
    it.row = row;
  }
  return rowEnd.length;
}

// Union of a set of spans. `gapMs` merges anything closer than that, so the
// week's segments can carry a minimum rendered width and still never touch.
function unionSpans(spans, gapMs = 0) {
  const sorted = spans.map(s => [s[0], s[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const sp of sorted) {
    const last = out[out.length - 1];
    if (last && sp[0] - last[1] <= gapMs) last[1] = Math.max(last[1], sp[1]);
    else out.push(sp);
  }
  return out;
}

// Widen the default window until it covers every timed span given to it.
// `from`/`to` are ms from that span's own midnight, so a week can pool spans
// from seven different days into one window.
function windowHours(spans) {
  let lo = WIN_OPEN_H;
  let hi = WIN_CLOSE_H;
  for (const sp of spans) {
    lo = Math.min(lo, Math.floor(sp.from / HOUR_MS));
    hi = Math.max(hi, Math.ceil(sp.to / HOUR_MS));
  }
  lo = Math.max(0, lo);
  hi = Math.min(24, Math.max(hi, lo + 2));
  return [lo, hi];
}

// Bucket the loaded events by owner, in the lane order handed in. Every event
// whose owner has a lane lands in exactly one bucket; the parent guarantees a
// lane exists for every owner present in the data, including someone who has
// since left the roster.
function bucketByOwner(lanes, events) {
  const by = new Map(lanes.map(l => [l.id, []]));
  for (const ev of events) {
    const bucket = by.get(ev.resource?.userId);
    if (bucket) bucket.push(ev);
  }
  return by;
}

const hourLabel = (h) => {
  const hh = ((h + 11) % 12) + 1;
  if (h === 0)  return "12am";
  if (h === 12) return "noon";
  return `${hh}${h < 12 ? "am" : "pm"}`;
};

// "4.5h" / "45m". Tabular figures, no unit word, because it sits in a 96px
// cell next to sixteen others.
function loadLabel(ms) {
  const mins = Math.round(ms / 60000);
  if (mins <= 0) return EMPTY;
  if (mins < 60) return `${mins}m`;
  const h = mins / 60;
  return `${h % 1 === 0 ? h : h.toFixed(1)}h`;
}
function loadSpoken(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minutes booked`;
  const h = mins / 60;
  const n = h % 1 === 0 ? h : h.toFixed(1);
  return `${n} hours booked`;
}

// ---------------------------------------------------------------------------
// Shared chrome: the person cell that opens every lane and every week row.
// It is the only place identity is asserted, which is why the block skins can
// afford to be as quiet as they are.
// ---------------------------------------------------------------------------
function LaneIdentity({ user, meta, tone }) {
  return (
    <>
      <Swatch initials={user.initials} className="size-6 text-[10px]" />
      <span className="bxtc-lane-id">
        <span className="bxtc-lane-name" title={user.name}>{user.name}</span>
        <span className="bxtc-lane-meta" data-tone={tone || undefined}>{meta}</span>
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------
// DAY: one lane per person, time on the X axis.
//
// This is the scheduling-assistant primitive, and it is the whole point of
// the restructure. Because a lane holds exactly one calendar, the only way
// two blocks can compete is a genuine double-booking, which stacks into
// sub-rows instead of shredding the column. A person with nothing booked
// still gets a lane: an empty row IS the answer to "who is free at 2pm".
// ---------------------------------------------------------------------------
function DayLanes({ date, laneEvents = [], laneUsers = [], onSelectEvent }) {
  const model = useMemo(() => {
    const dStart = dayKey(date);
    const dEnd   = dStart + DAY_MS;
    const buckets = bucketByOwner(laneUsers, laneEvents);

    // Window first: every timed span in the day, pooled.
    const pool = [];
    for (const list of buckets.values()) {
      for (const ev of list) {
        if (outKind(ev)) continue;
        const sp = spanInDay(ev, dStart, dEnd);
        if (sp) pool.push({ from: sp[0] - dStart, to: sp[1] - dStart });
      }
    }
    // Window before geometry: an all-day band spans whatever the timed events
    // opened the day out to.
    const [openH, closeH] = windowHours(pool);
    const winStart = dStart + openH * HOUR_MS;
    const winEnd   = dStart + closeH * HOUR_MS;
    const span     = winEnd - winStart;

    const lanes = laneUsers.map(user => {
      const items = [];
      const busySpans = [];
      let out = null;
      for (const ev of buckets.get(user.id) || []) {
        // Reach is decided the same way for every event, INCLUDING all-day
        // ones. An Outlook all-day block ends at the next midnight, so
        // Thursday's runs to Friday 00:00 and must not paint a band across
        // Friday; only the geometry differs once the event is known to land
        // on this day.
        const sp = spanInDay(ev, dStart, dEnd);
        if (!sp) continue;
        const kind = outKind(ev);
        if (kind) {
          // "Out of office" outranks "booked all day" when both are present.
          out = out === "out" ? out : kind;
          items.push({ ev, s: winStart, e: winEnd, kind });
          continue;
        }
        busySpans.push(sp);
        items.push({ ev, s: sp[0], e: sp[1], kind: null });
      }
      const busyMs = unionSpans(busySpans).reduce((n, sp) => n + (sp[1] - sp[0]), 0);
      // All-day bands first so they take the top sub-row, then by start.
      items.sort((a, b) =>
        (a.kind ? 0 : 1) - (b.kind ? 0 : 1) || a.s - b.s || b.e - a.e
      );
      const rows = packRows(items);
      const timed = items.filter(i => !i.kind).length;
      const meta =
        out === "out"    ? "Out of office"
      : out === "allday" ? "Booked all day"
      : timed === 0      ? "Free all day"
      : `${timed} ${timed === 1 ? "event" : "events"}, ${loadLabel(busyMs)}`;
      return {
        user, items, meta,
        tone: out ? "out" : undefined,
        height: laneHeight(rows),
      };
    });

    const now = new Date();
    const nowPct = sameCalDay(now, date)
      ? ((+now - winStart) / span) * 100
      : null;

    return {
      lanes,
      hours: closeH - openH,
      ticks: Array.from({ length: closeH - openH }, (_, i) => openH + i),
      winStart, span,
      nowPct: nowPct != null && nowPct >= 0 && nowPct <= 100 ? nowPct : null,
    };
  }, [date, laneEvents, laneUsers]);

  const heading = `Team schedule for ${format(date, "EEEE, MMMM d, yyyy")}`;

  return (
    // A scrollable region needs to be reachable by keyboard in its own right,
    // because a lane with nothing booked has no focusable child to scroll to.
    <div className="bxtc-lanes" role="region" aria-label={heading} tabIndex={0}>
      <div className="bxtc-lanes-inner" style={{ "--bxtc-hours": model.hours }}>
        <div className="bxtc-axisrow">
          <div className="bxtc-axis-head">
            <span className="bxtc-colcap">Person</span>
          </div>
          <div className="bxtc-axis" aria-hidden="true">
            {model.ticks.map(h => (
              <span key={h} className="bxtc-axis-tick num">{hourLabel(h)}</span>
            ))}
          </div>
        </div>

        <ul className="bxtc-lane-list" role="list" aria-label="People">
          {model.lanes.map(lane => (
            <li key={lane.user.id} className="bxtc-lane" style={{ height: `${lane.height}px` }}>
              <div
                className={`${IDENT} bxtc-lane-head`}
                style={lane.user.identity}
              >
                <LaneIdentity user={lane.user} meta={lane.meta} tone={lane.tone} />
              </div>
              <ul
                className="bxtc-lane-track"
                role="list"
                data-now={model.nowPct != null ? "true" : undefined}
                style={model.nowPct != null ? { "--bxtc-now": model.nowPct } : undefined}
              >
                {lane.items.map(item => {
                  const label = fullEventLabel(item.ev);
                  const r = item.ev.resource || {};
                  const left  = ((item.s - model.winStart) / model.span) * 100;
                  const width = ((item.e - item.s) / model.span) * 100;
                  return (
                    // The <li> carries the geometry and the button fills it,
                    // so the measured box of a block IS its packed interval.
                    <li
                      key={item.ev.id}
                      className="bxtc-blockwrap"
                      style={{
                        left: `${left}%`,
                        width: `calc(${width}% - 2px)`,
                        top: `${LANE_PAD + item.row * (BLOCK_H + BLOCK_GAP)}px`,
                      }}
                    >
                      <button
                        type="button"
                        className={`${IDENT} bxtc-block`}
                        style={lane.user.identity}
                        data-kind={item.kind || undefined}
                        data-cancelled={r.isCancelled ? "true" : undefined}
                        title={label}
                        onClick={(e) => onSelectEvent && onSelectEvent(item.ev, e)}
                      >
                        <span className="sr-only">{label}</span>
                        <span className="bxtc-block-title" aria-hidden="true">
                          {item.ev.title}
                        </span>
                        {!item.kind && (
                          <span className="bxtc-block-time num" aria-hidden="true">
                            {fmtTime(item.ev.start)}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
DayLanes.range    = (date, { localizer }) => [localizer.startOf(date, "day")];
DayLanes.navigate = (date, action, { localizer }) => {
  if (action === "PREV") return localizer.add(date, -1, "day");
  if (action === "NEXT") return localizer.add(date, 1, "day");
  return date;
};
DayLanes.title    = (date, { localizer }) => localizer.format(date, "dayHeaderFormat");

// ---------------------------------------------------------------------------
// WEEK: a real matrix, person down, day across.
//
// Sixteen people over seven days is 112 cells, which is a table and should be
// marked up as one: `scope="col"` on the day, `scope="row"` on the person, so
// a screen reader announces "Randy Patel, MON 3, 4.5 hours booked" from any
// cell. Each cell is a busy STRIP rather than a list of blocks, because at
// this scale the question is "is this person around", not "what is the 11am".
// The strip's segments are the UNION of that day's events, so a person who is
// triple-booked at 10am gets one bar, not three.
// ---------------------------------------------------------------------------
// Segments closer together than 1/40th of the strip are merged, so that the
// 2px minimum on a segment can never make two of them touch.
const SEG_MERGE_FRACTION = 40;

function WeekMatrix({ date, laneEvents = [], laneUsers = [], onOpenDayList }) {
  const model = useMemo(() => {
    const first = dfnsStartOfWeek(date, { weekStartsOn: 0 });
    const days = Array.from({ length: 7 }, (_, i) => addDays(first, i));
    const buckets = bucketByOwner(laneUsers, laneEvents);

    const pool = [];
    for (const list of buckets.values()) {
      for (const ev of list) {
        if (outKind(ev)) continue;
        for (const d of days) {
          const ds = dayKey(d);
          const sp = spanInDay(ev, ds, ds + DAY_MS);
          if (sp) pool.push({ from: sp[0] - ds, to: sp[1] - ds });
        }
      }
    }
    const [openH, closeH] = windowHours(pool);
    const spanMs = (closeH - openH) * HOUR_MS;
    const gapMs  = spanMs / SEG_MERGE_FRACTION;

    const rows = laneUsers.map(user => {
      const mine = buckets.get(user.id) || [];
      let weekMs = 0;
      let outDays = 0;
      const cells = days.map(d => {
        const ds = dayKey(d);
        const winStart = ds + openH * HOUR_MS;
        const winEnd   = ds + closeH * HOUR_MS;
        const events = [];
        const spans = [];
        let out = null;
        for (const ev of mine) {
          const kind = outKind(ev);
          const sp = spanInDay(ev, ds, ds + DAY_MS);
          if (!sp) continue;
          events.push(ev);
          if (kind) { out = out === "out" ? out : kind; continue; }
          spans.push([
            Math.max(sp[0], winStart),
            Math.min(Math.max(sp[1], winStart + MIN_SPAN_MS), winEnd),
          ]);
        }
        const merged = unionSpans(spans.filter(sp => sp[1] > sp[0]), gapMs);
        const busyMs = merged.reduce((n, sp) => n + (sp[1] - sp[0]), 0);
        weekMs += busyMs;
        if (out) outDays += 1;
        return {
          day: d,
          events,
          out,
          busyMs,
          segments: merged.map(sp => ({
            left:  ((sp[0] - winStart) / spanMs) * 100,
            width: ((sp[1] - sp[0]) / spanMs) * 100,
          })),
        };
      });
      return { user, cells, weekMs, outDays };
    });

    // Column tally: how much of the team is on something that day.
    const tallies = days.map((d, i) => {
      let busy = 0;
      let out  = 0;
      for (const row of rows) {
        const c = row.cells[i];
        if (c.out) out += 1;
        else if (c.events.length > 0) busy += 1;
      }
      return { busy, out, total: rows.length };
    });

    return { days, rows, tallies };
  }, [date, laneEvents, laneUsers]);

  const today = new Date();

  return (
    <div
      className="bxtc-wkwrap"
      role="region"
      aria-label="Who is booked this week"
      tabIndex={0}
    >
      <table className="bxtc-wk">
        <caption className="sr-only">
          Who is booked each day this week, one row per person.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="bxtc-wk-corner">
              <span className="bxtc-colcap">Person</span>
            </th>
            {model.days.map((d, i) => {
              const t = model.tallies[i];
              const isToday = sameCalDay(d, today);
              const pct = t.total ? ((t.busy + t.out) / t.total) * 100 : 0;
              return (
                <th
                  key={+d}
                  scope="col"
                  className="bxtc-wk-day"
                  data-today={isToday ? "true" : undefined}
                  aria-current={isToday ? "date" : undefined}
                >
                  <span className="bxtc-wk-dayline" aria-hidden="true">
                    <span className="bxtc-wk-dow">{format(d, "EEE")}</span>
                    <span className="bxtc-wk-dom num">{format(d, "d")}</span>
                  </span>
                  <span className="bxtc-wk-loadline" aria-hidden="true">
                    <span className="bxtc-meter">
                      <span className="bxtc-meter-fill" style={{ "--bxtc-pct": pct }} />
                    </span>
                    <span className="bxtc-wk-tally">
                      <span className="num">{t.busy + t.out}</span>
                      <span>of</span>
                      <span className="num">{t.total}</span>
                    </span>
                  </span>
                  <span className="sr-only">
                    {`${t.busy + t.out} of ${t.total} people booked`}
                    {t.out > 0 ? `, ${t.out} out of office` : ""}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {model.rows.map(row => (
            <tr key={row.user.id}>
              <th
                scope="row"
                className={`${IDENT} bxtc-wk-person`}
                style={row.user.identity}
              >
                <LaneIdentity
                  user={row.user}
                  meta={
                    row.weekMs > 0
                      ? `${loadLabel(row.weekMs)} this week`
                      : row.outDays > 0 ? "Away this week" : "Nothing booked"
                  }
                  tone={row.weekMs === 0 && row.outDays > 0 ? "out" : undefined}
                />
              </th>
              {row.cells.map(cell => {
                const isToday = sameCalDay(cell.day, today);
                const dayName = format(cell.day, "EEEE MMMM d");
                if (cell.events.length === 0) {
                  return (
                    <td
                      key={+cell.day}
                      className="bxtc-wk-cell"
                      data-today={isToday ? "true" : undefined}
                    >
                      <span className="bxtc-wk-none" aria-hidden="true">{EMPTY}</span>
                      <span className="sr-only">Nothing booked</span>
                    </td>
                  );
                }
                const fig =
                  cell.out === "out"    ? "Out"
                : cell.out === "allday" ? "All day"
                : loadLabel(cell.busyMs);
                const spoken =
                  cell.out === "out"    ? "Out of office"
                : cell.out === "allday" ? "Booked all day"
                : loadSpoken(cell.busyMs);
                return (
                  <td
                    key={+cell.day}
                    className="bxtc-wk-cell"
                    data-today={isToday ? "true" : undefined}
                  >
                    <button
                      type="button"
                      className={`${IDENT} bxtc-wk-btn`}
                      style={row.user.identity}
                      data-out={cell.out || undefined}
                      onClick={() => onOpenDayList({
                        start: startOfDay(cell.day),
                        end: endOfDay(cell.day),
                        events: cell.events,
                        heading: `${row.user.name}, ${dayName}`,
                      })}
                    >
                      <span className="sr-only">
                        {`${spoken}, ${cell.events.length} ${cell.events.length === 1 ? "event" : "events"}. Open the list.`}
                      </span>
                      <span className="bxtc-strip" aria-hidden="true">
                        {cell.out ? (
                          <span className="bxtc-seg bxtc-seg--out" />
                        ) : (
                          cell.segments.map((sg, i) => (
                            <span
                              key={i}
                              className="bxtc-seg"
                              style={{ left: `${sg.left}%`, width: `${sg.width}%` }}
                            />
                          ))
                        )}
                      </span>
                      <span className="bxtc-wk-fig num" aria-hidden="true">{fig}</span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
WeekMatrix.navigate = (date, action, { localizer }) => {
  if (action === "PREV") return localizer.add(date, -1, "week");
  if (action === "NEXT") return localizer.add(date, 1, "week");
  return date;
};
WeekMatrix.range = (date, { localizer }) => {
  const firstOfWeek = localizer.startOfWeek();
  const start = localizer.startOf(date, "week", firstOfWeek);
  const end   = localizer.endOf(date, "week", firstOfWeek);
  return localizer.range(start, end);
};
WeekMatrix.title = (date, { localizer }) => {
  const range = WeekMatrix.range(date, { localizer });
  return localizer.format(
    { start: range[0], end: range[range.length - 1] },
    "dayRangeHeaderFormat"
  );
};

// ---------------------------------------------------------------------------
// MONTH: the team, not the people.
//
// A month cell is 130px wide and there are 194 events in a week, so per-person
// chips here were always going to be a pile. What a month is actually good at
// is the shape of the month: which days the team is loaded, and which days
// people are away. Each cell answers that with one meter and two figures, and
// drills into the day lanes through react-big-calendar's own `onDrillDown`,
// so the view switch and the date change run through `onView` / `onNavigate`
// exactly as clicking a date always has.
// ---------------------------------------------------------------------------
function TeamMonth({ date, laneEvents = [], laneUsers = [], localizer, onDrillDown }) {
  const model = useMemo(() => {
    const first = localizer.firstVisibleDay(date, localizer);
    const last  = localizer.lastVisibleDay(date, localizer);
    const days = [];
    for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);

    const buckets = bucketByOwner(laneUsers, laneEvents);
    const stats = new Map();
    for (const d of days) {
      stats.set(dayKey(d), { busy: new Set(), out: new Set(), events: 0 });
    }
    for (const [uid, list] of buckets) {
      for (const ev of list) {
        const kind = outKind(ev);
        for (const d of days) {
          const ds = dayKey(d);
          if (!spanInDay(ev, ds, ds + DAY_MS)) continue;
          const s = stats.get(ds);
          s.events += 1;
          if (kind) s.out.add(uid); else s.busy.add(uid);
        }
      }
    }

    const weeks = [];
    for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
    return { days, weeks, stats, month: date.getMonth() };
  }, [date, laneEvents, laneUsers, localizer]);

  const today = new Date();
  const total = laneUsers.length;

  return (
    <div
      className="bxtc-mowrap"
      role="region"
      aria-label="Team load this month"
      tabIndex={0}
    >
      <table className="bxtc-mo">
        <caption className="sr-only">
          How much of the team is booked or away on each day of the month.
        </caption>
        <thead>
          <tr>
            {model.weeks[0]?.map(d => (
              <th key={+d} scope="col">{format(d, "EEE")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.weeks.map((week, wi) => (
            <tr key={wi}>
              {week.map(d => {
                const s = model.stats.get(dayKey(d));
                // Someone who is away AND has a meeting on the books is one
                // person, not two: `out` wins and `busy` drops them, so the
                // two figures always add up to the headcount and never past it.
                const out  = s.out.size;
                const busy = [...s.busy].filter(id => !s.out.has(id)).length;
                const on   = busy + out;
                const pct  = total ? (on / total) * 100 : 0;
                const isToday = sameCalDay(d, today);
                const offRange = d.getMonth() !== model.month;
                const spoken =
                  on === 0
                    ? `${format(d, "EEEE MMMM d")}, nobody booked`
                    : `${format(d, "EEEE MMMM d")}, ${on} of ${total} booked` +
                      (out > 0 ? `, ${out} out of office` : "") +
                      `, ${s.events} ${s.events === 1 ? "event" : "events"}`;
                return (
                  <td
                    key={+d}
                    className="bxtc-mo-cell"
                    data-today={isToday ? "true" : undefined}
                    data-off={offRange ? "true" : undefined}
                  >
                    <button
                      type="button"
                      className="bxtc-mo-day"
                      onClick={() => onDrillDown && onDrillDown(d, "day")}
                    >
                      <span className="sr-only">{spoken}. Open the day.</span>
                      <span className="bxtc-mo-date num" aria-hidden="true">
                        {format(d, "d")}
                      </span>
                      {on > 0 ? (
                        <span className="bxtc-mo-body" aria-hidden="true">
                          <span className="bxtc-meter">
                            <span className="bxtc-meter-fill" style={{ "--bxtc-pct": pct }} />
                          </span>
                          <span className="bxtc-mo-figs">
                            <span className="bxtc-mo-fig">
                              <span className="num">{on}</span>
                              <span>of</span>
                              <span className="num">{total}</span>
                              <span>booked</span>
                            </span>
                            {out > 0 && (
                              <span className="bxtc-mo-out">
                                <span className="num">{out}</span>
                                <span>out</span>
                              </span>
                            )}
                          </span>
                        </span>
                      ) : (
                        <span className="bxtc-mo-quiet" aria-hidden="true">{EMPTY}</span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
TeamMonth.range = (date, { localizer }) => ({
  start: localizer.firstVisibleDay(date, localizer),
  end:   localizer.lastVisibleDay(date, localizer),
});
TeamMonth.navigate = (date, action, { localizer }) => {
  if (action === "PREV") return localizer.add(date, -1, "month");
  if (action === "NEXT") return localizer.add(date, 1, "month");
  return date;
};
TeamMonth.title = (date, { localizer }) => localizer.format(date, "monthHeaderFormat");


// Lane, strip and block skins live in the `.bxtc-*` rules in styles.css.
// Two reasons they are not utility strings: a block sets an all-round border
// colour AND a differently-coloured left rule, and two competing Tailwind
// border utilities on one element resolve by generated source order rather
// than by the order they appear here; and the container queries that thin a
// block out on a narrow track have to be able to `display: none` a part,
// which a layered rule cannot do to an element carrying a display utility.

// One sentence describing an event completely. It is BOTH the block's
// accessible name (an `.sr-only` span, with every visible part marked
// `aria-hidden`, so a screen reader gets the whole event rather than whatever
// survived the layout) and its hover tooltip. Commas, never dashes, so it
// reads as a sentence when spoken.
function fullEventLabel(event) {
  const r = event.resource || {};
  const owners = mergedOwners(r);
  const who = owners
    ? owners.map(o => o.name).join(", ")
    : ownerIdentity(r).name;
  const bits = [who, event.title];
  const sameDay = event.start.toDateString() === event.end.toDateString();
  bits.push(
    r.isAllDay ? "all day"
    : sameDay  ? `${fmtTime(event.start)} to ${fmtTime(event.end)}`
    : `${format(event.start, "MMM d")} ${fmtTime(event.start)} to ${format(event.end, "MMM d")} ${fmtTime(event.end)}`
  );
  if (r.location) bits.push(r.location);
  const n = attendeeCount(r);
  if (n > 1) bits.push(`${n} attendees`);
  if (r.isCancelled) bits.push("cancelled");
  return bits.join(", ");
}

/**
 * Initials tiles for the owners behind a merged all-day bar. Decorative: the
 * same names are already in the block's accessible name.
 */
function OwnerChips({ owners, max = 4 }) {
  const shown = owners.slice(0, max);
  const rest  = owners.length - shown.length;
  return (
    <span className="bxtc-owners" aria-hidden="true">
      {shown.map(o => (
        <span
          key={o.id}
          className={`${IDENT} bxtc-swatch bxtc-owner`}
          style={identityVars(o.id)}
        >
          {o.initials}
        </span>
      ))}
      {rest > 0 && <span className="bxtc-owner bxtc-owner--rest num">+{rest}</span>}
    </span>
  );
}

/**
 * The agenda's event cell. react-big-calendar puts the click handler on the
 * surrounding `<td>` and nothing else: no tab stop, no key handling. Rendering
 * the row as a real `<button>` that fills the cell makes it reachable and
 * operable from the keyboard, and the click still bubbles to rbc's own handler
 * so `onSelectEvent` fires exactly once, exactly as before.
 */
function AgendaRow({ event }) {
  const r = event.resource || {};
  const n = attendeeCount(r);
  const owners = mergedOwners(r);
  return (
    <button
      type="button"
      className={[
        IDENT,
        "bxtc-agenda-row",
        "flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-left",
        r.isCancelled ? "opacity-60" : "",
      ].join(" ")}
      style={ownerIdentity(r).style}
      title={fullEventLabel(event)}
    >
      <span className="sr-only">{fullEventLabel(event)}</span>
      <span className="flex min-w-0 shrink-0 items-center gap-1.5" aria-hidden="true">
        {owners ? (
          <>
            <OwnerChips owners={owners} max={5} />
            <span className="max-w-[16ch] truncate text-[length:var(--fs-2xs)] text-[var(--text-muted)]">
              <span className="num">{owners.length}</span> calendars
            </span>
          </>
        ) : (
          <>
            <Swatch initials={ownerIdentity(r).initials} className="size-5 text-[9.5px]" />
            <span className="max-w-[16ch] truncate text-[length:var(--fs-2xs)] text-[var(--text-muted)]">
              {ownerIdentity(r).name}
            </span>
          </>
        )}
      </span>
      <span
        className={[
          "min-w-0 flex-1 truncate text-[length:var(--fs-sm)] font-medium text-[var(--text)]",
          r.isCancelled ? "line-through" : "",
        ].join(" ")}
        aria-hidden="true"
      >
        {event.title}
      </span>
      {r.location && (
        <span
          className="flex min-w-0 max-w-[22ch] shrink-0 items-center gap-1 text-[length:var(--fs-2xs)] text-[var(--text-muted)]"
          aria-hidden="true"
        >
          <Icon name="pin" size={11} stroke={2} className="shrink-0" />
          <span className="truncate">{r.location}</span>
        </span>
      )}
      {n > 1 && (
        <span
          className="flex shrink-0 items-center gap-1 text-[length:var(--fs-2xs)] text-[var(--text-muted)]"
          aria-hidden="true"
        >
          <Icon name="users" size={11} stroke={1.8} />
          <span className="num">{n}</span>
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Attendee row sub-components — internal attendees get their per-user color
// avatar (resolved via roster email lookup); external attendees fall back to
// initials from name/email. Both rows show response status as a badge.
// ---------------------------------------------------------------------------
function initialsFrom(text) {
  if (!text) return "··";
  const parts = text.replace(/[^A-Za-z\s]/g, "").trim().split(/\s+/);
  const a = parts[0]?.[0] || "";
  const b = parts[1]?.[0] || "";
  return (a + b).toUpperCase() || (text[0] || "·").toUpperCase();
}

function ResponseBadge({ chip }) {
  return (
    <Badge tone={RESPONSE_TONE[chip.cls] || "neutral"} size="sm" dot className="shrink-0">
      {chip.label}
    </Badge>
  );
}

const ATT_ROW = "flex min-w-0 items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5";

function InternalAttendeeRow({ attendee, rosterUser }) {
  const chip = responseChip(attendee.response);
  const initials = rosterUser?.initials || initialsFrom(attendee.name || attendee.email);
  // Someone on the roster wears the same swatch they wear on the grid; anyone
  // else falls back to the neutral ramp rather than borrowing a colour.
  const style = rosterUser ? identityVars(rosterUser.id) : NEUTRAL_IDENT;
  return (
    <div className={`${IDENT} ${ATT_ROW}`} style={style}>
      <Swatch initials={initials} className="size-6 text-[10px]" />
      <span className="min-w-0 flex-1 truncate text-[length:var(--fs-sm)] text-[var(--text)]">
        {rosterUser?.name || attendee.name || attendee.email.split("@")[0]}
      </span>
      {rosterUser?.department && (
        <span className="hidden shrink-0 truncate text-[length:var(--fs-2xs)] text-[var(--text-muted)] xs:block">
          {rosterUser.department}
        </span>
      )}
      <ResponseBadge chip={chip} />
    </div>
  );
}

function ExternalAttendeeRow({ attendee }) {
  const chip = responseChip(attendee.response);
  const initials = initialsFrom(attendee.name || attendee.email);
  const name  = attendee.name || attendee.email.split("@")[0];
  const email = attendee.email;
  return (
    <div className={ATT_ROW}>
      <span
        className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-xs)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] text-[10px] font-semibold uppercase leading-none text-[var(--text-muted)]"
        aria-hidden="true"
      >
        {initials}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--fs-sm)] text-[var(--text)]">{name}</span>
        {email && (
          <span className="block truncate font-[family-name:var(--font-mono)] text-[length:var(--fs-2xs)] text-[var(--text-soft)]">
            {email}
          </span>
        )}
      </span>
      <ResponseBadge chip={chip} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only event dialog. Built on the kit's Radix `Dialog`, so focus
// trapping, Escape, click-outside and the mobile bottom-sheet layout are all
// handled by the primitive rather than hand-rolled here.
// ---------------------------------------------------------------------------
function EventPopover({ event, onClose }) {
  // Roster lookup by lowercased email so internal attendees pick up the same
  // color they have everywhere else in the Team Calendar.
  const usersByEmail = useMemo(() => {
    const m = new Map();
    for (const u of getUsers()) {
      if (u.email) m.set(u.email.toLowerCase(), u);
    }
    return m;
  }, []);

  if (!event) return null;
  const r = event.resource;
  const sameDay = event.start.toDateString() === event.end.toDateString();
  const dateLabel = format(event.start, "EEEE · MMMM d, yyyy");
  const timeLabel = r.isAllDay
    ? "All day"
    : sameDay
      ? `${fmtTime(event.start)} – ${fmtTime(event.end)}`
      : `${format(event.start, "MMM d, h:mma")} → ${format(event.end, "MMM d, h:mma")}`;
  const minutes = Math.max(0, differenceInMinutes(event.end, event.start));
  const durLabel = r.isAllDay ? "" :
    minutes >= 60
      ? `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)} hr`
      : `${minutes} min`;

  // Partition + sort attendees. Internal first (resolved against roster so we
  // get colors + departments), external second. Within each group, organizer
  // → accepted → tentative → no response → declined.
  const allAttendees = (r.attendees || []).filter(a => a?.email);
  const sortByResp = (a, b) =>
    (responseChip(a.response).sort - responseChip(b.response).sort) ||
    (a.name || a.email).localeCompare(b.name || b.email);
  const internal = allAttendees
    .filter(a => INTERNAL_EMAIL_RE.test(a.email))
    .sort(sortByResp)
    .map(a => ({ ...a, _rosterUser: usersByEmail.get(a.email.toLowerCase()) }));
  const external = allAttendees
    .filter(a => !INTERNAL_EMAIL_RE.test(a.email))
    .sort(sortByResp);
  const totalAttendees = internal.length + external.length;

  // Subject-missing reason hint — surfaced inline in the title area so the
  // user knows WHY the title is generic and isn't a sync glitch.
  const subjectMissing = !(r.subject || "").trim();
  const missingReason =
    r.sensitivity === "private"      ? "Owner marked this private."
  : r.sensitivity === "confidential" ? "Owner marked this confidential."
  : subjectMissing                    ? "No title set in Outlook."
  : null;

  const ownerStyle = ownerIdentity(r).style;
  const owners = mergedOwners(r);

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      {/* No aria-describedby: the body is a structured metadata list, not a
          single sentence, so a description would just repeat the title. */}
      <DialogContent
        size="md"
        className={IDENT}
        style={ownerStyle}
        aria-describedby={undefined}
      >
        {/* Owner colour rides the top edge of the sheet, so the dialog is
            visibly "the same person" as the block that opened it. Same 3px
            rule as an event block, same token. */}
        <span
          className="absolute inset-x-0 top-0 h-[3px] bg-[var(--u-key)]"
          aria-hidden="true"
        />
        <DialogHeader className="pt-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={r.isCancelled ? "danger" : "neutral"} size="sm">
              {r.isCancelled ? "Cancelled" : "Calendar event"}
            </Badge>
            <Badge tone="outline" size="sm">Read only</Badge>
          </div>
          <DialogTitle className={r.isCancelled ? "line-through decoration-1" : undefined}>
            {event.title}
          </DialogTitle>
          {missingReason && !r.isCancelled && (
            <p className="m-0 text-[length:var(--fs-2xs)] text-[var(--text-soft)]">
              {missingReason}
            </p>
          )}
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {r.isCancelled && (
            <Alert tone="danger">This meeting was cancelled in Outlook.</Alert>
          )}

          <dl className="m-0 grid grid-cols-[minmax(0,68px)_minmax(0,1fr)] gap-x-3 gap-y-2.5">
            <dt className="m-0 pt-px text-[length:var(--fs-2xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
              When
            </dt>
            <dd className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-sm)] text-[var(--text)]">
              <span>{dateLabel}</span>
              <span className="num font-[family-name:var(--font-mono)] text-[length:var(--fs-xs)] text-[var(--text-muted)]">
                {timeLabel}
              </span>
              {durLabel && <Badge tone="neutral" size="sm" className="num">{durLabel}</Badge>}
            </dd>

            {r.location && (
              <>
                <dt className="m-0 pt-px text-[length:var(--fs-2xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
                  Where
                </dt>
                <dd className="m-0 flex min-w-0 items-center gap-1.5 text-[length:var(--fs-sm)] text-[var(--text)]">
                  <Icon name="pin" size={13} stroke={2} className="shrink-0 text-[var(--text-soft)]" />
                  <span className="min-w-0 break-words">{r.location}</span>
                </dd>
              </>
            )}

            <dt className="m-0 pt-px text-[length:var(--fs-2xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
              {owners ? "Owners" : "Owner"}
            </dt>
            {/* A merged all-day bar stands for one copy per attendee, so the
                dialog names every calendar it came off rather than only the
                first. Nothing is lost by the merge. */}
            <dd className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[length:var(--fs-sm)] text-[var(--text)]">
              {(owners
                ? owners.map(o => ({ ...o, style: identityVars(o.id) }))
                : [{ id: r.userId, ...ownerIdentity(r) }]
              ).map(o => (
                <span
                  key={o.id}
                  className={`${IDENT} flex min-w-0 items-center gap-2`}
                  style={o.style}
                >
                  <Swatch initials={o.initials} className="size-6 text-[10px]" />
                  <span className="min-w-0 truncate font-medium">{o.name}</span>
                </span>
              ))}
              {!owners && r._user?._department && (
                <span className="text-[length:var(--fs-2xs)] text-[var(--text-muted)]">
                  {r._user._department}
                </span>
              )}
            </dd>

            {r.organizer?.email && r.organizer.email.toLowerCase() !== (r._user?._email || "").toLowerCase() && (
              <>
                <dt className="m-0 pt-px text-[length:var(--fs-2xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
                  Organizer
                </dt>
                <dd className="m-0 min-w-0 break-words text-[length:var(--fs-sm)] text-[var(--text)]">
                  {r.organizer.name || r.organizer.email}
                </dd>
              </>
            )}
          </dl>

          {totalAttendees > 0 && (
            <section className="min-w-0">
              <div className="mb-1.5 flex items-baseline gap-2">
                <h3 className="m-0 text-[length:var(--fs-2xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
                  Attendees
                </h3>
                <span className="num text-[length:var(--fs-2xs)] font-semibold text-[var(--text-muted)]">
                  {totalAttendees}
                </span>
                <Separator className="ml-1 flex-1" />
              </div>

              <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-2)] p-1.5">
                {internal.length > 0 && (
                  <div className="min-w-0">
                    <p className="m-0 flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[length:var(--fs-2xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
                      <span>From MSMM</span>
                      <span className="num">{internal.length}</span>
                    </p>
                    {internal.map((a, i) => (
                      <InternalAttendeeRow
                        key={`int:${a.email}:${i}`}
                        attendee={a}
                        rosterUser={a._rosterUser}
                      />
                    ))}
                  </div>
                )}
                {external.length > 0 && (
                  <div className="min-w-0">
                    <p className="m-0 flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[length:var(--fs-2xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
                      <span>External</span>
                      <span className="num">{external.length}</span>
                    </p>
                    {external.map((a, i) => (
                      <ExternalAttendeeRow key={`ext:${a.email}:${i}`} attendee={a} />
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}
        </DialogBody>

        <DialogFooter className="sm:justify-between">
          {r.outlookWebLink ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={r.outlookWebLink} target="_blank" rel="noopener noreferrer">
                <Icon name="external" size={14} stroke={2} />
                <span>Open in Outlook</span>
              </a>
            </Button>
          ) : (
            <span className="hidden sm:block" />
          )}
          <Button variant="default" size="sm" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The day list behind a week cell.
//
// The week matrix answers "is this person around" with a strip and a figure.
// The follow-up question, "around doing what", is one click away: the cell
// opens this list, and every row opens the same read-only detail dialog a day
// block would. A Dialog rather than a Popover because the trigger is one cell
// of a 112-cell table that re-renders on every navigation, so there is no
// stable node for a popover to anchor to.
// ---------------------------------------------------------------------------
function DayListRow({ event, onOpen }) {
  const r = event.resource || {};
  const n = attendeeCount(r);
  return (
    <button
      type="button"
      onClick={() => onOpen(event)}
      style={ownerIdentity(r).style}
      className={[
        IDENT,
        "flex w-full min-w-0 items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-2 text-left",
        "border border-transparent",
        "transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]",
        "hover:border-[var(--border)] hover:bg-[var(--surface-2)]",
        "active:bg-[var(--surface-3)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]",
      ].join(" ")}
    >
      <Swatch initials={ownerIdentity(r).initials} className="size-6 shrink-0 text-[10px]" />
      <span className="min-w-0 flex-1">
        <span
          className={[
            "block truncate text-[length:var(--fs-sm)] font-medium text-[var(--text)]",
            r.isCancelled ? "line-through" : "",
          ].join(" ")}
        >
          {event.title}
        </span>
        <span className="block truncate text-[length:var(--fs-2xs)] text-[var(--text-muted)]">
          <span className="num">{fmtTime(event.start)} – {fmtTime(event.end)}</span>
          {` · ${ownerIdentity(r).name}`}
          {r.location ? ` · ${r.location}` : ""}
        </span>
      </span>
      {n > 1 && (
        <span className="flex shrink-0 items-center gap-1 text-[length:var(--fs-2xs)] text-[var(--text-muted)]">
          <Icon name="users" size={11} stroke={1.8} />
          <span className="num">{n}</span>
        </span>
      )}
      <Icon name="chevronRight" size={14} stroke={2} className="shrink-0 text-[var(--text-soft)]" />
    </button>
  );
}

function DayListDialog({ group, onOpenEvent, onClose }) {
  if (!group) return null;
  const list = [...group.events].sort(
    (a, b) => a.start - b.start || String(a.title).localeCompare(String(b.title))
  );
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md" aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral" size="sm" className="num">
              {list.length} {list.length === 1 ? "event" : "events"}
            </Badge>
            <Badge tone="outline" size="sm">Read only</Badge>
          </div>
          <DialogTitle>{group.heading}</DialogTitle>
          <p className="m-0 text-[length:var(--fs-2xs)] text-[var(--text-soft)]">
            Everything on this day. Pick one to see its full detail.
          </p>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-0.5">
          {list.map(ev => (
            <DayListRow key={ev.id} event={ev} onOpen={onOpenEvent} />
          ))}
        </DialogBody>
        <DialogFooter>
          <Button variant="default" size="sm" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Custom toolbar — date nav + view switch + manual refresh.
//
// The refresh button does two different jobs based on role:
//   • Admin → kicks the outlook-sync Edge Function (pulls fresh delta from
//             Microsoft Graph), then re-queries the DB.
//   • Non-admin → just re-queries the DB to pick up whatever the 15-min cron
//                 has already mirrored.
//
// Either way the freshness label updates to reflect the new fetch time.
// ---------------------------------------------------------------------------
function CalToolbar({
  label, onNavigate, onView, view, viewsAvailable, eventCount, peopleOn,
  onRefresh, syncing, isAdmin, lastRefreshedAt, nowMs, refreshError,
}) {
  const freshness = lastRefreshedAt
    ? `Updated ${timeAgo(lastRefreshedAt, nowMs)}`
    : "Not refreshed yet";
  const refreshHint = isAdmin
    ? "Pull the latest events from Outlook for every selected person"
    : "Reload events from the most recent sync";
  const refreshLabel = syncing ? (isAdmin ? "Syncing…" : "Refreshing…") : "Refresh";

  return (
    <div className="bx-teamcal-toolbar flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
      <div className="min-w-0 flex-1 basis-[min(100%,220px)]">
        <h2 className="m-0 truncate font-[family-name:var(--font-display)] text-[length:var(--fs-lg)] font-semibold leading-[var(--lh-tight)] tracking-[var(--tracking-tight)] text-[var(--text)]">
          {label}
        </h2>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[length:var(--fs-2xs)] text-[var(--text-muted)]">
          <span>
            <span className="num font-semibold text-[var(--text)]">{peopleOn}</span> on view
          </span>
          <span aria-hidden="true" className="text-[var(--text-soft)]">·</span>
          <span>
            <span className="num font-semibold text-[var(--text)]">{eventCount}</span>{" "}
            {eventCount === 1 ? "event" : "events"} in range
          </span>
          <span aria-hidden="true" className="text-[var(--text-soft)]">·</span>
          {refreshError ? (
            <Badge tone="danger" size="sm" dot>Refresh failed</Badge>
          ) : (
            // A `title` rather than a Tooltip: the trigger is inert text, and
            // wrapping it in a Radix trigger would make it a tab stop that
            // does nothing.
            <span
              className={syncing ? "text-[var(--accent)]" : undefined}
              aria-live="polite"
              title={lastRefreshedAt ? lastRefreshedAt.toLocaleString() : undefined}
            >
              {syncing ? "Refreshing…" : freshness}
            </span>
          )}
        </div>
      </div>

      <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
        <div className="flex items-center gap-0.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-0.5 shadow-[var(--shadow-xs)]">
          <Tooltip label="Previous">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous period"
              onClick={() => onNavigate("PREV")}
            >
              <Icon name="chevronLeft" size={16} stroke={2} />
            </Button>
          </Tooltip>
          <Button variant="ghost" size="sm" onClick={() => onNavigate("TODAY")}>
            Today
          </Button>
          <Tooltip label="Next">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next period"
              onClick={() => onNavigate("NEXT")}
            >
              <Icon name="chevronRight" size={16} stroke={2} />
            </Button>
          </Tooltip>
        </div>

        {viewsAvailable.length > 1 && (
          <Tabs value={view} onValueChange={(v) => onView(v)}>
            <TabsList variant="segmented" aria-label="Calendar view">
              {viewsAvailable.map(v => (
                <TabsTrigger key={v} value={v}>{VIEW_LABEL[v]}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        <Tooltip label={refreshHint}>
          <Button
            variant="subtle"
            size="sm"
            onClick={onRefresh}
            disabled={syncing}
            aria-label={refreshLabel}
          >
            <Icon
              name={syncing ? "spinner" : "refresh"}
              size={14}
              stroke={2}
              className={syncing ? "animate-spin" : undefined}
            />
            <span className="hidden xs:inline">{refreshLabel}</span>
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty / loading states.
//
// Glyph adapters are hoisted to module scope: EmptyState takes a component,
// and an inline arrow would be a fresh component type on every render.
// ---------------------------------------------------------------------------
const CalendarGlyph = (p) => <Icon name="calendarDays" {...p} />;
const ClockGlyph    = (p) => <Icon name="calendarClock" {...p} />;

const NO_EVENTS_TITLE = "Nothing booked in this range";
const NO_EVENTS_BODY  =
  "None of the selected colleagues has an event here. Move to another date, or add more people from the People picker.";

// Overlay shown over an empty grid. Pointer-events stay off the wrapper so
// the toolbar and the date cells underneath remain clickable.
function GridOverlay({ children }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[6] grid place-items-center p-4">
      <div className="w-full max-w-[400px]">{children}</div>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-md)]">
      <p className="m-0 flex items-center gap-2 text-[length:var(--fs-sm)] font-medium text-[var(--text)]">
        <Icon name="spinner" size={15} stroke={2} className="animate-spin text-[var(--accent)]" />
        <span>Loading calendars</span>
      </p>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level tab component.
// ---------------------------------------------------------------------------
export function TeamCalendarTab() {
  const isMobile = useIsMobile();
  const rosterAll = getUsers();

  // adaptUser carries department/location/email/isEnabled as first-class
  // fields. We project to the underscored aliases the renderers below use so
  // the renderer code stays stable if the source shape ever shifts.
  const roster = useMemo(() => {
    return rosterAll
      .filter(u => u.isEnabled !== false)
      .map(u => ({
        ...u,
        _department: u.department || "",
        _location:   u.location   || "",
        _email:      u.email      || "",
      }));
  }, [rosterAll]);

  // Default selection: just the Engineering department. Falls back to all
  // internal users if Engineering happens to be empty (e.g., dev seed data),
  // and finally to the entire roster. The Team Calendar's people picker can
  // always widen the view from here — this only seeds the initial state.
  const defaultIds = useMemo(() => {
    const dept = DEFAULT_DEPARTMENT.toLowerCase();
    const eng = roster.filter(u => (u._department || "").toLowerCase() === dept);
    if (eng.length > 0) return eng.map(u => u.id);
    const internal = roster.filter(u => !u._email || INTERNAL_EMAIL_RE.test(u._email));
    return (internal.length > 0 ? internal : roster).map(u => u.id);
  }, [roster]);

  const [selected, setSelected] = useState(() => {
    const stored = lsRead(LS_SELECTED, null);
    if (Array.isArray(stored)) return new Set(stored);
    return new Set(defaultIds);
  });

  // Persist selection so the choice survives reloads.
  useEffect(() => { lsWrite(LS_SELECTED, Array.from(selected)); }, [selected]);

  const [view, setView] = useState(() => {
    const v = lsRead(LS_VIEW, "week");
    return ["month", "week", "day", "agenda"].includes(v) ? v : "week";
  });
  useEffect(() => { lsWrite(LS_VIEW, view); }, [view]);

  const [date, setDate] = useState(new Date());
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [popoverEvent, setPopoverEvent] = useState(null);
  // One person's day, while the week cell's list dialog is open.
  const [dayList, setDayList] = useState(null);

  // Manual refresh wiring. `refreshKey` increments to force the loader effect
  // to re-run even when selected/view/date haven't changed. `syncing` is true
  // while we await the Outlook Edge Function (admin path); `loading` covers
  // the DB re-query. `lastRefreshedAt` powers the "Updated Xm ago" label.
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const admin = getIsAdmin();

  // Re-render the freshness label every 30 seconds so "X ago" stays current
  // even when the user is staring at the screen without interacting.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Refresh handler. For admins, kick the outlook-sync Edge Function first
  // (pulls fresh delta from Microsoft Graph into beacon_v2.user_calendar_events)
  // then re-query the DB. For non-admins, just re-query — the cron job runs
  // every 15 minutes regardless, so a DB reload is enough to pick up anything
  // the latest tick already mirrored.
  const handleRefresh = async () => {
    if (syncing || loading) return;
    setRefreshError(null);
    setSyncing(true);
    try {
      if (admin) {
        await runOutlookSyncNow();
      }
      // Always bump the refresh key — both paths need the DB re-query.
      setRefreshKey(k => k + 1);
    } catch (err) {
      const msg = err?.message || "Refresh failed";
      setRefreshError(msg);
      console.error("[TeamCalendar] refresh failed:", err);
      // Auto-clear the inline error after 6s so it doesn't linger forever.
      setTimeout(() => setRefreshError(null), 6_000);
    } finally {
      setSyncing(false);
    }
  };

  // Build a lookup map id → roster entry once per roster change.
  const userById = useMemo(() => {
    const m = new Map();
    for (const u of roster) m.set(u.id, u);
    return m;
  }, [roster]);

  // Load events whenever the selection / view / date window changes — or when
  // the manual refresh handler bumps `refreshKey` to force a re-fetch without
  // changing any of those inputs.
  useEffect(() => {
    let cancelled = false;
    if (selected.size === 0) { setEvents([]); return; }
    const { start, end } = windowForView(date, view);
    setLoading(true);
    loadTeamCalendarEvents(Array.from(selected), start, end)
      .then(rows => {
        if (cancelled) return;
        setEvents(rows);
        setLastRefreshedAt(new Date());
      })
      .catch(err => {
        if (cancelled) return;
        console.error("[TeamCalendar] load failed:", err);
        setEvents([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selected, view, date, refreshKey]);

  // Build the event array. Attach `_user` so renderers can read initials/name
  // without a Map lookup on every paint. One entry per row: this is the list
  // the lane views place, and it is why every input event lands in exactly one
  // lane, its owner's.
  const laneEvents = useMemo(() => {
    return events.map(r => {
      const start = new Date(r.startAt);
      const end   = new Date(r.endAt);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
      const u = userById.get(r.userId);
      const enriched = { ...r, _user: u };
      return {
        id: `${r.userId}:${r.outlookEventId}`,
        title: smartTitle(enriched),
        start, end,
        allDay: r.isAllDay,
        resource: enriched,
      };
    }).filter(Boolean);
  }, [events, userById]);

  // The AGENDA is the one view that still shares a single stream between
  // everybody, so it is the one view where a shared all-day event arriving
  // once per attendee would print four identical rows. The merge folds those
  // into a single row wearing every owner's initials. It is applied here and
  // nowhere else: the lane views give each owner their own row already, so
  // merging there would take a person's own vacation off their own lane.
  const agendaEvents = useMemo(() => mergeAllDayEvents(laneEvents), [laneEvents]);

  // Events "in range" counts what the calendars actually hold, which is the
  // unmerged list. Comparing it against the merged bars' `_members` totals is
  // the merge's losslessness invariant.
  const eventTotal = laneEvents.length;

  // ---- lanes -------------------------------------------------------------
  // One lane per selected person, in roster order, plus a lane for any owner
  // who has events in range but is no longer on the roster (a disabled user
  // whose id is still in the saved selection). Without that second pass an
  // event could arrive with nowhere to go; with it, `bucketByOwner` places
  // every single event, and every selected person is a lane exactly once.
  const lanes = useMemo(() => {
    const built = [];
    const seen = new Set();
    for (const u of roster) {
      if (!selected.has(u.id)) continue;
      seen.add(u.id);
      built.push({
        id: u.id,
        name: u.name,
        initials: u.initials || "?",
        identity: identityVars(u.id),
      });
    }
    for (const ev of laneEvents) {
      const id = ev.resource?.userId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      built.push({
        id,
        name: UNKNOWN_OWNER,
        initials: "?",
        identity: NEUTRAL_IDENT,
      });
    }
    return built;
  }, [roster, selected, laneEvents]);

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setSelected(new Set(roster.map(u => u.id)));
  const clearAll  = () => setSelected(new Set());
  const setMany   = (ids) => setSelected(new Set(ids));

  const eventPropGetter = (event) => {
    // The wrapper class kills RBC's default blue tile so our renderers fully
    // own the visual row. Only the agenda still runs through this.
    return { className: "tcal-evt-wrap" };
  };

  const dayPropGetter = (d) => {
    const t = new Date();
    const isToday =
      d.getFullYear() === t.getFullYear() &&
      d.getMonth()    === t.getMonth() &&
      d.getDate()     === t.getDate();
    return isToday ? { className: "cal-day-today" } : {};
  };

  const effectiveView = isMobile ? "agenda" : view;
  const viewsAvailable = isMobile ? ["agenda"] : DESKTOP_VIEWS;

  // ---- event activation -------------------------------------------------
  // One route for every way an event can be opened: a lane block, an agenda
  // row, or a row of the week cell's day list.
  const openEvent = useCallback((e) => {
    setDayList(null);
    setPopoverEvent(e);
  }, []);

  // A week cell hands over its person + day so the list can name itself.
  const openDayList = useCallback((group) => {
    setPopoverEvent(null);
    setDayList(group);
  }, []);

  const nothingSelected = selected.size === 0;
  const firstLoad  = !nothingSelected && loading && laneEvents.length === 0;

  // The overlay is now the FIRST LOAD only. An empty range used to need a
  // card explaining itself because an empty time grid says nothing; a lane
  // view says it perfectly well on its own, with a row per person reading
  // "Nothing booked" and a per-day tally of nought. Covering that up with a
  // card would hide the answer to make room for a restatement of it. The
  // agenda still gets rbc's own `noEventsInRange` slot, which is a list and
  // therefore genuinely blank when empty.
  const showGridOverlay = effectiveView !== "agenda" && firstLoad;

  return (
    <TooltipProvider delayDuration={250}>
      <div className="bx-teamcal flex min-w-0 flex-col gap-4" data-view={effectiveView}>
        <PeopleBar
          users={roster}
          selected={selected}
          onToggle={toggle}
          onSelectAll={selectAll}
          onClearAll={clearAll}
          onSetMany={setMany}
        />

        {refreshError && (
          <Alert tone="danger" title="Could not refresh from Outlook">
            {refreshError}
          </Alert>
        )}

        {nothingSelected ? (
          <EmptyState
            icon={CalendarGlyph}
            title="No colleagues selected"
            description="Open the People picker and choose whose Outlook calendars to show. Everyone you pick gets their own row, so nobody's events land on top of anybody else's."
            action={
              <Button variant="primary" size="sm" onClick={selectAll}>
                Show everyone
              </Button>
            }
          />
        ) : (
          <div
            className="relative min-w-0 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-xs)]"
            aria-busy={loading || undefined}
          >
            <div className="min-w-0">
              <Calendar
                localizer={localizer}
                // The agenda is the only view still fed by rbc's own event
                // pipeline, so it gets the all-day-merged stream. The lane
                // views read `laneEvents`, one entry per calendar row.
                events={agendaEvents}
                laneEvents={laneEvents}
                laneUsers={lanes}
                onOpenDayList={openDayList}
                view={effectiveView}
                onView={(v) => { if (!isMobile) setView(v); }}
                date={date}
                onNavigate={setDate}
                startAccessor="start"
                endAccessor="end"
                // Month, week and day are this page's own components; agenda
                // is react-big-calendar's. `Calendar` still owns navigation,
                // the toolbar, the view switch and event activation for all
                // four, and each custom view carries the same `navigate`,
                // `range` and `title` statics the library view it replaces did.
                views={{
                  month:  TeamMonth,
                  week:   WeekMatrix,
                  day:    DayLanes,
                  agenda: true,
                }}
                eventPropGetter={eventPropGetter}
                dayPropGetter={dayPropGetter}
                popup
                // Read-only: NO selectable, NO onSelectSlot, NO drag/drop.
                selectable={false}
                components={{
                  toolbar: (props) => (
                    <CalToolbar
                      {...props}
                      viewsAvailable={viewsAvailable}
                      eventCount={eventTotal}
                      peopleOn={selected.size}
                      onRefresh={handleRefresh}
                      syncing={syncing || loading}
                      isAdmin={admin}
                      lastRefreshedAt={lastRefreshedAt}
                      nowMs={nowMs}
                      refreshError={refreshError}
                    />
                  ),
                  agenda: { event: AgendaRow },
                }}
                onSelectEvent={openEvent}
                formats={{
                  monthHeaderFormat:    (d, _c, l) => l.format(d, "MMMM yyyy"),
                  dayHeaderFormat:      (d, _c, l) => l.format(d, "EEEE · MMM d"),
                  dayRangeHeaderFormat: ({ start, end }, _c, l) =>
                    `${l.format(start, "MMM d")} – ${l.format(end, "MMM d, yyyy")}`,
                  weekdayFormat:        (d, _c, l) => l.format(d, "EEE").toUpperCase(),
                  dayFormat:            (d, _c, l) =>
                    `${l.format(d, "EEE").toUpperCase()} · ${l.format(d, "d")}`,
                  timeGutterFormat:     (d, _c, l) =>
                    d.getMinutes() === 0
                      ? l.format(d, "h a").toLowerCase().replace(" ", "")
                      : "",
                  eventTimeRangeFormat: ({ start, end }, _c, l) =>
                    `${l.format(start, "h:mma").toLowerCase()} – ${l.format(end, "h:mma").toLowerCase()}`,
                  agendaTimeFormat:     (d, _c, l) => l.format(d, "h:mma").toLowerCase(),
                  agendaDateFormat:     (d, _c, l) => l.format(d, "EEE MMM d"),
                  agendaHeaderFormat:   ({ start, end }, _c, l) =>
                    `${l.format(start, "MMM d")} – ${l.format(end, "MMM d, yyyy")}`,
                }}
                messages={{
                  noEventsInRange: loading ? (
                    <span className="block px-1 py-4 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
                      Loading calendars…
                    </span>
                  ) : (
                    <EmptyState
                      compact
                      icon={ClockGlyph}
                      title={NO_EVENTS_TITLE}
                      description={NO_EVENTS_BODY}
                    />
                  ),
                }}
                length={30}
              />
            </div>

            {showGridOverlay && (
              <GridOverlay>
                <LoadingCard />
              </GridOverlay>
            )}
          </div>
        )}

        {dayList && (
          <DayListDialog
            group={dayList}
            onOpenEvent={openEvent}
            onClose={() => setDayList(null)}
          />
        )}

        {popoverEvent && (
          <EventPopover event={popoverEvent} onClose={() => setPopoverEvent(null)} />
        )}
      </div>
    </TooltipProvider>
  );
}

export default TeamCalendarTab;
