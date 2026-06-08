// LeavesPanel — Time Admin → Leaves. Three stacked sections:
//   1. Pending requests   — approve / reject (with optional note). Surfaces a
//                           warning when the request exceeds the person's
//                           accrued balance (admin can still approve).
//   2. Approved leave     — revert (adds the hours back, returns to pending).
//   3. Team balances      — the editable balance table (LeaveAdminTable).
//
// Approve / reject / revert call the SECURITY DEFINER RPCs (admin-gated in the
// DB); the balance math is atomic there. Refreshing after each action keeps the
// embedded balance table in sync via a bumped reloadKey.

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Icon } from "../icons";
import {
  loadAllLeaveRequests, loadLeaveBalances, computeLeaveAvailable,
  approveLeaveRequest, rejectLeaveRequest, revertLeaveRequest,
  userById, getAppSettings, fmtDate,
} from "../data";
import { LeaveAdminTable, LeaveStatusChip } from "../leave.jsx";

const hrs = (n) => `${(Math.round((n || 0) * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} hrs`;

export function LeavesPanel() {
  const settings = getAppSettings();

  const [requests, setRequests] = useState([]);
  const [balances, setBalances] = useState([]);
  const [busy,     setBusy]     = useState(true);
  const [err,      setErr]      = useState(null);
  const [acting,   setActing]   = useState(null);   // request id with an action in flight
  const [notes,    setNotes]    = useState({});     // id → review note
  const [reloadKey, setReloadKey] = useState(0);    // bump → refresh embedded balance table

  const refresh = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const [reqs, bals] = await Promise.all([loadAllLeaveRequests(), loadLeaveBalances()]);
      setRequests(reqs);
      setBalances(bals);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const balByUser = useMemo(() => new Map(balances.map(b => [b.userId, b])), [balances]);

  const availableFor = useCallback((userId, leaveType) => {
    const b = balByUser.get(userId);
    if (!b) return null;
    const c = computeLeaveAvailable(b, settings);
    return leaveType === "sick" ? c.sickAvailable : c.vacationAvailable;
  }, [balByUser, settings]);

  const pending  = useMemo(() => requests.filter(r => r.status === "pending"), [requests]);
  const approved = useMemo(() => requests.filter(r => r.status === "approved"), [requests]);

  const act = async (id, fn) => {
    setActing(id); setErr(null);
    try {
      await fn();
      await refresh();
      setReloadKey(k => k + 1);
      setNotes(n => { const m = { ...n }; delete m[id]; return m; });
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="leave-panel">
      {err && <div className="leave-err"><Icon name="warn" size={12}/> {err}</div>}

      {/* 1. Pending */}
      <section className="leave-panel-sec">
        <header className="leave-panel-sec-head">
          <h3>Pending requests</h3>
          <span className="leave-panel-count">{pending.length}{busy ? " · refreshing…" : ""}</span>
        </header>
        {pending.length === 0 && !busy && (
          <p className="leave-empty-note">No requests awaiting review.</p>
        )}
        <ul className="leave-req-cards">
          {pending.map(r => {
            const u = userById(r.userId);
            const avail = availableFor(r.userId, r.leaveType);
            const over = avail != null && r.totalHours > avail;
            const inFlight = acting === r.id;
            return (
              <li key={r.id} className={`leave-req-card ${over ? "is-over" : ""}`}>
                <div className="leave-req-card-main">
                  <div className="leave-req-card-who">
                    {u && <span className={`avatar xs ${u.color}`}>{u.initials}</span>}
                    <span className="leave-req-card-name">{u?.name || "Unknown"}</span>
                    <span className={`leave-type-pill tone-${r.leaveType === "sick" ? "blue" : "sage"}`}>
                      {r.leaveType === "sick" ? "Sick" : "Vacation"}
                    </span>
                  </div>
                  <div className="leave-req-card-facts">
                    <span><Icon name="calendar" size={12}/> {fmtDate(r.dateStart)}{r.dateEnd !== r.dateStart ? ` – ${fmtDate(r.dateEnd)}` : ""}</span>
                    <span><Icon name="clock" size={12}/> {r.businessDays}d · {hrs(r.totalHours)}</span>
                    {avail != null && <span className="leave-req-card-avail">Balance {hrs(avail)}</span>}
                  </div>
                  {r.reason && <div className="leave-req-card-reason">“{r.reason}”</div>}
                  {over && (
                    <div className="leave-warn leave-warn-inline">
                      <Icon name="warn" size={12}/>
                      Exceeds accrued balance by {hrs(r.totalHours - avail)} — approving will take it negative.
                    </div>
                  )}
                  <input
                    className="form-input leave-note-input"
                    placeholder="Note (optional)"
                    value={notes[r.id] || ""}
                    onChange={e => setNotes(n => ({ ...n, [r.id]: e.target.value }))}
                  />
                </div>
                <div className="leave-req-card-actions">
                  <button className="btn btn-ghost btn-sm" disabled={inFlight}
                    onClick={() => act(r.id, () => rejectLeaveRequest(r.id, notes[r.id]?.trim() || null))}>
                    Reject
                  </button>
                  <button className="btn btn-primary btn-sm" disabled={inFlight}
                    onClick={() => act(r.id, () => approveLeaveRequest(r.id, notes[r.id]?.trim() || null))}>
                    {inFlight ? "…" : "Approve"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 2. Approved */}
      <section className="leave-panel-sec">
        <header className="leave-panel-sec-head">
          <h3>Approved leave</h3>
          <span className="leave-panel-count">{approved.length}</span>
        </header>
        {approved.length === 0 && !busy && (
          <p className="leave-empty-note">Nothing approved yet.</p>
        )}
        <ul className="leave-approved-list">
          {approved.map(r => {
            const u = userById(r.userId);
            const inFlight = acting === r.id;
            return (
              <li key={r.id} className="leave-approved-row">
                <div className="leave-approved-who">
                  {u && <span className={`avatar xs ${u.color}`}>{u.initials}</span>}
                  <span className="leave-approved-name">{u?.name || "Unknown"}</span>
                </div>
                <span className={`leave-type-pill tone-${r.leaveType === "sick" ? "blue" : "sage"}`}>
                  {r.leaveType === "sick" ? "Sick" : "Vacation"}
                </span>
                <span className="leave-approved-dates">
                  {fmtDate(r.dateStart)}{r.dateEnd !== r.dateStart ? ` – ${fmtDate(r.dateEnd)}` : ""}
                </span>
                <span className="leave-approved-hours">{hrs(r.totalHours)}</span>
                <LeaveStatusChip status="approved"/>
                <button className="btn btn-ghost btn-sm" disabled={inFlight}
                  title="Add these hours back and return the request to pending"
                  onClick={() => act(r.id, () => revertLeaveRequest(r.id))}>
                  <Icon name="undo" size={12}/> {inFlight ? "…" : "Revert"}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* 3. Balances */}
      <LeaveAdminTable reloadKey={reloadKey}/>
    </div>
  );
}
