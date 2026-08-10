// TeamRangeView — the admin's main canvas. Renders one of four shapes
// depending on `prefs.range`:
//
//   day     · one row per user with a horizontal interval bar (rich detail)
//   week    · one row per user × 7 day cells with hours + bar (Mon..Sun)
//   month   · one row per user × N week cells with totals (W1, W2, ...)
//   custom  · per-user totals over the chosen range, sortable
//
// Visible-users + search filters are applied uniformly. Today's column gets
// an accent stripe. Hours bars cap at a 8 h workday by default; overtime
// shows as a deeper accent extension. Click any cell or name → opens the
// per-user day drawer via onOpenUserDay.
//
// Week / Month / Custom render as real <table> markup inside a scroller that
// pins the person column and the column header — the grid is comparison of
// many people across the same fields, so it must stay aligned at any width.

import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Icon } from "@/icons";
import { Badge, Button, EmptyState, Alert, SkeletonTable, Tooltip } from "@/ui";
import {
  todayInCT, weekStartCT, fmtHM, fmtClock,
  loadTeamDay, loadTeamRange, getUsers,
  TK_CATEGORY_LABEL, intervalTone,
} from "../data";
import { inSince, openIntervalOf } from "../timekeeping-presence.js";
import { DayTimeline } from "./DayTimeline";
import { useIsMobile } from "../use-mobile";

const TARGET_DAY_MIN = 480;   // 8h workday — bar goal
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LIVE_TICK_MS = 30_000;   // refresh "in since" + open-interval totals
const TRACK_START_HOUR = 6;
const TRACK_END_HOUR   = 20;
const EMPTY = "–";             // en dash placeholder for an empty numeric cell

const UsersGlyph = (props) => <Icon name="users" {...props} />;
const ClockGlyph = (props) => <Icon name="clock" {...props} />;

// ---------------------------------------------------------------------------
// Date helpers (all in CT business tz logic, matching the rest of the system)
// ---------------------------------------------------------------------------
function addDays(isoDate, delta) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}
function firstOfMonth(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}
function addMonths(isoDate, delta) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setMonth(d.getMonth() + delta);
  return d.toISOString().slice(0, 10);
}
function fmtMonth(isoDate) {
  return new Date(`${isoDate}T12:00:00`)
    .toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
function fmtDayLong(isoDate) {
  return new Date(`${isoDate}T12:00:00`)
    .toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
function fmtDateShort(isoDate) {
  return new Date(`${isoDate}T12:00:00`)
    .toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtWeekRange(weekStartIso) {
  const start = new Date(`${weekStartIso}T12:00:00`);
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const startStr = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endStr   = end  .toLocaleDateString("en-US", sameMonth
    ? { day: "numeric" }
    : { month: "short", day: "numeric" });
  return `${startStr} – ${endStr}, ${end.getFullYear()}`;
}
function endOfMonthExclusive(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setMonth(d.getMonth() + 1); d.setDate(1);
  return d.toISOString().slice(0, 10);
}
function totalMinForDay(d) {
  if (!d) return 0;
  // Worked time = at-desk (IN) minutes only; punched-out time never counts.
  return d.minutesWork || 0;
}

// Stored rollup + live elapsed for the open interval. Used by Week/Month/
// Custom views, which can't afford to fetch per-day intervals across the
// whole range. Known to overcount on days where an open interval crossed
// midnight — the DB rollup credits cross-day spans to the day they started.
function liveTotalForDay(d, openSinceIso) {
  const stored = totalMinForDay(d);
  if (!openSinceIso) return stored;
  const elapsed = Math.max(0, Math.floor((Date.now() - +new Date(openSinceIso)) / 60_000));
  return stored + elapsed;
}

// Day-mode total computed directly from today's intervals, clamped to the
// calendar day. Counts work/meeting/travel categories. Open intervals are
// credited up to now(). Deliberately bypasses timesheet_days.minutes_work,
// which inflates today when an interval crossed midnight (e.g. yesterday's
// IN punch was never paired with an OUT).
function workMinutesFromIntervals(intervals, date) {
  if (!intervals || intervals.length === 0) return 0;
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const dayEnd   = dayStart + 86_400_000;
  const now      = Date.now();
  let mins = 0;
  for (const iv of intervals) {
    if (iv.isOut) continue;   // worked time = at-desk (IN) only; OUT never counts
    const s = Math.max(new Date(iv.startAt).getTime(), dayStart);
    const e = Math.min(iv.endAt ? new Date(iv.endAt).getTime() : now, dayEnd);
    if (e > s) mins += Math.floor((e - s) / 60_000);
  }
  return mins;
}

// When a Day-mode row has been at their desk since (Range-mode rows carry an
// `openSince` string instead).
//
// Delegates to `inSince` so the chip this feeds and the In/Out filter are the
// same decision. It used to search for ANY open IN interval, which on a day
// with a stale unclosed punch disagreed with the filter about the same person
// — see the banner in timekeeping-presence.js.
function openSinceFromDayRow(row) {
  return inSince(row.intervals);
}

// First-in / last-out for a day, derived from intervals (preferred) or the
// rollup's first_in / last_out (fallback). Returns ISO strings or null.
function dayPunchBounds(row) {
  const ivs = row.intervals || [];
  if (ivs.length > 0) {
    const sorted = ivs.slice().sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt));
    const firstIn = sorted[0].startAt;
    const lastClosed = sorted.slice().reverse().find(i => i.endAt);
    return { firstIn, lastOut: lastClosed ? lastClosed.endAt : null };
  }
  return { firstIn: row.day?.firstIn || null, lastOut: row.day?.lastOut || null };
}

// ---------------------------------------------------------------------------
export function TeamRangeView({ prefs, onPrefsChange, onOpenUserDay, dataVersion = 0, signals }) {
  const today      = todayInCT();
  const anchorDate = prefs.anchorDate || today;
  const range      = prefs.range || "day";

  // Compute the [start, endExclusive) window for the current range.
  const window = useMemo(() => {
    if (range === "day") {
      return { start: anchorDate, endExclusive: addDays(anchorDate, 1), columns: [anchorDate] };
    }
    if (range === "week") {
      const start = weekStartCT(anchorDate);
      const cols = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      return { start, endExclusive: addDays(start, 7), columns: cols };
    }
    if (range === "month") {
      const start = firstOfMonth(anchorDate);
      const endX  = endOfMonthExclusive(anchorDate);
      // Build week-start columns within the month.
      const weeks = [];
      let cur = weekStartCT(start);
      while (cur < endX) {
        weeks.push(cur);
        cur = addDays(cur, 7);
      }
      return { start, endExclusive: endX, columns: weeks };
    }
    // custom
    const cs = prefs.customStart || today;
    const ce = prefs.customEnd   || today;
    const endX = addDays(ce, 1);
    return { start: cs, endExclusive: endX, columns: [] };
  }, [range, anchorDate, prefs.customStart, prefs.customEnd, today]);

  // Data loading
  const [rows, setRows]       = useState([]);
  const [dayRows, setDayRows] = useState([]);     // only used in 'day' mode
  const [busy, setBusy]       = useState(false);
  const [err,  setErr]        = useState(null);

  const refresh = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      if (range === "day") {
        const r = await loadTeamDay(anchorDate);
        setDayRows(r);
        setRows([]);   // not used in day mode
      } else {
        const r = await loadTeamRange(window.start, window.endExclusive);
        setRows(r);
        setDayRows([]);
      }
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
    // `dataVersion` is included so the Time Admin tab can force a refetch
    // after a correction/week is approved on the Approvals tab.
  }, [range, anchorDate, window.start, window.endExclusive, dataVersion]);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh every LIVE_TICK_MS so the Team view never goes stale —
  // covers correction approvals, new punches from the Pi/web, and advances
  // "in since" / open-interval totals without a manual reload. Runs always
  // (not just "when anyone is in") so a punch arriving from anywhere lands
  // here within one tick. Skipped while a refresh is already in flight to
  // avoid stacking duplicate requests.
  useEffect(() => {
    const id = setInterval(() => {
      if (!busy) refresh();
    }, LIVE_TICK_MS);
    return () => clearInterval(id);
  }, [refresh, busy]);

  // ---------- Filter visible users (allowlist + search)
  const visibleSet = useMemo(() => {
    const allIds = getUsers().map(u => u.id);
    if (prefs.visibleUsers === "all") return new Set(allIds);
    return new Set(prefs.visibleUsers || []);
  }, [prefs.visibleUsers]);

  const matchesSearch = useCallback((user) => {
    if (!prefs.search?.trim()) return true;
    const q = prefs.search.trim().toLowerCase();
    return user.name.toLowerCase().includes(q) || (user.initials || "").toLowerCase().includes(q);
  }, [prefs.search]);

  // ---------- Presence filter (in / out / all)
  //
  // Both states are about RIGHT NOW, not about the range on screen — on a past
  // week "who is in" would mean nothing, and the two other places that say
  // "in" on this page (the In chip, the "Currently in" tile) already mean this
  // moment.
  //
  // Punches toggle, so a person is in exactly one of three states and OUT IS
  // NOT THE COMPLEMENT OF IN:
  //
  //   in     an open interval whose direction is IN — at their desk
  //   out    an open interval whose direction is OUT — at lunch, on site, or
  //          gone for the day
  //   —      no open interval at all: they have not punched today
  //
  // Filtering "out" as `!in` swept that third group in, so an admin asking
  // "who is out" was handed everyone who never showed up. They are different
  // questions with different answers, and only All covers the third group.
  //
  // Both sets come from the live today-snapshot the parent already fetches —
  // see the comment on `signals` in TimeAdminTab for why they cannot be
  // derived from the range rows.
  const presence = prefs.presence || "all";
  const matchesPresence = useCallback((row) => {
    if (presence === "all") return true;
    const set = presence === "in" ? signals?.currentlyIn : signals?.currentlyOut;
    return !!set?.has(row.user.id);
  }, [presence, signals]);

  // ONE predicate for every consumer. It used to be spelled out at each of the
  // five call sites (the stats and the four matrices), which is exactly the
  // shape where a new filter gets added to four of them and the tiles quietly
  // keep counting rows the table is no longer showing.
  const visibleRows = useCallback((arr) => (
    arr.filter(r =>
      visibleSet.has(r.user.id) && matchesSearch(r.user) && matchesPresence(r))
  ), [visibleSet, matchesSearch, matchesPresence]);

  // ---------- Sorting
  // Anyone currently in → top, then anyone with hours, then alpha.
  const sortRows = useCallback((arr, kind) => {
    return arr.slice().sort((a, b) => {
      // Same rule as the chip and the filter, so the person sorted to the top
      // as "in" is the person the row says is in.
      const aIn = kind === "day" ? !!inSince(a.intervals) : !!a.openSince;
      const bIn = kind === "day" ? !!inSince(b.intervals) : !!b.openSince;
      if (aIn !== bIn) return aIn ? -1 : 1;
      const aTot = kind === "day"
        ? (a.day ? totalMinForDay(a.day) : 0)
        : a.days.reduce((acc, d) => acc + totalMinForDay(d), 0);
      const bTot = kind === "day"
        ? (b.day ? totalMinForDay(b.day) : 0)
        : b.days.reduce((acc, d) => acc + totalMinForDay(d), 0);
      if (aTot !== bTot) return bTot - aTot;
      return (a.user.name || "").localeCompare(b.user.name || "");
    });
  }, []);

  // ---------- Stat tiles (compute once per data load)
  const stats = useMemo(() => {
    let totalMin = 0, activeUsers = 0, inNow = 0, daysWithFlags = 0;
    if (range === "day") {
      const list = visibleRows(dayRows);
      for (const r of list) {
        if (r.intervals.length > 0) activeUsers++;
        const openSince = openSinceFromDayRow(r);
        if (openSince) inNow++;
        totalMin += workMinutesFromIntervals(r.intervals, anchorDate);
        if (r.day?.flags?.missing_out || r.day?.flags?.untagged_meeting) daysWithFlags++;
      }
      return { totalMin, activeUsers, inNow, daysWithFlags, peopleShown: list.length };
    }
    const list = visibleRows(rows);
    for (const r of list) {
      if (r.days.length > 0) activeUsers++;
      if (r.openSince) inNow++;
      const todayDate = todayInCT();
      for (const d of r.days) {
        // Only the today-row should get the open-interval credit.
        const openCredit = (r.openSince && d.date === todayDate) ? r.openSince : null;
        totalMin += liveTotalForDay(d, openCredit);
        if (d.flags?.missing_out || d.flags?.untagged_meeting) daysWithFlags++;
      }
      // Open interval started today but no rollup row yet — still credit.
      if (r.openSince && !r.days.some(d => d.date === todayDate)) {
        totalMin += Math.max(0, Math.floor((Date.now() - +new Date(r.openSince)) / 60_000));
      }
    }
    return { totalMin, activeUsers, inNow, daysWithFlags, peopleShown: list.length };
  }, [range, dayRows, rows, anchorDate, visibleRows]);

  // ---------- Render
  const isCompact = prefs.density === "compact";
  const noPeople  = stats.peopleShown === 0;
  // Whether an empty table can be read as a statement about the whole team.
  const presenceIsOnlyFilter =
    presence !== "all" && !prefs.search?.trim() && prefs.visibleUsers === "all";

  return (
    <section className={`tka-range ${isCompact ? "is-compact" : ""}`} aria-busy={busy || undefined}>

      <RangeHeader
        range={range}
        anchorDate={anchorDate}
        windowStart={window.start}
        customStart={prefs.customStart}
        customEnd={prefs.customEnd}
        busy={busy}
        onShift={(delta) => {
          if (range === "day")   onPrefsChange?.({ anchorDate: addDays(anchorDate, delta) });
          if (range === "week")  onPrefsChange?.({ anchorDate: addDays(anchorDate, 7 * delta) });
          if (range === "month") onPrefsChange?.({ anchorDate: addMonths(anchorDate, delta) });
        }}
        onJumpToday={() => onPrefsChange?.({ anchorDate: today, customStart: today, customEnd: today })}
        onAnchorPick={(d) => onPrefsChange?.({ anchorDate: d })}
        onCustomStart={(d) => onPrefsChange?.({ customStart: d })}
        onCustomEnd={(d)   => onPrefsChange?.({ customEnd: d })}
        today={today}
      />

      <StatTiles stats={stats} range={range} />

      {err && (
        <Alert tone="danger" title="Could not load the team range">{err}</Alert>
      )}

      <div className="tka-canvas">
        {busy && noPeople ? (
          <SkeletonTable rows={6} cols={6} />
        ) : noPeople ? (
          // Three filters can empty this table and the fix differs for each.
          //
          // "Nobody is punched in right now" is an ANSWER, not an error — an
          // admin who filtered to In and sees an empty table should be told
          // the office is empty, not told to widen a selection that is already
          // correct. But it is only a true answer when presence is the ONLY
          // filter narrowing; with a name search or a People allowlist also
          // on, the empty table says nothing about the whole team, so it falls
          // back to the neutral title rather than asserting something false.
          <EmptyState
            icon={UsersGlyph}
            title={!presenceIsOnlyFilter ? "No people match this view"
                 : presence === "in"     ? "Nobody is punched in right now"
                 : presence === "out"    ? "Everybody is punched in right now"
                 : "No people match this view"}
            description={presence !== "all"
              ? "Switch the In/Out filter back to All, or widen the People selection and clear the name search."
              : "Widen the People selection or clear the name search to bring rows back."}
          />
        ) : (
          <>
            {range === "day" && (
              <DayMatrix
                rows={sortRows(visibleRows(dayRows), "day")}
                date={anchorDate}
                onOpenUserDay={onOpenUserDay}
                isCompact={isCompact}
              />
            )}
            {range === "week" && (
              <WeekMatrix
                rows={sortRows(visibleRows(rows), "range")}
                columns={window.columns}
                today={today}
                onOpenUserDay={onOpenUserDay}
                isCompact={isCompact}
              />
            )}
            {range === "month" && (
              <MonthMatrix
                rows={sortRows(visibleRows(rows), "range")}
                weeks={window.columns}
                anchorDate={anchorDate}
                today={today}
                onOpenUserDay={onOpenUserDay}
                isCompact={isCompact}
              />
            )}
            {range === "custom" && (
              <CustomMatrix
                rows={sortRows(visibleRows(rows), "range")}
                start={window.start}
                endExclusive={window.endExclusive}
                onOpenUserDay={onOpenUserDay}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Header — range nav + date display + jump-to-today
// ---------------------------------------------------------------------------
function RangeHeader({
  range, anchorDate, windowStart, customStart, customEnd,
  busy, onShift, onJumpToday, onAnchorPick, onCustomStart, onCustomEnd, today,
}) {
  const title =
    range === "day"   ? fmtDayLong(anchorDate)
  : range === "week"  ? fmtWeekRange(windowStart)
  : range === "month" ? fmtMonth(anchorDate)
  :                     `${fmtDateShort(customStart || today)} – ${fmtDateShort(customEnd || today)}`;

  const isToday =
    range === "day"   ? anchorDate === today
  : range === "week"  ? weekStartCT(today) === windowStart
  : range === "month" ? firstOfMonth(today) === firstOfMonth(anchorDate)
  :                     false;

  const eyebrow =
    range === "day" ? "Day" : range === "week" ? "Week" : range === "month" ? "Month" : "Custom range";

  return (
    <header className="tka-rangehead">
      <div className="tka-rangehead-main">
        {range !== "custom" && (
          <div className="tka-rangehead-steps">
            <Button variant="default" size="icon-sm" onClick={() => onShift(-1)} aria-label={`Previous ${eyebrow.toLowerCase()}`}>
              <Icon name="back" size={14}/>
            </Button>
            <Button variant="default" size="icon-sm" onClick={() => onShift(+1)} aria-label={`Next ${eyebrow.toLowerCase()}`}>
              <Icon name="forward" size={14}/>
            </Button>
          </div>
        )}

        <div className="tka-rangehead-titles">
          <span className="tka-eyebrow">
            {eyebrow}
            {busy && <span className="tka-eyebrow-busy"> · refreshing</span>}
          </span>
          <h2 className="tka-rangetitle">{title}</h2>
        </div>

        {!isToday && range !== "custom" && (
          <Button variant="subtle" size="xs" onClick={onJumpToday}>
            <Icon name="clock" size={12}/> Today
          </Button>
        )}
      </div>

      <div className="tka-rangehead-side">
        {(range === "day" || range === "week") && (
          <input
            type="date"
            className="tka-dateinput"
            aria-label={range === "day" ? "Pick a day" : "Pick a day inside the week"}
            value={anchorDate}
            max={today}
            onChange={e => onAnchorPick(e.target.value || today)}
          />
        )}
        {range === "month" && (
          <input
            type="month"
            className="tka-dateinput"
            aria-label="Pick a month"
            value={anchorDate.slice(0, 7)}
            max={today.slice(0, 7)}
            onChange={e => onAnchorPick(e.target.value ? `${e.target.value}-01` : today)}
          />
        )}
        {range === "custom" && (
          <span className="tka-daterange">
            <input
              type="date"
              className="tka-dateinput"
              value={customStart || today}
              max={today}
              onChange={e => onCustomStart(e.target.value || today)}
              aria-label="Start date"
            />
            <Icon name="forward" size={13} className="tka-daterange-sep"/>
            <input
              type="date"
              className="tka-dateinput"
              value={customEnd || today}
              max={today}
              min={customStart || undefined}
              onChange={e => onCustomEnd(e.target.value || today)}
              aria-label="End date"
            />
          </span>
        )}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------
function StatTiles({ stats, range }) {
  const tiles = [
    { key: "in",     label: "Currently in",  value: stats.inNow,      sub: "right now",  tone: "accent", icon: "userCheck", pulse: stats.inNow > 0 },
    { key: "active", label: "Active",        value: stats.activeUsers, sub: "people",     tone: "sage",  icon: "users" },
    { key: "hours",  label: "Hours logged",  value: fmtHM(stats.totalMin, { always: true }), sub: rangeWord(range), tone: "blue", icon: "clock", asString: true },
    { key: "flags",  label: "Needs review",  value: stats.daysWithFlags, sub: "flagged days", tone: stats.daysWithFlags > 0 ? "rose" : "muted", icon: stats.daysWithFlags > 0 ? "warn" : "check" },
  ];
  return (
    <div className="tka-stats">
      {tiles.map(t => (
        <div key={t.key} className={`tka-stat tone-${t.tone}`}>
          <div className="tka-stat-label">
            <Icon name={t.icon} size={13}/>
            <span>{t.label}</span>
          </div>
          <div className="tka-stat-value num">
            {t.pulse && <span className="tka-livedot" aria-hidden="true"/>}
            {t.asString ? t.value : Number(t.value).toLocaleString()}
          </div>
          <div className="tka-stat-sub">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}

function rangeWord(r) {
  return r === "day" ? "this day" : r === "week" ? "this week" : r === "month" ? "this month" : "in range";
}

// In-office chip — never colour alone: a live dot plus the word "In".
function InChip() {
  return (
    <Badge tone="brand" size="sm" className="tka-inchip">
      <span className="tka-livedot" aria-hidden="true"/>
      In
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// DayMatrix — one row per user with horizontal timeline
// ---------------------------------------------------------------------------
function DayMatrix({ rows, date, onOpenUserDay, isCompact }) {
  const isMobile = useIsMobile();
  const span = TRACK_END_HOUR - TRACK_START_HOUR;
  const hourTicks = Array.from({ length: span + 1 }, (_, i) => TRACK_START_HOUR + i);

  // Mobile — compact tappable rows with a text-based status line. The
  // horizontal mini-timeline is unreadable at phone widths (intervals
  // collapse to a few pixels, gap stripes overlap empty-state text), so
  // we strip it and surface the same info as plain text. Tap → opens
  // the full UserDayModal (vertical day calendar) for the chosen user.
  if (isMobile) {
    return (
      <ul className="tka-daylist">
        {rows.map(r => (
          <DayMatrixMobileRow
            key={r.user.id}
            row={r}
            date={date}
            onOpenUserDay={onOpenUserDay}
          />
        ))}
        {rows.length === 0 && (
          <li>
            <EmptyState
              compact
              icon={ClockGlyph}
              title="Nothing recorded on this day"
              description="Punches from a fob reader or the web timesheet will appear here."
            />
          </li>
        )}
      </ul>
    );
  }

  return (
    <div className="bx-scroll-x tka-daymx-scroll">
      <div className="tka-daymx">
        {/* Shared hour grid above all rows so positions are readable. */}
        <div className="tka-daymx-axis" aria-hidden="true">
          <div className="tka-daymx-axis-track">
            {hourTicks.map(h => (
              <span key={h} className="tka-daymx-tick num"
                style={{ left: `${((h - TRACK_START_HOUR) / span) * 100}%` }}>
                {h === 12 ? "12p" : h > 12 ? `${h - 12}p` : `${h}a`}
              </span>
            ))}
          </div>
        </div>

        <ul className="tka-daymx-rows">
          {rows.map(r => {
            const openSince = openSinceFromDayRow(r);
            const isIn  = !!openSince;
            const total = workMinutesFromIntervals(r.intervals, date);
            const flags = r.day?.flags || {};
            const showFlag = flags.missing_out || flags.untagged_meeting;
            const bounds = dayPunchBounds(r);
            return (
              <li key={r.user.id} className={`tka-daymx-row ${isIn ? "is-in" : ""} ${showFlag ? "has-flag" : ""}`}>
                <button
                  type="button"
                  className="tka-daymx-name"
                  onClick={() => onOpenUserDay?.({ userId: r.user.id, date })}
                >
                  <span className="tka-daymx-name-top">
                    <span className={`avatar xs ${r.user.color}`}>{r.user.initials}</span>
                    <span className="tka-daymx-name-label">{r.user.name}</span>
                    {isIn && <InChip/>}
                  </span>
                  <PunchTimesLine
                    firstIn={bounds.firstIn}
                    lastOut={bounds.lastOut}
                    openSince={openSince}
                  />
                </button>
                <div className="tka-daymx-tl">
                  <DayTimeline
                    date={date}
                    intervals={r.intervals}
                    onIntervalClick={() => onOpenUserDay?.({ userId: r.user.id, date })}
                    height={isCompact ? 18 : 24}
                    showHourGrid={false}
                  />
                </div>
                <div className="tka-daymx-total">
                  <span className="num">{fmtHM(total, { always: true })}</span>
                  {showFlag && (
                    <Tooltip label={flagTitle(flags)}>
                      <span className="tka-flag" tabIndex={0} role="img" aria-label={`Needs review: ${flagTitle(flags)}`}>
                        <Icon name="warn" size={12}/>
                      </span>
                    </Tooltip>
                  )}
                </div>
              </li>
            );
          })}
          {rows.length === 0 && (
            <li className="tka-emptyrow">No activity for the visible people on this day.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

// Phone row — replaces the horizontal mini-timeline with a clean
// 3-line layout. Built to be tap-comfortable + glance-readable.
function DayMatrixMobileRow({ row, date, onOpenUserDay }) {
  const openSince = openSinceFromDayRow(row);
  const isIn      = !!openSince;
  const total     = workMinutesFromIntervals(row.intervals, date);
  const flags     = row.day?.flags || {};
  const showFlag  = flags.missing_out || flags.untagged_meeting;

  // Status line:
  //   currently in   → "Working · since 9:27 AM"
  //   has activity   → "Last: Break · 9:27 AM"   (most-recent closed interval)
  //   no activity    → "No activity today"
  let statusKind, statusBody;
  if (isIn) {
    statusKind = "in";
    statusBody = (
      <>
        <span className="tka-daylist-cat">Working</span>
        <span className="tka-dot" aria-hidden="true">·</span>
        <span className="num">since {fmtClock(openSince)}</span>
      </>
    );
  } else {
    const lastClosed = (row.intervals || [])
      .filter(i => i.endAt)
      .slice()
      .sort((a, b) => +new Date(b.endAt) - +new Date(a.endAt))[0];
    if (lastClosed) {
      const catLabel = TK_CATEGORY_LABEL[lastClosed.category] || lastClosed.category;
      statusKind = "last";
      statusBody = (
        <>
          <span className="tka-daylist-tag">Last</span>
          <span className={`tka-catchip tone-${intervalTone(lastClosed)}`}>{catLabel}</span>
          <span className="tka-dot" aria-hidden="true">·</span>
          <span className="num">{fmtClock(lastClosed.endAt)}</span>
        </>
      );
    } else {
      statusKind = "empty";
      statusBody = <span className="tka-daylist-none">No activity today</span>;
    }
  }

  // Surface the open interval's note if there is one (short notes only;
  // longer fall through to UserDayModal where they wrap properly).
  const openIv = openIntervalOf(row.intervals);
  const noteToShow = openIv?.notes ||
    (statusKind === "last" && (row.intervals || []).find(i => i.endAt && i.notes)?.notes);

  return (
    <li className={`tka-daylist-item ${isIn ? "is-in" : ""} ${showFlag ? "has-flag" : ""}`}>
      <button
        type="button"
        className="tka-daylist-btn"
        onClick={() => onOpenUserDay?.({ userId: row.user.id, date })}
      >
        <span className="tka-daylist-head">
          <span className={`avatar xs ${row.user.color}`}>{row.user.initials}</span>
          <span className="tka-daylist-name">{row.user.name}</span>
          {isIn && <InChip/>}
          <span className="tka-daylist-total num">
            {fmtHM(total, { always: true })}
            {showFlag && <Icon name="warn" size={12} className="tka-flag-inline"/>}
          </span>
        </span>

        <span className={`tka-daylist-status is-${statusKind}`}>
          <Icon name="clock" size={12}/>
          <span className="tka-daylist-status-text">{statusBody}</span>
        </span>

        {noteToShow && (
          <span className="tka-daylist-note">
            <Icon name="note" size={12}/>
            <span>{noteToShow}</span>
          </span>
        )}
      </button>
    </li>
  );
}

// Small line under the name showing the actual clock times. Switches between
// "In since 9:30a" (currently in), "9:30a → 9:38a" (clocked out), and a
// neutral "No punches yet" when the row is empty.
function PunchTimesLine({ firstIn, lastOut, openSince }) {
  if (openSince) {
    return (
      <span className="tka-daymx-times is-in">
        <Icon name="clock" size={11}/>
        <span className="num">In since {fmtClock(openSince)}</span>
        {firstIn && firstIn !== openSince && (
          <span className="tka-daymx-times-extra num">
            · first in {fmtClock(firstIn)}
          </span>
        )}
      </span>
    );
  }
  if (firstIn) {
    return (
      <span className="tka-daymx-times">
        <Icon name="clock" size={11}/>
        <span className="num">{fmtClock(firstIn)} → {lastOut ? fmtClock(lastOut) : EMPTY}</span>
      </span>
    );
  }
  return (
    <span className="tka-daymx-times is-empty">
      <Icon name="clock" size={11}/>
      <span>No punches yet</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Person cell shared by the three table grids — pinned to the left edge.
// ---------------------------------------------------------------------------
function PersonCell({ user, isIn, onClick }) {
  return (
    <th scope="row" className="tka-grid-person">
      <button type="button" className="tka-grid-personbtn" onClick={onClick}>
        <span className={`avatar xs ${user.color}`}>{user.initials}</span>
        <span className="tka-grid-personname">{user.name}</span>
        {isIn && <InChip/>}
      </button>
    </th>
  );
}

// ---------------------------------------------------------------------------
// WeekMatrix — 7 cells per user
// ---------------------------------------------------------------------------
function WeekMatrix({ rows, columns, today, onOpenUserDay, isCompact }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ClockGlyph}
        title="No hours logged this week"
        description="Once anyone in the current People selection punches in, their days fill in here."
      />
    );
  }
  return (
    <div className="bx-scroll-x tka-gridscroll">
      <table className="tka-grid">
        <caption className="sr-only">Hours worked per person for each day of the week</caption>
        <thead>
          <tr>
            <th scope="col" className="tka-grid-person tka-grid-corner">Person</th>
            {columns.map((d, i) => (
              <th key={d} scope="col" className={`tka-grid-col ${d === today ? "is-today" : ""}`}>
                <span className="tka-grid-col-dow">{DOW_LABELS[i]}</span>
                <span className="tka-grid-col-date num">{fmtDateShort(d).split(" ")[1]}</span>
              </th>
            ))}
            <th scope="col" className="tka-grid-total tka-grid-totalhead">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const byDate = new Map(r.days.map(d => [d.date, d]));
            const weekTotal = r.days.reduce((acc, d) => acc + totalMinForDay(d), 0);
            return (
              <tr key={r.user.id} className={r.openSince ? "is-in" : ""}>
                <PersonCell
                  user={r.user}
                  isIn={!!r.openSince}
                  onClick={() => onOpenUserDay?.({ userId: r.user.id, date: today })}
                />
                {columns.map((d) => {
                  const day = byDate.get(d);
                  const mins = day ? totalMinForDay(day) : 0;
                  const pct = Math.min(100, (mins / TARGET_DAY_MIN) * 100);
                  const ot  = mins > TARGET_DAY_MIN;
                  const isToday = d === today;
                  const future = d > today;
                  return (
                    <td key={d} className={`tka-grid-cell ${isToday ? "is-today" : ""} ${future ? "is-future" : ""}`}>
                      <button
                        type="button"
                        className={`tka-cell ${mins === 0 ? "is-empty" : ""} ${ot ? "is-ot" : ""}`}
                        onClick={() => onOpenUserDay?.({ userId: r.user.id, date: d })}
                        aria-label={`${r.user.name}, ${fmtDateShort(d)}, ${mins > 0 ? fmtHM(mins, { always: true }) : "no hours"}`}
                        title={`${fmtDateShort(d)} · ${fmtHM(mins, { always: true })}`}
                      >
                        <span className="tka-cell-num num">{mins > 0 ? fmtHM(mins, { always: true }) : EMPTY}</span>
                        <span className="tka-cell-bar" aria-hidden="true">
                          <span className="tka-cell-bar-fill" style={{ width: `${pct}%` }}/>
                          {ot && <span className="tka-cell-bar-ot"/>}
                        </span>
                      </button>
                    </td>
                  );
                })}
                <td className="tka-grid-total num">{fmtHM(weekTotal, { always: true })}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MonthMatrix — week-rollup view
// ---------------------------------------------------------------------------
function MonthMatrix({ rows, weeks, anchorDate, today, onOpenUserDay, isCompact }) {
  const monthStart = firstOfMonth(anchorDate);
  const monthEndX  = endOfMonthExclusive(anchorDate);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ClockGlyph}
        title="No hours logged this month"
        description="Weeks fill in as people punch. Change the month or widen the People selection to see more."
      />
    );
  }

  return (
    <div className="bx-scroll-x tka-gridscroll">
      <table className="tka-grid">
        <caption className="sr-only">Hours worked per person for each week of the month</caption>
        <thead>
          <tr>
            <th scope="col" className="tka-grid-person tka-grid-corner">Person</th>
            {weeks.map((wkStart, i) => (
              <th key={wkStart} scope="col" className="tka-grid-col">
                <span className="tka-grid-col-dow">W{i + 1}</span>
                <span className="tka-grid-col-date num">{fmtDateShort(wkStart)}</span>
              </th>
            ))}
            <th scope="col" className="tka-grid-total tka-grid-totalhead">Month total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const byDate = new Map(r.days.map(d => [d.date, d]));
            let monthTotal = 0;
            const weekTotals = weeks.map(wkStart => {
              let total = 0;
              for (let i = 0; i < 7; i++) {
                const dt = addDays(wkStart, i);
                if (dt < monthStart || dt >= monthEndX) continue;
                const day = byDate.get(dt);
                if (day) total += totalMinForDay(day);
              }
              monthTotal += total;
              return total;
            });
            const maxWeekMin = Math.max(40 * 60, ...weekTotals);   // 40h baseline
            return (
              <tr key={r.user.id} className={r.openSince ? "is-in" : ""}>
                <PersonCell
                  user={r.user}
                  isIn={!!r.openSince}
                  onClick={() => onOpenUserDay?.({ userId: r.user.id, date: today })}
                />
                {weekTotals.map((mins, i) => {
                  const pct = Math.max(4, (mins / maxWeekMin) * 100);
                  const wkStart = weeks[i];
                  return (
                    <td key={wkStart} className="tka-grid-cell">
                      <button
                        type="button"
                        className={`tka-cell ${mins === 0 ? "is-empty" : ""}`}
                        onClick={() => onOpenUserDay?.({ userId: r.user.id, date: wkStart })}
                        aria-label={`${r.user.name}, week of ${fmtDateShort(wkStart)}, ${mins > 0 ? fmtHM(mins, { always: true }) : "no hours"}`}
                        title={`Week of ${fmtDateShort(wkStart)} · ${fmtHM(mins, { always: true })}`}
                      >
                        <span className="tka-cell-num num">{mins > 0 ? fmtHM(mins, { always: true }) : EMPTY}</span>
                        <span className="tka-cell-bar" aria-hidden="true">
                          <span className="tka-cell-bar-fill" style={{ width: `${pct}%` }}/>
                        </span>
                      </button>
                    </td>
                  );
                })}
                <td className="tka-grid-total num">{fmtHM(monthTotal, { always: true })}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CustomMatrix — aggregate totals per user
// ---------------------------------------------------------------------------
function CustomMatrix({ rows, start, endExclusive, onOpenUserDay }) {
  const enriched = rows.map(r => {
    let total = 0, flagDays = 0;
    for (const d of r.days) {
      total += totalMinForDay(d);
      if (d.flags?.missing_out || d.flags?.untagged_meeting) flagDays++;
    }
    return { ...r, total, flagDays, avg: r.days.length ? total / r.days.length : 0 };
  }).sort((a, b) => b.total - a.total);

  const max = Math.max(60, ...enriched.map(e => e.total));

  if (enriched.length === 0) {
    return (
      <EmptyState
        icon={ClockGlyph}
        title="No hours in this range"
        description="Pick a wider start and end date, or widen the People selection."
      />
    );
  }

  return (
    <div className="bx-scroll-x tka-gridscroll">
      <table className="tka-grid tka-grid-custom">
        <caption className="sr-only">Total hours per person across the selected range</caption>
        <thead>
          <tr>
            <th scope="col" className="tka-grid-person tka-grid-corner">Person</th>
            <th scope="col" className="tka-grid-col tka-grid-col-wide">Distribution</th>
            <th scope="col" className="tka-grid-num">Avg / day</th>
            <th scope="col" className="tka-grid-num">Flags</th>
            <th scope="col" className="tka-grid-total tka-grid-totalhead">Total</th>
          </tr>
        </thead>
        <tbody>
          {enriched.map(r => {
            const pct = Math.max(2, (r.total / max) * 100);
            return (
              <tr key={r.user.id} className={r.openSince ? "is-in" : ""}>
                <PersonCell
                  user={r.user}
                  isIn={!!r.openSince}
                  onClick={() => onOpenUserDay?.({ userId: r.user.id, date: start })}
                />
                <td className="tka-grid-cell tka-grid-col-wide">
                  <span className="tka-distbar" aria-hidden="true">
                    <span className="tka-distbar-fill" style={{ width: `${pct}%` }}/>
                  </span>
                </td>
                <td className="tka-grid-num num">{fmtHM(r.avg, { always: true })}</td>
                <td className="tka-grid-num num">
                  {r.flagDays > 0 ? (
                    <Badge tone="danger" size="sm">
                      <Icon name="warn" size={11}/> {r.flagDays}
                    </Badge>
                  ) : EMPTY}
                </td>
                <td className="tka-grid-total num">{fmtHM(r.total, { always: true })}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
function flagTitle(flags) {
  const parts = [];
  if (flags.missing_out)      parts.push("missing punch-out");
  if (flags.untagged_meeting) parts.push("untagged meeting gap");
  if (flags.overtime_min)     parts.push(`overtime ${flags.overtime_min}m`);
  return parts.join(" · ");
}
