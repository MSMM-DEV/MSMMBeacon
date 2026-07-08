// EditableDayTimeline — the admin's draggable day canvas (Time Admin → Day editor).
//
// A vertical 6 AM → 8 PM hour rail (64 px/hour) where each interval is a card the
// admin can DIRECTLY manipulate:
//   • drag a card body              → move the whole block (shifts both punches)
//   • drag the top / bottom handle  → move the start / end punch
//   • drag on empty track           → carve a NEW block (opens the create form)
//   • click a card (no drag)        → select it (opens the inspector)
//
// Presence drives color (green = at desk / IN, rose = out / OUT) — never category.
// Times snap to 5-minute steps; a floating mono chip shows the live edge time.
// The component is presentational + gesture-only: it never writes to the DB. It
// reports resolved edits up via onCommitEdits / onCreateRange, and the parent
// (UserDayModal) routes them through the admin day-edit mutators in data.js.
//
// Gesture handlers are stable (useCallback([])) and read everything from refs,
// so the window pointermove/up listeners added on pointerdown are the exact
// same references removed on pointerup — no listener leaks across drags.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import {
  ctMinutesOfIso, ctWallMinToISO, intervalTone,
  TK_CATEGORY_LABEL, fmtClock, fmtHM, todayInCT,
} from "../data";

const TZ              = "America/Chicago";
const TRACK_START_HR  = 6;
const TRACK_END_HR    = 20;
const HOUR_PX         = 64;
const PX_PER_MIN      = HOUR_PX / 60;
const TRACK_MIN       = TRACK_START_HR * 60;
const TRACK_MAX       = TRACK_END_HR * 60;
const TRACK_HEIGHT    = (TRACK_END_HR - TRACK_START_HR) * HOUR_PX;
const SNAP_MIN        = 5;
const MIN_DUR         = 5;
const NOW_TICK_MS     = 30_000;

const ctDateOf = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
const snap     = (m) => Math.round(m / SNAP_MIN) * SNAP_MIN;
const clampMin = (m) => Math.max(TRACK_MIN, Math.min(TRACK_MAX, m));
const minToY   = (m) => (clampMin(m) - TRACK_MIN) * PX_PER_MIN;
const fmtMinClock = (m) => {
  const h24 = Math.floor(m / 60), mm = ((Math.round(m) % 60) + 60) % 60;
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
};
const hourLabel = (h) => (h === 12 ? "noon" : h > 12 ? `${h - 12}p` : `${h}a`);

export function EditableDayTimeline({
  date,
  intervals = [],
  selectedId = null,
  disabled = false,
  busy = false,
  onSelectInterval,     // (interval) => void               — click without drag
  onCommitEdits,        // (edits:[{id,punchedAt}]) => void  — drag move/resize landed
  onCreateRange,        // ({startMin,endMin}) => void       — carve on empty track
}) {
  const isToday = date === todayInCT();
  const scrollerRef = useRef(null);
  const trackRef    = useRef(null);

  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (!isToday) return undefined;
    const id = setInterval(() => setNowTick((t) => t + 1), NOW_TICK_MS);
    return () => clearInterval(id);
  }, [isToday]);

  const nowMin = ctMinutesOfIso(new Date().toISOString());

  // Latest props/state mirrored into a ref so the stable gesture handlers
  // always see current values without being recreated.
  const ctx = useRef({});
  ctx.current = { date, disabled, busy, onSelectInterval, onCommitEdits, onCreateRange };

  // ----- base geometry per interval -----
  const blocks = useMemo(() => {
    return (intervals || []).map((iv) => {
      const startSameDay = ctDateOf(iv.startAt) === date;
      const endSameDay   = iv.endAt ? ctDateOf(iv.endAt) === date : true;
      if (!startSameDay && iv.endAt && !endSameDay && ctDateOf(iv.startAt) > date) return null;

      let startMin = startSameDay ? ctMinutesOfIso(iv.startAt) : TRACK_MIN;
      let endMin   = iv.endAt
        ? (endSameDay ? ctMinutesOfIso(iv.endAt) : TRACK_MAX)
        : (isToday ? nowMin : TRACK_MAX);
      if (endMin <= startMin) endMin = startMin + MIN_DUR;

      const isOpen = iv.endAt == null;
      return {
        iv, startMin, endMin, isOpen,
        canMoveStart: !!iv.startPunchId && startSameDay,
        canMoveEnd:   !!iv.endPunchId   && endSameDay && !isOpen,
      };
    }).filter(Boolean);
  }, [intervals, date, isToday, nowMin]);

  // ----- drag plumbing -----
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null);

  const handleMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();

    const trackEl = trackRef.current;
    const rect = trackEl ? trackEl.getBoundingClientRect() : { top: 0 };

    if (d.mode === "create") {
      d.curMin = snap(clampMin(TRACK_MIN + (e.clientY - rect.top) / PX_PER_MIN));
      d.moved = Math.abs(d.curMin - d.anchorMin) >= MIN_DUR;
      setDrag({ ...d });
      return;
    }

    const delta = snap((e.clientY - d.originClientY) / PX_PER_MIN);
    const moves = {};
    if (d.mode === "start") {
      moves[d.startPunchId] = Math.max(TRACK_MIN, Math.min(d.baseEndMin - MIN_DUR, d.baseStartMin + delta));
    } else if (d.mode === "end") {
      moves[d.endPunchId] = Math.min(TRACK_MAX, Math.max(d.baseStartMin + MIN_DUR, d.baseEndMin + delta));
    } else if (d.mode === "move") {
      let dl = delta;
      dl = Math.max(dl, TRACK_MIN - d.baseStartMin);
      dl = Math.min(dl, TRACK_MAX - d.baseEndMin);
      if (d.startPunchId) moves[d.startPunchId] = d.baseStartMin + dl;
      if (d.endPunchId)   moves[d.endPunchId]   = d.baseEndMin + dl;
    }
    d.moves = moves;
    d.moved = Object.entries(moves).some(([id, m]) => Number.isFinite(m) && m !== d.baseMinByPunch[id]);
    setDrag({ ...d });
  }, []);

  const handleUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    try { d?.pointerTarget?.releasePointerCapture?.(d.pointerId); } catch {}
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    window.removeEventListener("pointercancel", handleUp);
    if (!d) return;
    const c = ctx.current;

    if (d.mode === "create") {
      const lo = Math.min(d.anchorMin, d.curMin ?? d.anchorMin);
      const hi = Math.max(d.anchorMin, d.curMin ?? d.anchorMin);
      if (d.moved && hi - lo >= MIN_DUR) c.onCreateRange?.({ startMin: lo, endMin: hi });
      return;
    }
    if (!d.moved) { c.onSelectInterval?.(d.iv); return; }
    const moves = d.moves || {};
    const edits = Object.entries(moves)
      .filter(([id, m]) => id && id !== "null" && id !== "undefined"
        && Number.isFinite(m) && m !== d.baseMinByPunch[id])
      .map(([id, m]) => ({ id, punchedAt: ctWallMinToISO(c.date, m) }));
    if (edits.length > 0) c.onCommitEdits?.(edits);
  }, [handleMove]);

  const beginGesture = useCallback((e, descriptor) => {
    const c = ctx.current;
    if (c.disabled || c.busy) return;
    e.stopPropagation();
    e.preventDefault();
    try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch {}
    dragRef.current = {
      ...descriptor,
      originClientY: e.clientY,
      pointerId: e.pointerId,
      pointerTarget: e.currentTarget,
      moved: false,
      moves: {},
    };
    setDrag({ ...dragRef.current });
    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  }, [handleMove, handleUp]);

  useEffect(() => () => {
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    window.removeEventListener("pointercancel", handleUp);
  }, [handleMove, handleUp]);

  const onTrackPointerDown = (e) => {
    if (disabled || busy) return;
    // Touch keeps native scroll on empty space (create-drag is mouse/pen only;
    // touch users add via the inspector's "Add a block"). Cards still drag on
    // touch via their own touch-action:none.
    if (e.pointerType === "touch") return;
    const isBg = e.target === trackRef.current || e.target.classList?.contains("tk-edit-track-bg");
    if (!isBg) return;
    const rect = trackRef.current.getBoundingClientRect();
    const anchor = snap(clampMin(TRACK_MIN + (e.clientY - rect.top) / PX_PER_MIN));
    beginGesture(e, { mode: "create", anchorMin: anchor, curMin: anchor });
  };

  // live preview lookups
  const previewMoves = drag && drag.mode !== "create" ? (drag.moves || {}) : null;
  const previewMinutes = (blk) => {
    if (!previewMoves) return { s: blk.startMin, e: blk.endMin };
    const sp = blk.iv.startPunchId, ep = blk.iv.endPunchId;
    return {
      s: (sp != null && previewMoves[sp] != null) ? previewMoves[sp] : blk.startMin,
      e: (ep != null && previewMoves[ep] != null) ? previewMoves[ep] : blk.endMin,
    };
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let target = (8 - TRACK_START_HR) * HOUR_PX - HOUR_PX;
    if (isToday) target = minToY(nowMin) - 2 * HOUR_PX;
    else if (blocks.length) target = minToY(blocks[0].startMin) - HOUR_PX;
    el.scrollTop = Math.max(0, target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const hours = Array.from({ length: TRACK_END_HR - TRACK_START_HR + 1 }, (_, i) => TRACK_START_HR + i);
  const createSel = drag?.mode === "create"
    ? { lo: Math.min(drag.anchorMin, drag.curMin), hi: Math.max(drag.anchorMin, drag.curMin) }
    : null;

  const handleDescriptor = (iv, blk, mode) => ({
    mode, intervalId: iv.id, iv,
    startPunchId: iv.startPunchId, endPunchId: iv.endPunchId,
    baseStartMin: blk.startMin, baseEndMin: blk.endMin,
    baseMinByPunch: Object.fromEntries(
      [[iv.startPunchId, blk.startMin], [iv.endPunchId, blk.endMin]].filter(([k]) => k != null)
    ),
  });

  return (
    <div className={`tk-edit ${disabled ? "is-disabled" : ""} ${drag ? "is-dragging" : ""}`}>
      <div className="tk-edit-scroller" ref={scrollerRef}>
        <div className="tk-edit-track" ref={trackRef} style={{ height: TRACK_HEIGHT }} onPointerDown={onTrackPointerDown}>
          <div className="tk-edit-track-bg" aria-hidden="true" />

          <div className="tk-edit-gutter" aria-hidden="true">
            {hours.map((h) => (
              <div key={h} className="tk-edit-hour-label" style={{ top: (h - TRACK_START_HR) * HOUR_PX - 6 }}>
                {hourLabel(h)}
              </div>
            ))}
          </div>
          <div className="tk-edit-grid" aria-hidden="true">
            {hours.map((h, i) => <div key={h} className="tk-edit-hour-line" style={{ top: i * HOUR_PX }} />)}
            {hours.slice(0, -1).map((h, i) => (
              <div key={`half-${h}`} className="tk-edit-half-line" style={{ top: i * HOUR_PX + HOUR_PX / 2 }} />
            ))}
          </div>

          <div
            className="tk-edit-workday"
            style={{ top: minToY(8 * 60), height: minToY(17 * 60) - minToY(8 * 60) }}
            aria-hidden="true"
          >
            <span className="tk-edit-workday-tag">Workday · 8a – 5p</span>
          </div>

          {createSel && createSel.hi - createSel.lo >= 1 && (
            <div className="tk-edit-create-ghost"
              style={{ top: minToY(createSel.lo), height: minToY(createSel.hi) - minToY(createSel.lo) }}>
              <span className="tk-edit-create-ghost-label">
                <Icon name="plus" size={12} /> {fmtMinClock(createSel.lo)} – {fmtMinClock(createSel.hi)}
              </span>
            </div>
          )}

          {blocks.map((blk) => {
            const { iv } = blk;
            const { s, e } = previewMinutes(blk);
            const top = minToY(s);
            const height = Math.max(20, minToY(e) - top);
            const tone = intervalTone(iv);
            const compact = height < 46;
            const isSel = iv.id === selectedId;
            const dragging = drag && drag.intervalId === iv.id && drag.mode !== "create";
            const isAdmin = iv.categorySource === "admin";
            const isUser  = iv.categorySource === "user";
            const dur = Math.max(0, Math.round(e - s));
            const bodyMode = blk.canMoveStart && blk.canMoveEnd ? "move" : (blk.canMoveStart ? "start" : "none");

            return (
              <div
                key={iv.id}
                className={`tk-edit-card tone-${tone} ${blk.isOpen ? "is-open" : ""} ${isSel ? "is-selected" : ""} ${dragging ? "is-dragging-card" : ""} ${compact ? "is-compact" : ""} ${bodyMode === "none" ? "is-locked" : ""}`}
                style={{ top, height }}
                data-category={iv.category}
                data-source={iv.categorySource}
                onPointerDown={(ev) => bodyMode !== "none" && beginGesture(ev, handleDescriptor(iv, blk, bodyMode))}
                onClick={(ev) => { if (bodyMode === "none") { ev.stopPropagation(); onSelectInterval?.(iv); } }}
                role="button"
                tabIndex={0}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onSelectInterval?.(iv); } }}
                title={`${fmtClock(iv.startAt)} – ${iv.endAt ? fmtClock(iv.endAt) : "now"} · ${TK_CATEGORY_LABEL[iv.category] || iv.category}`}
              >
                {blk.canMoveStart && !blk.isOpen && (
                  <span className="tk-edit-handle tk-edit-handle-top"
                    onPointerDown={(ev) => beginGesture(ev, handleDescriptor(iv, blk, "start"))}>
                    <span className="tk-edit-handle-grip" />
                  </span>
                )}

                <div className="tk-edit-card-body">
                  <div className="tk-edit-card-row">
                    <span className="tk-edit-card-time">{dragging ? fmtMinClock(s) : fmtClock(iv.startAt)}</span>
                    <span className="tk-edit-card-dur">{fmtHM(dur)}</span>
                  </div>
                  {!compact && (
                    <div className="tk-edit-card-label">
                      {iv.outlookEventId && <Icon name="link" size={11} />}
                      {iv.outlookEventSubject || TK_CATEGORY_LABEL[iv.category] || iv.category}
                    </div>
                  )}
                  {!compact && iv.notes && (
                    <div className="tk-edit-card-note"><Icon name="edit" size={10} /><span>{iv.notes}</span></div>
                  )}
                  <div className="tk-edit-card-foot">
                    <span className="tk-edit-card-time-end">
                      {blk.isOpen ? "now" : (dragging ? fmtMinClock(e) : fmtClock(iv.endAt))}
                    </span>
                    {(isAdmin || isUser) && (
                      <span className={`tk-edit-card-src is-${iv.categorySource}`}>
                        <Icon name="check" size={10} /> {iv.categorySource}
                      </span>
                    )}
                  </div>
                </div>

                {blk.isOpen && <span className="tk-edit-card-livedot" aria-hidden="true" />}
                {iv.notes && compact && <span className="tk-edit-card-notedot" aria-hidden="true" />}

                {blk.canMoveEnd && (
                  <span className="tk-edit-handle tk-edit-handle-bot"
                    onPointerDown={(ev) => beginGesture(ev, handleDescriptor(iv, blk, "end"))}>
                    <span className="tk-edit-handle-grip" />
                  </span>
                )}
              </div>
            );
          })}

          {isToday && (
            <div className="tk-edit-now" style={{ top: minToY(nowMin) }} aria-hidden="true">
              <span className="tk-edit-now-dot" />
              <span className="tk-edit-now-line" />
            </div>
          )}

          {blocks.length === 0 && (
            <div className="tk-edit-empty">
              <Icon name="clock" size={18} />
              <span>No punches on this day</span>
              {!disabled && <span className="tk-edit-empty-hint">Drag on an empty area to add a block</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
