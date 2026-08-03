// IntervalReclassifyPopover — small floating panel for changing one interval's
// category + notes. Used by:
//   • the personal Timesheet day calendar (TimesheetTab)
//   • the admin per-user day modal (UserDayModal)
// Admin-only write paths use the same RLS-aware setIntervalCategory; the
// `tk_intervals_admin_write` policy authorises edits to any user's row.
//
// The caller renders this detached (no trigger element of its own), so the
// Radix popover hangs off a zero-size anchor pinned to the middle of the
// viewport and runs in `modal` mode, which gives it focus trapping, Escape and
// outside-click dismissal without hand-rolling an overlay.

import React, { useState } from "react";
import { Icon } from "@/icons";
import {
  Alert, Badge, Button, Field, Popover, PopoverAnchor, PopoverContent,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea,
} from "@/ui";
import {
  fmtClock, setIntervalCategory,
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

export function IntervalReclassifyPopover({ interval, locked, onClose, onSaved }) {
  const [category, setCategory] = useState(interval.category);
  const [notes,    setNotes]    = useState(interval.notes || "");
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState(null);

  const save = async () => {
    if (locked) { onClose?.(); return; }
    setBusy(true); setErr(null);
    try {
      await setIntervalCategory(interval.id, {
        category,
        outlookEventId: interval.outlookEventId,
        notes: notes.trim() || null,
        interval,
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

  return (
    <Popover open modal onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <PopoverAnchor asChild>
        <span className="tka-vp-anchor" aria-hidden="true"/>
      </PopoverAnchor>

      <PopoverContent
        align="center"
        side="bottom"
        sideOffset={0}
        aria-label="Reclassify interval"
        className="tka-reclass w-[min(420px,calc(100vw-24px))] p-0"
      >
        <header className="tka-reclass-head">
          <div className="min-w-0">
            <p className="tka-eyebrow">Interval</p>
            <p className="tka-reclass-title num">
              {fmtClock(interval.startAt)} – {interval.endAt ? fmtClock(interval.endAt) : "now"}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14}/>
          </Button>
        </header>

        <div className="tka-reclass-body">
          {interval.outlookEventSubject && (
            <p className="tka-reclass-outlook">
              <Icon name="link" size={12}/>
              Linked to Outlook event: <strong>{interval.outlookEventSubject}</strong>
              {interval.outlookEventLocation && <> · {interval.outlookEventLocation}</>}
            </p>
          )}

          <Field label="Category" htmlFor="tka-reclass-cat">
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="tka-reclass-cat" aria-label="Category">
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
            <Textarea id="tka-reclass-note" rows={2} value={notes}
              onChange={e => setNotes(e.target.value)} maxLength={400}/>
          </Field>

          {err && <Alert tone="danger">{err}</Alert>}
        </div>

        <footer className="tka-reclass-foot">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || locked} loading={busy}>
            {busy ? "Saving" : "Save"}
          </Button>
        </footer>
      </PopoverContent>
    </Popover>
  );
}
