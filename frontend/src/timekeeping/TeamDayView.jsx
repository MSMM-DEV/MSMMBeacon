// TeamDayView — admin's primary view. One row per user with a horizontal
// timeline of the day's intervals. Click an interval to open the day detail
// drawer for that user; hover for tooltip with linked Outlook event subjects.

import React, { useEffect, useState, useCallback } from "react";
import { Icon } from "../icons";
import { UserTag } from "../primitives";
import { loadTeamDay, fmtHM, todayInCT } from "../data";
import { DayTimeline } from "./DayTimeline";

export function TeamDayView({ date, onDate, onUserDay }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    const r = await loadTeamDay(date);
    setRows(r);
    setBusy(false);
  }, [date]);

  useEffect(() => { refresh(); }, [refresh]);

  // Sort: anyone with punches first (most recent activity at top), then alphabetical.
  const sorted = [...rows].sort((a, b) => {
    const ai = a.intervals.length, bi = b.intervals.length;
    if (ai !== bi) return bi - ai;
    return (a.user.displayName || "").localeCompare(b.user.displayName || "");
  });

  const totalActive = sorted.filter(r => r.intervals.length > 0).length;
  const totalIn     = sorted.filter(r => r.intervals.some(i => !i.endAt && !i.isOut)).length;

  return (
    <div className="tk-team-day">
      <header className="tk-team-day-head">
        <div className="tk-team-day-date">
          <button className="btn btn-ghost btn-sm" onClick={() => shift(date, onDate, -1)}>
            <Icon name="back" size={14}/>
          </button>
          <input
            type="date" className="tk-day-input"
            value={date} max={todayInCT()}
            onChange={e => onDate?.(e.target.value || todayInCT())}
          />
          <button className="btn btn-ghost btn-sm" onClick={() => shift(date, onDate, +1)}
            disabled={date >= todayInCT()}>
            <Icon name="forward" size={14}/>
          </button>
          {date !== todayInCT() && (
            <button className="btn btn-ghost btn-sm" onClick={() => onDate?.(todayInCT())}>
              Today
            </button>
          )}
        </div>
        <div className="tk-team-day-stats">
          <span><strong>{totalIn}</strong> currently in</span>
          <span className="dot"/>
          <span><strong>{totalActive}</strong> active today</span>
          <span className="dot"/>
          <span>{sorted.length} total</span>
          {busy && <span className="tk-loading">refreshing…</span>}
        </div>
      </header>

      <ul className="tk-team-rows">
        {sorted.map(r => (
          <li key={r.user.id} className="tk-team-row">
            <button className="tk-team-row-name"
              onClick={() => onUserDay?.({ userId: r.user.id, date })}>
              <UserTag userId={r.user.id} size="sm" nameOnly/>
            </button>
            <div className="tk-team-row-timeline">
              <DayTimeline
                date={date}
                intervals={r.intervals}
                leaveBlocks={r.leaveBlocks}
                onIntervalClick={() => onUserDay?.({ userId: r.user.id, date })}
                height={22}
                showHourGrid={false}
              />
            </div>
            <div className="tk-team-row-total">
              {r.day ? fmtHM(r.day.minutesWork || 0) : "—"}
            </div>
            <div className={`tk-team-row-state ${r.intervals.some(i => !i.endAt && !i.isOut) ? "is-in" : ""}`}>
              {r.intervals.some(i => !i.endAt && !i.isOut) ? "IN" : ""}
            </div>
          </li>
        ))}
        {sorted.length === 0 && (
          <li className="tk-team-empty">No users to display.</li>
        )}
      </ul>
    </div>
  );
}

function shift(date, onDate, delta) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + delta);
  onDate?.(d.toISOString().slice(0, 10));
}
