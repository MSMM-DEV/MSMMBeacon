// DayTimeline — horizontal bar of work intervals for one (user, date).
//
// Used by:
//   • TimesheetTab (personal): one row, the signed-in user's day.
//   • TeamDayView  (admin):    one row per user.
//   • WeekApprovalModal:        seven rows, one per day Mon–Sun.
//
// Renders a track from 06:00 to 20:00 in the workspace business timezone
// (Central by default). Each interval becomes a colored bar; the tooltip
// surfaces punch IN/OUT times, source, the linked Outlook event subject,
// and the classification source ('auto'/'rule'/'outlook'/'user'/'admin').

import React from "react";
import { Icon } from "../icons";
import {
  intervalTone, TK_CATEGORY_LABEL, fmtClock, fmtHM,
  computeOutGaps, WORKDAY_START_MIN, WORKDAY_END_MIN,
  mergeDisplaySegments,
} from "../data";

const TRACK_START_HOUR = 6;
const TRACK_END_HOUR   = 20;
const TZ               = "America/Chicago";

// Convert "minutes-since-CT-midnight" to a [0,1] position within the visible
// track window. Clamps so anything outside 6a-8p is pinned to the edges.
function trackFractionForMin(min) {
  const startMin = TRACK_START_HOUR * 60;
  const endMin   = TRACK_END_HOUR   * 60;
  const m = Math.max(startMin, Math.min(endMin, min));
  return (m - startMin) / (endMin - startMin);
}

function hoursInCT(iso) {
  // Returns fractional hours from start of CT day for an ISO timestamp.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(iso));
  const h = +parts.find(p => p.type === "hour"  )?.value || 0;
  const m = +parts.find(p => p.type === "minute")?.value || 0;
  return h + m / 60;
}

export function DayTimeline({
  intervals = [],
  date,
  onIntervalClick,
  height = 28,
  showHourGrid = true,
  leaveBlocks = [],           // approved-leave overlay band(s) for this (user, date)
}) {
  const leave = (leaveBlocks || [])[0] || null;
  const span = TRACK_END_HOUR - TRACK_START_HOUR;
  const hours = Array.from({ length: span + 1 }, (_, i) => TRACK_START_HOUR + i);

  // Clamp intervals to today and the visible window. mergeDisplaySegments drops
  // "Done for the day" blocks and fuses same-task blocks split by a ≤5-min gap.
  // The red OUT-gap overlay (computeOutGaps) keeps the RAW intervals so an eod's
  // coverage still suppresses a phantom red gap where the hidden block sat.
  const segments = mergeDisplaySegments(intervals)
    .map(iv => {
      let start = hoursInCT(iv.startAt);
      let end   = iv.endAt ? hoursInCT(iv.endAt) : hoursInCT(new Date().toISOString());
      // If startAt is on a prior day (or far past), pin to track start.
      if (date) {
        const ctDate = new Date(iv.startAt).toLocaleDateString("en-CA", { timeZone: TZ });
        if (ctDate !== date) {
          if (ctDate < date) start = 0;
          else return null; // future-day; skip
        }
      }
      start = Math.max(TRACK_START_HOUR, Math.min(TRACK_END_HOUR, start));
      end   = Math.max(TRACK_START_HOUR, Math.min(TRACK_END_HOUR, end));
      if (end <= start) return null;
      return { iv, start, end };
    })
    .filter(Boolean);

  return (
    <div className="tk-day-timeline" style={{ height }}>
      {showHourGrid && (
        <div className="tk-day-grid" aria-hidden="true">
          {hours.map(h => (
            <span
              key={h}
              className="tk-day-tick"
              style={{ left: `${((h - TRACK_START_HOUR) / span) * 100}%` }}
            >
              <span className="tk-day-tick-label">
                {h === 12 ? "12p" : h > 12 ? `${h - 12}p` : `${h}a`}
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="tk-day-track">
        {/* Approved-leave band — spans the full track behind everything else. */}
        {leave && (
          <div
            className={`tk-day-leave-band tone-${leave.leaveType === "sick" ? "blue" : "sage"}`}
            title={`${leave.leaveType === "sick" ? "Sick leave" : "Vacation"} · ${leave.hoursPerDay}h (approved)`}
          >
            <span className="tk-day-leave-label">
              {leave.leaveType === "sick" ? "Sick" : "Vacation"} · {leave.hoursPerDay}h
            </span>
          </div>
        )}

        {/* Workday window — subtle band 8a–5p */}
        {(() => {
          const left  = trackFractionForMin(WORKDAY_START_MIN) * 100;
          const right = trackFractionForMin(WORKDAY_END_MIN)   * 100;
          if (right <= left) return null;
          return (
            <div
              className="tk-day-track-workday"
              style={{ left: `${left}%`, width: `${right - left}%` }}
              aria-hidden="true"
            />
          );
        })()}

        {/* Red OUT-gap overlay — behind interval cards so cards still click.
            Labeled with the gap duration when wide enough, mirroring the
            "Working" label on green segment bars. */}
        {date && computeOutGaps({ intervals, date }).map(([sMin, eMin], i) => {
          const leftFrac  = trackFractionForMin(sMin);
          const rightFrac = trackFractionForMin(eMin);
          const widthFrac = Math.max(0, rightFrac - leftFrac);
          if (widthFrac <= 0) return null;
          const widthPct = widthFrac * 100;
          const durMin = eMin - sMin;
          return (
            <div
              key={`gap-${i}`}
              className="tk-day-gap"
              style={{ left: `${leftFrac * 100}%`, width: `${widthPct}%` }}
              title={`Out ${fmtHM(durMin)}`}
              aria-hidden="true"
            >
              {widthPct > 4 && (
                <span className="tk-day-gap-label">
                  {widthPct > 8 ? `Out · ${fmtHM(durMin)}` : "Out"}
                </span>
              )}
            </div>
          );
        })}

        {segments.map(({ iv, start, end }) => {
          const left  = ((start - TRACK_START_HOUR) / span) * 100;
          const width = ((end   - start)            / span) * 100;
          const tone  = intervalTone(iv);   // green = at desk, red = out
          return (
            <button
              key={iv.id}
              type="button"
              className={`tk-day-seg tone-${tone}`}
              style={{ left: `${left}%`, width: `${width}%` }}
              onClick={(e) => { e.stopPropagation(); onIntervalClick?.(iv); }}
              title={tooltipFor(iv)}
              data-category={iv.category}
              data-source={iv.categorySource}
            >
              {width > 5 && (
                <span className="tk-day-seg-label">
                  {iv.outlookEventSubject || TK_CATEGORY_LABEL[iv.category] || "—"}
                </span>
              )}
              {iv.outlookEventId && width > 8 && (
                <Icon name="link" size={11} />
              )}
              {iv.notes && width > 4 && (
                <span className="tk-day-seg-note-dot" aria-hidden="true"/>
              )}
            </button>
          );
        })}
        {segments.length === 0 && !leave && (
          <div className="tk-day-empty">No punches on this day</div>
        )}
      </div>
    </div>
  );
}

function tooltipFor(iv) {
  const parts = [
    `${fmtClock(iv.startAt)} – ${iv.endAt ? fmtClock(iv.endAt) : "now"}`,
    TK_CATEGORY_LABEL[iv.category] || iv.category,
    iv.durationMinutes != null ? fmtHM(iv.durationMinutes) : null,
    iv.outlookEventSubject ? `📅 ${iv.outlookEventSubject}` : null,
    iv.outlookEventLocation ? `📍 ${iv.outlookEventLocation}` : null,
    iv.notes ? `📝 ${iv.notes}` : null,
    iv.categorySource === "user"   ? "set by user" :
    iv.categorySource === "admin"  ? "set by admin" :
    iv.categorySource === "outlook"? "auto-tagged from calendar" :
    iv.categorySource === "rule"   ? "rule-classified" : "auto",
  ].filter(Boolean);
  return parts.join("\n");
}
