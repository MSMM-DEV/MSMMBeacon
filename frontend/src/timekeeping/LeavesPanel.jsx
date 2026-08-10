// LeavesPanel — Time Admin → Leaves. Three stacked sections:
//   1. Pending requests   — approve / reject (with optional note). Surfaces a
//                           warning when the request exceeds the person's
//                           accrued balance (admin can still approve).
//   2. Decided leave      — every request an admin has already ruled on, in a
//                           table, each row revertible back to pending.
//   3. Team balances      — the editable balance table (LeaveAdminTable).
//
// Section 2 carries BOTH outcomes. It used to list approved requests only,
// which meant a rejection vanished from the admin's screen the instant it was
// made: no record of the decision and no way to walk it back short of asking
// the person to re-submit. A Status column is what makes one table able to hold
// both, and "Revert" then means the same thing in both rows — send it back to
// pending — even though the two paths differ underneath (see `revert`).
//
// Approve / reject / revert call the SECURITY DEFINER RPCs (admin-gated in the
// DB); the balance math is atomic there. Refreshing after each action keeps the
// embedded balance table in sync via a bumped reloadKey.

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Icon } from "../icons";
import { Badge, Button, EmptyState, Input, Tooltip } from "@/ui";
import {
  loadAllLeaveRequests, loadLeaveBalances, computeLeaveAvailable,
  approveLeaveRequest, rejectLeaveRequest, revertLeaveRequest, reopenLeaveRequest,
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

  const pending = useMemo(() => requests.filter(r => r.status === "pending"), [requests]);

  // Everything already ruled on, newest decision first. `reviewedAt` is stamped
  // by both RPCs; requestedAt is the fallback for rows decided before that
  // column existed, so a null review timestamp can't sink a row to the bottom.
  const decided = useMemo(() => requests
    .filter(r => r.status === "approved" || r.status === "rejected")
    .sort((a, b) =>
      String(b.reviewedAt || b.requestedAt || "").localeCompare(String(a.reviewedAt || a.requestedAt || ""))),
  [requests]);

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

      {/* 2. Decided — approved AND rejected, both revertible back to pending. */}
      <section className="tsx-leave-sec" aria-labelledby="tsx-leaveadmin-decided">
        <header className="tsx-leave-sechead">
          <h4 id="tsx-leaveadmin-decided">
            Decided leave
            <span className="tsx-count num">{decided.length}</span>
          </h4>
          <p>Every request you have ruled on. Reverting sends it back to pending — an approval also returns the hours.</p>
        </header>

        {decided.length === 0 && !busy ? (
          <EmptyState
            compact
            title="No decisions yet"
            description="Once you approve or reject a request it stays listed here, so you can see what was decided and undo it if plans change."
          />
        ) : (
          <div className="bx-scroll-x tsx-leaveadmin-wrap">
            <table className="tsx-leaveadmin-table tsx-leavedecided-table">
              <thead>
                <tr>
                  <th scope="col" className="tsx-leaveadmin-th-name">Employee</th>
                  <th scope="col">Type</th>
                  <th scope="col">Dates</th>
                  <th scope="col">Hours</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {decided.map(r => {
                  const u = userById(r.userId);
                  const inFlight = acting === r.id;
                  const name     = u?.name || "Unknown";
                  const approved = r.status === "approved";
                  // Two different undos behind one word. An approval moved a
                  // balance, so it goes back through the RPC that reverses the
                  // math atomically; a rejection never moved one, so it is a
                  // status flip. Both land at pending — which is why the button
                  // says the same thing on both rows.
                  const hint = approved
                    ? `Add ${hrs(r.totalHours)} back to ${name}'s balance and return the request to pending`
                    : `Return ${name}'s request to pending so you can decide again — no balance changes`;
                  return (
                    <tr key={r.id} className={`is-${r.status}`}>
                      <th scope="row" className="tsx-leaveadmin-td-name">
                        <span className="tsx-leaveadmin-who">
                          {u && <span className={`avatar xs ${u.color}`}>{u.initials}</span>}
                          <span className="tsx-leaveadmin-name">{name}</span>
                        </span>
                      </th>
                      <td>
                        <Badge tone={r.leaveType === "sick" ? "info" : "success"}>
                          {r.leaveType === "sick" ? "Sick" : "Vacation"}
                        </Badge>
                      </td>
                      <td className="num tsx-leavedecided-dates">
                        {fmtDate(r.dateStart)}{r.dateEnd !== r.dateStart ? ` – ${fmtDate(r.dateEnd)}` : ""}
                      </td>
                      <td className="num tsx-leavedecided-hours">{hrs(r.totalHours)}</td>
                      <td><LeaveStatusChip status={r.status}/></td>
                      <td className="tsx-leavedecided-td-act">
                        <Tooltip label={hint}>
                          <Button
                            variant="ghost" size="sm" disabled={inFlight} loading={inFlight}
                            aria-label={`Revert ${approved ? "approved" : "rejected"} leave for ${name}`}
                            onClick={() => act(r.id, () => (
                              approved ? revertLeaveRequest(r.id) : reopenLeaveRequest(r.id)
                            ))}>
                            <Icon name="undo" size={12}/> Revert
                          </Button>
                        </Tooltip>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 3. Balances */}
      <LeaveAdminTable reloadKey={reloadKey}/>
    </div>
  );
}
