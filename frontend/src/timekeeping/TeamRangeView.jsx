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

import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Icon } from "../icons";
import {
  todayInCT, weekStartCT, fmtHM, fmtClock,
  loadTeamDay, loadTeamRange, getUsers,
  TK_CATEGORY_LABEL, TK_CATEGORY_TONE,
} from "../data";
import { DayTimeline } from "./DayTimeline";
import { useIsMobile } from "../use-mobile";

const TARGET_DAY_MIN = 480;   // 8h workday — bar goal
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LIVE_TICK_MS = 30_000;   // refresh "in since" + open-interval totals
const TRACK_START_HOUR = 6;
const TRACK_END_HOUR   = 20;

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
  return (d.minutesWork || 0) + (d.minutesMeeting || 0) + (d.minutesTravel || 0);
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
const WORK_LIKE_CATEGORIES = new Set(["work", "meeting", "travel"]);
function workMinutesFromIntervals(intervals, date) {
  if (!intervals || intervals.length === 0) return 0;
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const dayEnd   = dayStart + 86_400_000;
  const now      = Date.now();
  let mins = 0;
  for (const iv of intervals) {
    if (!WORK_LIKE_CATEGORIES.has(iv.category)) continue;
    const s = Math.max(new Date(iv.startAt).getTime(), dayStart);
    const e = Math.min(iv.endAt ? new Date(iv.endAt).getTime() : now, dayEnd);
    if (e > s) mins += Math.floor((e - s) / 60_000);
  }
  return mins;
}

// Most recent open interval's start (Day-mode rows carry intervals[], Range-
// mode rows carry an `openSince` string).
function openSinceFromDayRow(row) {
  const open = (row.intervals || []).find(i => !i.endAt);
  return open ? open.startAt : null;
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
export function TeamRangeView({ prefs, onPrefsChange, onOpenUserDay, dataVersion = 0 }) {
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

  // ---------- Sorting
  // Anyone currently in → top, then anyone with hours, then alpha.
  const sortRows = useCallback((arr, kind) => {
    return arr.slice().sort((a, b) => {
      const aIn = kind === "day"
        ? a.intervals.some(i => !i.endAt)
        : !!a.openSince;
      const bIn = kind === "day"
        ? b.intervals.some(i => !i.endAt)
        : !!b.openSince;
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
    const eligible = (kind, arr) => arr.filter(r => visibleSet.has(r.user.id) && matchesSearch(r.user));
    if (range === "day") {
      const list = eligible("day", dayRows);
      for (const r of list) {
        if (r.intervals.length > 0) activeUsers++;
        const openSince = openSinceFromDayRow(r);
        if (openSince) inNow++;
        totalMin += workMinutesFromIntervals(r.intervals, anchorDate);
        if (r.day?.flags?.missing_out || r.day?.flags?.untagged_meeting) daysWithFlags++;
      }
      return { totalMin, activeUsers, inNow, daysWithFlags, peopleShown: list.length };
    }
    const list = eligible("range", rows);
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
  }, [range, dayRows, rows, anchorDate, visibleSet, matchesSearch]);

  // ---------- Render
  const isCompact = prefs.density === "compact";

  return (
    <div className={`tk-range ${isCompact ? "is-compact" : ""}`}>

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

      {err && <div className="tk-range-err">Couldn't load: {err}</div>}

      <div className="tk-range-canvas">
        {range === "day" && (
          <DayMatrix
            rows={sortRows(dayRows.filter(r => visibleSet.has(r.user.id) && matchesSearch(r.user)), "day")}
            date={anchorDate}
            onOpenUserDay={onOpenUserDay}
            isCompact={isCompact}
          />
        )}
        {range === "week" && (
          <WeekMatrix
            rows={sortRows(rows.filter(r => visibleSet.has(r.user.id) && matchesSearch(r.user)), "range")}
            columns={window.columns}
            today={today}
            onOpenUserDay={onOpenUserDay}
            isCompact={isCompact}
          />
        )}
        {range === "month" && (
          <MonthMatrix
            rows={sortRows(rows.filter(r => visibleSet.has(r.user.id) && matchesSearch(r.user)), "range")}
            weeks={window.columns}
            anchorDate={anchorDate}
            today={today}
            onOpenUserDay={onOpenUserDay}
            isCompact={isCompact}
          />
        )}
        {range === "custom" && (
          <CustomMatrix
            rows={sortRows(rows.filter(r => visibleSet.has(r.user.id) && matchesSearch(r.user)), "range")}
            start={window.start}
            endExclusive={window.endExclusive}
            onOpenUserDay={onOpenUserDay}
          />
        )}

        {!busy && stats.peopleShown === 0 && (
          <div className="tk-range-empty">
            <Icon name="users" size={20}/>
            <p>No people match the current filter.</p>
            <p className="tk-range-empty-sub">Use the People menu to widen the selection or clear the search.</p>
          </div>
        )}
      </div>
    </div>
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

  return (
    <header className="tk-range-head">
      <div className="tk-range-nav">
        {range !== "custom" && (
          <>
            <button type="button" className="tk-icon-btn" onClick={() => onShift(-1)} aria-label="Previous">
              <Icon name="back" size={14}/>
            </button>
            <button type="button" className="tk-icon-btn" onClick={() => onShift(+1)} aria-label="Next">
              <Icon name="forward" size={14}/>
            </button>
          </>
        )}
        <div className="tk-range-title-wrap">
          <span className="tk-range-eyebrow">
            {range === "day" ? "Day" : range === "week" ? "Week" : range === "month" ? "Month" : "Custom range"}
            {busy && <span className="tk-range-busy"> · refreshing</span>}
          </span>
          <h2 className="tk-range-title">{title}</h2>
        </div>
        {!isToday && range !== "custom" && (
          <button type="button" className="tk-pill-btn" onClick={onJumpToday}>
            <Icon name="clock" size={11}/> Today
          </button>
        )}
      </div>

      <div className="tk-range-side">
        {range === "day" && (
          <input
            type="date"
            className="tk-day-input"
            value={anchorDate}
            max={today}
            onChange={e => onAnchorPick(e.target.value || today)}
          />
        )}
        {range === "week" && (
          <input
            type="date"
            className="tk-day-input"
            value={anchorDate}
            max={today}
            onChange={e => onAnchorPick(e.target.value || today)}
          />
        )}
        {range === "month" && (
          <input
            type="month"
            className="tk-day-input"
            value={anchorDate.slice(0, 7)}
            max={today.slice(0, 7)}
            onChange={e => onAnchorPick(e.target.value ? `${e.target.value}-01` : today)}
          />
        )}
        {range === "custom" && (
          <span className="tk-custom-inputs">
            <input
              type="date"
              className="tk-day-input"
              value={customStart || today}
              max={today}
              onChange={e => onCustomStart(e.target.value || today)}
              aria-label="Start date"
            />
            <span className="tk-custom-sep">→</span>
            <input
              type="date"
              className="tk-day-input"
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
    { key: "in",     label: "Currently in",  value: stats.inNow,      sub: "right now",  tone: "accent", pulse: stats.inNow > 0 },
    { key: "active", label: "Active",        value: stats.activeUsers, sub: "people",     tone: "sage" },
    { key: "hours",  label: "Hours logged",  value: fmtHM(stats.totalMin, { always: true }), sub: rangeWord(range), tone: "blue", asString: true },
    { key: "flags",  label: "Needs review",  value: stats.daysWithFlags, sub: "flagged days", tone: stats.daysWithFlags > 0 ? "rose" : "muted" },
  ];
  return (
    <div className="tk-stat-grid">
      {tiles.map(t => (
        <div key={t.key} className={`tk-stat-tile tone-${t.tone}`}>
          <div className="tk-stat-tile-label">{t.label}</div>
          <div className="tk-stat-tile-value">
            {t.pulse && <span className="tk-pulse-dot tk-stat-pulse"/>}
            {t.asString ? t.value : Number(t.value).toLocaleString()}
          </div>
          <div className="tk-stat-tile-sub">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}

function rangeWord(r) {
  return r === "day" ? "this day" : r === "week" ? "this week" : r === "month" ? "this month" : "in range";
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
      <ul className="tk-day-matrix tk-day-matrix-mobile">
        {rows.map(r => (
          <DayMatrixMobileRow
            key={r.user.id}
            row={r}
            date={date}
            onOpenUserDay={onOpenUserDay}
          />
        ))}
        {rows.length === 0 && (
          <li className="tk-range-empty-row">No activity for the visible people on this day.</li>
        )}
      </ul>
    );
  }

  return (
    <div className="tk-day-matrix-wrap">
      {/* Shared hour grid above all rows so positions are readable. */}
      <div className="tk-day-matrix-axis" aria-hidden="true">
        <div className="tk-day-matrix-axis-spacer"/>
        <div className="tk-day-matrix-axis-track">
          {hourTicks.map(h => (
            <span key={h} className="tk-day-matrix-axis-tick"
              style={{ left: `${((h - TRACK_START_HOUR) / span) * 100}%` }}>
              {h === 12 ? "12p" : h > 12 ? `${h - 12}p` : `${h}a`}
            </span>
          ))}
        </div>
        <div className="tk-day-matrix-axis-spacer"/>
      </div>

      <ul className="tk-day-matrix">
        {rows.map(r => {
          const openSince = openSinceFromDayRow(r);
          const isIn  = !!openSince;
          const total = workMinutesFromIntervals(r.intervals, date);
          const flags = r.day?.flags || {};
          const showFlag = flags.missing_out || flags.untagged_meeting;
          const bounds = dayPunchBounds(r);
          return (
            <li key={r.user.id} className={`tk-day-matrix-row ${isIn ? "is-in" : ""} ${showFlag ? "has-flag" : ""}`}>
              <button className="tk-day-matrix-name" onClick={() => onOpenUserDay?.({ userId: r.user.id, date })}>
                <div className="tk-day-matrix-name-top">
                  <span className={`avatar xs ${r.user.color}`}>{r.user.initials}</span>
                  <span className="tk-day-matrix-name-label">{r.user.name}</span>
                  {isIn && <span className="tk-in-chip"><span className="tk-pulse-dot"/>In</span>}
                </div>
                <PunchTimesLine
                  firstIn={bounds.firstIn}
                  lastOut={bounds.lastOut}
                  openSince={openSince}
                />
              </button>
              <div className="tk-day-matrix-timeline">
                <DayTimeline
                  date={date}
                  intervals={r.intervals}
                  onIntervalClick={() => onOpenUserDay?.({ userId: r.user.id, date })}
                  height={isCompact ? 18 : 24}
                  showHourGrid={false}
                />
              </div>
              <div className="tk-day-matrix-total">
                <span className="tk-num">{fmtHM(total, { always: true })}</span>
                {showFlag && <span className="tk-flag-dot" title={flagTitle(flags)}/>}
              </div>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="tk-range-empty-row">No activity for the visible people on this day.</li>
        )}
      </ul>
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
        <span className="tk-day-matrix-mob-status-cat">Working</span>
        <span className="tk-day-matrix-mob-status-sep">·</span>
        <span>since {fmtClock(openSince)}</span>
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
          <span className="tk-day-matrix-mob-status-tag">Last</span>
          <span className={`tk-day-matrix-mob-cat-chip tone-${TK_CATEGORY_TONE[lastClosed.category] || "muted"}`}>
            {catLabel}
          </span>
          <span className="tk-day-matrix-mob-status-sep">·</span>
          <span>{fmtClock(lastClosed.endAt)}</span>
        </>
      );
    } else {
      statusKind = "empty";
      statusBody = <span className="tk-day-matrix-mob-empty">No activity today</span>;
    }
  }

  // Surface the open interval's note if there is one (short notes only;
  // longer fall through to UserDayModal where they wrap properly).
  const openIv = (row.intervals || []).find(i => !i.endAt);
  const noteToShow = openIv?.notes ||
    (statusKind === "last" && (row.intervals || []).find(i => i.endAt && i.notes)?.notes);

  return (
    <li className={`tk-day-matrix-row tk-day-matrix-mob ${isIn ? "is-in" : ""} ${showFlag ? "has-flag" : ""}`}>
      <button
        type="button"
        className="tk-day-matrix-mob-btn"
        onClick={() => onOpenUserDay?.({ userId: row.user.id, date })}
      >
        <div className="tk-day-matrix-mob-head">
          <span className={`avatar xs ${row.user.color}`}>{row.user.initials}</span>
          <span className="tk-day-matrix-mob-name">{row.user.name}</span>
          {isIn && <span className="tk-in-chip"><span className="tk-pulse-dot"/>In</span>}
          <span className="tk-day-matrix-mob-total">
            {fmtHM(total, { always: true })}
            {showFlag && <span className="tk-flag-dot" title={flagTitle(flags)}/>}
          </span>
        </div>

        <div className={`tk-day-matrix-mob-status is-${statusKind}`}>
          <Icon name="clock" size={11}/>
          <span className="tk-day-matrix-mob-status-text">{statusBody}</span>
        </div>

        {noteToShow && (
          <div className="tk-day-matrix-mob-note">
            <Icon name="edit" size={11}/>
            <span>{noteToShow}</span>
          </div>
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
      <div className="tk-day-matrix-times is-in">
        <Icon name="clock" size={10}/>
        <span className="tk-num">In since {fmtClock(openSince)}</span>
        {firstIn && firstIn !== openSince && (
          <span className="tk-day-matrix-times-extra">
            · first in {fmtClock(firstIn)}
          </span>
        )}
      </div>
    );
  }
  if (firstIn) {
    return (
      <div className="tk-day-matrix-times">
        <Icon name="clock" size={10}/>
        <span className="tk-num">{fmtClock(firstIn)} → {lastOut ? fmtClock(lastOut) : "—"}</span>
      </div>
    );
  }
  return (
    <div className="tk-day-matrix-times is-empty">
      <Icon name="clock" size={10}/>
      <span>No punches yet</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WeekMatrix — 7 cells per user
// ---------------------------------------------------------------------------
function WeekMatrix({ rows, columns, today, onOpenUserDay, isCompact }) {
  return (
    <div className="tk-week-matrix">
      <div className="tk-week-matrix-head">
        <div className="tk-week-matrix-spacer"/>
        {columns.map((d, i) => (
          <div key={d} className={`tk-week-matrix-col-head ${d === today ? "is-today" : ""}`}>
            <div className="tk-week-matrix-col-dow">{DOW_LABELS[i]}</div>
            <div className="tk-week-matrix-col-date">{fmtDateShort(d).split(" ")[1]}</div>
          </div>
        ))}
        <div className="tk-week-matrix-total-head">Total</div>
      </div>
      <ul className="tk-week-matrix-rows">
        {rows.map(r => {
          const byDate = new Map(r.days.map(d => [d.date, d]));
          const weekTotal = r.days.reduce((acc, d) => acc + totalMinForDay(d), 0);
          return (
            <li key={r.user.id} className={`tk-week-matrix-row ${r.openSince ? "is-in" : ""}`}>
              <button className="tk-week-matrix-name" onClick={() => onOpenUserDay?.({ userId: r.user.id, date: today })}>
                <span className={`avatar xs ${r.user.color}`}>{r.user.initials}</span>
                <span className="tk-week-matrix-name-label">{r.user.name}</span>
                {r.openSince && <span className="tk-in-chip"><span className="tk-pulse-dot"/>In</span>}
              </button>
              {columns.map((d) => {
                const day = byDate.get(d);
                const mins = day ? totalMinForDay(day) : 0;
                const pct = Math.min(100, (mins / TARGET_DAY_MIN) * 100);
                const ot  = mins > TARGET_DAY_MIN;
                const isToday = d === today;
                const future = d > today;
                return (
                  <button
                    key={d}
                    type="button"
                    className={`tk-week-cell ${isToday ? "is-today" : ""} ${future ? "is-future" : ""} ${mins === 0 ? "is-empty" : ""} ${ot ? "is-ot" : ""}`}
                    onClick={() => onOpenUserDay?.({ userId: r.user.id, date: d })}
                    title={`${fmtDateShort(d)} · ${fmtHM(mins, { always: true })}`}
                  >
                    <div className="tk-week-cell-num">{mins > 0 ? fmtHM(mins, { always: true }) : "—"}</div>
                    <div className="tk-week-cell-bar">
                      <div className="tk-week-cell-bar-fill" style={{ width: `${pct}%` }}/>
                      {ot && <div className="tk-week-cell-bar-ot"/>}
                    </div>
                  </button>
                );
              })}
              <div className="tk-week-matrix-total">{fmtHM(weekTotal, { always: true })}</div>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="tk-range-empty-row">No activity for the visible people this week.</li>
        )}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MonthMatrix — week-rollup view
// ---------------------------------------------------------------------------
function MonthMatrix({ rows, weeks, anchorDate, today, onOpenUserDay, isCompact }) {
  const monthStart = firstOfMonth(anchorDate);
  const monthEndX  = endOfMonthExclusive(anchorDate);

  const styleVar = { "--mm-cols": weeks.length };
  return (
    <div className="tk-month-matrix" style={styleVar}>
      <div className="tk-month-matrix-head">
        <div className="tk-month-matrix-spacer"/>
        {weeks.map((wkStart, i) => (
          <div key={wkStart} className="tk-month-matrix-col-head">
            <div className="tk-month-matrix-col-wk">W{i + 1}</div>
            <div className="tk-month-matrix-col-range">{fmtDateShort(wkStart)}</div>
          </div>
        ))}
        <div className="tk-month-matrix-total-head">Month total</div>
      </div>
      <ul className="tk-month-matrix-rows">
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
            <li key={r.user.id} className={`tk-month-matrix-row ${r.openSince ? "is-in" : ""}`}>
              <button className="tk-month-matrix-name" onClick={() => onOpenUserDay?.({ userId: r.user.id, date: today })}>
                <span className={`avatar xs ${r.user.color}`}>{r.user.initials}</span>
                <span className="tk-month-matrix-name-label">{r.user.name}</span>
                {r.openSince && <span className="tk-in-chip"><span className="tk-pulse-dot"/>In</span>}
              </button>
              {weekTotals.map((mins, i) => {
                const pct = Math.max(4, (mins / maxWeekMin) * 100);
                const wkStart = weeks[i];
                return (
                  <button
                    key={wkStart}
                    type="button"
                    className={`tk-month-cell ${mins === 0 ? "is-empty" : ""}`}
                    onClick={() => onOpenUserDay?.({ userId: r.user.id, date: wkStart })}
                    title={`Week of ${fmtDateShort(wkStart)} · ${fmtHM(mins, { always: true })}`}
                  >
                    <div className="tk-month-cell-num">{mins > 0 ? fmtHM(mins, { always: true }) : "—"}</div>
                    <div className="tk-month-cell-bar">
                      <div className="tk-month-cell-bar-fill" style={{ width: `${pct}%` }}/>
                    </div>
                  </button>
                );
              })}
              <div className="tk-month-matrix-total">{fmtHM(monthTotal, { always: true })}</div>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="tk-range-empty-row">No activity for the visible people this month.</li>
        )}
      </ul>
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

  return (
    <div className="tk-custom-matrix">
      <div className="tk-custom-matrix-head">
        <div>Person</div>
        <div>Distribution</div>
        <div className="tk-custom-avg">Avg / day</div>
        <div className="tk-custom-flags">Flags</div>
        <div className="tk-custom-total">Total</div>
      </div>
      <ul className="tk-custom-matrix-rows">
        {enriched.map(r => {
          const pct = Math.max(2, (r.total / max) * 100);
          return (
            <li key={r.user.id} className={`tk-custom-matrix-row ${r.openSince ? "is-in" : ""}`}>
              <button className="tk-custom-matrix-name" onClick={() => onOpenUserDay?.({ userId: r.user.id, date: start })}>
                <span className={`avatar xs ${r.user.color}`}>{r.user.initials}</span>
                <span className="tk-custom-matrix-name-label">{r.user.name}</span>
                {r.openSince && <span className="tk-in-chip"><span className="tk-pulse-dot"/>In</span>}
              </button>
              <div className="tk-custom-bar">
                <div className="tk-custom-bar-fill" style={{ width: `${pct}%` }}/>
              </div>
              <div className="tk-custom-avg">{fmtHM(r.avg, { always: true })}</div>
              <div className="tk-custom-flags">{r.flagDays > 0 ? `${r.flagDays}` : "—"}</div>
              <div className="tk-custom-total">{fmtHM(r.total, { always: true })}</div>
            </li>
          );
        })}
        {enriched.length === 0 && (
          <li className="tk-range-empty-row">No activity in this range.</li>
        )}
      </ul>
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
