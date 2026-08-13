// IntervalReclassifyPopover — the block editor behind a click on any time block
// in the personal Timesheet (both the horizontal strip and the day list).
//
// It edits ONE block completely: start, end, category and note. Times used to
// live only in the day editor's inspector, which meant clicking a block opened
// a panel that printed the two numbers the user came to change as static text —
// the click succeeded and then couldn't finish the job. Both editors now write
// through data.js `saveTimeBlock`, so the punch-edit → re-derive → re-match →
// reclassify sequence exists in exactly one place.
//
// "Edit your time" (the day editor) keeps the work that has no block to click:
// adding a block that was never punched, deleting one, stepping across dates.
//
// The caller renders this detached (no trigger element of its own), so the Radix
// popover hangs off a zero-size anchor pinned to the middle of the viewport and
// runs in `modal` mode, which gives it focus trapping, Escape and outside-click
// dismissal without hand-rolling an overlay.

import React, { useRef, useState } from "react";
import { Icon } from "@/icons";
import {
  Alert, Badge, Button, Field, Popover, PopoverAnchor, PopoverContent,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea,
} from "@/ui";
import {
  fmtClock, fmtHM, saveTimeBlock, ctMinutesOfIso, TIME_BLOCK_MIN_MINUTES,
  TK_CATEGORY_LABEL, TK_CATEGORY_TONE,
} from "../data";
import { presenceForCategory } from "../timekeepingPolicy";

export const CATEGORY_USER_OPTIONS = [
  ["work",             "Working"             ],
  ["meeting",          "Meeting"             ],
  ["travel",           "Site visit"          ],
  ["lunch",            "Lunch"               ],
  ["break",            "Break"               ],
  ["vacation",         "Vacation"            ],
  ["eod",              "Done for the day"    ],   // stops the red overlay
  ["meeting_untagged", "(leave as untagged)" ],
];

const pad2      = (n) => String(n).padStart(2, "0");
const minToHHMM = (m) => `${pad2(Math.floor(m / 60))}:${pad2(Math.round(m) % 60)}`;
const hhmmToMin = (s) => {
  const [h, m] = (s || "").split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
// "9:02 AM" for a wall-clock minute — mirrors fmtClock so the live header title
// reads identically whether it comes from the saved ISO or the pending draft.
const fmtMin = (m) => {
  const h24 = Math.floor(m / 60);
  const mm  = m % 60;
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${pad2(mm)} ${h24 >= 12 ? "PM" : "AM"}`;
};

export function IntervalReclassifyPopover({
  interval, locked, date, userId, onClose, onSaved,
}) {
  const [category, setCategory] = useState(interval.category);
  const [notes,    setNotes]    = useState(interval.notes || "");
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState(null);

  const isOpenBlock = interval.endAt == null;
  const baseStart   = ctMinutesOfIso(interval.startAt);
  const baseEnd     = interval.endAt ? ctMinutesOfIso(interval.endAt) : null;

  const [start, setStart] = useState(minToHHMM(baseStart));
  const [end,   setEnd]   = useState(baseEnd == null ? "" : minToHHMM(baseEnd));

  const categoryRef = useRef(null);

  // A merged display segment carries the FIRST interval's id and the LAST one's
  // endAt (mergeDisplaySegments fuses same-category blocks split by a <=5 min
  // gap), so its boundaries don't belong to one punch pair. Tag and note still
  // apply cleanly to the id, so only the time fields are withheld.
  const merged = !!interval.merged;
  // Without a boundary punch there is nothing to move — a block whose start was
  // carried in from the previous day, or an open block with no end yet.
  const canEditStart = !!interval.startPunchId && !merged && !locked;
  const canEditEnd   = !!interval.endPunchId && !isOpenBlock && !merged && !locked;
  const timesLocked  = merged || locked;

  const startMin = hhmmToMin(start);
  const endMin   = hhmmToMin(end);
  const duration = endMin != null && startMin != null ? endMin - startMin : null;
  const tooShort = duration != null && duration < TIME_BLOCK_MIN_MINUTES;

  const save = async () => {
    if (locked) return;
    if (startMin == null) { setErr("enter a start time"); return; }
    if (!isOpenBlock && endMin == null) { setErr("enter an end time"); return; }
    if (tooShort) {
      setErr(`a block must be at least ${TIME_BLOCK_MIN_MINUTES} minutes long`);
      return;
    }
    setBusy(true); setErr(null);
    try {
      await saveTimeBlock({
        interval, userId, date,
        startMin: canEditStart ? startMin : null,
        endMin:   canEditEnd   ? endMin   : null,
        category,
        notes: notes.trim() || null,
        source: "user",
      });
      onSaved?.();
      onClose?.();
    } catch (e) { setErr(e.message || "save failed"); }
    finally { setBusy(false); }
  };

  const forcedPresence = presenceForCategory(category, interval);
  const presenceLabel = category === "meeting"
    ? "Keeps current in/out state"
    : forcedPresence === false
    ? "Counts as in-time"
    : forcedPresence === true
      ? "Marked as out-time"
      : "Keeps current in/out state";

  // Header title tracks the DRAFT, not the saved row, so the times never read as
  // fixed text again — editing a field visibly moves the block's identity.
  const headTitle = `${startMin == null ? fmtClock(interval.startAt) : fmtMin(startMin)} – ${
    isOpenBlock ? "now" : (endMin == null ? fmtClock(interval.endAt) : fmtMin(endMin))
  }`;

  return (
    <Popover open modal onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <PopoverAnchor asChild>
        <span className="tka-vp-anchor" aria-hidden="true"/>
      </PopoverAnchor>

      <PopoverContent
        align="center"
        side="bottom"
        sideOffset={0}
        aria-label="Edit time block"
        className="tka-reclass w-[min(420px,calc(100vw-24px))] p-0"
        // Land on the tag, not the start time: retagging is by far the most
        // frequent edit on this page. The times stay in first position because
        // that position is what sets the expectation we're fixing.
        onOpenAutoFocus={(e) => { e.preventDefault(); categoryRef.current?.focus(); }}
      >
        <header className="tka-reclass-head">
          <div className="min-w-0">
            <p className="tka-eyebrow">Time block</p>
            <p className="tka-reclass-title num">{headTitle}</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14}/>
          </Button>
        </header>

        <div className="tka-reclass-body">
          {locked && (
            <Alert tone="warning">
              This week was approved and locked, so it can&rsquo;t be edited here.
              Ask an admin to unlock the week or submit a correction request.
            </Alert>
          )}

          {interval.outlookEventSubject && (
            <p className="tka-reclass-outlook">
              <Icon name="link" size={12}/>
              Linked to Outlook event: <strong>{interval.outlookEventSubject}</strong>
              {interval.outlookEventLocation && <> · {interval.outlookEventLocation}</>}
            </p>
          )}

          <div className="tka-insp-field">
            <span className="tka-insp-label" id="tka-reclass-timeslabel">Times</span>
            <div className="tka-insp-times" role="group" aria-labelledby="tka-reclass-timeslabel">
              <input
                type="time"
                className="tka-dateinput num"
                value={start}
                onChange={(e) => { setStart(e.target.value); setErr(null); }}
                disabled={!canEditStart || busy}
                aria-label="Starts"
              />
              <Icon name="forward" size={13} className="tka-insp-arrow"/>
              <input
                type="time"
                className="tka-dateinput num"
                value={end}
                onChange={(e) => { setEnd(e.target.value); setErr(null); }}
                disabled={!canEditEnd || busy}
                aria-label={isOpenBlock ? "Ends, open block running until now" : "Ends"}
              />
            </div>
            <p className="tka-insp-hint">
              {merged
                ? "These punches are shown merged — use Edit your time to change their times."
                : timesLocked
                ? "Times can’t be changed while the week is locked."
                : isOpenBlock
                ? "This block is still running, so it ends at now."
                : duration != null && !tooShort
                ? `${fmtHM(duration)} long.`
                : `A block must be at least ${TIME_BLOCK_MIN_MINUTES} minutes long.`}
            </p>
          </div>

          <Field label="Category" htmlFor="tka-reclass-cat">
            <Select value={category} onValueChange={setCategory} disabled={locked}>
              <SelectTrigger id="tka-reclass-cat" ref={categoryRef} aria-label="Category">
                <SelectValue/>
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_USER_OPTIONS.map(([v, l]) => (
                  <SelectItem key={v} value={v}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="tka-reclass-preview">
            <span className={`tka-chip is-on tone-${TK_CATEGORY_TONE[category] || "muted"}`}>
              <span className="tka-chip-dot" aria-hidden="true"/>
              {TK_CATEGORY_LABEL[category] || category}
            </span>
            <Badge tone={forcedPresence ? "danger" : "success"} size="sm" dot>
              {presenceLabel}
            </Badge>
          </div>

          <Field label="Note" htmlFor="tka-reclass-note">
            <Textarea id="tka-reclass-note" rows={2} value={notes} disabled={locked}
              onChange={e => setNotes(e.target.value)} maxLength={400}/>
          </Field>

          {err && <Alert tone="danger">{err}</Alert>}
        </div>

        <footer className="tka-reclass-foot">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || locked || tooShort} loading={busy}>
            {busy ? "Saving" : "Save"}
          </Button>
        </footer>
      </PopoverContent>
    </Popover>
  );
}
