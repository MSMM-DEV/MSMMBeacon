// IntervalReclassifyPopover — small modal for changing one interval's
// category + notes. Used by:
//   • the personal Timesheet day calendar (TimesheetTab)
//   • the admin per-user day modal (UserDayModal)
// Admin-only write paths use the same RLS-aware setIntervalCategory; the
// `tk_intervals_admin_write` policy authorises edits to any user's row.

import React, { useState } from "react";
import { Icon } from "../icons";
import {
  fmtClock, setIntervalCategory,
  TK_CATEGORY_LABEL, TK_CATEGORY_TONE,
} from "../data";

export const CATEGORY_USER_OPTIONS = [
  ["work",             "Working"             ],
  ["meeting",          "Meeting"             ],
  ["travel",           "Travel"              ],
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
      });
      onSaved?.();
      onClose?.();
    } catch (e) { setErr(e.message || "save failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-eyebrow">Interval</div>
          <h3 className="modal-title">
            {fmtClock(interval.startAt)} – {interval.endAt ? fmtClock(interval.endAt) : "now"}
          </h3>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-body">
          {interval.outlookEventSubject && (
            <div className="form-help">
              <Icon name="link" size={12}/> Linked to Outlook event: <strong>{interval.outlookEventSubject}</strong>
              {interval.outlookEventLocation && <> · {interval.outlookEventLocation}</>}
            </div>
          )}
          <div className="form-row">
            <label className="form-label">Category</label>
            <select className="form-input" value={category} onChange={e => setCategory(e.target.value)}>
              {CATEGORY_USER_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <div className="tk-category-chip">
              <span className={`tk-cat tone-${TK_CATEGORY_TONE[category] || "muted"}`}>
                {TK_CATEGORY_LABEL[category] || category}
              </span>
            </div>
          </div>
          <div className="form-row">
            <label className="form-label">Note</label>
            <textarea className="form-input" rows={2} value={notes}
              onChange={e => setNotes(e.target.value)} maxLength={400}/>
          </div>
          {err && <div className="form-error">{err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost"   onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={save}    disabled={busy || locked}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
