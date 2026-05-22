// PunchButton — the big tactile toggle in the Timesheet tab.
//
// State machine:
//   out          → primary green "PUNCH IN"        → POST source=web
//   in           → primary red   "PUNCH OUT"       → POST source=web
//   loading      → grey, disabled                  → ... while in-flight
//   locked       → muted, disabled                 → "week is locked"
//   error        → rose, "RETRY"                   → re-issue
//
// Geolocation: the browser asks for it once on first PUNCH IN. We don't block
// the punch if the user declines — geo is captured for audit / future
// geofencing but never required.

import React, { useEffect, useState, useCallback } from "react";
import { Icon } from "../icons";
import { callTimeclockPunch, fmtHM, fmtClock } from "../data";

const ELAPSED_TICK_MS = 30_000;

function elapsedMin(openSinceIso) {
  if (!openSinceIso) return 0;
  return Math.floor((Date.now() - +new Date(openSinceIso)) / 60_000);
}

export function PunchButton({
  state,             // 'in' | 'out'
  openSince,         // ISO string when state === 'in'
  todayMinutesWork,  // for inline summary
  locked = false,
  onPunched,         // (response) => void
}) {
  const [loading, setLoading]   = useState(false);
  const [error,   setError]     = useState(null);
  const [_, force]              = useState(0);

  // Tick the elapsed display every 30 s while currently in.
  useEffect(() => {
    if (state !== "in" || !openSince) return undefined;
    const id = setInterval(() => force(n => n + 1), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [state, openSince]);

  const punch = useCallback(async () => {
    setLoading(true); setError(null);
    let geo = null;
    if (navigator.geolocation) {
      // Best-effort, 3 s ceiling — we never block on it.
      geo = await new Promise(res => {
        const timer = setTimeout(() => res(null), 3_000);
        navigator.geolocation.getCurrentPosition(
          p => { clearTimeout(timer); res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy }); },
          () => { clearTimeout(timer); res(null); },
          { timeout: 3_000, maximumAge: 60_000, enableHighAccuracy: false },
        );
      });
    }
    try {
      const r = await callTimeclockPunch({ source: "web", geo });
      onPunched?.(r);
    } catch (e) {
      setError(e.message || "punch failed");
    } finally {
      setLoading(false);
    }
  }, [onPunched]);

  const label = locked  ? "WEEK LOCKED"
              : error   ? "RETRY"
              : loading ? "…"
              : state === "in" ? "PUNCH OUT" : "PUNCH IN";
  const cls = [
    "tk-punch-btn",
    locked ? "tk-punch-locked" : "",
    error  ? "tk-punch-error"  : "",
    !error && !locked && state === "in"  ? "tk-punch-out" : "",
    !error && !locked && state === "out" ? "tk-punch-in"  : "",
    loading ? "is-loading" : "",
  ].filter(Boolean).join(" ");

  const elapsed = state === "in" ? elapsedMin(openSince) : 0;

  return (
    <div className="tk-punch-wrap">
      <button
        type="button"
        className={cls}
        onClick={punch}
        disabled={loading || locked}
      >
        <span className="tk-punch-icon">
          <Icon name={state === "in" ? "lock" : "bolt"} size={28}/>
        </span>
        <span className="tk-punch-label">{label}</span>
        {state === "in" && !locked && !error && (
          <span className="tk-punch-sub">in for {fmtHM(elapsed)}</span>
        )}
        {state === "out" && !locked && !error && (
          <span className="tk-punch-sub">today · {fmtHM(todayMinutesWork || 0)}</span>
        )}
      </button>
      {error && (
        <div className="tk-punch-error-msg">{error}</div>
      )}
      {openSince && state === "in" && (
        <div className="tk-punch-since">Last punch · {fmtClock(openSince)}</div>
      )}
    </div>
  );
}
