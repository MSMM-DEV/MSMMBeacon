// TimesheetTab — the personal timekeeping page. Hero punch button, today's
// timeline, this week's summary card, recent corrections, plus a focused
// "tag your meeting" prompt when the day has untagged_meeting flags.
//
// Phone-first layout: this page is opened from the PWA far more often than
// from a desktop, so the punch control is the first thing under the date bar,
// sized for thumb reach, and everything below it is a single column until
// there is genuinely room for the presence rail (lg and up).

import React, { useEffect, useState, useCallback, useRef } from "react";
import { Icon } from "../icons";
import { Button, EmptyState } from "@/ui";
import {
  getCurrentBeaconUser, todayInCT, weekStartCT, fmtHM,
  loadPunchState, loadDayDetail, loadMyWeek,
  loadCachedPunchState, saveCachedPunchState, adaptPunchResponseToState,
  subscribeMyTimeState, loadLatestInterval,
} from "../data";
import { PunchButton } from "./PunchButton";
import { DayCalendar } from "./DayCalendar";
import { DayTimeline } from "./DayTimeline";
import { WeekSummary } from "./WeekSummary";
import { UserDayModal } from "./UserDayModal";
import { PunchPromptModal } from "./PunchPromptModal";
import { IntervalReclassifyPopover } from "./IntervalReclassifyPopover";
import { TeamPresenceView } from "./TeamPresenceView";
import { LeaveRequestModal } from "./LeaveRequestModal";
import { MyLeaveSection } from "../leave.jsx";

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
  const [editDay,       setEditDay]       = useState(false);
  const [focusInterval, setFocusInterval] = useState(null);
  const [prompt,        setPrompt]        = useState(null);   // { kind, interval } | null
  const [showLeave,     setShowLeave]     = useState(false);  // Request-leave modal
  const [section,       setSection]       = useState("time"); // time | leave
  const [leaveReloadKey, setLeaveReloadKey] = useState(0);    // bump → MyLeaveSection refetch

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
      // Every punch now OPENS a fresh interval (punch-in → an IN interval,
      // punch-out → an OUT interval). The prompt always tags that newly-opened
      // interval — so a punch-out labels the away period it just started, NOT
      // the at-desk session it just closed.
      const iv = await loadLatestInterval(userId, "open");
      if (iv) setPrompt({ kind, interval: iv });
    } catch {
      // Don't block the punch flow on prompt-fetch failure; user can
      // always edit later via the calendar.
    }
  }, [refresh, state.today, userId]);

  if (!me) {
    return <div className="page-empty">Sign in to view your timesheet.</div>;
  }

  // An open interval no longer implies "in" — a punch-out leaves an open OUT
  // interval ("currently out"). Only an open IN (is_out=false) interval is IN.
  const currentUserName = (
    me.first_name ||
    me.shortName ||
    me.display_name ||
    me.name ||
    me.email ||
    ""
  ).trim().split(/\s+/)[0] || "there";
  const punchedIn = state.open != null && !state.open.isOut;
  const todayMinutes = state.today?.minutesWork || 0;
  const locked       = !!week.week?.locked;
  const isToday      = date === todayInCT();
  const untaggedCount = (day.intervals || []).filter(i =>
    i.category === "meeting_untagged" && !i.endAt ? false : i.category === "meeting_untagged"
  ).length;
  const dayIntervals = day.intervals || [];
  const dayPunches   = day.punches || [];
  const dayLeave     = day.leaveBlocks || [];
  const hasDayActivity = dayIntervals.length > 0 || dayPunches.length > 0;
  const sectionTabId = (key) => `tk-timesheet-${key}-tab`;
  const sectionPanelId = (key) => `tk-timesheet-${key}-panel`;
  const selectSection = (key) => setSection(key);
  const focusSection = (key) => {
    window.requestAnimationFrame(() => document.getElementById(sectionTabId(key))?.focus());
  };
  const onSectionKeyDown = (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const next =
      e.key === "Home" ? "time" :
      e.key === "End" ? "leave" :
      section === "time" ? "leave" : "time";
    setSection(next);
    focusSection(next);
  };

  return (
    <div className="tsx-page">

      <div className="tsx-switch" role="tablist" aria-label="Timesheet section" onKeyDown={onSectionKeyDown}>
        {[
          ["time", "Time", "clock"],
          ["leave", "Leave", "sun"],
        ].map(([key, label, icon]) => (
          <button
            key={key}
            type="button"
            id={sectionTabId(key)}
            className={`tsx-switch-btn ${section === key ? "is-active" : ""}`}
            role="tab"
            aria-selected={section === key}
            aria-controls={sectionPanelId(key)}
            tabIndex={section === key ? 0 : -1}
            onClick={() => selectSection(key)}
          >
            <Icon name={icon} size={14}/>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {section === "time" ? (
        <div
          id={sectionPanelId("time")}
          className="tsx-panel"
          role="tabpanel"
          aria-labelledby={sectionTabId("time")}
        >
          <header className={`tsx-daybar ${isToday ? "is-today" : "is-other-day"}`}>
            <div className="tsx-daybar-copy">
              <span className="tsx-daybar-eyebrow">{isToday ? "Timesheet" : "Viewing"}</span>
              <h3 className="tsx-daybar-title">{isToday ? "Today" : formatDateLabel(date)}</h3>
            </div>

            <div className="tsx-daynav" role="group" aria-label="Timesheet date">
              <Button
                variant="ghost" size="icon-sm"
                onClick={() => shiftDay(date, setDate, -1)}
                aria-label="Previous day"
              >
                <Icon name="back" size={14}/>
              </Button>
              <input
                type="date"
                className="tsx-dateinput num"
                aria-label="Timesheet date"
                value={date}
                onChange={e => setDate(e.target.value || todayInCT())}
                max={todayInCT()}
              />
              <Button
                variant="ghost" size="icon-sm"
                onClick={() => shiftDay(date, setDate, +1)}
                disabled={date >= todayInCT()}
                aria-label="Next day"
              >
                <Icon name="forward" size={14}/>
              </Button>
              {!isToday && (
                <Button variant="subtle" size="sm" onClick={() => setDate(todayInCT())}>
                  Today
                </Button>
              )}
            </div>
          </header>

          {/* Hero punch panel — only on today */}
          {isToday && (
            <section className="tsx-hero" aria-label="Punch clock and today's totals">
              <PunchButton
                phase={phase}
                state={punchedIn ? "in" : "out"}
                openSince={state.open?.startAt || null}
                todayMinutesWork={todayMinutes}
                userName={currentUserName}
                locked={locked}
                onPunched={applyPunchResponse}
                onRetry={() => refresh()}
              />
              {phaseError && phase === "ready" && (
                <p className="tsx-note tone-warn" role="alert">
                  <Icon name="warn" size={13}/>
                  <span>
                    We could not refresh, so this is your last known state.{" "}
                    <button className="tsx-inline-btn" type="button" onClick={() => refresh()}>Retry</button>
                  </span>
                </p>
              )}
              {(state.today?.minutesMeeting > 0 || state.today?.minutesLunch > 0 || untaggedCount > 0) && (
                <dl className="tsx-hero-facts">
                  {state.today?.minutesMeeting > 0 && (
                    <div className="tsx-hero-fact">
                      <dt>Meetings</dt>
                      <dd className="num">{fmtHM(state.today.minutesMeeting)}</dd>
                    </div>
                  )}
                  {state.today?.minutesLunch > 0 && (
                    <div className="tsx-hero-fact">
                      <dt>Lunch</dt>
                      <dd className="num">{fmtHM(state.today.minutesLunch)}</dd>
                    </div>
                  )}
                  {untaggedCount > 0 && (
                    <div className="tsx-hero-fact is-warn">
                      <dt><Icon name="warn" size={13}/> Needs a tag</dt>
                      <dd>
                        {untaggedCount === 1
                          ? "1 time block"
                          : `${untaggedCount} time blocks`}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
            </section>
          )}

          <div className="tsx-grid">
            <main className="tsx-main">

              {/* Vertical day calendar — punches as labeled markers, intervals as cards */}
              <section className="tsx-day" aria-labelledby="tsx-day-title">
                <header className="tsx-day-head">
                  <div className="tsx-day-headline">
                    <h3 className="tsx-day-title" id="tsx-day-title">My day</h3>
                    <p className="tsx-day-sub">
                      <span className="num">{fmtHM(todayMinutes)}</span> total hours worked
                    </p>
                  </div>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => setEditDay(true)}
                    aria-label={`Edit timesheet day for ${formatDateLabel(date)}`}
                  >
                    <Icon name="edit" size={13}/> Edit day
                  </Button>
                </header>

                {/* Approved-leave band(s) for this day */}
                {dayLeave.length > 0 && (
                  <ul className="tsx-day-leave">
                    {dayLeave.map((lb, i) => (
                      <li key={lb.id || i} className={`tsx-day-leave-band tone-${lb.leaveType === "sick" ? "blue" : "sage"}`}>
                        <Icon name="sun" size={13}/>
                        <span className="tsx-day-leave-label">
                          {lb.leaveType === "sick" ? "Sick leave" : "Vacation"} · <span className="num">{lb.hoursPerDay}h</span>
                        </span>
                        <span className="tsx-day-leave-badge">approved</span>
                      </li>
                    ))}
                  </ul>
                )}

                {hasDayActivity ? (
                  <>
                    {/* Overview strip: where the day's blocks sit between 6a and 8p.
                        The list below carries the detail. */}
                    <div className="tsx-day-strip">
                      <DayTimeline
                        date={date}
                        intervals={dayIntervals}
                        onIntervalClick={setFocusInterval}
                        height={34}
                      />
                    </div>

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
                  </>
                ) : (
                  <EmptyState
                    compact
                    title={isToday ? "No punches yet today" : "No punches on this day"}
                    description={isToday
                      ? "Punch in above, or tap your badge on a Pi reader, and every block lands here with its category and notes."
                      : "Nothing was recorded for this date. Use Edit day to add the punches that are missing."}
                    action={(
                      <Button variant="default" size="sm" onClick={() => setEditDay(true)}>
                        <Icon name="edit" size={13}/> Edit day
                      </Button>
                    )}
                  />
                )}
              </section>

              {/* Week summary */}
              <WeekSummary
                userId={userId}
                weekStart={weekStart}
                days={week.days}
                week={week.week}
                onSelectDate={setDate}
                onChanged={refresh}
              />
            </main>

            <aside className="tsx-side">
              <TeamPresenceView date={date} onDate={setDate} embedded />
            </aside>
          </div>
        </div>
      ) : (
        <div
          id={sectionPanelId("leave")}
          className="tsx-panel"
          role="tabpanel"
          aria-labelledby={sectionTabId("leave")}
        >
          <MyLeaveSection reloadKey={leaveReloadKey} onRequest={() => setShowLeave(true)}/>
        </div>
      )}

      {/* Modals */}
      {editDay && (
        <UserDayModal
          userId={userId}
          initialDate={date}
          selfMode
          onClose={() => { setEditDay(false); refresh(); }}
          onDirty={() => refresh({ silent: true })}
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
          userName={currentUserName}
          onClose={() => setPrompt(null)}
          onSaved={() => refresh({ silent: true })}
        />
      )}
      {showLeave && (
        <LeaveRequestModal
          onClose={() => setShowLeave(false)}
          onSubmitted={() => setLeaveReloadKey(k => k + 1)}
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

function formatDateLabel(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric",
  });
}
