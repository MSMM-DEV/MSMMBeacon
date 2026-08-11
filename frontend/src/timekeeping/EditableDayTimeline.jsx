// EditableDayTimeline — the admin/self day canvas (Time Admin → Day editor and
// the personal "Edit Day" sheet).
//
// A vertical 6 AM → 8 PM hour rail (64 px/hour) that renders each interval as a
// card. The canvas is a PURE VISUAL + SELECTION layer — it does not drag:
//   • click (or focus + Enter) a card → select it, which opens the inspector
// All time editing happens in the inspector's start/end time fields, and new
// blocks are added via the "Add block" button. Dragging was removed because the
// edge/body drag gestures were effectively unusable on touch devices; the time
// inputs cover move (edit both ends), resize (edit one end), and create.
//
// Because the edges are NOT draggable, the card renders explicit boundary rules
// at its start and end plus an "Edit times" affordance on hover/focus, so the
// editable handles read as "these two times are what you change", not as a
// drag target that silently does nothing.
//
// "Done for the day" (eod) blocks are not rendered here — a finished day shows
// no trailing block, matching every read-only timeline (see mergeDisplaySegments
// / HIDDEN_DISPLAY_CATEGORIES in data.js).
//
// Presence drives color (sage = at desk / IN, clay = out / OUT), never category.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/icons";
import {
  ctMinutesOfIso, intervalTone, HIDDEN_DISPLAY_CATEGORIES,
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
const MIN_DUR         = 5;
const NOW_TICK_MS     = 30_000;

const ctDateOf = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
const clampMin = (m) => Math.max(TRACK_MIN, Math.min(TRACK_MAX, m));
const minToY   = (m) => (clampMin(m) - TRACK_MIN) * PX_PER_MIN;
const hourLabel = (h) => (h === 12 ? "noon" : h > 12 ? `${h - 12}p` : `${h}a`);

export function EditableDayTimeline({
  date,
  intervals = [],
  selectedId = null,
  disabled = false,
  busy = false,
  onSelectInterval,     // (interval) => void — click a card to open the inspector
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

  // ----- base geometry per interval (raw, unmerged — each block stays its own
  //       selectable unit — but "Done for the day" is hidden like elsewhere). -----
  const blocks = useMemo(() => {
    return (intervals || [])
      .filter((iv) => iv && !HIDDEN_DISPLAY_CATEGORIES.has(iv.category))
      .map((iv) => {
        const startSameDay = ctDateOf(iv.startAt) === date;
        const endSameDay   = iv.endAt ? ctDateOf(iv.endAt) === date : true;
        if (!startSameDay && iv.endAt && !endSameDay && ctDateOf(iv.startAt) > date) return null;

        let startMin = startSameDay ? ctMinutesOfIso(iv.startAt) : TRACK_MIN;
        let endMin   = iv.endAt
          ? (endSameDay ? ctMinutesOfIso(iv.endAt) : TRACK_MAX)
          : (isToday ? nowMin : TRACK_MAX);
        if (endMin <= startMin) endMin = startMin + MIN_DUR;

        return { iv, startMin, endMin, isOpen: iv.endAt == null };
      })
      .filter(Boolean);
  }, [intervals, date, isToday, nowMin]);

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

  const select = (iv) => { if (!disabled && !busy) onSelectInterval?.(iv); };

  return (
    <div className={`tka-et ${disabled ? "is-disabled" : ""} ${busy ? "is-busy" : ""}`}>
      <div className="tka-et-legend">
        <span className="tka-et-legenditem"><span className="tka-swatch tone-sage" aria-hidden="true"/>At desk</span>
        <span className="tka-et-legenditem"><span className="tka-swatch tone-rose" aria-hidden="true"/>Out</span>
        <span className="tka-et-legendhint">
          <Icon name="edit" size={11}/>
          Select a block to change its times
        </span>
      </div>

      <div className="tka-et-scroller" ref={scrollerRef} tabIndex={-1}>
        <div className="tka-et-track" ref={trackRef} style={{ height: TRACK_HEIGHT }}>
          <div className="tka-et-bg" aria-hidden="true" />

          <div className="tka-et-gutter" aria-hidden="true">
            {hours.map((h) => (
              <span key={h} className="tka-et-hour num" style={{ top: (h - TRACK_START_HR) * HOUR_PX - 6 }}>
                {hourLabel(h)}
              </span>
            ))}
          </div>
          <div className="tka-et-grid" aria-hidden="true">
            {hours.map((h, i) => <span key={h} className="tka-et-hourline" style={{ top: i * HOUR_PX }} />)}
            {hours.slice(0, -1).map((h, i) => (
              <span key={`half-${h}`} className="tka-et-halfline" style={{ top: i * HOUR_PX + HOUR_PX / 2 }} />
            ))}
          </div>

          <div
            className="tka-et-workday"
            style={{ top: minToY(8 * 60), height: minToY(17 * 60) - minToY(8 * 60) }}
            aria-hidden="true"
          >
            <span className="tka-et-workday-tag">Workday · 8a to 5p</span>
          </div>

          {blocks.map((blk) => {
            const { iv, startMin, endMin } = blk;
            const top = minToY(startMin);
            const height = Math.max(20, minToY(endMin) - top);
            const tone = intervalTone(iv);
            const compact = height < 46;
            const isSel = iv.id === selectedId;
            const isAdmin = iv.categorySource === "admin";
            const isUser  = iv.categorySource === "user";
            const dur = Math.max(0, Math.round(endMin - startMin));
            const catLabel = TK_CATEGORY_LABEL[iv.category] || iv.category;
            const endLabel = blk.isOpen ? "now" : fmtClock(iv.endAt);

            return (
              <button
                type="button"
                key={iv.id}
                className={`tka-et-card tone-${tone} ${blk.isOpen ? "is-open" : ""} ${isSel ? "is-selected" : ""} ${compact ? "is-compact" : ""}`}
                style={{ top, height }}
                data-category={iv.category}
                data-source={iv.categorySource}
                aria-pressed={isSel}
                aria-label={`${catLabel}, ${fmtClock(iv.startAt)} to ${endLabel}, ${fmtHM(dur)}. Select to edit.`}
                onClick={() => select(iv)}
                title={`${fmtClock(iv.startAt)} – ${endLabel} · ${catLabel}`}
              >
                {/* Boundary rules — the two times the inspector edits. */}
                <span className="tka-et-edge is-start" aria-hidden="true"/>
                <span className="tka-et-edge is-end" aria-hidden="true"/>

                <span className="tka-et-card-body">
                  <span className="tka-et-card-row">
                    <span className="tka-et-card-time num">{fmtClock(iv.startAt)}</span>
                    <span className="tka-et-card-dur num">{fmtHM(dur)}</span>
                  </span>
                  {!compact && (
                    <span className="tka-et-card-label">
                      {iv.outlookEventId && <Icon name="link" size={11} />}
                      {iv.outlookEventSubject || catLabel}
                    </span>
                  )}
                  {!compact && iv.notes && (
                    <span className="tka-et-card-note"><Icon name="note" size={11} /><span>{iv.notes}</span></span>
                  )}
                  <span className="tka-et-card-foot">
                    <span className="tka-et-card-end num">{endLabel}</span>
                    {(isAdmin || isUser) && (
                      <span className={`tka-et-card-src is-${iv.categorySource}`}>
                        <Icon name="check" size={10} /> {iv.categorySource}
                      </span>
                    )}
                  </span>
                </span>

                <span className="tka-et-card-cta" aria-hidden="true">
                  <Icon name="edit" size={11}/> Edit times
                </span>

                {blk.isOpen && <span className="tka-et-livedot" aria-hidden="true" />}
                {iv.notes && compact && <span className="tka-et-notedot" aria-hidden="true" />}
              </button>
            );
          })}

          {isToday && (
            <div className="tka-et-now" style={{ top: minToY(nowMin) }} aria-hidden="true">
              <span className="tka-et-now-dot" />
              <span className="tka-et-now-line" />
            </div>
          )}

          {blocks.length === 0 && (
            <div className="tka-et-empty">
              <Icon name="clock" size={20} />
              <span>No punches on this day</span>
              {!disabled && <span className="tka-et-empty-hint">Use Add block to enter a time</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
