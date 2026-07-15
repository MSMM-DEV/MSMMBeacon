// LeaveRequestModal — an employee requests time off.
//
// Pick a type (vacation / sick), a date range, a per-day basis (full 8h /
// half 4h / custom hours), and a reason. A live preview shows the eligible
// weekday count, the requested hours, the current available balance, and the
// projected balance after approval. Requesting more than the accrued balance
// does NOT block submission — a soft warning surfaces here and again in the
// admin approval row.
//
// Built on the shared modal/form primitives (mirrors CorrectionModal).

import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import {
  submitLeaveRequest, loadLeaveBalances, computeLeaveAvailable,
  leaveBusinessDays, getCurrentBeaconUser, getAppSettings, todayInCT,
} from "../data";

const hrs = (n) => `${(Math.round((n || 0) * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} hrs`;

export function LeaveRequestModal({ onClose, onSubmitted }) {
  const me       = getCurrentBeaconUser();
  const settings = getAppSettings();
  const holidays = settings.tkHolidays;

  const [leaveType, setLeaveType] = useState("vacation");
  const [start,     setStart]     = useState(todayInCT());
  const [end,       setEnd]       = useState(todayInCT());
  const [basis,     setBasis]     = useState("full");     // full | half | custom
  const [customHrs, setCustomHrs] = useState("8");
  const [reason,    setReason]    = useState("");

  const [balance,   setBalance]   = useState(null);
  const [busy,      setBusy]      = useState(false);
  const [err,       setErr]       = useState(null);

  // Load my current balance for the before/after preview.
  useEffect(() => {
    let cancelled = false;
    if (!me?.id) return undefined;
    loadLeaveBalances()
      .then(rows => { if (!cancelled) setBalance(rows.find(b => b.userId === me.id) || null); })
      .catch(() => { /* preview just shows — fall back to 0 */ });
    return () => { cancelled = true; };
  }, [me?.id]);

  // Keep end ≥ start.
  const onStart = (v) => {
    const s = v || todayInCT();
    setStart(s);
    if (end < s) setEnd(s);
  };

  const isCustom    = basis === "custom";
  // Full/Half are per-WEEKDAY (× eligible weekdays). Custom is the TOTAL number
  // of hours for the whole leave (not per day) — the user enters how much time
  // off they want across the selected range.
  const perDay      = basis === "half" ? 4 : 8;
  const customTotal = Math.max(0, Number(customHrs) || 0);

  const calc = useMemo(() => {
    const days = leaveBusinessDays(start, end, holidays);
    // Custom = the total hours entered (spread across the whole leave);
    // Full/Half = per-weekday × eligible weekdays.
    const requested = isCustom ? customTotal : Math.round(days * perDay * 100) / 100;
    const avail = balance
      ? (leaveType === "sick"
          ? computeLeaveAvailable(balance, settings).sickAvailable
          : computeLeaveAvailable(balance, settings).vacationAvailable)
      : 0;
    const after = Math.round((avail - requested) * 100) / 100;
    return { days, requested, avail, after, over: requested > avail };
  }, [start, end, holidays, isCustom, perDay, customTotal, balance, leaveType, settings]);

  const canSubmit = calc.days > 0 && calc.requested > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setErr(null);
    try {
      await submitLeaveRequest({
        leaveType,
        dateStart: start,
        dateEnd:   end,
        // Full/Half send a per-day basis; Custom sends an explicit TOTAL for the
        // whole leave (not per day).
        hoursPerDay: isCustom ? undefined : perDay,
        totalHours:  isCustom ? calc.requested : undefined,
        reason:    reason.trim() || null,
      });
      onSubmitted?.();
      onClose?.();
    } catch (e) {
      setErr(e.message || "could not submit request");
    } finally {
      setBusy(false);
    }
  };

  const typeLabel = leaveType === "sick" ? "sick leave" : "vacation";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow leave-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal-eyebrow">Timesheet</div>
            <h3 className="modal-title">Request leave</h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16}/>
          </button>
        </div>

        <div className="modal-body">
          {/* Type */}
          <div className="form-row">
            <label className="form-label">Type</label>
            <div className="leave-seg" role="group" aria-label="Leave type">
              <button type="button"
                className={`leave-seg-btn ${leaveType === "vacation" ? "is-active tone-sage" : ""}`}
                onClick={() => setLeaveType("vacation")}>
                <Icon name="sun" size={13}/> Vacation
              </button>
              <button type="button"
                className={`leave-seg-btn ${leaveType === "sick" ? "is-active tone-blue" : ""}`}
                onClick={() => setLeaveType("sick")}>
                <Icon name="bell" size={13}/> Sick
              </button>
            </div>
          </div>

          {/* Dates */}
          <div className="form-row leave-date-row">
            <div className="leave-date-field">
              <label className="form-label">From</label>
              <input type="date" className="form-input" value={start}
                onChange={e => onStart(e.target.value)}/>
            </div>
            <div className="leave-date-field">
              <label className="form-label">To</label>
              <input type="date" className="form-input" value={end} min={start}
                onChange={e => setEnd(e.target.value || start)}/>
            </div>
          </div>

          {/* Basis */}
          <div className="form-row">
            <label className="form-label">Hours</label>
            <div className="leave-seg" role="group" aria-label="How many hours">
              <button type="button" className={`leave-seg-btn ${basis === "full"   ? "is-active" : ""}`} onClick={() => setBasis("full")}>Full · 8h/day</button>
              <button type="button" className={`leave-seg-btn ${basis === "half"   ? "is-active" : ""}`} onClick={() => setBasis("half")}>Half · 4h/day</button>
              <button type="button" className={`leave-seg-btn ${basis === "custom" ? "is-active" : ""}`} onClick={() => setBasis("custom")}>Custom</button>
            </div>
            {basis === "custom" && (
              <div className="leave-custom-hrs">
                <input type="number" className="form-input" min="0" step="0.5"
                  value={customHrs}
                  onChange={e => setCustomHrs(e.target.value)}
                  onFocus={e => e.target.select()}/>
                <span className="form-help" style={{ margin: 0 }}>total hours for the whole leave</span>
              </div>
            )}
            <p className="form-help">
              {isCustom
                ? "Custom is the total hours you want off across the selected weekdays — not per day."
                : "Full and Half are per weekday. Weekends and company holidays don’t count against your balance."}
            </p>
          </div>

          {/* Reason */}
          <div className="form-row">
            <label className="form-label">Reason <span className="form-optional">(optional)</span></label>
            <textarea className="form-input" rows={2} maxLength={500}
              placeholder="Add a note for your manager…"
              value={reason}
              onChange={e => setReason(e.target.value)}/>
          </div>

          {/* Live preview */}
          <div className={`leave-preview ${calc.over ? "is-over" : ""}`}>
            <div className="leave-preview-row">
              <span>Eligible weekdays</span>
              <strong>{calc.days}{calc.days === 1 ? " day" : " days"}</strong>
            </div>
            <div className="leave-preview-row">
              <span>Requested</span>
              <strong>{hrs(calc.requested)}</strong>
            </div>
            <div className="leave-preview-row">
              <span>Current {typeLabel}</span>
              <strong>{hrs(calc.avail)}</strong>
            </div>
            <div className="leave-preview-row leave-preview-after">
              <span>After approval</span>
              <strong className={calc.after < 0 ? "is-neg" : ""}>{hrs(calc.after)}</strong>
            </div>
          </div>

          {calc.over && (
            <div className="leave-warn">
              <Icon name="warn" size={13}/>
              This is more than your accrued {typeLabel} balance. You can still submit — an admin will review.
            </div>
          )}
          {calc.days === 0 && (
            <div className="form-help">No eligible weekdays in this range — pick dates that include a weekday.</div>
          )}
          {err && <div className="form-error">{err}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </div>
    </div>
  );
}
