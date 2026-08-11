// TeamPresenceView — read-only "where is everyone" board for the personal
// Timesheet tab. Same day picture as the admin Team view (one row per person
// with a horizontal day timeline), but VIEW-ONLY: no edits, no day-editor.
//
// The point is presence: each colleague's CURRENT tag (Working / At lunch /
// In a meeting / Out …) and the NOTE they left, so people can see where someone
// is and go find them. Writes are impossible here — there are no edit
// affordances, and the team-read RLS policies (migration 20260608140000) grant
// SELECT only; the UI never offers a mutate path.
//
// Layout: each row is its own container query (`.tka-presence-row` in
// styles.css), because this board is rendered full width AND inside the
// 320–360px rail on the Timesheet page. Wide, everything sits on one line;
// narrow, the day strip drops to a second row under the name. Every element
// keeps its own grid cell either way, and long names truncate rather than
// pushing the duration and chevron out of the card.

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Icon } from "@/icons";
import { Alert, Button, EmptyState } from "@/ui";
import {
  loadTeamDay, todayInCT, fmtHM, fmtClock,
  TK_CATEGORY_LABEL, TK_CATEGORY_TONE,
  HIDDEN_DISPLAY_CATEGORIES, mergeDisplaySegments,
} from "../data";
import { DayTimeline } from "./DayTimeline";

const LIVE_TICK_MS = 30_000;

const UsersGlyph = (props) => <Icon name="users" {...props} />;

// Friendlier phrasing for an OUT interval's category — reads as a status, not a
// label ("At lunch" rather than "Lunch"). Falls back to the plain label.
const OUT_PHRASE = {
  lunch:            "At lunch",
  meeting:          "In a meeting",
  travel:           "On a site visit",
  break:            "On a break",
  eod:              "Left for the day",
  meeting_untagged: "Out, untagged",
  vacation:         "On vacation",
  holiday:          "Holiday",
  off:              "Off",
  work:             "Stepped out",
};

// Icon per status key, so presence never reads by colour alone.
const STATUS_ICON = { in: "check", out: "logout", done: "moon", none: "dot" };

// Derive a person's current status from their day's intervals. Punch direction
// is the source of truth: an open IN interval = at desk (Working); an open OUT
// interval = physically out, labelled by its category; no open interval = either
// not in yet or done for the day.
function currentStatus(intervals) {
  const sorted = (intervals || []).slice()
    .sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt));
  const open = sorted.find(i => !i.endAt);
  // An open "Done for the day" interval means the day is finished, not that the
  // person is out/away — it must not paint a red timeline or count toward "out".
  const openIsDone = !!open && open.isOut && HIDDEN_DISPLAY_CATEGORIES.has(open.category);
  if (open && !openIsDone) {
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
  // Done for the day — either an open eod block, or a fully-closed day.
  const finisher = openIsDone ? open : sorted[sorted.length - 1];
  return { key: "done", label: "Done for the day", tone: "muted",
           note: finisher?.notes || null, lastOut: openIsDone ? finisher?.startAt : finisher?.endAt };
}

export function TeamPresenceView({ date: controlledDate = null, onDate = null, embedded = false }) {
  const [localDate, setLocalDate] = useState(todayInCT());
  const date = controlledDate || localDate;
  const setDate = onDate || setLocalDate;
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState(null);
  const [open, setOpen] = useState(() => new Set());   // expanded user ids
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
    <div className={`tka-presence ${embedded ? "is-embedded" : ""}`}>
      <header className="tka-presence-head">
        <div className="tka-presence-titles">
          <h3 className="tka-presence-title">
            {isToday ? "Team right now" : "Team snapshot"}
            {isToday && (
              <span className="tka-presence-live">
                <span className="tka-livedot" aria-hidden="true"/>live
              </span>
            )}
          </h3>
          <p className="tka-presence-sub">
            {isToday ? "Who is in, out, or done for the day." : "Read-only view for the selected date."}
          </p>
        </div>

        {!embedded && (
          <div className="tka-presence-daybar">
            <Button variant="default" size="icon-sm" onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day">
              <Icon name="back" size={14}/>
            </Button>
            <input
              type="date" className="tka-dateinput num"
              aria-label="Presence date"
              value={date} max={todayInCT()}
              onChange={e => setDate(e.target.value || todayInCT())}
            />
            <Button
              variant="default" size="icon-sm"
              onClick={() => setDate(shiftDay(date, +1))}
              disabled={date >= todayInCT()}
              aria-label="Next day"
            >
              <Icon name="forward" size={14}/>
            </Button>
            {!isToday && (
              <Button variant="subtle" size="xs" onClick={() => setDate(todayInCT())}>
                <Icon name="clock" size={12}/> Today
              </Button>
            )}
          </div>
        )}
      </header>

      <div className="tka-presence-stats">
        <span className="tka-presence-stat tone-green">
          <Icon name="check" size={12}/><strong className="num">{inNow}</strong> in the office
        </span>
        <span className="tka-presence-stat tone-rose">
          <Icon name="logout" size={12}/><strong className="num">{outNow}</strong> out / away
        </span>
        <span className="tka-presence-stat">
          <Icon name="users" size={12}/><strong className="num">{active}</strong> active today
        </span>
        {busy && <span className="tka-muted" role="status">refreshing</span>}
      </div>

      {err && <Alert tone="danger" title="Could not load team presence">{err}</Alert>}

      {enriched.length === 0 && !busy ? (
        <EmptyState
          compact
          icon={UsersGlyph}
          title="No one to show"
          description="Presence appears as soon as a teammate is enabled and starts punching."
        />
      ) : (
        <ul className="tka-presence-rows">
          {enriched.map(({ user, intervals, day, status }) => {
            const expanded = open.has(user.id);
            return (
              <li key={user.id} className={`tka-presence-row tone-${status.tone}`}>
                <button
                  type="button"
                  className="tka-presence-main"
                  onClick={() => toggle(user.id)}
                  aria-expanded={expanded}
                >
                  <span className={`avatar sm ${user.color}`}>{user.initials}</span>

                  <span className="tka-presence-who">
                    <span className="tka-presence-name" title={user.name}>{user.name}</span>
                    <span className="tka-presence-statusline">
                      <span className={`tka-statuspill tone-${status.tone}`}>
                        <Icon name={STATUS_ICON[status.key] || "dot"} size={11}/>
                        <span className="tka-statuspill-label">{status.label}</span>
                      </span>
                      {status.since && (
                        <span className="tka-presence-since num">since {fmtClock(status.since)}</span>
                      )}
                      {status.lastOut && (
                        <span className="tka-presence-since num">last seen {fmtClock(status.lastOut)}</span>
                      )}
                    </span>
                    {status.note && (
                      <span className="tka-presence-note" title={status.note}>
                        <Icon name="note" size={11}/>
                        <span className="tka-presence-note-copy">{status.note}</span>
                      </span>
                    )}
                  </span>

                  <span className="tka-presence-tl">
                    <DayTimeline date={date} intervals={intervals} height={22} showHourGrid={false}/>
                  </span>
                  <span className="tka-presence-total num">{day ? fmtHM(day.minutesWork || 0) : "–"}</span>
                  <span className="tka-presence-caret" aria-hidden="true">
                    <Icon name={expanded ? "chevronDown" : "chevronRight"} size={15}/>
                  </span>
                </button>

                {expanded && (
                  <div className="tka-presence-detail">
                    {intervals.length === 0 ? (
                      <p className="tka-presence-detail-empty">
                        No punches recorded {isToday ? "yet today" : "this day"}.
                      </p>
                    ) : (
                      <ul className="tka-presence-ivs">
                        {mergeDisplaySegments(intervals).map(iv => (
                          <li key={iv.id} className={`tka-presence-iv ${iv.isOut ? "is-out" : "is-in"}`}>
                            <span className="tka-presence-iv-time num">
                              {fmtClock(iv.startAt)} – {iv.endAt ? fmtClock(iv.endAt) : "now"}
                            </span>
                            <span className={`tka-statuspill tone-${iv.isOut ? (TK_CATEGORY_TONE[iv.category] || "rose") : "green"}`}>
                              {iv.isOut ? (TK_CATEGORY_LABEL[iv.category] || "Out") : "At desk"}
                            </span>
                            {iv.outlookEventSubject && (
                              <span className="tka-presence-iv-cal">
                                <Icon name="calendar" size={11}/> {iv.outlookEventSubject}
                              </span>
                            )}
                            {iv.notes && (
                              <span className="tka-presence-iv-note">
                                <Icon name="note" size={11}/> {iv.notes}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function shiftDay(date, delta) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}
