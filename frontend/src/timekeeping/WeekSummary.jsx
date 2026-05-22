// WeekSummary — 7-day card for the current user. Submits the week for
// approval; re-submits after a rejection. Pre-flight warns about unresolved
// flags (missing_out, untagged_meeting).

import React, { useState } from "react";
import { Icon } from "../icons";
import { fmtHM, submitWeek } from "../data";

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function WeekSummary({
  userId,
  weekStart,
  days,            // adapted timesheet_days for this week (length 0..7)
  week,            // adapted timesheet_weeks row (or default open)
  onChanged,
}) {
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState(null);

  const dayByDate = new Map((days || []).map(d => [d.date, d]));
  const slots = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${weekStart}T00:00:00`);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    return { date: dateStr, label: DOW_LABELS[i], day: dayByDate.get(dateStr) };
  });

  const total = slots.reduce((acc, s) => acc + (s.day?.minutesWork || 0) + (s.day?.minutesMeeting || 0) + (s.day?.minutesTravel || 0), 0);
  const flags = slots.flatMap(s => {
    const f = s.day?.flags || {};
    const list = [];
    if (f.missing_out)        list.push({ date: s.date, kind: "Missing punch-out" });
    if (f.untagged_meeting)   list.push({ date: s.date, kind: "Untagged out-of-office gap" });
    return list;
  });

  const status     = week?.approvalStatus || "open";
  const locked     = !!week?.locked;
  const submitted  = status === "submitted";
  const approved   = status === "approved" || locked;
  const rejected   = status === "rejected";

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await submitWeek(userId, weekStart);
      onChanged?.();
    } catch (e) { setErr(e.message || "submission failed"); }
    finally { setBusy(false); }
  };

  return (
    <section className="tk-week-card">
      <header className="tk-week-head">
        <div>
          <div className="tk-week-eyebrow">Week of</div>
          <h3 className="tk-week-title">{fmtWeekRange(weekStart)}</h3>
        </div>
        <div className="tk-week-meta">
          <div className="tk-week-total">{fmtHM(total)}</div>
          <div className={`tk-week-chip status-${status}`}>
            {approved   ? "Approved · locked" :
             submitted  ? "Awaiting approval" :
             rejected   ? "Returned for review" :
             "Open"}
          </div>
        </div>
      </header>

      <ul className="tk-week-days">
        {slots.map(s => {
          const minutes = (s.day?.minutesWork || 0) + (s.day?.minutesMeeting || 0) + (s.day?.minutesTravel || 0);
          const f = s.day?.flags || {};
          return (
            <li key={s.date} className="tk-week-day">
              <span className="tk-week-day-label">{s.label}</span>
              <span className="tk-week-day-bar">
                <span className="tk-week-day-bar-fill"
                  style={{ width: `${Math.min(100, (minutes / 480) * 100)}%` }} />
              </span>
              <span className="tk-week-day-total">{fmtHM(minutes)}</span>
              {(f.missing_out || f.untagged_meeting) && (
                <span className="tk-week-day-flag" title="Needs attention">
                  <Icon name="bell" size={12}/>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {rejected && week?.rejectReason && (
        <div className="tk-week-reject-note">
          <strong>Returned:</strong> {week.rejectReason}
        </div>
      )}

      {flags.length > 0 && !approved && (
        <ul className="tk-week-flags">
          {flags.map((f, i) => (
            <li key={i}><Icon name="bell" size={11}/> {f.kind} on {f.date}</li>
          ))}
        </ul>
      )}

      <footer className="tk-week-foot">
        {approved ? (
          <span className="tk-week-locked-note">
            <Icon name="lock" size={12}/> Approved. Submit a correction request to make changes.
          </span>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? "Submitting…" : submitted ? "Re-submit for approval" : "Submit week for approval"}
          </button>
        )}
        {err && <div className="form-error">{err}</div>}
      </footer>
    </section>
  );
}

function fmtWeekRange(weekStart) {
  const start = new Date(`${weekStart}T00:00:00`);
  const end   = new Date(start); end.setDate(start.getDate() + 6);
  const f = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(start)} – ${f(end)}, ${start.getFullYear()}`;
}
