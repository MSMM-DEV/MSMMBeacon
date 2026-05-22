// TimesheetTab — the personal timekeeping page. Hero punch button, today's
// timeline, this week's summary card, recent corrections, plus a focused
// "tag your meeting" prompt when the day has untagged_meeting flags.
//
// Phone-first layout: the punch button is the visual anchor and sized for
// thumb reach (~240 px tall on ≤640).

import React, { useEffect, useState, useCallback } from "react";
import { Icon } from "../icons";
import {
  getCurrentBeaconUser, todayInCT, weekStartCT, fmtHM, fmtClock,
  loadPunchState, loadDayDetail, loadMyWeek,
  setIntervalCategory, subscribeMyTimeState,
  TK_CATEGORY_LABEL, TK_CATEGORY_TONE,
} from "../data";
import { PunchButton } from "./PunchButton";
import { DayCalendar } from "./DayCalendar";
import { WeekSummary } from "./WeekSummary";
import { CorrectionModal } from "./CorrectionModal";

const CATEGORY_USER_OPTIONS = [
  ["work",             "Working"],
  ["meeting",          "Meeting"],
  ["travel",           "Travel"],
  ["lunch",            "Lunch"],
  ["break",            "Break"],
  ["eod",              "Personal / off"],
  ["meeting_untagged", "(leave as untagged)"],
];

export function TimesheetTab({ focusDate = null }) {
  const me = getCurrentBeaconUser();
  const [date,         setDate]         = useState(focusDate || todayInCT());
  const [state,        setState]        = useState({ open: null, today: null });
  const [day,          setDay]          = useState({ date, intervals: [], punches: [], day: null });
  const [week,         setWeek]         = useState({ days: [], week: null });
  const [showCorrect,  setShowCorrect]  = useState(false);
  const [focusInterval,setFocusInterval]= useState(null);

  const userId    = me?.id;
  const weekStart = weekStartCT(date);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const [st, d, w] = await Promise.all([
      loadPunchState(userId),
      loadDayDetail(userId, date),
      loadMyWeek(userId, weekStart),
    ]);
    setState(st); setDay(d); setWeek(w);
  }, [userId, date, weekStart]);

  useEffect(() => { refresh(); }, [refresh]);

  // Realtime: re-fetch when our own intervals or day rollup change. The DB
  // trigger updates rollups synchronously after each punch, but Realtime
  // confirms across multiple tabs / Pi punches.
  useEffect(() => {
    if (!userId) return undefined;
    return subscribeMyTimeState(userId, () => { refresh(); });
  }, [userId, refresh]);

  if (!me) {
    return <div className="page-empty">Sign in to view your timesheet.</div>;
  }

  const punchedIn = state.open != null;
  const todayMinutes = state.today?.minutesWork || 0;
  const locked       = !!week.week?.locked;
  const isToday      = date === todayInCT();
  const untaggedCount = (day.intervals || []).filter(i =>
    i.category === "meeting_untagged" && !i.endAt ? false : i.category === "meeting_untagged"
  ).length;

  return (
    <div className="tk-timesheet-page">

      {/* Day picker */}
      <div className="tk-day-bar">
        <button className="btn btn-ghost btn-sm" onClick={() => shiftDay(date, setDate, -1)}>
          <Icon name="back" size={14}/>
        </button>
        <input
          type="date"
          className="tk-day-input"
          value={date}
          onChange={e => setDate(e.target.value || todayInCT())}
          max={todayInCT()}
        />
        <button className="btn btn-ghost btn-sm" onClick={() => shiftDay(date, setDate, +1)}
          disabled={date >= todayInCT()}>
          <Icon name="forward" size={14}/>
        </button>
        {!isToday && (
          <button className="btn btn-ghost btn-sm" onClick={() => setDate(todayInCT())}>
            Today
          </button>
        )}
      </div>

      {/* Hero punch panel — only on today */}
      {isToday && (
        <section className="tk-hero">
          <PunchButton
            state={punchedIn ? "in" : "out"}
            openSince={state.open?.startAt || null}
            todayMinutesWork={todayMinutes}
            locked={locked}
            onPunched={refresh}
          />
          <div className="tk-hero-side">
            <div className="tk-hero-row">
              <span className="tk-hero-key">Today</span>
              <span className="tk-hero-val">{fmtHM(todayMinutes)}</span>
            </div>
            {state.today?.minutesMeeting > 0 && (
              <div className="tk-hero-row">
                <span className="tk-hero-key">Meetings</span>
                <span className="tk-hero-val">{fmtHM(state.today.minutesMeeting)}</span>
              </div>
            )}
            {state.today?.minutesLunch > 0 && (
              <div className="tk-hero-row">
                <span className="tk-hero-key">Lunch</span>
                <span className="tk-hero-val">{fmtHM(state.today.minutesLunch)}</span>
              </div>
            )}
            {untaggedCount > 0 && (
              <div className="tk-hero-row tk-hero-warn">
                <Icon name="bell" size={14}/>
                {untaggedCount} gap{untaggedCount === 1 ? "" : "s"} need tagging
              </div>
            )}
          </div>
        </section>
      )}

      {/* Vertical day calendar — punches as labeled markers, intervals as cards */}
      <section className="tk-day-card tk-day-card-cal">
        <header className="tk-day-card-head">
          <div className="tk-day-card-head-meta">
            <h3>Day timeline</h3>
            <span className="tk-day-card-sub">
              {(day.punches || []).length} {(day.punches || []).length === 1 ? "punch" : "punches"} ·{" "}
              {(day.intervals || []).filter(i => i.endAt).length} closed
              {(day.intervals || []).some(i => !i.endAt) ? " · 1 open" : ""}
            </span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowCorrect(true)} disabled={locked}>
            <Icon name="edit" size={13}/> Request correction
          </button>
        </header>
        <DayCalendar
          date={date}
          intervals={day.intervals}
          punches={day.punches}
          onIntervalClick={setFocusInterval}
          onAddTagForInterval={setFocusInterval}
        />
      </section>

      {/* Week summary */}
      <WeekSummary
        userId={userId}
        weekStart={weekStart}
        days={week.days}
        week={week.week}
        onChanged={refresh}
      />

      {/* Modals */}
      {showCorrect && (
        <CorrectionModal
          date={date}
          onClose={() => setShowCorrect(false)}
          onSubmitted={refresh}
        />
      )}
      {focusInterval && (
        <IntervalReclassifyPopover
          interval={focusInterval}
          locked={locked}
          onClose={() => setFocusInterval(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}

function shiftDay(date, setDate, delta) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + delta);
  setDate(d.toISOString().slice(0, 10));
}

function IntervalReclassifyPopover({ interval, locked, onClose, onSaved }) {
  const [category, setCategory] = useState(interval.category);
  const [notes,    setNotes]    = useState(interval.notes || "");
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState(null);

  const save = async () => {
    if (locked) { onClose?.(); return; }
    setBusy(true); setErr(null);
    try {
      await setIntervalCategory(interval.id, {
        category, outlookEventId: interval.outlookEventId, notes: notes || null,
      });
      onSaved?.();
      onClose?.();
    } catch (e) { setErr(e.message || "save failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-eyebrow">Interval</div>
          <h3 className="modal-title">
            {fmtClock(interval.startAt)} – {interval.endAt ? fmtClock(interval.endAt) : "now"}
          </h3>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-body">
          {interval.outlookEventSubject && (
            <div className="form-help">
              <Icon name="link" size={12}/> Linked to Outlook event: <strong>{interval.outlookEventSubject}</strong>
              {interval.outlookEventLocation && <> · {interval.outlookEventLocation}</>}
            </div>
          )}
          <div className="form-row">
            <label className="form-label">Category</label>
            <select className="form-input" value={category} onChange={e => setCategory(e.target.value)}>
              {CATEGORY_USER_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <div className="tk-category-chip">
              <span className={`tk-cat tone-${TK_CATEGORY_TONE[category] || "muted"}`}>
                {TK_CATEGORY_LABEL[category] || category}
              </span>
            </div>
          </div>
          <div className="form-row">
            <label className="form-label">Note</label>
            <textarea className="form-input" rows={2} value={notes}
              onChange={e => setNotes(e.target.value)} maxLength={400}/>
          </div>
          {err && <div className="form-error">{err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost"   onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={save}    disabled={busy || locked}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
