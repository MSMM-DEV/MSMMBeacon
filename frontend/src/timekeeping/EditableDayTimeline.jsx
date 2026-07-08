// EditableDayTimeline — the admin/self day canvas (Time Admin → Day editor and
// the personal "Edit Day" sheet).
//
// A vertical 6 AM → 8 PM hour rail (64 px/hour) that renders each interval as a
// card. The canvas is now a PURE VISUAL + SELECTION layer — it does not drag:
//   • click a card  → select it (opens the inspector on the right / bottom sheet)
// All time editing happens in the inspector's start/end time fields, and new
// blocks are added via the "Add block" button. Dragging was removed because the
// edge/body drag gestures were effectively unusable on touch devices; the time
// inputs cover move (edit both ends), resize (edit one end), and create.
//
// "Done for the day" (eod) blocks are not rendered here — a finished day shows
// no trailing block, matching every read-only timeline (see mergeDisplaySegments
// / HIDDEN_DISPLAY_CATEGORIES in data.js).
//
// Presence drives color (green = at desk / IN, rose = out / OUT), never category.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
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
    <div className={`tk-edit ${disabled ? "is-disabled" : ""} is-static`}>
      <div className="tk-edit-scroller" ref={scrollerRef}>
        <div className="tk-edit-track" ref={trackRef} style={{ height: TRACK_HEIGHT }}>
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

            return (
              <button
                type="button"
                key={iv.id}
                className={`tk-edit-card tone-${tone} ${blk.isOpen ? "is-open" : ""} ${isSel ? "is-selected" : ""} ${compact ? "is-compact" : ""}`}
                style={{ top, height }}
                data-category={iv.category}
                data-source={iv.categorySource}
                onClick={() => select(iv)}
                title={`${fmtClock(iv.startAt)} – ${iv.endAt ? fmtClock(iv.endAt) : "now"} · ${TK_CATEGORY_LABEL[iv.category] || iv.category}`}
              >
                <div className="tk-edit-card-body">
                  <div className="tk-edit-card-row">
                    <span className="tk-edit-card-time">{fmtClock(iv.startAt)}</span>
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
                      {blk.isOpen ? "now" : fmtClock(iv.endAt)}
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
              </button>
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
              {!disabled && <span className="tk-edit-empty-hint">Use “Add block” to enter a time</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
