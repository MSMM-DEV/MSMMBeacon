// TimesheetTab — the personal timekeeping page. Hero punch button, today's
// timeline, this week's summary card, recent corrections, plus a focused
// "tag your meeting" prompt when the day has untagged_meeting flags.
//
// Phone-first layout: the punch button is the visual anchor and sized for
// thumb reach (~240 px tall on ≤640).

import React, { useEffect, useState, useCallback, useRef } from "react";
import { Icon } from "../icons";
import {
  getCurrentBeaconUser, todayInCT, weekStartCT, fmtHM,
  loadPunchState, loadDayDetail, loadMyWeek,
  loadCachedPunchState, saveCachedPunchState, adaptPunchResponseToState,
  subscribeMyTimeState, loadLatestInterval,
} from "../data";
import { PunchButton } from "./PunchButton";
import { DayCalendar } from "./DayCalendar";
import { WeekSummary } from "./WeekSummary";
import { CorrectionModal } from "./CorrectionModal";
import { PunchPromptModal } from "./PunchPromptModal";
import { IntervalReclassifyPopover } from "./IntervalReclassifyPopover";

export function TimesheetTab({ focusDate = null }) {
  const me        = getCurrentBeaconUser();
  const userId    = me?.id;
  const [date,    setDate]    = useState(focusDate || todayInCT());
  const weekStart = weekStartCT(date);

  // Punch state — hydrate from localStorage so reload shows the correct
  // IN/OUT toggle instantly. Background fetch reconciles within ~200 ms.
  // `phase` distinguishes "we genuinely don't know yet" from "we know they're
  // out" — critical so the button doesn't default to PUNCH IN while loading.
  const [state, setState] = useState(() => loadCachedPunchState(userId) || { open: null, today: null });
  const [phase, setPhase] = useState(() => loadCachedPunchState(userId) ? "ready" : "loading");
  const [phaseError, setPhaseError] = useState(null);

  const [day,           setDay]           = useState({ date, intervals: [], punches: [], day: null });
  const [week,          setWeek]          = useState({ days: [], week: null });
  const [showCorrect,   setShowCorrect]   = useState(false);
  const [focusInterval, setFocusInterval] = useState(null);
  const [prompt,        setPrompt]        = useState(null);   // { kind, interval } | null

  // Persist whenever state changes so reloads/cross-tab opens see truth.
  useEffect(() => { if (userId) saveCachedPunchState(userId, state); }, [userId, state]);

  // Track the latest in-flight refresh so a stale fetch can't overwrite
  // newer state (e.g. realtime fires while a manual refresh is pending).
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!userId) return;
    const seq = ++refreshSeqRef.current;
    if (!silent) setPhaseError(null);
    try {
      const [st, d, w] = await Promise.all([
        loadPunchState(userId),
        loadDayDetail(userId, date),
        loadMyWeek(userId, weekStart),
      ]);
      if (seq !== refreshSeqRef.current) return;  // a newer refresh superseded us
      setState(st);
      setDay(d);
      setWeek(w);
      setPhase("ready");
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      // If we have cached state, stay in "ready" and just surface the error
      // as a soft warning. If we don't, this is a hard error — show it.
      setPhaseError(err.message || "could not load timesheet");
      setPhase(prev => prev === "ready" ? "ready" : "error");
    }
  }, [userId, date, weekStart]);

  useEffect(() => { refresh(); }, [refresh]);

  // Realtime: re-fetch when our own intervals or day rollup change. Cross-tab
  // and Pi-punch updates flow through here. Note: this requires
  // beacon_v2.time_intervals + timesheet_days to be in the supabase_realtime
  // publication (see migration 20260601120600_timekeeping_realtime.sql).
  useEffect(() => {
    if (!userId) return undefined;
    return subscribeMyTimeState(userId, () => { refresh({ silent: true }); });
  }, [userId, refresh]);

  // Apply the Edge Function response directly so the button reflects the new
  // state without a round trip. This kills the post-click flicker where the
  // UI briefly showed the pre-click state until the background fetch landed.
  // After applying, fetch the affected interval (new-open after PUNCH IN,
  // just-closed after PUNCH OUT) and open the PunchPromptModal so the user
  // can attach a category + note while the context is fresh.
  const applyPunchResponse = useCallback(async (response) => {
    const next = adaptPunchResponseToState(response, state.today);
    if (next) {
      setState(next);
      setPhase("ready");
    }
    refresh({ silent: true });

    if (!userId || !response || response.deduped) return;
    try {
      const kind = response.state === "in" ? "in" : "out";
      const iv   = await loadLatestInterval(userId, kind === "in" ? "open" : "closed");
      if (iv) setPrompt({ kind, interval: iv });
    } catch {
      // Don't block the punch flow on prompt-fetch failure; user can
      // always edit later via the calendar.
    }
  }, [refresh, state.today, userId]);

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
            phase={phase}
            state={punchedIn ? "in" : "out"}
            openSince={state.open?.startAt || null}
            todayMinutesWork={todayMinutes}
            locked={locked}
            onPunched={applyPunchResponse}
            onRetry={() => refresh()}
          />
          {phaseError && phase === "ready" && (
            <div className="tk-hero-warn-banner" role="alert">
              <Icon name="bell" size={12}/> Couldn't refresh — showing last-known state. <button className="link-btn" type="button" onClick={() => refresh()}>Retry</button>
            </div>
          )}
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
        {/*
          List-view across every viewport width. The absolute-positioned
          hour rail can't avoid overlap when several punches cluster within
          a short window (punch markers collide with interval cards at the
          card boundaries; back-to-back intervals abut). The list scales
          linearly with the count, never overlaps, and surfaces category /
          note / source / Outlook subject as primary content. Matches what
          the admin's UserDayModal already does.
        */}
        <DayCalendar
          date={date}
          intervals={day.intervals}
          punches={day.punches}
          onIntervalClick={setFocusInterval}
          onAddTagForInterval={setFocusInterval}
          forceList
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
      {prompt && (
        <PunchPromptModal
          kind={prompt.kind}
          interval={prompt.interval}
          onClose={() => setPrompt(null)}
          onSaved={() => refresh({ silent: true })}
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

