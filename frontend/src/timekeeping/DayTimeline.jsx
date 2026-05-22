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
import { TK_CATEGORY_TONE, TK_CATEGORY_LABEL, fmtClock, fmtHM } from "../data";

const TRACK_START_HOUR = 6;
const TRACK_END_HOUR   = 20;
const TZ               = "America/Chicago";

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
}) {
  const span = TRACK_END_HOUR - TRACK_START_HOUR;
  const hours = Array.from({ length: span + 1 }, (_, i) => TRACK_START_HOUR + i);

  // Clamp intervals to today and the visible window.
  const segments = (intervals || [])
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
        {segments.map(({ iv, start, end }) => {
          const left  = ((start - TRACK_START_HOUR) / span) * 100;
          const width = ((end   - start)            / span) * 100;
          const tone  = TK_CATEGORY_TONE[iv.category] || "muted";
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
            </button>
          );
        })}
        {segments.length === 0 && (
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
    iv.categorySource === "user"   ? "set by user" :
    iv.categorySource === "admin"  ? "set by admin" :
    iv.categorySource === "outlook"? "auto-tagged from calendar" :
    iv.categorySource === "rule"   ? "rule-classified" : "auto",
  ].filter(Boolean);
  return parts.join("\n");
}
