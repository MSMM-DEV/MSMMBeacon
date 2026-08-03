// LeaveRequestModal — an employee requests time off.
//
// Pick a type (vacation / sick), a date range, a per-day basis (full 8h /
// half 4h / custom hours), and a reason. A live preview shows the eligible
// weekday count, the requested hours, the current available balance, and the
// projected balance after approval. Requesting more than the accrued balance
// does NOT block submission — a soft warning surfaces here and again in the
// admin approval row.
//
// Built on the shared Dialog primitive from @/ui, so focus trapping, escape,
// the phone bottom-sheet treatment and the aria wiring are Radix's problem.
//
// One rule the UI has to make impossible to misread: CUSTOM HOURS ARE THE
// TOTAL FOR THE WHOLE LEAVE, not a per-day figure. Full and Half are per
// weekday. The field label, its hint, and the preview row all say so.

import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogBody, DialogFooter, Button, Input, Textarea, Label,
} from "@/ui";
import {
  submitLeaveRequest, loadLeaveBalances, computeLeaveAvailable,
  leaveBusinessDays, getCurrentBeaconUser, getAppSettings, todayInCT,
} from "../data";

const hrs = (n) => `${(Math.round((n || 0) * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} hrs`;

const TYPE_CHOICES = [
  { key: "vacation", label: "Vacation",   icon: "sun",  tone: "sage" },
  { key: "sick",     label: "Sick leave", icon: "bell", tone: "blue" },
];

const BASIS_CHOICES = [
  { key: "full",   label: "Full day",  meta: "8h per weekday" },
  { key: "half",   label: "Half day",  meta: "4h per weekday" },
  { key: "custom", label: "Custom",    meta: "total hours" },
];

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
    <Dialog open onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <DialogContent size="sm" className="tsx-dialog">
        <DialogHeader>
          <DialogTitle>Request leave</DialogTitle>
          <DialogDescription>
            Weekends and company holidays are skipped, so they never come off your balance.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="tsx-form">
          {/* Type */}
          <div className="tsx-field">
            <Label id="tsx-leave-type-label">Type</Label>
            <div className="tsx-seg" role="radiogroup" aria-labelledby="tsx-leave-type-label">
              {TYPE_CHOICES.map(t => (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={leaveType === t.key}
                  className={`tsx-seg-btn tone-${t.tone} ${leaveType === t.key ? "is-active" : ""}`}
                  onClick={() => setLeaveType(t.key)}
                >
                  <Icon name={t.icon} size={14}/>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Dates */}
          <div className="tsx-field-row">
            <div className="tsx-field">
              <Label htmlFor="tsx-leave-from">From</Label>
              <Input id="tsx-leave-from" type="date" value={start}
                onChange={e => onStart(e.target.value)}/>
            </div>
            <div className="tsx-field">
              <Label htmlFor="tsx-leave-to">To</Label>
              <Input id="tsx-leave-to" type="date" value={end} min={start}
                onChange={e => setEnd(e.target.value || start)}/>
            </div>
          </div>

          {/* Basis */}
          <div className="tsx-field">
            <Label id="tsx-leave-basis-label">How much time</Label>
            <div className="tsx-seg tsx-seg-stack" role="radiogroup" aria-labelledby="tsx-leave-basis-label">
              {BASIS_CHOICES.map(b => (
                <button
                  key={b.key}
                  type="button"
                  role="radio"
                  aria-checked={basis === b.key}
                  className={`tsx-seg-btn ${basis === b.key ? "is-active" : ""}`}
                  onClick={() => setBasis(b.key)}
                >
                  <span className="tsx-seg-btn-label">{b.label}</span>
                  <span className="tsx-seg-btn-meta">{b.meta}</span>
                </button>
              ))}
            </div>

            {isCustom ? (
              <div className="tsx-leave-custom">
                <Label htmlFor="tsx-leave-custom-hrs">Total hours for the whole leave</Label>
                <div className="tsx-leave-custom-input">
                  <Input
                    id="tsx-leave-custom-hrs"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.5"
                    value={customHrs}
                    onChange={e => setCustomHrs(e.target.value)}
                    onFocus={e => e.target.select()}
                    aria-describedby="tsx-leave-custom-help"
                  />
                  <span className="tsx-leave-custom-unit" aria-hidden="true">hrs</span>
                </div>
                <p className="tsx-help" id="tsx-leave-custom-help">
                  <Icon name="info" size={12}/>
                  <span>
                    This is the total across the whole leave, not a figure per day.
                    Enter 12 for a three day trip and 12 hours come off your balance.
                  </span>
                </p>
              </div>
            ) : (
              <p className="tsx-help">
                <Icon name="info" size={12}/>
                <span>
                  Full and Half apply to every eligible weekday in the range.
                  Weekends and company holidays do not count against your balance.
                </span>
              </p>
            )}
          </div>

          {/* Reason */}
          <div className="tsx-field">
            <Label htmlFor="tsx-leave-reason">
              Reason <span className="tsx-optional">(optional)</span>
            </Label>
            <Textarea
              id="tsx-leave-reason"
              rows={2}
              maxLength={500}
              placeholder="Add a note for your manager…"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>

          {/* Live preview */}
          <dl className={`tsx-leave-preview ${calc.over ? "is-over" : ""}`}>
            <div className="tsx-leave-preview-row">
              <dt>Eligible weekdays</dt>
              <dd className="num">{calc.days}{calc.days === 1 ? " day" : " days"}</dd>
            </div>
            <div className="tsx-leave-preview-row">
              <dt>Requested{isCustom ? " (total)" : ""}</dt>
              <dd className="num">{hrs(calc.requested)}</dd>
            </div>
            <div className="tsx-leave-preview-row">
              <dt>Current {typeLabel}</dt>
              <dd className="num">{hrs(calc.avail)}</dd>
            </div>
            <div className="tsx-leave-preview-row is-total">
              <dt>After approval</dt>
              <dd className={`num ${calc.after < 0 ? "is-neg" : ""}`}>{hrs(calc.after)}</dd>
            </div>
          </dl>

          {calc.over && (
            <p className="tsx-note tone-warn">
              <Icon name="warn" size={13}/>
              <span>
                This is more than your accrued {typeLabel} balance. You can still submit it,
                and an admin will review.
              </span>
            </p>
          )}
          {calc.days === 0 && (
            <p className="tsx-note tone-muted">
              <Icon name="calendar" size={13}/>
              <span>No eligible weekdays in this range. Pick dates that include a weekday.</span>
            </p>
          )}
          {err && (
            <p className="tsx-note tone-bad" role="alert">
              <Icon name="warn" size={13}/>
              <span>{err}</span>
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit} loading={busy}>
            {busy ? "Submitting…" : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
