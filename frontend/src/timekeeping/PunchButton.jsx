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
  if (!online)         label = "OFFLINE";
  else if (locked)     label = "WEEK LOCKED";
  else if (busy)       label = state === "in" ? "Punching out…" : "Punching in…";
  else if (error)      label = "RETRY";
  else if (isFetchErr) label = "RETRY";
  else if (isUnknown)  label = "Checking…";
  else if (showIn)     label = "Punch out";
  else                 label = "Punch in";

  const cls = [
    "tk-punch-btn",
    !online      ? "tk-punch-offline" : "",
    locked       ? "tk-punch-locked"  : "",
    error || isFetchErr ? "tk-punch-error"  : "",
    isUnknown    ? "tk-punch-loading" : "",
    online && showIn   ? "tk-punch-out" : "",
    online && showOut  ? "tk-punch-in"  : "",
    busy         ? "is-loading"       : "",
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

  return (
    <div className={`tk-punch-wrap ${statusKind ? `is-${statusKind}` : "is-standalone"}`}>
      {statusKind && (
        <div className="tk-punch-status-card">
          <span className="tk-punch-status-kicker">Current status</span>
          <div className="tk-punch-status-main">
            <span className={`tk-punch-status-dot tone-${statusKind}`} aria-hidden="true"/>
            <strong>
              <span className="tk-punch-status-title-full">{statusTitle}</span>
              <span className="tk-punch-status-title-short">{statusTitleShort}</span>
            </strong>
          </div>
          <div className="tk-punch-status-meta">
            {showIn ? (
              <>
                <span>Session Started At <strong>{fmtClock(openSince)}</strong></span>
                <span>Current Session <strong>{fmtHM(elapsed)}</strong></span>
                <span>Total Hours Worked <strong>{fmtHM(todayMinutesWork || 0)}</strong></span>
              </>
            ) : (
              <>
                <span>Ready to start your next work session</span>
                <span>Total Hours Worked <strong>{fmtHM(todayMinutesWork || 0)}</strong></span>
              </>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        className={cls}
        onClick={handleClick}
        disabled={disabled}
        aria-busy={busy || isUnknown}
        aria-label={actionLabel}
      >
        <span className="tk-punch-icon">
          <Icon name={iconName} size={30}/>
        </span>
        <span className="tk-punch-label">{label}</span>
      </button>
      {!online && (
        <div className="tk-punch-error-msg" role="status">
          You're offline — punching needs a connection. Try again once you're back online.
        </div>
      )}
      {online && error && (
        <div className="tk-punch-error-msg" role="alert">{error}</div>
      )}
      {online && !error && isFetchErr && (
        <div className="tk-punch-error-msg" role="alert">Couldn't load your timesheet. Tap to retry.</div>
      )}
    </div>
  );
}
