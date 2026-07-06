// WeekSummary — read-only 7-day hours card for the current user. Approval was
// retired (everyone edits their own time directly), so this no longer submits
// or shows approval state — just the week's worked hours per day + any
// attention flags (missing_out, untagged_meeting).

import React from "react";
import { Icon } from "../icons";
import { fmtHM } from "../data";

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function WeekSummary({
  weekStart,
  days,            // adapted timesheet_days for this week (length 0..7)
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
    if (f.missing_out)        list.push({ date: s.date, kind: "Missing punch-out" });
    if (f.untagged_meeting)   list.push({ date: s.date, kind: "Needs a time tag" });
    return list;
  });

  return (
    <section className="tk-week-card">
      <header className="tk-week-head">
        <div>
          <div className="tk-week-eyebrow">Week of</div>
          <h3 className="tk-week-title">{fmtWeekRange(weekStart)}</h3>
        </div>
        <div className="tk-week-meta">
          <div className="tk-week-total">{fmtHM(total)}</div>
        </div>
      </header>

      <ul className="tk-week-days">
        {slots.map(s => {
          const minutes = s.day?.minutesWork || 0;
          const f = s.day?.flags || {};
          const attention = attentionFor(f);
          return (
            <li key={s.date} className={`tk-week-day ${attention ? "has-attention" : ""}`}>
              <span className="tk-week-day-label">{s.label}</span>
              <span className="tk-week-day-bar">
                <span className="tk-week-day-bar-fill"
                  style={{ width: `${Math.min(100, (minutes / 480) * 100)}%` }} />
              </span>
              <span className="tk-week-day-total">{fmtHM(minutes)}</span>
              {attention && (
                <span className={`tk-week-day-flag tone-${attention.tone}`} title={attention.label} aria-label={attention.label}>
                  {attention.short}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {flags.length > 0 && (
        <ul className="tk-week-flags">
          {flags.map((f, i) => (
            <li key={i}><Icon name="warn" size={11}/> {f.kind} on {f.date}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function attentionFor(flags = {}) {
  if (flags.missing_out && flags.untagged_meeting) {
    return { short: "Review", label: "Missing punch-out and needs a time tag", tone: "rose" };
  }
  if (flags.missing_out) {
    return { short: "Missing out", label: "Missing punch-out", tone: "rose" };
  }
  if (flags.untagged_meeting) {
    return { short: "Needs tag", label: "Needs a time tag", tone: "amber" };
  }
  return null;
}

function fmtWeekRange(weekStart) {
  const start = new Date(`${weekStart}T00:00:00`);
  const end   = new Date(start); end.setDate(start.getDate() + 6);
  const f = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(start)} – ${f(end)}, ${start.getFullYear()}`;
}
