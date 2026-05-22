// CorrectionModal — user submits a punch-correction request.
//
// Kinds:
//   add_punch     — "I forgot to punch out at 17:30"
//   edit_punch    — admin-only in v1; user-facing UI hides this kind
//   delete_punch  — admin-only in v1
//   note          — pure annotation, no payload effect
//
// Pending requests appear in the admin's ApprovalsQueue.

import React, { useState } from "react";
import { Icon } from "../icons";
import { submitCorrection } from "../data";

export function CorrectionModal({ date, onClose, onSubmitted }) {
  const [kind,     setKind]   = useState("add_punch");
  const [time,     setTime]   = useState("17:00");
  const [reason,   setReason] = useState("");
  const [note,     setNote]   = useState("");
  const [busy,     setBusy]   = useState(false);
  const [err,      setErr]    = useState(null);

  const valid = reason.trim().length > 3 && (kind !== "add_punch" || time);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      let payload = {};
      if (kind === "add_punch") {
        const iso = new Date(`${date}T${time}:00`).toISOString();
        payload = { punched_at: iso, note: note || null };
      } else {
        payload = { note: note || null };
      }
      await submitCorrection({ date, kind, payload, reason });
      onSubmitted?.();
      onClose?.();
    } catch (e) {
      setErr(e.message || "submission failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-eyebrow">Timesheet</div>
          <h3 className="modal-title">Request a correction</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16}/>
          </button>
        </div>

        <div className="modal-body">
          <p className="form-help">
            Day: <strong>{date}</strong>. Your admin will review the request before it lands on your timesheet.
          </p>

          <div className="form-row">
            <label className="form-label">What needs to change?</label>
            <select className="form-input" value={kind} onChange={e => setKind(e.target.value)}>
              <option value="add_punch">Add a missing punch</option>
              <option value="note">Add a note (no time change)</option>
            </select>
          </div>

          {kind === "add_punch" && (
            <div className="form-row">
              <label className="form-label">Punch time (24-hour)</label>
              <input type="time" className="form-input" value={time}
                onChange={e => setTime(e.target.value)}/>
              <p className="form-help">
                Note: the system will toggle your state (IN ↔ OUT) at this moment.
              </p>
            </div>
          )}

          <div className="form-row">
            <label className="form-label">Reason</label>
            <input className="form-input" type="text" value={reason}
              placeholder="e.g. forgot to tap out before leaving"
              onChange={e => setReason(e.target.value)} maxLength={200}/>
          </div>

          <div className="form-row">
            <label className="form-label">Optional note</label>
            <textarea className="form-input" rows={2} value={note}
              onChange={e => setNote(e.target.value)} maxLength={400}/>
          </div>

          {err && <div className="form-error">{err}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !valid}>
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </div>
    </div>
  );
}
