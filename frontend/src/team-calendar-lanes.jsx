// Team Calendar — the PEOPLE LANE layout.
//
// The second of the page's two layouts. Where the traditional grid gives the
// week one shared time axis and stacks everybody into it, this one gives each
// person their own row and puts time on the X axis. Which one renders is the
// user's choice, held in `beacon.teamCalendar.layout` and switched from the
// toolbar; see CAL_LAYOUTS in team-calendar.jsx.
//
// The two layouts answer different questions. The grid answers "what is
// happening at 10am" and is the familiar shape. Lanes answer "who is free at
// 10am", which a shared grid cannot show at this roster's density: sixteen
// calendars in one column means every concurrent event competes for the same
// horizontal space, and at 16 people the column arithmetic leaves each block
// too narrow to label. A lane holds exactly one calendar, so two blocks can
// only compete when that person is genuinely double-booked, which stacks into
// sub-rows instead.
//
// Day, Week and Month here are custom react-big-calendar views passed through
// `views={{...}}`. `Calendar` still owns onNavigate, onView, onSelectEvent,
// onDrillDown, the toolbar and the view switch; each view carries the same
// `navigate`, `range` and `title` statics as the library view it stands in
// for, so navigation behaves identically in both layouts. Agenda is rbc's own
// in both.
//
// Read-only, like the grid: no selectable, no onSelectSlot, no drag/drop.
// Nothing here fetches or writes; it is arithmetic over events already loaded.
// ---------------------------------------------------------------------------

import React, { useMemo } from "react";
import {
  format, startOfDay, endOfDay, addDays,
  startOfWeek as dfnsStartOfWeek,
} from "date-fns";
import { Icon } from "./icons.jsx";
import {
  Badge, Button,
  Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle,
} from "@/ui";
import {
  EMPTY, IDENT, Swatch, ownerIdentity, fmtTime, attendeeCount,
} from "./team-calendar-shared.jsx";



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

// One sentence describing an event completely. It is BOTH a block's accessible
// name (an `.sr-only` span, with every visible part marked `aria-hidden`, so a
// screen reader gets the whole event rather than whatever survived the layout)
// and its hover tooltip. Commas, never dashes, so it reads as a sentence when
// spoken.
function fullEventLabel(event) {
  const r = event.resource || {};
  const bits = [ownerIdentity(r).name, event.title];
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
export function DayLanes({ date, laneEvents = [], laneUsers = [], onSelectEvent }) {
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

export function WeekMatrix({ date, laneEvents = [], laneUsers = [], onOpenDayList }) {
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
export function TeamMonth({ date, laneEvents = [], laneUsers = [], localizer, onDrillDown }) {
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

export function DayListDialog({ group, onOpenEvent, onClose }) {
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

