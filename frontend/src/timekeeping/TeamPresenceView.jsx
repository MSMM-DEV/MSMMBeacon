// TeamPresenceView — read-only "where is everyone" board for the personal
// Timesheet tab. Same day picture as the admin Team view (one row per person
// with a horizontal day timeline), but VIEW-ONLY: no edits, no day-editor.
//
// The point is presence: each colleague's CURRENT tag (Working / At lunch /
// In a meeting / Out …) and the NOTE they left, so people can see where someone
// is and go find them. Writes are impossible here — there are no edit
// affordances, and the team-read RLS policies (migration 20260608140000) grant
// SELECT only; the UI never offers a mutate path.

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Icon } from "../icons";
import {
  loadTeamDay, todayInCT, fmtHM, fmtClock,
  TK_CATEGORY_LABEL, TK_CATEGORY_TONE,
} from "../data";
import { DayTimeline } from "./DayTimeline";

const LIVE_TICK_MS = 30_000;

// Friendlier phrasing for an OUT interval's category — reads as a status, not a
// label ("At lunch" rather than "Lunch"). Falls back to the plain label.
const OUT_PHRASE = {
  lunch:            "At lunch",
  meeting:          "In a meeting",
  travel:           "Traveling",
  break:            "On a break",
  eod:              "Left for the day",
  meeting_untagged: "Out — untagged",
  vacation:         "On vacation",
  holiday:          "Holiday",
  off:              "Off",
  work:             "Stepped out",
};

// Derive a person's current status from their day's intervals. Punch direction
// is the source of truth: an open IN interval = at desk (Working); an open OUT
// interval = physically out, labelled by its category; no open interval = either
// not in yet or done for the day.
function currentStatus(intervals) {
  const sorted = (intervals || []).slice()
    .sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt));
  const open = sorted.find(i => !i.endAt);
  if (open) {
    if (!open.isOut) {
      return { key: "in", label: "Working", tone: "green", live: true,
               since: open.startAt, note: open.notes, category: "work" };
    }
    const label = OUT_PHRASE[open.category] || TK_CATEGORY_LABEL[open.category] || "Out";
    const tone  = open.category === "meeting_untagged" ? "rose"
                : (TK_CATEGORY_TONE[open.category] || "muted");
    return { key: "out", label, tone, live: true,
             since: open.startAt, note: open.notes, category: open.category };
  }
  if (sorted.length === 0) {
    return { key: "none", label: "Not in yet", tone: "ghost", note: null };
  }
  const last = sorted[sorted.length - 1];
  return { key: "done", label: "Out", tone: "muted",
           note: last?.notes || null, lastOut: last?.endAt };
}

export function TeamPresenceView() {
  const [date, setDate]   = useState(todayInCT());
  const [rows, setRows]   = useState([]);
  const [busy, setBusy]   = useState(false);
  const [err,  setErr]    = useState(null);
  const [open, setOpen]   = useState(() => new Set());   // expanded user ids
  const isToday = date === todayInCT();

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setBusy(true);
    setErr(null);
    try { setRows(await loadTeamDay(date)); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }, [date]);

  useEffect(() => { refresh(); }, [refresh]);

  // Live-refresh while viewing today so the board reflects punches as they land.
  useEffect(() => {
    if (!isToday) return undefined;
    const id = setInterval(() => refresh({ silent: true }), LIVE_TICK_MS);
    return () => clearInterval(id);
  }, [isToday, refresh]);

  const enriched = useMemo(() => {
    const rank = (s) => s.key === "in" ? 0 : (s.key === "out" ? 1 : s.key === "done" ? 2 : 3);
    return rows
      .map(r => ({ ...r, status: currentStatus(r.intervals) }))
      .sort((a, b) => {
        const ra = rank(a.status), rb = rank(b.status);
        if (ra !== rb) return ra - rb;
        return (a.user.name || "").localeCompare(b.user.name || "");
      });
  }, [rows]);

  const inNow  = enriched.filter(e => e.status.key === "in").length;
  const outNow = enriched.filter(e => e.status.key === "out").length;
  const active = enriched.filter(e => e.intervals.length > 0).length;

  const toggle = (id) => setOpen(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div className="tk-presence">
      <header className="tk-presence-head">
        <div className="tk-presence-head-titles">
          <h3 className="tk-presence-title">
            Team presence
            {isToday && <span className="tk-presence-live"><span className="tk-pulse-dot"/>live</span>}
          </h3>
          <p className="tk-presence-sub">Read-only · where everyone is right now</p>
        </div>
        <div className="tk-presence-daybar">
          <button className="btn btn-ghost btn-sm" onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day">
            <Icon name="back" size={14}/>
          </button>
          <input
            type="date" className="tk-day-input"
            value={date} max={todayInCT()}
            onChange={e => setDate(e.target.value || todayInCT())}
          />
          <button className="btn btn-ghost btn-sm" onClick={() => setDate(shiftDay(date, +1))}
            disabled={date >= todayInCT()} aria-label="Next day">
            <Icon name="forward" size={14}/>
          </button>
          {!isToday && (
            <button className="btn btn-ghost btn-sm" onClick={() => setDate(todayInCT())}>Today</button>
          )}
        </div>
      </header>

      <div className="tk-presence-stats">
        <span className="tk-presence-stat is-in"><strong>{inNow}</strong> in the office</span>
        <span className="tk-presence-stat is-out"><strong>{outNow}</strong> out / away</span>
        <span className="tk-presence-stat"><strong>{active}</strong> active today</span>
        {busy && <span className="tk-loading">refreshing…</span>}
      </div>

      {err && <div className="tk-range-err">Couldn't load team presence: {err}</div>}

      <ul className="tk-presence-rows">
        {enriched.map(({ user, intervals, day, status }) => {
          const expanded = open.has(user.id);
          return (
            <li key={user.id} className={`tk-presence-row tone-${status.tone}`}>
              <button className="tk-presence-main" onClick={() => toggle(user.id)} aria-expanded={expanded}>
                <span className={`tk-presence-dot ${status.key}`}/>
                <span className={`avatar sm ${user.color}`}>{user.initials}</span>

                <span className="tk-presence-who">
                  <span className="tk-presence-name">{user.name}</span>
                  <span className="tk-presence-status">
                    <span className={`tk-presence-pill tone-${status.tone}`}>{status.label}</span>
                    {status.since && (
                      <span className="tk-presence-since">since {fmtClock(status.since)}</span>
                    )}
                    {status.lastOut && (
                      <span className="tk-presence-since">last seen {fmtClock(status.lastOut)}</span>
                    )}
                  </span>
                  {status.note && (
                    <span className="tk-presence-note" title={status.note}>
                      <Icon name="note" size={11}/> {status.note}
                    </span>
                  )}
                </span>

                <span className="tk-presence-timeline">
                  <DayTimeline date={date} intervals={intervals} height={22} showHourGrid={false}/>
                </span>
                <span className="tk-presence-total">{day ? fmtHM(day.minutesWork || 0) : "—"}</span>
                <span className="tk-presence-caret"><Icon name={expanded ? "chevronDown" : "chevronRight"} size={14}/></span>
              </button>

              {expanded && (
                <div className="tk-presence-detail">
                  {intervals.length === 0 ? (
                    <div className="tk-presence-detail-empty">No punches recorded {isToday ? "yet today" : "this day"}.</div>
                  ) : (
                    <ul className="tk-presence-ivs">
                      {intervals.slice().sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt)).map(iv => (
                        <li key={iv.id} className={`tk-presence-iv ${iv.isOut ? "is-out" : "is-in"}`}>
                          <span className="tk-presence-iv-time">
                            {fmtClock(iv.startAt)} – {iv.endAt ? fmtClock(iv.endAt) : "now"}
                          </span>
                          <span className={`tk-presence-iv-tag tone-${iv.isOut ? (TK_CATEGORY_TONE[iv.category] || "rose") : "green"}`}>
                            {iv.isOut ? (TK_CATEGORY_LABEL[iv.category] || "Out") : "At desk"}
                          </span>
                          {iv.outlookEventSubject && (
                            <span className="tk-presence-iv-cal"><Icon name="calendar" size={10}/> {iv.outlookEventSubject}</span>
                          )}
                          {iv.notes && <span className="tk-presence-iv-note">“{iv.notes}”</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {enriched.length === 0 && !busy && (
          <li className="tk-presence-empty">
            <Icon name="users" size={20}/>
            <span>No one to show.</span>
          </li>
        )}
      </ul>
    </div>
  );
}

function shiftDay(date, delta) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}
