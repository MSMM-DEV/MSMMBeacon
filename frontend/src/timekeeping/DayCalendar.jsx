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
import { TK_CATEGORY_TONE, TK_CATEGORY_LABEL, fmtClock, fmtHM } from "../data";

const TZ                = "America/Chicago";
const TRACK_START_HOUR  = 6;
const TRACK_END_HOUR    = 20;
const HOUR_HEIGHT       = 56;           // px per hour
const TRACK_HEIGHT      = (TRACK_END_HOUR - TRACK_START_HOUR) * HOUR_HEIGHT;
const NOW_TICK_MS       = 30_000;

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

export function DayCalendar({
  date,
  intervals = [],
  punches = [],
  onIntervalClick,
  onAddTagForInterval,        // optional — opens reclassify on an untagged interval
}) {
  const isToday = date === new Date().toLocaleDateString("en-CA", { timeZone: TZ });
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

  // ----- "now" line -----
  const nowLineTop = isToday
    ? pxForHour(hoursInCT(new Date().toISOString()))
    : null;

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
