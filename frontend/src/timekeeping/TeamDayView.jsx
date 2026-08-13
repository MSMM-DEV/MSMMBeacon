// TeamDayView — admin's primary view. One row per user with a horizontal
// timeline of the day's intervals. Click an interval to open the day detail
// drawer for that user; hover for tooltip with linked Outlook event subjects.

import React, { useEffect, useState, useCallback } from "react";
import { Icon } from "@/icons";
import { Badge, Button, EmptyState } from "@/ui";
import { UserTag } from "../primitives";
import { loadTeamDay, fmtHM, todayInCT } from "../data";
import { DayTimeline } from "./DayTimeline";

const UsersGlyph = (props) => <Icon name="users" {...props} />;

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
    <div className="tka-teamday">
      <header className="tka-teamday-head">
        <div className="tka-teamday-daybar">
          <Button variant="default" size="icon-sm" onClick={() => shift(date, onDate, -1)} aria-label="Previous day">
            <Icon name="back" size={14}/>
          </Button>
          <input
            type="date" className="tka-dateinput num"
            aria-label="Team day"
            value={date} max={todayInCT()}
            onChange={e => onDate?.(e.target.value || todayInCT())}
          />
          <Button
            variant="default" size="icon-sm"
            onClick={() => shift(date, onDate, +1)}
            disabled={date >= todayInCT()}
            aria-label="Next day"
          >
            <Icon name="forward" size={14}/>
          </Button>
          {date !== todayInCT() && (
            <Button variant="subtle" size="xs" onClick={() => onDate?.(todayInCT())}>
              <Icon name="clock" size={12}/> Today
            </Button>
          )}
        </div>

        <div className="tka-teamday-stats">
          <span><strong className="num">{totalIn}</strong> currently in</span>
          <span className="tka-dot" aria-hidden="true">·</span>
          <span><strong className="num">{totalActive}</strong> active today</span>
          <span className="tka-dot" aria-hidden="true">·</span>
          <span><span className="num">{sorted.length}</span> total</span>
          {busy && <span className="tka-muted" role="status">refreshing</span>}
        </div>
      </header>

      {sorted.length === 0 ? (
        <EmptyState
          compact
          icon={UsersGlyph}
          title="No users to display"
          description="Once people are enabled in the directory, their day appears on this board."
        />
      ) : (
        <div className="bx-scroll-x tka-teamday-scroll">
          <ul className="tka-teamday-rows">
            {sorted.map(r => {
              const isIn = r.intervals.some(i => !i.endAt && !i.isOut);
              return (
                <li key={r.user.id} className={`tka-teamday-row ${isIn ? "is-in" : ""}`}>
                  <button
                    type="button"
                    className="tka-teamday-name"
                    onClick={() => onUserDay?.({ userId: r.user.id, date })}
                  >
                    <UserTag userId={r.user.id} size="sm" nameOnly/>
                  </button>
                  <div className="tka-teamday-tl">
                    <DayTimeline
                      date={date}
                      intervals={r.intervals}
                      leaveBlocks={r.leaveBlocks}
                      onIntervalClick={() => onUserDay?.({ userId: r.user.id, date })}
                      actionHint="Open this day."
                      height={22}
                      showHourGrid={false}
                    />
                  </div>
                  <div className="tka-teamday-total num">
                    {r.day ? fmtHM(r.day.minutesWork || 0) : "–"}
                  </div>
                  <div className="tka-teamday-state">
                    {isIn && (
                      <Badge tone="brand" size="sm">
                        <span className="tka-livedot" aria-hidden="true"/> In
                      </Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function shift(date, onDate, delta) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + delta);
  onDate?.(d.toISOString().slice(0, 10));
}
