// WeekSummary — read-only 7-day hours card for the current user. Approval was
// retired (everyone edits their own time directly), so this no longer submits
// or shows approval state — just the week's worked hours per day + any
// attention flags (missing_out, untagged_meeting).
//
// Presentation (ui-v2.0): a real table rather than a row of stat cards, so the
// seven days line up as one column of tabular figures and a screen reader gets
// day/hours pairs instead of a pile of divs. The bar behind each row is the
// same 8-hour reference the previous version used. Days past eight hours are
// NOT flagged: overtime is a payroll conversation, not something this read-only
// card should editorialise, so the bar and the figure read the same either way.

import React from "react";
import { Icon } from "../icons";
import { EmptyState } from "@/ui";
import { fmtHM } from "../data";

// Full day names. The row header reads "Monday 08/03" — spelled out, because
// the column is wide enough for "Wednesday" and an abbreviation saves nothing.
const DOW_LABELS = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

// The reference day length the bars are drawn against (8 h). Unchanged from
// the original: fill = min(100%, minutes / FULL_DAY_MIN).
const FULL_DAY_MIN = 480;

export function WeekSummary({
  weekStart,
  days,            // adapted timesheet_days for this week (length 0..7)
  onSelectDate,
}) {
  const dayByDate = new Map((days || []).map(d => [d.date, d]));
  const slots = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${weekStart}T00:00:00`);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    return { date: dateStr, label: DOW_LABELS[i], day: dayByDate.get(dateStr) };
  });

  // Worked time = at-desk (IN) minutes only; punched-out time never counts.
  const total = slots.reduce((acc, s) => acc + (s.day?.minutesWork || 0), 0);
  const flags = slots.flatMap(s => {
    const f = s.day?.flags || {};
    const list = [];
    if (f.missing_out) {
      list.push({
        date: s.date,
        dayLabel: fullDayLabel(s.date),
        title: "Missing punch-out",
        detail: "Add or adjust the final punch so the day can close cleanly.",
      });
    }
    if (f.untagged_meeting) {
      list.push({
        date: s.date,
        dayLabel: fullDayLabel(s.date),
        title: "Untagged time needs a category",
        detail: "Open the day and tap Tag this on the red time block.",
      });
    }
    return list;
  });

  const anyHours = slots.some(s => (s.day?.minutesWork || 0) > 0);

  return (
    <section className="tsx-week" aria-labelledby="tsx-week-title">
      <header className="tsx-week-head">
        <div className="tsx-week-headline">
          <span className="tsx-week-eyebrow">Week of</span>
          <h3 className="tsx-week-title" id="tsx-week-title">{fmtWeekRange(weekStart)}</h3>
        </div>
        <p className="tsx-week-total">
          <span className="tsx-week-total-val num">{fmtHM(total)}</span>
          <span className="tsx-week-total-key">worked this week</span>
        </p>
      </header>

      {anyHours ? (
        <div className="tsx-week-tablewrap">
          <table className="tsx-week-table">
            <caption className="sr-only">
              Hours worked each day this week. Bars are drawn against an eight hour day.
            </caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="tsx-week-col-bar">Share of an eight hour day</th>
                <th scope="col" className="tsx-week-col-h">Worked</th>
                <th scope="col" className="tsx-week-col-flag">Needs attention</th>
              </tr>
            </thead>
            <tbody>
              {slots.map(s => {
                const minutes = s.day?.minutesWork || 0;
                const f = s.day?.flags || {};
                const attention = attentionFor(f);
                return (
                  <tr
                    key={s.date}
                    className={`tsx-week-row ${minutes === 0 ? "is-empty" : ""} ${attention ? "has-attention" : ""}`}
                  >
                    <th scope="row" className="tsx-week-cell-day">
                      <span className="tsx-week-dow">{s.label}</span>
                      <span className="tsx-week-dom num">{monthDay(s.date)}</span>
                    </th>
                    <td className="tsx-week-cell-bar">
                      <span className="tsx-week-bar" aria-hidden="true">
                        <span
                          className="tsx-week-bar-fill"
                          style={{ width: `${Math.min(100, (minutes / FULL_DAY_MIN) * 100)}%` }}
                        />
                      </span>
                    </td>
                    <td className="tsx-week-cell-h">
                      <span className="tsx-week-hours num">{minutes === 0 ? "–" : fmtHM(minutes)}</span>
                    </td>
                    <td className="tsx-week-cell-flag">
                      {attention ? (
                        <button
                          type="button"
                          className={`tsx-week-flag tone-${attention.tone}`}
                          title={attention.label}
                          aria-label={`${attention.label}. Open ${fullDayLabel(s.date)}.`}
                          onClick={() => onSelectDate?.(s.date)}
                        >
                          <Icon name={attention.icon} size={11}/>
                          <span>{attention.short}</span>
                        </button>
                      ) : (
                        <span className="tsx-week-noflag" aria-hidden="true">–</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          compact
          title="No hours logged this week yet"
          description="Punch in from the button above, or tap a badge from a Pi reader, and the day will fill in here."
        />
      )}

      {flags.length > 0 && (
        <ul className="tsx-week-flags">
          {flags.map((f, i) => (
            <li key={i}>
              <span className="tsx-week-flags-icon" aria-hidden="true"><Icon name="warn" size={13}/></span>
              <span className="tsx-week-flag-copy">
                <strong>{f.dayLabel}: {f.title}</strong>
                <span>{f.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function attentionFor(flags = {}) {
  if (flags.missing_out && flags.untagged_meeting) {
    return { short: "Review day", label: "Missing punch-out and untagged time need review", tone: "rose", icon: "warn" };
  }
  if (flags.missing_out) {
    return { short: "Fix punch", label: "Missing punch-out", tone: "rose", icon: "warn" };
  }
  if (flags.untagged_meeting) {
    return { short: "Tag time", label: "Untagged time needs a category", tone: "amber", icon: "edit" };
  }
  return null;
}

function fullDayLabel(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" });
}

// Zero-padded MM/DD, e.g. "08/03". Tabular figures keep the seven rows aligned.
function monthDay(dateStr) {
  return new Date(`${dateStr}T00:00:00`)
    .toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" });
}

function fmtWeekRange(weekStart) {
  const start = new Date(`${weekStart}T00:00:00`);
  const end   = new Date(start); end.setDate(start.getDate() + 6);
  const f = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(start)} – ${f(end)}, ${start.getFullYear()}`;
}
