// UserDayModal — admin's focused per-user day view inside Time Admin.
// Replaces the v1 "switch to admin's own Timesheet" hack so admins can
// inspect ANY user's day (with notes + categories per interval) without
// leaving the Time Admin tab.
//
// Behaviour:
//   • Loads the target user's intervals + punches + day rollup for the date.
//   • Renders the same DayCalendar used in the personal Timesheet (so
//     interval cards show category + note + source the same way).
//   • Click an interval → IntervalReclassifyPopover. Admin writes go through
//     the `tk_intervals_admin_write` RLS policy.
//   • Day navigation (prev/next/today) + jump-to-date picker.
//   • Bottom-sheet behaviour on phones inherited from .modal-narrow rules.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import {
  loadDayDetail, fmtHM, todayInCT, userById,
} from "../data";
import { DayCalendar } from "./DayCalendar";
import { IntervalReclassifyPopover } from "./IntervalReclassifyPopover";

function shiftDay(dateIso, delta) {
  const d = new Date(`${dateIso}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}
function fmtLong(iso) {
  return new Date(`${iso}T12:00:00`)
    .toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

export function UserDayModal({ userId, initialDate, onClose }) {
  const [date, setDate] = useState(initialDate || todayInCT());
  const [day,  setDay]  = useState({ date, intervals: [], punches: [], day: null });
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState(null);
  const [focusInterval, setFocusInterval] = useState(null);

  const user = useMemo(() => userById(userId), [userId]);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setBusy(true); setErr(null);
    try {
      const d = await loadDayDetail(userId, date);
      setDay(d);
    } catch (e) {
      setErr(e.message || "could not load");
    } finally {
      setBusy(false);
    }
  }, [userId, date]);

  useEffect(() => { refresh(); }, [refresh]);

  // Escape to close.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !focusInterval) onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, focusInterval]);

  if (!userId) return null;

  const isToday = date === todayInCT();
  const minutesWork    = day.day?.minutesWork    || 0;
  const minutesMeeting = day.day?.minutesMeeting || 0;
  const minutesTravel  = day.day?.minutesTravel  || 0;
  const minutesUntagged = day.day?.minutesUntagged || 0;
  // Worked time = at-desk (IN) minutes only; punched-out meeting/travel time is
  // shown as separate informational stats below but never counts in the total.
  const total = minutesWork;
  const closedCount = (day.intervals || []).filter(i => i.endAt).length;
  const openCount   = (day.intervals || []).filter(i => !i.endAt).length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal tk-user-day-modal"
        onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="tk-user-day-title"
      >
        <header className="tk-user-day-head">
          <div className="tk-user-day-id">
            {user && <span className={`avatar sm ${user.color}`}>{user.initials}</span>}
            <div className="tk-user-day-title-wrap">
              <div className="tk-user-day-eyebrow">Time Admin · per-user day</div>
              <h2 id="tk-user-day-title" className="tk-user-day-title">
                {user?.name || "User"}
              </h2>
            </div>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16}/>
          </button>
        </header>

        <div className="tk-user-day-toolbar">
          <div className="tk-user-day-nav">
            <button type="button" className="tk-icon-btn" onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day">
              <Icon name="back" size={14}/>
            </button>
            <input
              type="date"
              className="tk-day-input"
              value={date}
              max={todayInCT()}
              onChange={e => setDate(e.target.value || todayInCT())}
            />
            <button
              type="button"
              className="tk-icon-btn"
              onClick={() => setDate(shiftDay(date, +1))}
              disabled={date >= todayInCT()}
              aria-label="Next day"
            >
              <Icon name="forward" size={14}/>
            </button>
            {!isToday && (
              <button type="button" className="tk-pill-btn" onClick={() => setDate(todayInCT())}>
                <Icon name="clock" size={11}/> Today
              </button>
            )}
          </div>
          <div className="tk-user-day-date">{fmtLong(date)}</div>
        </div>

        <div className="tk-user-day-stats">
          <div className="tk-user-day-stat">
            <div className="tk-user-day-stat-label">Total worked</div>
            <div className="tk-user-day-stat-value">{fmtHM(total, { always: true })}</div>
          </div>
          {minutesMeeting > 0 && (
            <div className="tk-user-day-stat">
              <div className="tk-user-day-stat-label">Meetings</div>
              <div className="tk-user-day-stat-value">{fmtHM(minutesMeeting, { always: true })}</div>
            </div>
          )}
          {minutesTravel > 0 && (
            <div className="tk-user-day-stat">
              <div className="tk-user-day-stat-label">Travel</div>
              <div className="tk-user-day-stat-value">{fmtHM(minutesTravel, { always: true })}</div>
            </div>
          )}
          {minutesUntagged > 0 && (
            <div className="tk-user-day-stat is-warn">
              <div className="tk-user-day-stat-label">Untagged gaps</div>
              <div className="tk-user-day-stat-value">{fmtHM(minutesUntagged, { always: true })}</div>
            </div>
          )}
          <div className="tk-user-day-stat is-meta">
            <div className="tk-user-day-stat-label">Punches · intervals</div>
            <div className="tk-user-day-stat-value">
              {(day.punches || []).length} · {closedCount}{openCount > 0 ? ` + ${openCount} open` : ""}
            </div>
          </div>
          {busy && <div className="tk-user-day-busy">refreshing…</div>}
        </div>

        {err && <div className="tk-user-day-err" role="alert">Couldn't load: {err}</div>}

        <div className="tk-user-day-body">
          {/* Always use the list view here. The modal is space-constrained
              (max-width 720 px); the hour rail overlaps when intervals
              cluster, and admins investigating a user's day care more
              about category + note + source than visual positioning. */}
          <DayCalendar
            date={date}
            intervals={day.intervals}
            punches={day.punches}
            onIntervalClick={setFocusInterval}
            onAddTagForInterval={setFocusInterval}
            forceList
          />
        </div>

        {focusInterval && (
          <IntervalReclassifyPopover
            interval={focusInterval}
            locked={false}    /* admins always bypass week lock */
            onClose={() => setFocusInterval(null)}
            onSaved={refresh}
          />
        )}
      </div>
    </div>
  );
}
