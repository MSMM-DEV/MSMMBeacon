// PunchButton — the big tactile toggle in the Timesheet tab.
//
// State machine (driven by props):
//   phase=loading            → grey, disabled "Checking…"  (we don't know yet)
//   phase=error              → rose, "Retry" (parent fetch failed and no cache)
//   locked                   → muted, disabled "Week locked"
//   in-flight (local)        → grey, "Punching in…" / "Punching out…"
//   error (local)            → rose,  "Retry"
//   state=out                → green, "PUNCH IN"
//   state=in                 → red,   "PUNCH OUT"
//
// Crucially: the button must NEVER default to "PUNCH IN" while the parent is
// still loading. If we don't know whether the user is in or out, a click in
// that window sends a punch that the DB trigger toggles based on actual DB
// state — which means the user can punch the wrong direction. The phase
// prop forces a neutral disabled state until we have ground truth.
//
// Geolocation: best-effort, capped at 1200 ms so the punch never blocks on
// it. Captured for audit / future geofencing; declines or timeouts don't
// affect the punch.
//
// Presentation (ui-v2.0): a single card that answers three questions without
// scrolling on a phone — am I in or out, how long has this run, and what does
// pressing the button do next. Every non-actionable state (offline, locked,
// checking, fetch error) explains itself in a note tied to the control with
// aria-describedby, and the current state is mirrored into a polite live
// region so a screen reader hears the toggle flip.

import React, { useEffect, useState, useCallback, useRef } from "react";
import { Icon } from "../icons";
import { callTimeclockPunch, fmtHM, fmtClock } from "../data";
import { usePwa } from "../pwa";

const ELAPSED_TICK_MS = 30_000;
const GEO_TIMEOUT_MS  = 1200;

function elapsedMin(openSinceIso) {
  if (!openSinceIso) return 0;
  return Math.max(0, Math.floor((Date.now() - +new Date(openSinceIso)) / 60_000));
}

function captureGeo() {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise(res => {
    const timer = setTimeout(() => res(null), GEO_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      p => {
        clearTimeout(timer);
        res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy });
      },
      () => { clearTimeout(timer); res(null); },
      { timeout: GEO_TIMEOUT_MS, maximumAge: 60_000, enableHighAccuracy: false },
    );
  });
}

export function PunchButton({
  phase = "ready",      // 'loading' | 'ready' | 'error'
  state,                // 'in' | 'out'  — only meaningful when phase==='ready'
  openSince,            // ISO string when state === 'in'
  todayMinutesWork,     // for inline summary when out
  userName = "there",
  locked = false,
  onPunched,            // (response) => void — parent applies the new state
  onRetry,              // () => void — parent re-fetches state on error
}) {
  const [busy,  setBusy]  = useState(false);   // local in-flight flag
  const [error, setError] = useState(null);
  const [, force] = useState(0);
  const inFlightRef = useRef(false);           // hard guard against double-fire
  const { online } = usePwa();

  // Tick the elapsed display every 30 s while currently in.
  useEffect(() => {
    if (state !== "in" || !openSince) return undefined;
    const id = setInterval(() => force(n => n + 1), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [state, openSince]);

  // If the parent recovers from error (phase becomes 'ready'), clear our local error.
  useEffect(() => { if (phase === "ready") setError(null); }, [phase]);

  const punch = useCallback(async () => {
    if (inFlightRef.current) return;           // hard idempotency on rapid taps
    if (phase !== "ready") return;             // don't fire when state is unknown
    if (locked) return;
    if (!online) return;                       // offline guard — never silently fail
    inFlightRef.current = true;
    setBusy(true); setError(null);
    try {
      const geo = await captureGeo();
      const response = await callTimeclockPunch({ source: "web", geo });
      onPunched?.(response);
    } catch (e) {
      setError(e?.message || "punch failed");
    } finally {
      setBusy(false);
      inFlightRef.current = false;
    }
  }, [phase, locked, online, onPunched]);

  const handleClick = () => {
    if (error) {
      // Two retry paths: local punch failure → retry the punch; parent fetch
      // failure → retry the fetch via onRetry.
      setError(null);
      punch();
    } else if (phase === "error") {
      onRetry?.();
    } else {
      punch();
    }
  };

  // ----- Label + class derivation -----------------------------------------
  const isUnknown = phase === "loading";
  const isFetchErr = phase === "error" && !error;
  const showIn  = !isUnknown && !isFetchErr && !locked && !error && state === "in";
  const showOut = !isUnknown && !isFetchErr && !locked && !error && state === "out";

  let label;
  if (!online)         label = "Offline";
  else if (locked)     label = "Week locked";
  else if (busy)       label = state === "in" ? "Punching out…" : "Punching in…";
  else if (error)      label = "Retry";
  else if (isFetchErr) label = "Retry";
  else if (isUnknown)  label = "Checking…";
  else if (showIn)     label = "Punch out";
  else                 label = "Punch in";

  const cls = [
    "tsx-punch-go",
    !online      ? "is-offline" : "",
    locked       ? "is-locked"  : "",
    error || isFetchErr ? "is-error"  : "",
    isUnknown    ? "is-checking" : "",
    online && showIn   ? "is-punchout" : "",
    online && showOut  ? "is-punchin"  : "",
    busy         ? "is-busy"       : "",
  ].filter(Boolean).join(" ");

  const iconName = !online   ? "ban"
                 : isUnknown ? "clock"
                 : locked    ? "lock"
                 : showIn    ? "lock"   // we're IN → button means "PUNCH OUT" (lock the day)
                 : "bolt";              // we're OUT or unknown → PUNCH IN

  const disabled = !online || locked || busy || isUnknown;

  const elapsed = state === "in" ? elapsedMin(openSince) : 0;
  const statusKind = showIn ? "in" : showOut ? "out" : null;
  const displayName = String(userName || "").trim() || "there";
  const statusTitle = showIn
    ? `You are now clocked in, ${displayName}`
    : showOut
      ? `You are now clocked out, ${displayName}`
      : null;
  const statusTitleShort = showIn
    ? `Clocked in, ${displayName}`
    : showOut
      ? `Clocked out, ${displayName}`
      : null;
  const actionLabel = showIn
    ? `Punch out. ${statusTitle}. Session Started At ${fmtClock(openSince)}. Current Session ${fmtHM(elapsed)}.`
    : showOut
      ? `Punch in. ${statusTitle}. Total Hours Worked ${fmtHM(todayMinutesWork || 0)}.`
      : label;

  // What pressing the control does next, in plain words. Sits under the label
  // so nobody has to infer the direction from the colour.
  const actionHint = busy ? null
    : showIn  ? "Ends the session you have running"
    : showOut ? "Starts a new work session"
    : null;

  // Why the control is unavailable (or what it is waiting on). Rendered as a
  // note and wired to the button with aria-describedby.
  const note = !online
    ? "You are offline. Punching needs a connection, so try again once you are back on network."
    : locked
      ? "This week is locked, so punches are closed. An admin can reopen it if something needs fixing."
      : isUnknown
        ? "Checking your current punch state. The button unlocks as soon as we know whether you are in or out."
        : busy
          ? "Sending your punch. This takes a moment on a slow connection."
          : error
            ? error
            : isFetchErr
              ? "We could not load your timesheet. Press to try again."
              : null;
  const noteTone = (!online || locked) ? "muted" : (error || isFetchErr) ? "bad" : "info";
  const noteId = note ? "tsx-punch-note" : undefined;

  return (
    <section className={`tsx-punch is-${statusKind || "unknown"}`} aria-label="Punch clock">
      <p className="sr-only" role="status" aria-live="polite">
        {statusTitle || label}
      </p>

      <div className="tsx-punch-card">
        <header className={`tsx-punch-state tone-${statusKind || "unknown"}`}>
          <span className="tsx-punch-kicker">Current status</span>
          <p className="tsx-punch-title">
            <span className={`tsx-punch-dot tone-${statusKind || "unknown"}`} aria-hidden="true">
              <span className="tsx-punch-dot-core"/>
            </span>
            <span className="tsx-punch-title-full">{statusTitle || label}</span>
            <span className="tsx-punch-title-short">{statusTitleShort || label}</span>
          </p>

          <div className="tsx-punch-readout">
            {showIn ? (
              <>
                <div className="tsx-punch-figure">
                  <span className="tsx-punch-figure-val num">{fmtHM(elapsed)}</span>
                  <span className="tsx-punch-figure-key">this session</span>
                </div>
                <dl className="tsx-punch-facts">
                  <div>
                    <dt>Started</dt>
                    <dd className="num">{fmtClock(openSince)}</dd>
                  </div>
                  <div>
                    <dt>Worked today</dt>
                    <dd className="num">{fmtHM(todayMinutesWork || 0)}</dd>
                  </div>
                </dl>
              </>
            ) : showOut ? (
              <>
                <div className="tsx-punch-figure">
                  <span className="tsx-punch-figure-val num">{fmtHM(todayMinutesWork || 0)}</span>
                  <span className="tsx-punch-figure-key">worked today</span>
                </div>
                <p className="tsx-punch-hint">Ready to start your next work session.</p>
              </>
            ) : (
              <div className="tsx-punch-figure is-placeholder">
                <span className="tsx-punch-figure-val num" aria-hidden="true">–</span>
                <span className="tsx-punch-figure-key">{label}</span>
              </div>
            )}
          </div>
        </header>

        <div className="tsx-punch-action">
          <button
            type="button"
            className={cls}
            onClick={handleClick}
            disabled={disabled}
            aria-busy={busy || isUnknown}
            aria-label={actionLabel}
            aria-describedby={noteId}
          >
            <span className="tsx-punch-go-icon" aria-hidden="true">
              {busy
                ? <Icon name="spinner" size={26} className="tsx-spin"/>
                : <Icon name={iconName} size={26}/>}
            </span>
            <span className="tsx-punch-go-copy">
              <span className="tsx-punch-go-label">{label}</span>
              {actionHint && <span className="tsx-punch-go-hint">{actionHint}</span>}
            </span>
          </button>

          {note && (
            <p
              id={noteId}
              className={`tsx-punch-note tone-${noteTone}`}
              role={(error || isFetchErr) ? "alert" : "status"}
            >
              <Icon name={(error || isFetchErr) ? "warn" : !online ? "ban" : locked ? "lock" : "info"} size={13}/>
              <span>{note}</span>
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
