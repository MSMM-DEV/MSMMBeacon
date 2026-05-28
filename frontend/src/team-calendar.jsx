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
//     a read-only popover with the metadata that's already on the row.
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import {
  format, parse, startOfWeek, getDay,
  differenceInMinutes, startOfMonth, endOfMonth,
  startOfWeek as dfnsStartOfWeek, endOfWeek as dfnsEndOfWeek,
  startOfDay, endOfDay, addDays,
} from "date-fns";
import { enUS } from "date-fns/locale";
import "react-big-calendar/lib/css/react-big-calendar.css";

import { Icon } from "./icons.jsx";
import {
  getUsers, loadTeamCalendarEvents, userColorTokens,
} from "./data.js";

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

// ----- Smart subject fallback ---------------------------------------------
// When Graph returns null/empty `subject` (private events, app-permission
// limits, or genuinely untitled meetings), use the rest of the event payload
// to surface something more useful than "(no subject)".
function smartTitle(r) {
  const subj = (r.subject || "").trim();
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
  return "Untitled event";
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

// ---------------------------------------------------------------------------
// People Bar — the multi-select chip grid that doubles as a color legend.
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

  return (
    <div className="tcal-people">
      <div className="tcal-people-head">
        <div className="tcal-people-title">
          <span className="tcal-people-eyebrow">People</span>
          <span className="tcal-people-count">
            {totalSelected} of {users.length} selected
          </span>
        </div>
        <div className="tcal-people-actions">
          <button
            className="tcal-people-action"
            onClick={() => onSetMany(visibleUsers.map(u => u.id))}
            disabled={visibleUsers.length === 0}
          >
            Select visible
          </button>
          <span className="tcal-people-dot" aria-hidden>·</span>
          <button className="tcal-people-action" onClick={onSelectAll}>
            All
          </button>
          <span className="tcal-people-dot" aria-hidden>·</span>
          <button className="tcal-people-action" onClick={onClearAll}>
            None
          </button>
        </div>
      </div>

      <div className="tcal-people-filters">
        <label className="tcal-filter">
          <span className="tcal-filter-label">Dept</span>
          <select value={department} onChange={(e) => setDepartment(e.target.value)}>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="tcal-filter">
          <span className="tcal-filter-label">Loc</span>
          <select value={location} onChange={(e) => setLocation(e.target.value)}>
            {locations.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="tcal-search">
          <Icon name="search" size={14} />
          <input
            type="text"
            placeholder="Find someone…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="tcal-search-clear"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              title="Clear"
            >×</button>
          )}
        </label>
      </div>

      <div className="tcal-chip-grid" role="group" aria-label="Team members">
        {visibleUsers.length === 0 && (
          <div className="tcal-empty-chip">No one matches that filter.</div>
        )}
        {visibleUsers.map(u => {
          const isSel = selected.has(u.id);
          const c = userColorTokens(u.id);
          const style = {
            "--u-ink":     c.ink,
            "--u-ink-dk":  c.inkDark,
            "--u-stripe":  c.stripe,
            "--u-wash":    c.wash,
            "--u-wash-dk": c.washDark,
            "--u-chip":    c.chipFill,
            "--u-border":  c.chipBorder,
          };
          return (
            <button
              key={u.id}
              className={"tcal-chip" + (isSel ? " is-on" : "")}
              style={style}
              onClick={() => onToggle(u.id)}
              aria-pressed={isSel}
              title={`${u.name} · ${u._department || "—"} · ${u._location || "—"}`}
            >
              <span className="tcal-chip-avatar" aria-hidden>
                {u.initials}
              </span>
              <span className="tcal-chip-name">{u.name}</span>
              {isSel && (
                <span className="tcal-chip-tick" aria-hidden>
                  <Icon name="check" size={10} stroke={2.4} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event renderers — month/agenda use a compact pill, week/day use a full
// time-block that fills the absolutely-positioned rbc-event slot so a
// 10:00–15:00 event visually spans those five rows in the grid.
// ---------------------------------------------------------------------------
const fmtTime = (d) => {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = d.getMinutes();
  const hh = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? "am" : "pm";
  return m === 0 ? `${hh}${ampm}` : `${hh}:${String(m).padStart(2, "0")}${ampm}`;
};

function userStyleFor(userId) {
  const c = userColorTokens(userId);
  return {
    "--u-ink":     c.ink,
    "--u-ink-dk":  c.inkDark,
    "--u-stripe":  c.stripe,
    "--u-wash":    c.wash,
    "--u-wash-dk": c.washDark,
  };
}

// Total attendees on an event (resource shape). The Pass-B mirror stores
// every attendee — internal + external — in a single jsonb array.
function attendeeCount(r) {
  return (r.attendees || []).filter(a => a?.email).length;
}

function MonthPill({ event }) {
  const r = event.resource;
  const n = attendeeCount(r);
  return (
    <div
      className={"tcal-evt tcal-evt-pill" + (r.isAllDay ? " is-allday" : "")}
      style={userStyleFor(r.userId)}
    >
      <span className="tcal-evt-stripe" aria-hidden />
      <span className="tcal-evt-pill-body">
        <span className="tcal-evt-owner-mini" aria-hidden>{r._user?.initials || "··"}</span>
        <span className="tcal-evt-title">{event.title}</span>
        {n > 1 && <span className="tcal-evt-att" title={`${n} attendees`}>+{n}</span>}
      </span>
    </div>
  );
}

function TimeBlock({ event }) {
  const r = event.resource;
  const minutes = Math.max(0, differenceInMinutes(event.end, event.start));
  // Density tiers control how much chrome we render inside the block.
  // <30 min: title + owner only. 30–59: + time. ≥60: + location + attendees.
  const density = minutes < 30 ? "xs" : minutes < 60 ? "sm" : "lg";
  const n = attendeeCount(r);
  return (
    <div
      className={`tcal-evt tcal-evt-block density-${density}`}
      style={userStyleFor(r.userId)}
    >
      <span className="tcal-evt-stripe" aria-hidden />
      <span className="tcal-evt-block-body">
        <span className="tcal-evt-block-head">
          <span className="tcal-evt-owner" aria-hidden>{r._user?.initials || "··"}</span>
          <span className="tcal-evt-title">{event.title}</span>
          {density !== "xs" && n > 1 && (
            <span className="tcal-evt-att" title={`${n} attendees`}>+{n}</span>
          )}
        </span>
        {density !== "xs" && (
          <span className="tcal-evt-time">
            {fmtTime(event.start)} – {fmtTime(event.end)}
          </span>
        )}
        {density === "lg" && r.location && (
          <span className="tcal-evt-loc" title={r.location}>
            <Icon name="pin" size={10} stroke={2} />
            <span>{r.location}</span>
          </span>
        )}
      </span>
    </div>
  );
}

function AgendaRow({ event }) {
  const r = event.resource;
  const n = attendeeCount(r);
  return (
    <div className="tcal-agenda-row" style={userStyleFor(r.userId)}>
      <span className="tcal-agenda-dot" aria-hidden />
      <span className="tcal-agenda-owner">{r._user?.initials}</span>
      <span className="tcal-agenda-name">{r._user?.name}</span>
      <span className="tcal-agenda-sep" aria-hidden>·</span>
      <span className="tcal-agenda-title">{event.title}</span>
      {r.location && (
        <span className="tcal-agenda-loc">
          <Icon name="pin" size={10} stroke={2} />
          <span>{r.location}</span>
        </span>
      )}
      {n > 1 && (
        <span className="tcal-agenda-att" title={`${n} attendees`}>
          <Icon name="users" size={11} stroke={1.8} />
          <span>{n}</span>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attendee row sub-components — internal attendees get their per-user color
// avatar (resolved via roster email lookup); external attendees fall back to
// initials from name/email. Both rows show response status as a chip.
// ---------------------------------------------------------------------------
function initialsFrom(text) {
  if (!text) return "··";
  const parts = text.replace(/[^A-Za-z\s]/g, "").trim().split(/\s+/);
  const a = parts[0]?.[0] || "";
  const b = parts[1]?.[0] || "";
  return (a + b).toUpperCase() || (text[0] || "·").toUpperCase();
}

function InternalAttendeeRow({ attendee, rosterUser }) {
  const chip = responseChip(attendee.response);
  const initials = rosterUser?.initials || initialsFrom(attendee.name || attendee.email);
  const tokens = rosterUser ? userColorTokens(rosterUser.id) : null;
  const style = tokens
    ? { "--a-stripe": tokens.stripe, "--a-ink": tokens.ink, "--a-ink-dk": tokens.inkDark, "--a-wash": tokens.wash, "--a-wash-dk": tokens.washDark }
    : { "--a-stripe": "var(--text-soft)" };
  return (
    <div className="tcal-att-row tcal-att-internal" style={style}>
      <span className="tcal-att-avatar" aria-hidden>{initials}</span>
      <span className="tcal-att-name">
        {rosterUser?.name || attendee.name || attendee.email.split("@")[0]}
      </span>
      {rosterUser?.department && (
        <span className="tcal-att-dim">{rosterUser.department}</span>
      )}
      <span className={`tcal-att-chip ${chip.cls}`}>
        <span className="tcal-att-chip-dot" aria-hidden />
        <span>{chip.label}</span>
      </span>
    </div>
  );
}

function ExternalAttendeeRow({ attendee }) {
  const chip = responseChip(attendee.response);
  const initials = initialsFrom(attendee.name || attendee.email);
  const name  = attendee.name || attendee.email.split("@")[0];
  const email = attendee.email;
  return (
    <div className="tcal-att-row tcal-att-external">
      <span className="tcal-att-avatar tcal-att-avatar-ext" aria-hidden>{initials}</span>
      <span className="tcal-att-stack">
        <span className="tcal-att-name">{name}</span>
        {email && <span className="tcal-att-email">{email}</span>}
      </span>
      <span className={`tcal-att-chip ${chip.cls}`}>
        <span className="tcal-att-chip-dot" aria-hidden />
        <span>{chip.label}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only event popover — opens centered when an event is clicked.
// Esc + click-outside close.
// ---------------------------------------------------------------------------
function EventPopover({ event, onClose }) {
  const ref = useRef(null);

  // Roster lookup by lowercased email so internal attendees pick up the same
  // color they have everywhere else in the Team Calendar.
  const usersByEmail = useMemo(() => {
    const m = new Map();
    for (const u of getUsers()) {
      if (u.email) m.set(u.email.toLowerCase(), u);
    }
    return m;
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!event) return null;
  const r = event.resource;
  const c = userColorTokens(r.userId);
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

  return (
    <div
      className="tcal-pop-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="tcal-pop"
        ref={ref}
        role="dialog"
        aria-modal="true"
        style={{
          "--u-ink":    c.ink,
          "--u-ink-dk": c.inkDark,
          "--u-stripe": c.stripe,
          "--u-wash":   c.wash,
          "--u-wash-dk":c.washDark,
        }}
      >
        <span className="tcal-pop-stripe" aria-hidden />
        <div className="tcal-pop-head">
          <span className="tcal-pop-eyebrow">Calendar event · read-only</span>
          <button className="tcal-pop-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <h2 className="tcal-pop-title">{event.title}</h2>
        {missingReason && (
          <div className="tcal-pop-subnote">{missingReason}</div>
        )}

        <div className="tcal-pop-meta">
          <div className="tcal-pop-row">
            <span className="tcal-pop-label">When</span>
            <span className="tcal-pop-val">
              <span>{dateLabel}</span>
              <span className="tcal-pop-mono">{timeLabel}</span>
              {durLabel && <span className="tcal-pop-pill">{durLabel}</span>}
            </span>
          </div>

          {r.location && (
            <div className="tcal-pop-row">
              <span className="tcal-pop-label">Where</span>
              <span className="tcal-pop-val">
                <Icon name="pin" size={12} stroke={2} />
                <span>{r.location}</span>
              </span>
            </div>
          )}

          <div className="tcal-pop-row">
            <span className="tcal-pop-label">Owner</span>
            <span className="tcal-pop-val">
              <span className="tcal-pop-avatar" aria-hidden>{r._user?.initials || "··"}</span>
              <span className="tcal-pop-owner-name">{r._user?.name || "Unknown"}</span>
              {r._user?._department && (
                <span className="tcal-pop-dim">· {r._user._department}</span>
              )}
            </span>
          </div>

          {r.organizer?.email && r.organizer.email.toLowerCase() !== (r._user?._email || "").toLowerCase() && (
            <div className="tcal-pop-row">
              <span className="tcal-pop-label">Organizer</span>
              <span className="tcal-pop-val">
                <span>{r.organizer.name || r.organizer.email}</span>
              </span>
            </div>
          )}
        </div>

        {totalAttendees > 0 && (
          <div className="tcal-pop-attendees-section">
            <div className="tcal-pop-attendees-head">
              <span className="tcal-pop-label">Attendees</span>
              <span className="tcal-pop-attendees-count">{totalAttendees}</span>
            </div>
            <div className="tcal-att-list">
              {internal.length > 0 && (
                <div className="tcal-att-group">
                  <div className="tcal-att-subhead">
                    <span>From MSMM</span>
                    <span className="tcal-att-subhead-count">{internal.length}</span>
                  </div>
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
                <div className="tcal-att-group">
                  <div className="tcal-att-subhead">
                    <span>External</span>
                    <span className="tcal-att-subhead-count">{external.length}</span>
                  </div>
                  {external.map((a, i) => (
                    <ExternalAttendeeRow key={`ext:${a.email}:${i}`} attendee={a} />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="tcal-pop-foot">
          {r.outlookWebLink && (
            <a
              className="tcal-pop-link"
              href={r.outlookWebLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="link" size={11} stroke={2} />
              <span>Open in Outlook</span>
              <span aria-hidden>↗</span>
            </a>
          )}
          <span className="tcal-pop-foot-spacer" />
          <button className="tcal-pop-done" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom toolbar — date nav + view switch + density badge. No "Sync" here
// because Team Calendar reads what outlook-sync has already mirrored.
// ---------------------------------------------------------------------------
function CalToolbar({ label, onNavigate, onView, view, viewsAvailable, eventCount, peopleOn }) {
  return (
    <div className="cal-toolbar tcal-toolbar">
      <div className="cal-toolbar-l">
        <h2 className="cal-month-label">{label}</h2>
        <div className="tcal-toolbar-vitals">
          <span className="tcal-vital">
            <span className="tcal-vital-n">{peopleOn}</span>
            <span className="tcal-vital-l">on view</span>
          </span>
          <span className="tcal-vital-sep" aria-hidden>·</span>
          <span className="tcal-vital">
            <span className="tcal-vital-n">{eventCount}</span>
            <span className="tcal-vital-l">{eventCount === 1 ? "event" : "events"} in range</span>
          </span>
        </div>
      </div>
      <div className="cal-toolbar-r">
        <div className="cal-nav">
          <button className="cal-nav-btn" onClick={() => onNavigate("PREV")} aria-label="Previous">
            <span className="cal-chev" aria-hidden>‹</span>
          </button>
          <button className="cal-today-btn" onClick={() => onNavigate("TODAY")}>Today</button>
          <button className="cal-nav-btn" onClick={() => onNavigate("NEXT")} aria-label="Next">
            <span className="cal-chev" aria-hidden>›</span>
          </button>
        </div>
        {viewsAvailable.length > 1 && (
          <div className="cal-views">
            {viewsAvailable.map(v => (
              <button
                key={v}
                className={"cal-view-btn" + (v === view ? " active" : "")}
                onClick={() => onView(v)}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        )}
      </div>
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

  // Build a lookup map id → roster entry once per roster change.
  const userById = useMemo(() => {
    const m = new Map();
    for (const u of roster) m.set(u.id, u);
    return m;
  }, [roster]);

  // Load events whenever the selection / view / date window changes.
  useEffect(() => {
    let cancelled = false;
    if (selected.size === 0) { setEvents([]); return; }
    const { start, end } = windowForView(date, view);
    setLoading(true);
    loadTeamCalendarEvents(Array.from(selected), start, end)
      .then(rows => {
        if (cancelled) return;
        setEvents(rows);
      })
      .catch(err => {
        if (cancelled) return;
        console.error("[TeamCalendar] load failed:", err);
        setEvents([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selected, view, date]);

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

  const scrollToTime = useMemo(() => {
    const t = new Date(); t.setHours(7, 0, 0, 0); return t;
  }, []);

  return (
    <div className={"team-cal" + (loading ? " is-loading" : "")}>
      <PeopleBar
        users={roster}
        selected={selected}
        onToggle={toggle}
        onSelectAll={selectAll}
        onClearAll={clearAll}
        onSetMany={setMany}
      />

      <div className={`cal-shell team-cal-shell cal-view-${effectiveView}`}>
        {selected.size === 0 ? (
          <div className="tcal-empty-cal">
            <div className="tcal-empty-mark" aria-hidden>
              <Icon name="calendar" size={28} stroke={1.4} />
            </div>
            <h3>No one selected.</h3>
            <p>Pick teammates above to see their calendars overlaid here.</p>
            <button className="tcal-empty-cta" onClick={selectAll}>Show everyone</button>
          </div>
        ) : (
          <Calendar
            localizer={localizer}
            events={rbcEvents}
            view={effectiveView}
            onView={(v) => { if (!isMobile) setView(v); }}
            date={date}
            onNavigate={setDate}
            startAccessor="start"
            endAccessor="end"
            views={{ month: true, week: true, day: true, agenda: true }}
            eventPropGetter={eventPropGetter}
            dayPropGetter={dayPropGetter}
            popup
            // Read-only: NO selectable, NO onSelectSlot, NO drag/drop.
            selectable={false}
            step={30}
            timeslots={2}
            scrollToTime={scrollToTime}
            components={{
              event: MonthPill,
              toolbar: (props) => (
                <CalToolbar
                  {...props}
                  viewsAvailable={viewsAvailable}
                  eventCount={rbcEvents.length}
                  peopleOn={selected.size}
                />
              ),
              week:   { event: TimeBlock },
              day:    { event: TimeBlock },
              agenda: { event: AgendaRow },
            }}
            onSelectEvent={(e) => setPopoverEvent(e)}
            formats={{
              monthHeaderFormat:    (d, _c, l) => l.format(d, "MMMM yyyy"),
              dayHeaderFormat:      (d, _c, l) => l.format(d, "EEEE · MMM d"),
              dayRangeHeaderFormat: ({ start, end }, _c, l) =>
                `${l.format(start, "MMM d")} — ${l.format(end, "MMM d, yyyy")}`,
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
                `${l.format(start, "MMM d")} — ${l.format(end, "MMM d, yyyy")}`,
            }}
            messages={{
              noEventsInRange: "Nobody's calendar has anything in this range.",
            }}
            length={30}
          />
        )}
      </div>

      {popoverEvent && (
        <EventPopover event={popoverEvent} onClose={() => setPopoverEvent(null)} />
      )}
    </div>
  );
}

export default TeamCalendarTab;
