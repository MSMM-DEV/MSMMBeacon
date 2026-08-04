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
// The chrome is built entirely from the Beacon kit in `@/ui`. react-big-
// calendar's own grid internals cannot be reached with utility classes, so
// they are themed in ONE clearly-bannered block in src/styles.css, scoped
// under `.bx-teamcal` (the root element rendered below). That same block also
// owns this page's `.bxtc-*` event and swatch skins, which cannot live under
// `.bx-teamcal` because the event dialog is portalled to <body>.
//
// Per-person colour is DELIBERATELY QUIET. A week with twenty colleagues on
// it puts a hundred blocks on screen, so the hue is confined to a 3px left
// rule, a small initials tile and an all-day outline; the block body is a
// near-neutral wash and the type is Beacon's. Colour is also never the only
// signal: every chip, block, agenda row and legend entry carries the owner's
// initials, and the legend spells out the full name next to the swatch.
// =============================================================================

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  getUsers, loadTeamCalendarEvents,
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
// Per-person colour, the initials tile and two formatters. Shared with the
// lane layout, so they live in a module neither layout owns.
import {
  EMPTY, IDENT, NEUTRAL_IDENT, UNKNOWN_OWNER, Swatch,
  identityVars, fmtTime, attendeeCount,
} from "./team-calendar-shared.jsx";
import {
  DayLanes, WeekMatrix, TeamMonth, DayListDialog,
} from "./team-calendar-lanes.jsx";

const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({
  format, parse,
  startOfWeek: (d) => startOfWeek(d, { weekStartsOn: 0 }),
  getDay, locales,
});

const VIEW_LABEL = { month: "Month", week: "Week", day: "Day", agenda: "Agenda" };
const DESKTOP_VIEWS = ["month", "week", "day", "agenda"];

// ----- Layout ---------------------------------------------------------------
// Two ways of drawing the same loaded events, chosen by the user rather than
// picked for them, because the two answer different questions and which one
// is wanted depends on what is being asked.
//
//   grid   the familiar calendar: one shared time axis per day, everybody
//          stacked into it. Best for "what is happening at 10am" and for
//          reading one or two people closely.
//   people one row per person, time across. Best for "who is free at 10am":
//          a lane holds exactly one calendar, so blocks only compete when
//          somebody is genuinely double-booked. Holds up as the roster grows,
//          where the shared grid's day column has to divide by the number of
//          people busy at once.
//
// Only month/week/day differ. Agenda is react-big-calendar's own in both, and
// so is every navigation control, which is why switching never changes the
// date, the view, the selection or what has been loaded.
const CAL_LAYOUTS = [
  { id: "grid",   label: "Grid",   icon: "calendarDays",
    hint: "Shared time grid, everyone overlaid" },
  { id: "people", label: "People", icon: "users",
    hint: "One row per person, time across" },
];
const LAYOUT_IDS = CAL_LAYOUTS.map(l => l.id);

// LocalStorage keys — namespaced so they don't collide with other tabs.
// .v2 suffix on the selection key forces a fresh "Engineering by default"
// roll-out for users who'd previously saved the all-internal default.
const LS_SELECTED   = "beacon.teamCalendar.selectedUserIds.v2";
const LS_VIEW       = "beacon.teamCalendar.view";
const LS_LAYOUT     = "beacon.teamCalendar.layout";

// Department name used to anchor the default selection. Stored verbatim in
// beacon_v2.users.department; case-insensitive match below.
const DEFAULT_DEPARTMENT = "Engineering";

const INTERNAL_EMAIL_RE = /@msmmeng\.com$/i;

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
// | 'unknown'. Used as the fallback below when the row has no subject.
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
  // all. Those rows only ever captured a person and a time range, so the one
  // thing we can say truthfully is that the person is occupied. "Untitled
  // event" implies a title went missing from an otherwise-complete record,
  // which misdescribes the data.
  return "Busy";
}

// ---------------------------------------------------------------------------
// Week / day column layout.
//
// react-big-calendar ships two layout algorithms and neither survives sixteen
// overlaid calendars:
//
//   `overlap`     gives every concurrent event an equal share of the column
//                 and then widens each one to 1.7x that share so blocks
//                 deliberately sit on top of each other. Columns therefore
//                 never divide evenly, no block ends flush with the day's
//                 right edge, and at real density the share is a few pixels.
//   `no-overlap`  divides evenly with a 3px gutter (good) but subtracts 2px
//                 from every block's height, so no block ends on its time
//                 boundary (bad), and it still divides a 131px column by the
//                 concurrency count, so twelve at once is 11px each.
//
// Both produced the unlabelled bordered slivers: a block's identity rule,
// hairline and padding come to more than its whole width, so `overflow:hidden`
// ate the label and left an empty box.
//
// This is the traditional third option, the one Outlook and Google reach for
// when a slot is crowded: divide evenly while the columns still clear a
// measured legibility floor, and cascade past that point so every block keeps
// its left edge, its colour rule and its initials, and stays clickable.
//
// EVT_MIN_PX is that floor, and it is measured rather than chosen: rendered in
// the roster font at --fs-2xs/700, the widest two-letter monogram ("WM") is
// 20.7px, or 20.3px once the sub-floor tier drops the tracking. The sub-floor
// block skin in styles.css spends 3px on the identity rule and 1px of padding
// and gives up its right-hand hairline, so 3 + 1 + 20.3 = 24.3px of demand,
// rounded to 26px. That is the narrowest a block can be and still name its
// owner; below it there is nothing left to say.
const EVT_MIN_PX    = 26;
// Gap between evenly-divided columns. Consistent by construction: it is the
// only px term in the width expression.
const EVT_GUTTER_PX = 2;

/**
 * Build a `dayLayoutAlgorithm` for a known day-column width.
 *
 * `colPx` is the measured inner width of one day column (0 before the first
 * measurement lands, which simply means "assume everything fits").
 *
 * Returns rbc's `{ event, style }` shape. `top` and `height` are passed
 * through as exact percentages of the day so a block's edges land on its time
 * boundaries; only the horizontal arrangement is ours.
 */
function makeDayLayout(colPx) {
  return function beaconDayLayout({ events, slotMetrics, accessors }) {
    if (!events || events.length === 0) return [];

    const items = events.map((event) => {
      const r = slotMetrics.getRange(accessors.start(event), accessors.end(event));
      return { event, top: r.top, height: r.height, start: r.start, end: r.end };
    });
    // Earliest first; longer of two equal starts first, so the block a
    // neighbour is nested inside is the one on the left.
    items.sort((a, b) => (a.start - b.start) || (b.end - a.end) || 0);

    // Greedy interval-graph colouring. Scanning by start time makes the greedy
    // choice optimal, so `cols` is exactly the peak concurrency of the cluster
    // rather than the inflated count rbc's container/row grouping produces.
    // A cluster ends the moment an event starts after everything before it.
    const clusters = [];
    let cur = null;
    for (const it of items) {
      if (!cur || it.start >= cur.end) {
        cur = { items: [], colEnds: [], end: -Infinity };
        clusters.push(cur);
      }
      let c = cur.colEnds.findIndex((e) => e <= it.start);
      if (c === -1) { c = cur.colEnds.length; cur.colEnds.push(it.end); }
      else cur.colEnds[c] = it.end;
      it.col = c;
      cur.items.push(it);
      if (it.end > cur.end) cur.end = it.end;
    }

    // How many blocks can sit side by side and still clear the floor.
    const capacity = colPx > 0
      ? Math.max(1, Math.floor((colPx + EVT_GUTTER_PX) / (EVT_MIN_PX + EVT_GUTTER_PX)))
      : Infinity;

    const out = [];
    for (const cl of clusters) {
      const cols = cl.colEnds.length;
      const cascade = cols > capacity;
      // Paint order is array order, so leftmost first leaves the cascade's
      // later columns on top and every earlier block's left edge exposed.
      cl.items.sort((a, b) => a.col - b.col);

      for (const it of cl.items) {
        const i = it.col;
        let width = "100%";
        let xOffset = "0%";
        if (cols > 1 && !cascade) {
          // Even columns: `cols` equal shares separated by exactly one gutter.
          // The expression is percentage-based, so the last column's right
          // edge is the container's right edge to the sub-pixel.
          const g = (cols - 1) * EVT_GUTTER_PX;
          width   = `calc((100% - ${g}px) / ${cols})`;
          xOffset = `calc((100% - ${g}px) * ${i} / ${cols} + ${i * EVT_GUTTER_PX}px)`;
        } else if (cascade) {
          // Cascade. Every block in the fan is the SAME width, never below
          // the floor, and the fan spans exactly the column: block i sits at
          // i/(cols-1) of the leftover space, so block 0 starts on the left
          // edge and the last block ends on the right one. Once the floor
          // bites, consecutive blocks overlap by (floor - step) and each one
          // shows the step-wide left edge that carries its rule and initials,
          // which is how Outlook and Google draw a slot this crowded.
          //
          // Width is the block's OWN box, not a slab reaching the far edge:
          // a block wider than the sliver its neighbour leaves it would lay
          // out a title and a time it cannot show, and the visible fragment
          // of that is half a word, which is worse than the initials alone.
          const w = `max(${EVT_MIN_PX}px, 100% / ${cols})`;
          width   = w;
          xOffset = `calc((100% - ${w}) * ${i} / ${cols - 1})`;
        }
        out.push({
          event: it.event,
          style: { top: it.top, height: it.height, width, xOffset },
        });
      }
    }
    return out;
  };
}

/**
 * Measured inner width of one day column, for the layout above. Read from the
 * live grid rather than computed, so the gutter, the hairlines and whatever
 * the shell is doing to the page width are all already accounted for.
 */
function useDayColumnWidth(ref, deps) {
  const [colPx, setColPx] = useState(0);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || typeof ResizeObserver === "undefined") return undefined;
    let raf = 0;
    const read = () => {
      const c = root.querySelector(".rbc-day-slot .rbc-events-container");
      const w = c ? c.getBoundingClientRect().width : 0;
      // Only react to real changes; the layout never feeds back into the
      // column width, so this settles after one pass.
      if (w > 0) setColPx((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    };
    read();
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(read);
    });
    ro.observe(root);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return colPx;
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
// Event renderers — month/agenda use a compact pill, week/day use a full
// time-block that fills the absolutely-positioned rbc-event slot so a
// 10:00–15:00 event visually spans those five rows in the grid.
//
// Every renderer clips: the outer element is `overflow-hidden` and the title
// truncates, so a long subject can never spill past its slot.
// ---------------------------------------------------------------------------
// `fmtTime` and `attendeeCount` come from team-calendar-shared.jsx; both
// layouts label a block the same way.

// Event skins live in the `.bxtc-evt*` rules in styles.css. Two reasons they
// are not utility strings: an event sets an all-round border colour AND a
// differently-coloured 3px left rule, and two competing Tailwind border
// utilities on one element resolve by generated source order rather than by
// the order they appear here; and the container queries that thin a block out
// on a narrow column have to be able to `display: none` a part, which a
// layered rule cannot do to an element carrying a display utility.

// react-big-calendar puts `role="button"` and the click handler on the element
// that WRAPS these renderers, so the block's accessible name is whatever text
// they leave in the DOM. On a narrow column the container queries hide the
// title and the initials tile is decorative, which would leave a focusable
// button with no name at all. Every renderer therefore states the block in
// full for a screen reader and marks the visual content decorative, so what is
// announced does not change as the column narrows.
function blockLabel(event) {
  const r = event.resource;
  const who = r._user?.name || "Unknown";
  const when = r.isAllDay
    ? "all day"
    : `${fmtTime(event.start)} to ${fmtTime(event.end)}`;
  const n = attendeeCount(r);
  return [
    who,
    event.title,
    when,
    r.location || null,
    n > 1 ? `${n} attendees` : null,
  ].filter(Boolean).join(", ");
}

function MonthPill({ event }) {
  const r = event.resource;
  const n = attendeeCount(r);
  return (
    <div
      className={`${IDENT} bxtc-evt bxtc-evt--pill`}
      data-allday={r.isAllDay ? "true" : undefined}
      data-cancelled={r.isCancelled ? "true" : undefined}
      style={identityVars(r.userId)}
    >
      <span className="sr-only">{blockLabel(event)}</span>
      <span className="bxtc-evt-initials" aria-hidden="true">
        {r._user?.initials || "··"}
      </span>
      <span className="bxtc-evt-title" aria-hidden="true">{event.title}</span>
      {n > 1 && (
        <span className="bxtc-tick" aria-hidden="true">+{n}</span>
      )}
    </div>
  );
}

function TimeBlock({ event }) {
  const r = event.resource;
  const minutes = Math.max(0, differenceInMinutes(event.end, event.start));
  // Density tiers control how much chrome we render inside the block, and the
  // thresholds come out of the row-height arithmetic rather than being round
  // numbers. At the grid's 52px hour a minute is 0.867px; a line of block text
  // is a 13px box, and above the "xs" tier the block also spends 2px on
  // hairlines, 4px on padding and 1px per gap. So one line fits in a
  // quarter-hour (13px, and the tier drops the padding to make it exact), two
  // need 33px (39 min) and three need 47px (55 min). Rounded to the slot
  // boundary above, that is 45 and 60 minutes. Below each threshold the block
  // DROPS the line rather than clipping it, which is what used to leave a
  // half-height row of text at the bottom of a short block.
  // That is the HEIGHT budget. The WIDTH budget is handled by the container
  // queries on `.rbc-event`, which drop the meta lines, then the title, and
  // finally the block's own hairline, leaving the owner's rule and initials.
  const density = minutes < 45 ? "xs" : minutes < 60 ? "sm" : "lg";
  const n = attendeeCount(r);
  return (
    <div
      className={`${IDENT} bxtc-evt bxtc-evt--block`}
      data-density={density}
      data-allday={r.isAllDay ? "true" : undefined}
      data-cancelled={r.isCancelled ? "true" : undefined}
      style={identityVars(r.userId)}
    >
      <span className="sr-only">{blockLabel(event)}</span>
      <span className="bxtc-evt-head" aria-hidden="true">
        <span className="bxtc-evt-initials">
          {r._user?.initials || "··"}
        </span>
        <span className="bxtc-evt-title">{event.title}</span>
        {density !== "xs" && n > 1 && (
          <span className="bxtc-tick" title={`${n} attendees`}>+{n}</span>
        )}
      </span>

      {density !== "xs" && (
        <span className="bxtc-evt-meta" aria-hidden="true">
          <span>{fmtTime(event.start)} – {fmtTime(event.end)}</span>
        </span>
      )}

      {density === "lg" && r.location && (
        <span className="bxtc-evt-meta" aria-hidden="true">
          <Icon name="pin" size={10} stroke={2} />
          <span title={r.location}>{r.location}</span>
        </span>
      )}
    </div>
  );
}

function AgendaRow({ event }) {
  const r = event.resource;
  const n = attendeeCount(r);
  return (
    <div
      className={[
        IDENT,
        "flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1",
        r.isCancelled ? "opacity-60" : "",
      ].join(" ")}
      style={identityVars(r.userId)}
    >
      <span className="flex min-w-0 shrink-0 items-center gap-1.5">
        <Swatch initials={r._user?.initials} className="size-5 text-[9.5px]" />
        <span className="max-w-[16ch] truncate text-[length:var(--fs-2xs)] text-[var(--text-muted)]">
          {r._user?.name}
        </span>
      </span>
      <span
        className={[
          "min-w-0 flex-1 truncate text-[length:var(--fs-sm)] font-medium text-[var(--text)]",
          r.isCancelled ? "line-through" : "",
        ].join(" ")}
      >
        {event.title}
      </span>
      {r.location && (
        <span className="flex min-w-0 max-w-[22ch] shrink-0 items-center gap-1 text-[length:var(--fs-2xs)] text-[var(--text-muted)]">
          <Icon name="pin" size={11} stroke={2} className="shrink-0" />
          <span className="truncate">{r.location}</span>
        </span>
      )}
      {n > 1 && (
        <span
          className="flex shrink-0 items-center gap-1 text-[length:var(--fs-2xs)] text-[var(--text-muted)]"
          title={`${n} attendees`}
        >
          <Icon name="users" size={11} stroke={1.8} />
          <span className="num">{n}</span>
        </span>
      )}
    </div>
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

  const ownerStyle = identityVars(r.userId);

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
              Owner
            </dt>
            <dd className="m-0 flex min-w-0 flex-wrap items-center gap-2 text-[length:var(--fs-sm)] text-[var(--text)]">
              <Swatch initials={r._user?.initials} className="size-6 text-[10px]" />
              <span className="min-w-0 truncate font-medium">{r._user?.name || "Unknown"}</span>
              {r._user?._department && (
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
  layout, onLayout, layoutAvailable,
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

        {/* Layout switch. Sits after the view switch because it is the
            coarser of the two and changes far less often, and it is hidden
            on the mobile agenda, which has only one layout. The label drops
            below `sm` so the pair of controls still fits a tablet. */}
        {layoutAvailable && (
          <Tabs value={layout} onValueChange={(v) => onLayout(v)}>
            <TabsList variant="segmented" aria-label="Calendar layout">
              {CAL_LAYOUTS.map(l => (
                <TabsTrigger key={l.id} value={l.id} title={l.hint}>
                  <Icon name={l.icon} size={14} />
                  {/* One text node, not two: below `sm` it is read but not
                      drawn, so the control narrows to its icons without the
                      label disappearing from the accessibility tree. */}
                  <span className="sr-only sm:not-sr-only">{l.label}</span>
                </TabsTrigger>
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

  // Which of the two layouts draws month/week/day. Persisted like the view,
  // and deliberately independent of it: the choice of shape is not a choice
  // of period. Defaults to the traditional grid.
  const [layout, setLayout] = useState(() => {
    const l = lsRead(LS_LAYOUT, "grid");
    return LAYOUT_IDS.includes(l) ? l : "grid";
  });
  useEffect(() => { lsWrite(LS_LAYOUT, layout); }, [layout]);

  const [date, setDate] = useState(new Date());
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [popoverEvent, setPopoverEvent] = useState(null);
  // The list behind a week cell in the people layout. Grid has no equivalent
  // (its blocks are directly clickable), so it stays null there.
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

  // Build the rbc events array. Attach `_user` so renderers can read
  // initials/name without a Map lookup on every paint.
  const rbcEvents = useMemo(() => {
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

  // ---- lanes -------------------------------------------------------------
  // One lane per selected person, in roster order, plus a lane for any owner
  // who has events in range but is no longer on the roster (a disabled user
  // whose id is still in the saved selection). Without that second pass an
  // event could arrive with nowhere to go; with it every event is placed and
  // every selected person is a lane exactly once. Built regardless of layout
  // so switching does not have to wait on a recompute; it is a map over the
  // roster, not a fetch.
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
    for (const ev of rbcEvents) {
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
  }, [roster, selected, rbcEvents]);

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
    // own the visual block. The data attr is a hook for selected-event focus.
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

  // Mobile is agenda-only, and the agenda is the same in both layouts, so
  // there is nothing for the switch to choose between there.
  const layoutAvailable = !isMobile;
  const effectiveLayout = isMobile ? "grid" : layout;
  const isPeople = effectiveLayout === "people";

  // Column width drives only the even-columns / cascade decision in the day
  // layout below; nothing about the data or the view depends on it.
  const gridRef = useRef(null);
  const colPx = useDayColumnWidth(gridRef, [effectiveView, date, effectiveLayout]);
  const dayLayout = useMemo(() => makeDayLayout(colPx), [colPx]);

  const scrollToTime = useMemo(() => {
    const t = new Date(); t.setHours(7, 0, 0, 0); return t;
  }, []);

  // react-big-calendar reads `components.toolbar` as a COMPONENT TYPE, so an
  // inline arrow is a brand-new type on every render and React unmounts and
  // remounts the whole toolbar each time. That reset Radix's roving tabindex
  // on both segmented controls, leaving them at tabindex -1 and unreachable
  // by Tab. Holding the varying props in a ref keeps the component identity
  // fixed while the values it renders stay current: the toolbar still
  // re-renders whenever this component does, and reads the ref during that
  // render.
  const toolbarExtras = useRef(null);
  toolbarExtras.current = {
    viewsAvailable,
    eventCount: rbcEvents.length,
    peopleOn: selected.size,
    onRefresh: handleRefresh,
    syncing: syncing || loading,
    isAdmin: admin,
    lastRefreshedAt,
    nowMs,
    refreshError,
    layout: effectiveLayout,
    onLayout: setLayout,
    layoutAvailable,
  };

  const calComponents = useMemo(() => ({
    event: MonthPill,
    toolbar: function CalendarToolbar(props) {
      return <CalToolbar {...props} {...toolbarExtras.current} />;
    },
    week:   { event: TimeBlock },
    day:    { event: TimeBlock },
    agenda: { event: AgendaRow },
  }), []);

  // Switching layout closes anything anchored to the layout being left. Both
  // are read-only dialogs, so nothing can be lost by closing them.
  useEffect(() => { setDayList(null); setPopoverEvent(null); }, [effectiveLayout]);

  const openEvent = (e) => { setDayList(null); setPopoverEvent(e); };
  // A week cell in the people layout hands over its person + day so the list
  // can name itself.
  const openDayList = (group) => { setPopoverEvent(null); setDayList(group); };

  const nothingSelected = selected.size === 0;
  const emptyRange = !nothingSelected && !loading && rbcEvents.length === 0;
  const firstLoad  = !nothingSelected && loading && rbcEvents.length === 0;

  // The agenda view renders its own "nothing here" slot, so the floating
  // overlay is reserved for the month/week/day grids and the two never
  // double up.
  //
  // An empty range only needs a card in the GRID layout. An empty time grid
  // says nothing, so it gets one; a lane view already reads as a row per
  // person saying "Nothing booked", and covering that with a card would hide
  // the answer to restate it.
  const showGridOverlay =
    effectiveView !== "agenda" && (firstLoad || (emptyRange && !isPeople));

  return (
    <TooltipProvider delayDuration={250}>
      <div
        className="bx-teamcal flex min-w-0 flex-col gap-4"
        data-view={effectiveView}
        data-layout={effectiveLayout}
      >
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
            description="Open the People picker and choose whose Outlook calendars to overlay. Everyone you pick gets their own colour and initials on the grid."
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
            {/* The grid scrolls sideways when its columns cannot fit; the
                lane views size to the container and manage their own inner
                scroll, so the wrapper must not add a second one. */}
            <div className={isPeople ? "min-w-0" : "bx-scroll-x min-w-0"} ref={gridRef}>
              <Calendar
                localizer={localizer}
                events={rbcEvents}
                // The lane views read `laneEvents` (one entry per calendar
                // row) and `laneUsers` rather than rbc's placed events. Both
                // are ignored by the built-in views, so they can be passed
                // unconditionally.
                laneEvents={rbcEvents}
                laneUsers={lanes}
                onOpenDayList={openDayList}
                view={effectiveView}
                onView={(v) => { if (!isMobile) setView(v); }}
                date={date}
                onNavigate={setDate}
                startAccessor="start"
                endAccessor="end"
                // The only prop that differs between the two layouts.
                // `Calendar` still owns navigation, the toolbar, the view
                // switch and event activation either way, and each custom
                // view carries the same navigate/range/title statics as the
                // library view it stands in for.
                views={isPeople
                  ? { month: TeamMonth, week: WeekMatrix, day: DayLanes, agenda: true }
                  : { month: true, week: true, day: true, agenda: true }}
                eventPropGetter={eventPropGetter}
                dayPropGetter={dayPropGetter}
                popup
                // Read-only: NO selectable, NO onSelectSlot, NO drag/drop.
                selectable={false}
                dayLayoutAlgorithm={dayLayout}
                step={30}
                timeslots={2}
                scrollToTime={scrollToTime}
                components={calComponents}
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
                {firstLoad ? (
                  <LoadingCard />
                ) : (
                  <EmptyState
                    className="bg-[var(--surface)] shadow-[var(--shadow-md)]"
                    compact
                    icon={ClockGlyph}
                    title={NO_EVENTS_TITLE}
                    description={NO_EVENTS_BODY}
                  />
                )}
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
