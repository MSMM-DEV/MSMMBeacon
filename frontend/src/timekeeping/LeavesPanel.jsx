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
import { Badge, Button, EmptyState, Input } from "@/ui";
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
    <div className="tsx-leaveadmin-panel">
      {err && (
        <p className="tsx-note tone-bad" role="alert">
          <Icon name="warn" size={13}/><span>{err}</span>
        </p>
      )}

      {/* 1. Pending */}
      <section className="tsx-leave-sec" aria-labelledby="tsx-leaveadmin-pending">
        <header className="tsx-leave-sechead">
          <h4 id="tsx-leaveadmin-pending">
            Pending requests
            <span className="tsx-count num">{pending.length}</span>
          </h4>
          <p>Approve or reject. Balances update the moment you decide.</p>
          {busy && <span className="tsx-leave-refresh" role="status">refreshing…</span>}
        </header>

        {pending.length === 0 && !busy ? (
          <EmptyState
            compact
            title="No requests awaiting review"
            description="When someone submits vacation or sick leave from their timesheet, it lands here for approval."
          />
        ) : (
          <ul className="tsx-leavereq-list">
            {pending.map(r => {
              const u = userById(r.userId);
              const avail = availableFor(r.userId, r.leaveType);
              const over = avail != null && r.totalHours > avail;
              const inFlight = acting === r.id;
              return (
                <li key={r.id} className={`tsx-leavereq ${over ? "is-over" : ""}`}>
                  <div className="tsx-leavereq-main">
                    <div className="tsx-leavereq-who">
                      {u && <span className={`avatar xs ${u.color}`}>{u.initials}</span>}
                      <span className="tsx-leavereq-name">{u?.name || "Unknown"}</span>
                      <Badge tone={r.leaveType === "sick" ? "info" : "success"}>
                        {r.leaveType === "sick" ? "Sick" : "Vacation"}
                      </Badge>
                    </div>

                    <dl className="tsx-leavereq-facts">
                      <div>
                        <dt><Icon name="calendar" size={12}/><span className="sr-only">Dates</span></dt>
                        <dd className="num">
                          {fmtDate(r.dateStart)}{r.dateEnd !== r.dateStart ? ` – ${fmtDate(r.dateEnd)}` : ""}
                        </dd>
                      </div>
                      <div>
                        <dt><Icon name="clock" size={12}/><span className="sr-only">Amount</span></dt>
                        <dd className="num">{r.businessDays}d · {hrs(r.totalHours)}</dd>
                      </div>
                      {avail != null && (
                        <div>
                          <dt>Balance</dt>
                          <dd className="num">{hrs(avail)}</dd>
                        </div>
                      )}
                    </dl>

                    {r.reason && <blockquote className="tsx-leavereq-reason">{r.reason}</blockquote>}

                    {over && (
                      <p className="tsx-note tone-warn">
                        <Icon name="warn" size={12}/>
                        <span>
                          Exceeds the accrued balance by {hrs(r.totalHours - avail)}.
                          Approving takes the balance negative.
                        </span>
                      </p>
                    )}

                    <div className="tsx-leavereq-note">
                      <label className="sr-only" htmlFor={`tsx-leave-note-${r.id}`}>
                        Review note for {u?.name || "this request"} (optional)
                      </label>
                      <Input
                        id={`tsx-leave-note-${r.id}`}
                        placeholder="Note (optional)"
                        value={notes[r.id] || ""}
                        onChange={e => setNotes(n => ({ ...n, [r.id]: e.target.value }))}
                      />
                    </div>
                  </div>

                  <div className="tsx-leavereq-actions">
                    <Button variant="ghost" size="sm" disabled={inFlight}
                      onClick={() => act(r.id, () => rejectLeaveRequest(r.id, notes[r.id]?.trim() || null))}>
                      Reject
                    </Button>
                    <Button variant="primary" size="sm" disabled={inFlight} loading={inFlight}
                      onClick={() => act(r.id, () => approveLeaveRequest(r.id, notes[r.id]?.trim() || null))}>
                      Approve
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 2. Approved */}
      <section className="tsx-leave-sec" aria-labelledby="tsx-leaveadmin-approved">
        <header className="tsx-leave-sechead">
          <h4 id="tsx-leaveadmin-approved">
            Approved leave
            <span className="tsx-count num">{approved.length}</span>
          </h4>
          <p>Reverting adds the hours back and returns the request to pending.</p>
        </header>

        {approved.length === 0 && !busy ? (
          <EmptyState
            compact
            title="Nothing approved yet"
            description="Approved requests stay listed here so you can revert one if plans change."
          />
        ) : (
          <ul className="tsx-leaveapproved">
            {approved.map(r => {
              const u = userById(r.userId);
              const inFlight = acting === r.id;
              return (
                <li key={r.id} className="tsx-leaveapproved-row">
                  <span className="tsx-leaveapproved-who">
                    {u && <span className={`avatar xs ${u.color}`}>{u.initials}</span>}
                    <span className="tsx-leaveapproved-name">{u?.name || "Unknown"}</span>
                  </span>
                  <Badge tone={r.leaveType === "sick" ? "info" : "success"}>
                    {r.leaveType === "sick" ? "Sick" : "Vacation"}
                  </Badge>
                  <span className="tsx-leaveapproved-dates num">
                    {fmtDate(r.dateStart)}{r.dateEnd !== r.dateStart ? ` – ${fmtDate(r.dateEnd)}` : ""}
                  </span>
                  <span className="tsx-leaveapproved-hours num">{hrs(r.totalHours)}</span>
                  <LeaveStatusChip status="approved"/>
                  <Button
                    variant="ghost" size="sm" disabled={inFlight} loading={inFlight}
                    title="Add these hours back and return the request to pending"
                    aria-label={`Revert approved leave for ${u?.name || "this request"}`}
                    onClick={() => act(r.id, () => revertLeaveRequest(r.id))}>
                    <Icon name="undo" size={12}/> Revert
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 3. Balances */}
      <LeaveAdminTable reloadKey={reloadKey}/>
    </div>
  );
}
