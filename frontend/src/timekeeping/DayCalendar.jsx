// DayCalendar — vertical day view of a user's punches and intervals.
//
// Visual model:
//   • 6 AM → 8 PM vertical scroll at 56 px per hour (touch-comfortable).
//   • Each closed interval becomes a colored card positioned + sized by its
//     start_at / end_at within the visible window. Category tone matches the
//     palette used elsewhere (tone-{accent|sage|blue|rose|muted}).
//   • The currently-open interval (end_at = null) extends to "now" and pulses
//     a subtle animated stripe on its left edge so the user feels their
//     working time accumulating.
//   • Each punch becomes a labeled chip ▶ IN  / ■ OUT  on the hour rail with
//     the wall-clock time printed in tabular monospace. The chips alternate
//     left/right so they don't collide with the interval cards.
//   • If today, a thin red "now" line crosses the calendar at the current
//     minute.
//
// Interaction:
//   • Click an interval card → reclassify popover (parent owns the modal).
//   • Click the empty rail or "+ tag this gap" affordance on an unclassified
//     interval → same popover.
//
// Side note on aesthetics: the visual mirrors the Events calendar layout in
// the rest of the app on purpose — the user already has a mental model of
// reading "blocks on a vertical hour track" from there, so we lean into it
// instead of inventing a new metaphor for the same data.

import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import {
  TK_CATEGORY_TONE, TK_CATEGORY_LABEL, fmtClock, fmtHM,
  computeOutGaps, WORKDAY_START_MIN, WORKDAY_END_MIN, ctMinutesOfIso,
} from "../data";
import { useIsMobile } from "../use-mobile";

const TZ                = "America/Chicago";
const TRACK_START_HOUR  = 6;
const TRACK_END_HOUR    = 20;
const HOUR_HEIGHT       = 56;           // px per hour
const TRACK_HEIGHT      = (TRACK_END_HOUR - TRACK_START_HOUR) * HOUR_HEIGHT;
const NOW_TICK_MS       = 30_000;

// Convert "minutes since midnight CT" to a vertical px position in the track,
// clamped to the visible 6 AM – 8 PM window. Mirrors pxForHour but for finer
// resolution (the coverage overlay needs to start/end mid-hour).
function pxForMin(minSinceMidnight) {
  const h = minSinceMidnight / 60;
  const clamped = Math.max(TRACK_START_HOUR, Math.min(TRACK_END_HOUR, h));
  return (clamped - TRACK_START_HOUR) * HOUR_HEIGHT;
}

function hoursInCT(iso) {
  // Fractional hours since CT midnight for any ISO timestamp.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(iso));
  const h = +parts.find(p => p.type === "hour"  )?.value || 0;
  const m = +parts.find(p => p.type === "minute")?.value || 0;
  return h + m / 60;
}

function clampToTrack(h) {
  return Math.max(TRACK_START_HOUR, Math.min(TRACK_END_HOUR, h));
}

function pxForHour(h) {
  return (clampToTrack(h) - TRACK_START_HOUR) * HOUR_HEIGHT;
}

function fmtHourLabel(hour) {
  if (hour === 0)   return "12a";
  if (hour === 12)  return "noon";
  if (hour < 12)    return `${hour}a`;
  return `${hour - 12}p`;
}

// "minutes since midnight" → "9:15a" / "12:30p" — used in gap tooltips.
function fmtFromMin(min) {
  const h24 = Math.floor(min / 60);
  const m   = min % 60;
  const ampm = h24 >= 12 ? "p" : "a";
  const h12  = ((h24 + 11) % 12) + 1;
  return `${h12}:${m.toString().padStart(2, "0")}${ampm}`;
}

export function DayCalendar({
  date,
  intervals = [],
  punches = [],
  onIntervalClick,
  onAddTagForInterval,        // optional — opens reclassify on an untagged interval
}) {
  const isMobile = useIsMobile();
  const isToday = date === new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  // ALL hooks must run on every render before any conditional return — rules
  // of hooks. We compute everything the desktop layout needs, then branch.
  const [nowTick, setNowTick] = useState(0);
  const scrollerRef = useRef(null);

  // Re-render every 30 sec so the "now" line creeps + the open interval grows.
  useEffect(() => {
    if (!isToday) return undefined;
    const id = setInterval(() => setNowTick(t => t + 1), NOW_TICK_MS);
    return () => clearInterval(id);
  }, [isToday]);

  // On mount + when intervals change, scroll the track so the first activity
  // is visible (or current time if today). Without this the user lands at the
  // top of the track on tall calendars.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let target = 8 * HOUR_HEIGHT - 2 * HOUR_HEIGHT;  // default near 8 AM
    if (isToday) {
      const nowH = hoursInCT(new Date().toISOString());
      target = (clampToTrack(nowH) - TRACK_START_HOUR) * HOUR_HEIGHT - 2 * HOUR_HEIGHT;
    } else if (intervals.length > 0) {
      const firstH = hoursInCT(intervals[0].startAt);
      target = (clampToTrack(firstH) - TRACK_START_HOUR) * HOUR_HEIGHT - 2 * HOUR_HEIGHT;
    }
    el.scrollTop = Math.max(0, target);
    // Intentionally only on mount + when the day rolls over; not on every nowTick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // ----- prepare interval blocks -----
  const blocks = (intervals || []).map((iv) => {
    let startH = hoursInCT(iv.startAt);
    let endH   = iv.endAt ? hoursInCT(iv.endAt) : hoursInCT(new Date().toISOString());

    // Clamp same-day rendering; cross-day intervals are pinned to today's edges.
    if (date) {
      const ctStart = new Date(iv.startAt).toLocaleDateString("en-CA", { timeZone: TZ });
      const ctEnd   = iv.endAt
        ? new Date(iv.endAt).toLocaleDateString("en-CA", { timeZone: TZ })
        : ctStart;
      if (ctStart !== date && ctEnd !== date) return null;     // not this day
      if (ctStart !== date) startH = TRACK_START_HOUR;
      if (ctEnd   !== date && iv.endAt) endH   = TRACK_END_HOUR;
    }

    const top    = pxForHour(startH);
    const bottom = pxForHour(endH);
    const height = Math.max(18, bottom - top);   // min 18 px so brief breaks remain clickable
    return { iv, top, height, startH, endH, isOpen: iv.endAt == null };
  }).filter(Boolean);

  // ----- prepare punch markers -----
  const punchMarks = (punches || []).map((p, i) => {
    const hour = hoursInCT(p.punchedAt);
    if (hour < TRACK_START_HOUR || hour > TRACK_END_HOUR) return null;
    return {
      p,
      top:   pxForHour(hour) - 11,                  // visually center the chip on the line
      side:  i % 2 === 0 ? "left" : "right",        // alternate sides so they don't collide
      // odd-index punches are OUT in the toggle model (1=IN, 2=OUT, 3=IN, ...)
      kind:  i % 2 === 0 ? "in" : "out",
    };
  }).filter(Boolean);

  // ----- coverage overlay (workday band + red OUT gaps) -----
  // Recompute on every nowTick so the cutoff trails real time.
  void nowTick;
  const workdayTop    = pxForMin(WORKDAY_START_MIN);
  const workdayBottom = pxForMin(WORKDAY_END_MIN);
  const gaps = computeOutGaps({ intervals, date });

  // ----- "now" line -----
  const nowLineTop = isToday
    ? pxForHour(hoursInCT(new Date().toISOString()))
    : null;

  // Mobile branch — vertical list view. Defers to <DayList/> so the
  // hour-rail data prep above stays a no-op when phones render.
  if (isMobile) {
    return (
      <DayList
        date={date}
        intervals={intervals}
        gaps={gaps}
        onIntervalClick={onIntervalClick}
        onAddTagForInterval={onAddTagForInterval}
        isToday={isToday}
      />
    );
  }

  return (
    <div className="tk-cal-wrap">
      <div className="tk-cal-scroller" ref={scrollerRef}>
        <div className="tk-cal-track" style={{ height: TRACK_HEIGHT }}>

          {/* hour gutter on the left */}
          <div className="tk-cal-gutter" aria-hidden="true">
            {Array.from({ length: TRACK_END_HOUR - TRACK_START_HOUR + 1 }, (_, i) => {
              const hour = TRACK_START_HOUR + i;
              return (
                <div key={hour} className="tk-cal-hour-label"
                     style={{ top: pxForHour(hour) - 7 }}>
                  {fmtHourLabel(hour)}
                </div>
              );
            })}
          </div>

          {/* hour grid lines */}
          <div className="tk-cal-grid" aria-hidden="true">
            {Array.from({ length: TRACK_END_HOUR - TRACK_START_HOUR + 1 }, (_, i) => (
              <div key={i} className="tk-cal-hour-line"
                   style={{ top: i * HOUR_HEIGHT }}/>
            ))}
            {Array.from({ length: TRACK_END_HOUR - TRACK_START_HOUR }, (_, i) => (
              <div key={`h-${i}`} className="tk-cal-half-line"
                   style={{ top: i * HOUR_HEIGHT + HOUR_HEIGHT / 2 }}/>
            ))}
          </div>

          {/* Workday window band — quietly delineates 8a–5p so the user
              knows what "expected to be working" means. Behind everything. */}
          <div
            className="tk-cal-workday-band"
            style={{ top: workdayTop, height: workdayBottom - workdayTop }}
            aria-hidden="true"
          >
            <span className="tk-cal-workday-tag">Workday · 8a – 5p</span>
          </div>

          {/* Red OUT-gap overlay. Sits between the workday band and the
              interval cards so cards still receive clicks. */}
          {gaps.map(([startMin, endMin], i) => {
            const top    = pxForMin(startMin);
            const height = Math.max(8, pxForMin(endMin) - top);
            const span   = endMin - startMin;
            return (
              <div
                key={`gap-${i}`}
                className="tk-cal-gap"
                style={{ top, height }}
                title={`Out · ${fmtHM(span)} (${fmtFromMin(startMin)} – ${fmtFromMin(endMin)})`}
                aria-hidden="true"
              >
                {height > 30 && (
                  <span className="tk-cal-gap-label">
                    Out · {fmtHM(span)}
                  </span>
                )}
              </div>
            );
          })}

          {/* interval cards */}
          <div className="tk-cal-cards">
            {blocks.map(({ iv, top, height, isOpen }) => {
              const tone     = TK_CATEGORY_TONE[iv.category] || "muted";
              const isUntag  = iv.category === "meeting_untagged" && iv.categorySource !== "user" && iv.categorySource !== "admin";
              const compact  = height < 44;
              return (
                <button key={iv.id} type="button"
                  className={`tk-cal-card tone-${tone} ${isOpen ? "is-open" : ""} ${isUntag ? "is-untagged" : ""} ${compact ? "is-compact" : ""}`}
                  style={{ top, height }}
                  onClick={() => (isUntag && onAddTagForInterval)
                    ? onAddTagForInterval(iv)
                    : onIntervalClick?.(iv)}
                  data-category={iv.category}
                  data-source={iv.categorySource}>
                  {isOpen && <span className="tk-cal-card-pulse" aria-hidden="true"/>}
                  <div className="tk-cal-card-inner">
                    <div className="tk-cal-card-times">
                      <span className="tk-cal-card-time">{fmtClock(iv.startAt)}</span>
                      <span className="tk-cal-card-arrow">→</span>
                      <span className="tk-cal-card-time">{iv.endAt ? fmtClock(iv.endAt) : "now"}</span>
                      {iv.durationMinutes != null && (
                        <span className="tk-cal-card-duration">· {fmtHM(iv.durationMinutes)}</span>
                      )}
                      {isOpen && <span className="tk-cal-card-duration">· in progress</span>}
                    </div>
                    {!compact && (
                      <div className="tk-cal-card-title">
                        {iv.outlookEventSubject || TK_CATEGORY_LABEL[iv.category] || iv.category}
                      </div>
                    )}
                    {!compact && iv.notes && (
                      <div className="tk-cal-card-note" title={iv.notes}>
                        <Icon name="edit" size={11}/>
                        <span className="tk-cal-card-note-text">{iv.notes}</span>
                      </div>
                    )}
                    {!compact && (
                      <div className="tk-cal-card-foot">
                        <span className="tk-cal-card-tag">
                          {iv.outlookEventId && <Icon name="link" size={11}/>}
                          {TK_CATEGORY_LABEL[iv.category] || iv.category}
                        </span>
                        {isUntag && (
                          <span className="tk-cal-card-cta">
                            <Icon name="edit" size={11}/> tag this
                          </span>
                        )}
                        {!isUntag && iv.categorySource !== "user" && iv.categorySource !== "admin" && (
                          <span className="tk-cal-card-src">{iv.categorySource}</span>
                        )}
                        {(iv.categorySource === "user" || iv.categorySource === "admin") && (
                          <span className="tk-cal-card-src is-user">
                            <Icon name="check" size={11}/> set by {iv.categorySource}
                          </span>
                        )}
                      </div>
                    )}
                    {compact && iv.notes && (
                      <span
                        className="tk-cal-card-note-dot"
                        title={iv.notes}
                        aria-label={`Note: ${iv.notes}`}
                      />
                    )}
                  </div>
                </button>
              );
            })}
            {blocks.length === 0 && (
              <div className="tk-cal-empty">
                <Icon name="clock" size={20}/>
                <span>No punches on this day</span>
              </div>
            )}
          </div>

          {/* punch markers (IN / OUT) */}
          <div className="tk-cal-markers" aria-hidden="false">
            {punchMarks.map(({ p, top, side, kind }) => (
              <div key={p.id}
                   className={`tk-cal-mark tk-cal-mark-${kind} side-${side}`}
                   style={{ top }}>
                <span className="tk-cal-mark-dot"/>
                <span className="tk-cal-mark-time">{fmtClock(p.punchedAt)}</span>
                <span className="tk-cal-mark-kind">{kind === "in" ? "IN" : "OUT"}</span>
                <span className={`tk-cal-mark-src tk-cal-mark-src-${p.source}`}>{p.source}</span>
              </div>
            ))}
          </div>

          {/* now line */}
          {nowLineTop != null && (
            <div className="tk-cal-now" style={{ top: nowLineTop }} aria-hidden="true">
              <span className="tk-cal-now-dot"/>
              <span className="tk-cal-now-line"/>
              <span className="tk-cal-now-label">
                now · {new Date().toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" })}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DayList — phone-first vertical list. Replaces the absolute-positioned
// hour rail on viewports ≤ 640 px so:
//   • Short intervals (a 2-min break) get a full row instead of a 2-px sliver
//   • Adjacent / overlapping events stack vertically; no overlap possible
//   • Category + note + Outlook subject + source are always visible
//   • Tap target is the full row (~64+ px tall)
//
// Items are intervals + computed OUT-gap rows, interleaved in REVERSE-CHRONO
// so the currently-open / most-recent activity sits at the top of the list
// (where the user's thumb naturally lands after scrolling past the hero).
// ---------------------------------------------------------------------------
function DayList({
  date,
  intervals = [],
  gaps = [],
  onIntervalClick,
  onAddTagForInterval,
  isToday,
}) {
  // Sort + interleave (interval startMin, gap startMin).
  const items = [];
  for (const iv of intervals) {
    items.push({ kind: "interval", startMin: ctMinutesOfIso(iv.startAt), iv });
  }
  for (const [s, e] of gaps) {
    items.push({ kind: "gap", startMin: s, endMin: e });
  }
  items.sort((a, b) => b.startMin - a.startMin);

  const closedCount = intervals.filter(i => i.endAt).length;
  const openCount   = intervals.filter(i => !i.endAt).length;

  return (
    <div className="tk-day-list">
      <div className="tk-day-list-meta">
        <span className="tk-day-list-meta-band">Workday · 8a – 5p</span>
        <span className="tk-day-list-meta-stat">
          {intervals.length} {intervals.length === 1 ? "interval" : "intervals"}
          {openCount > 0 && <> · <span className="tk-pulse-dot"/> 1 open</>}
          {gaps.length > 0 && ` · ${gaps.length} gap${gaps.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {items.length === 0 && (
        <div className="tk-day-list-empty">
          <Icon name="clock" size={18}/>
          <span>No punches on this day</span>
        </div>
      )}

      {items.map((item, i) =>
        item.kind === "interval"
          ? <DayListIntervalCard
              key={item.iv.id || `iv-${i}`}
              iv={item.iv}
              isToday={isToday}
              onClick={() => {
                const isUntag = item.iv.category === "meeting_untagged" &&
                  item.iv.categorySource !== "user" &&
                  item.iv.categorySource !== "admin";
                if (isUntag && onAddTagForInterval) onAddTagForInterval(item.iv);
                else onIntervalClick?.(item.iv);
              }}
            />
          : <DayListGapRow
              key={`gap-${item.startMin}-${item.endMin}`}
              startMin={item.startMin}
              endMin={item.endMin}
            />
      )}
    </div>
  );
}

function DayListIntervalCard({ iv, isToday, onClick }) {
  const isOpen     = iv.endAt == null;
  const isUntagged = iv.category === "meeting_untagged" && iv.categorySource !== "user" && iv.categorySource !== "admin";
  const tone       = TK_CATEGORY_TONE[iv.category] || "muted";
  const minutes    = iv.durationMinutes != null
    ? iv.durationMinutes
    : Math.max(0, Math.floor((Date.now() - +new Date(iv.startAt)) / 60_000));

  return (
    <button
      type="button"
      className={`tk-day-list-card tone-${tone} ${isOpen ? "is-open" : ""} ${isUntagged ? "is-untagged" : ""}`}
      onClick={onClick}
      data-category={iv.category}
      data-source={iv.categorySource}
    >
      <div className="tk-day-list-card-head">
        <div className="tk-day-list-card-time">
          <span className="tk-day-list-card-time-from">{fmtClock(iv.startAt)}</span>
          <Icon name="forward" size={11}/>
          <span className="tk-day-list-card-time-to">
            {iv.endAt ? fmtClock(iv.endAt) : "now"}
          </span>
        </div>
        <div className="tk-day-list-card-dur">
          {isOpen && isToday ? <><span className="tk-pulse-dot"/> {fmtHM(minutes)}</> : fmtHM(minutes)}
        </div>
      </div>

      <div className="tk-day-list-card-chips">
        <span className="tk-day-list-card-chip">
          <span className="tk-day-list-card-dot"/>
          {TK_CATEGORY_LABEL[iv.category] || iv.category}
        </span>
        {iv.outlookEventId && (
          <span className="tk-day-list-card-chip tk-day-list-card-chip-outlook">
            <Icon name="link" size={11}/> Outlook
          </span>
        )}
        {(iv.categorySource === "user" || iv.categorySource === "admin") && (
          <span className="tk-day-list-card-chip tk-day-list-card-chip-confirmed">
            <Icon name="check" size={11}/> {iv.categorySource}
          </span>
        )}
        {isUntagged && (
          <span className="tk-day-list-card-chip tk-day-list-card-chip-cta">
            <Icon name="edit" size={11}/> tag this
          </span>
        )}
      </div>

      {iv.outlookEventSubject && (
        <div className="tk-day-list-card-outlook-line">
          📅 {iv.outlookEventSubject}
          {iv.outlookEventLocation && <span className="tk-day-list-card-loc"> · {iv.outlookEventLocation}</span>}
        </div>
      )}
      {iv.notes && (
        <div className="tk-day-list-card-note">
          <Icon name="edit" size={11}/> <span>{iv.notes}</span>
        </div>
      )}
    </button>
  );
}

function DayListGapRow({ startMin, endMin }) {
  return (
    <div className="tk-day-list-gap" aria-hidden="false">
      <div className="tk-day-list-gap-icon"><Icon name="ban" size={12}/></div>
      <div className="tk-day-list-gap-text">
        <div className="tk-day-list-gap-label">Out · {fmtHM(endMin - startMin)}</div>
        <div className="tk-day-list-gap-range">
          {fmtFromMin(startMin)} → {fmtFromMin(endMin)}
        </div>
      </div>
    </div>
  );
}
