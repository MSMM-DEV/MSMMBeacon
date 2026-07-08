// Leave (vacation + sick) — shared presentational + self-loading pieces.
//
// Balances accrue every pay period (every other Wednesday) automatically — the
// displayed "available" = stored net balance (as of its as_of_date) + accrued
// periods × rate, computed live in computeLeaveAvailable (mirrors the
// beacon_v2.v_leave_balances view).
//
// Exports:
//   • LeaveBalanceCards  — the two personal cards (Vacation / Sick). Used in the
//                          personal Timesheet hero.
//   • MyLeaveSection     — self-loading personal block: balance cards + a recent
//                          leave-request list (cancel own pending). Lives in the
//                          Timesheet tab; the "Request leave" button + modal are
//                          owned by TimesheetTab so it can sit beside "Edit day".
//   • LeaveAdminTable    — self-loading editable team balance table. Embedded in
//                          the Time Admin → Leaves panel.
//
// The standalone "Time Off" tab was retired — balances now live in the personal
// Timesheet (mine) and Time Admin → Leaves (team), alongside the new request +
// approval flow.

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Icon } from "./icons.jsx";
import {
  getCurrentBeaconUser, isAdmin, userById, getAppSettings,
  loadLeaveBalances, loadMyLeaveRequests, cancelLeaveRequest,
  computeLeaveAvailable, leaveNextPayDate,
  updateLeaveBalance, todayInCT, fmtDate,
} from "./data.js";

const hrs = (n) => `${(Math.round((n || 0) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} hrs`;

// ---------------------------------------------------------------------------
// LeaveBalanceCards — the two personal cards + the accrual sub-line.
// `balance` is one adapted leave_balances row (or null = nothing tracked).
// ---------------------------------------------------------------------------
export function LeaveBalanceCards({ balance, settings = getAppSettings(), busy = false, action = null }) {
  const today    = todayInCT();
  const vacRate  = settings.leaveVacationAccrual || 0;
  const sickRate = settings.leaveSickAccrual || 0;
  const nextPay  = leaveNextPayDate(settings, today);

  return (
    <div className="leave-hero">
      <div className="leave-hero-head">
        <div className="leave-hero-heading">
          <h3 className="leave-hero-title">Availability</h3>
          <span className="leave-hero-sub">
            Accrues {vacRate.toFixed(2)} vacation · {sickRate.toFixed(2)} sick hrs each pay period
            {" · next "}{fmtDate(nextPay)}
          </span>
        </div>
        {action && <div className="leave-hero-action">{action}</div>}
      </div>
      {balance ? (() => {
        const c = computeLeaveAvailable(balance, settings, today);
        return (
          <div className="leave-hero-cards">
            <LeaveCard tone="sage" label="Vacation"   available={c.vacationAvailable} used={balance.vacationUsed}/>
            <LeaveCard tone="blue" label="Sick leave" available={c.sickAvailable}     used={balance.sickUsed}/>
          </div>
        );
      })() : (
        <p className="leave-empty-note">
          {busy ? "Loading…" : "No leave is tracked for your account."}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MyLeaveSection — self-loading personal balances + recent requests.
// `reloadKey` (a number bumped by the parent after a submit) forces a refetch.
// ---------------------------------------------------------------------------
export function MyLeaveSection({ reloadKey = 0, onRequest = null }) {
  const me = getCurrentBeaconUser();
  const settings = getAppSettings();

  const [balance, setBalance] = useState(null);
  const [requests, setRequests] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    if (!me?.id) return;
    setBusy(true); setErr(null);
    try {
      const [bals, reqs] = await Promise.all([loadLeaveBalances(), loadMyLeaveRequests()]);
      setBalance(bals.find(b => b.userId === me.id) || null);
      setRequests(reqs);
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }, [me?.id]);

  useEffect(() => { refresh(); }, [refresh, reloadKey]);

  const cancel = async (id) => {
    setRequests(rs => rs.map(r => r.id === id ? { ...r, status: "cancelled" } : r));
    try { await cancelLeaveRequest(id); }
    catch (e) { setErr(e.message || String(e)); refresh(); }
  };

  // Newest-first, with active (pending) requests floated to the top.
  const ordered = useMemo(() => {
    const rank = { pending: 0, approved: 1, rejected: 2, cancelled: 3 };
    return [...requests].sort((a, b) =>
      (rank[a.status] - rank[b.status]) || (b.dateStart || "").localeCompare(a.dateStart || ""));
  }, [requests]);

  const today = todayInCT();
  const upcoming = useMemo(() =>
    requests
      .filter(r => r.status === "approved" && r.dateEnd >= today)
      .sort((a, b) => (a.dateStart || "").localeCompare(b.dateStart || "")),
  [requests, today]);

  const grouped = useMemo(() => {
    const isUpcoming = (r) => r.status === "approved" && r.dateEnd >= today;
    return [
      { key: "pending", label: "Pending", rows: ordered.filter(r => r.status === "pending") },
      { key: "approved", label: "Approved", rows: ordered.filter(r => r.status === "approved" && !isUpcoming(r)) },
      { key: "history", label: "Past requests", rows: ordered.filter(r => r.status === "rejected" || r.status === "cancelled") },
    ].filter(g => g.rows.length > 0);
  }, [ordered, today]);

  return (
    <section className="leave-mine" aria-label="My leave">
      {err && <div className="leave-err"><Icon name="warn" size={12}/> {err}</div>}

      <section className="leave-planner-top" aria-label="Leave planner">
        <LeaveBalanceCards
          balance={balance}
          settings={settings}
          busy={busy}
          action={(
            <button
              type="button"
              className="btn btn-primary leave-request-btn"
              onClick={onRequest || undefined}
              disabled={!onRequest}
            >
              <Icon name="sun" size={14}/> Request leave
            </button>
          )}
        />
      </section>

      <section className="leave-upcoming" aria-labelledby="leave-upcoming-title">
        <header className="leave-section-head">
          <div>
            <h4 id="leave-upcoming-title">Upcoming leave</h4>
            <p>Approved time off that has not ended yet.</p>
          </div>
        </header>

        {upcoming.length === 0 ? (
          <div className="leave-upcoming-empty">
            <Icon name="calendar" size={18}/>
            <span>{busy ? "Checking approved leave…" : "No upcoming leave."}</span>
          </div>
        ) : (
          <ul className="leave-upcoming-list">
            {upcoming.map(r => (
              <li key={r.id} className={`leave-upcoming-card tone-${r.leaveType === "sick" ? "blue" : "sage"}`}>
                <span className="leave-upcoming-icon" aria-hidden="true"><Icon name="check" size={15}/></span>
                <div className="leave-upcoming-main">
                  <span className="leave-upcoming-kind">{r.leaveType === "sick" ? "Sick leave" : "Vacation"}</span>
                  <span className="leave-upcoming-dates">
                    {fmtDate(r.dateStart)}{r.dateEnd !== r.dateStart ? ` – ${fmtDate(r.dateEnd)}` : ""}
                  </span>
                </div>
                <span className="leave-upcoming-hours">{hrs(r.totalHours)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="leave-reqs" aria-labelledby="leave-requests-title">
        <header className="leave-section-head leave-reqs-head">
          <div>
            <h4 id="leave-requests-title">My requests</h4>
            <p>Pending items first, older outcomes tucked below.</p>
          </div>
          {busy && <span className="leave-reqs-sub">refreshing…</span>}
        </header>

        {grouped.length === 0 && !busy && (
          <p className="leave-empty-note">No leave requests yet.</p>
        )}

        <div className="leave-req-groups">
          {grouped.map(group => (
            <section key={group.key} className={`leave-req-group is-${group.key}`} aria-label={group.label}>
              <h5>{group.label}</h5>
              <ul className="leave-reqs-list">
                {group.rows.map(r => (
                  <LeaveRequestRow key={r.id} request={r} onCancel={cancel}/>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </section>
    </section>
  );
}

function LeaveRequestRow({ request: r, onCancel }) {
  return (
    <li className={`leave-req-row is-${r.status}`}>
      <span className={`leave-type-dot tone-${r.leaveType === "sick" ? "blue" : "sage"}`} aria-hidden="true"/>
      <div className="leave-req-main">
        <div className="leave-req-top">
          <span className="leave-req-kind">{r.leaveType === "sick" ? "Sick leave" : "Vacation"}</span>
          <span className="leave-req-dates">
            {fmtDate(r.dateStart)}{r.dateEnd !== r.dateStart ? ` – ${fmtDate(r.dateEnd)}` : ""}
          </span>
          <span className="leave-req-hours">{hrs(r.totalHours)}</span>
        </div>
        {r.reason && <div className="leave-req-reason">{r.reason}</div>}
        {r.status === "rejected" && r.reviewNote && (
          <div className="leave-req-note">Admin: {r.reviewNote}</div>
        )}
      </div>
      <div className="leave-req-side">
        <LeaveStatusChip status={r.status}/>
        {r.status === "pending" && (
          <button className="link-btn leave-req-cancel" type="button" onClick={() => onCancel(r.id)}>
            Cancel
          </button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// ApprovedLeaveBanners — the prominent confirmation strip at the TOP of the
// Timesheet tab. One banner per APPROVED leave request whose end date hasn't
// passed yet (upcoming OR in-progress); each names the approving admin and the
// date it runs until, and stays put until that end date is in the past.
// Self-loading; `reloadKey` (bumped by the parent) forces a refetch.
// ---------------------------------------------------------------------------
export function ApprovedLeaveBanners({ reloadKey = 0 }) {
  const me = getCurrentBeaconUser();
  const [reqs, setReqs] = useState([]);

  useEffect(() => {
    let cancelled = false;
    if (!me?.id) return undefined;
    loadMyLeaveRequests()
      .then(rs => { if (!cancelled) setReqs(rs); })
      .catch(() => { /* banner is best-effort — never blocks the page */ });
    return () => { cancelled = true; };
  }, [me?.id, reloadKey]);

  const today = todayInCT();
  // Approved + not yet ended, soonest start first.
  const active = useMemo(() =>
    reqs
      .filter(r => r.status === "approved" && r.dateEnd >= today)
      .sort((a, b) => (a.dateStart || "").localeCompare(b.dateStart || "")),
  [reqs, today]);

  if (active.length === 0) return null;

  return (
    <div className="tk-approved-leave" role="status" aria-live="polite">
      {active.map((r, i) => {
        const admin = userById(r.reviewedBy);
        const kind  = r.leaveType === "sick" ? "Sick leave" : "Vacation";
        const tone  = r.leaveType === "sick" ? "blue" : "sage";
        const onNow = r.dateStart <= today && today <= r.dateEnd;
        const range = (r.dateEnd && r.dateEnd !== r.dateStart)
          ? `${fmtDate(r.dateStart)} – ${fmtDate(r.dateEnd)}`
          : fmtDate(r.dateStart);
        return (
          <div key={r.id} className={`tk-approved-banner tone-${tone}`} style={{ "--i": i }}>
            <span className="tk-approved-seal" aria-hidden="true"><Icon name="check" size={16}/></span>
            <div className="tk-approved-copy">
              <span className="tk-approved-title">
                {kind} approved{admin ? <> by <strong>{admin.name}</strong></> : null}
              </span>
              <span className="tk-approved-meta">
                <span className={`tk-approved-state${onNow ? " is-now" : ""}`}>
                  {onNow ? "On leave now" : "Upcoming"}
                </span>
                <span className="tk-approved-dot" aria-hidden="true">·</span>
                <span>{range}</span>
                <span className="tk-approved-dot" aria-hidden="true">·</span>
                <span>{hrs(r.totalHours)}</span>
              </span>
            </div>
            <span className="tk-approved-until">
              <span className="tk-approved-until-label">until</span>
              <span className="tk-approved-until-date">{fmtDate(r.dateEnd)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function LeaveStatusChip({ status }) {
  const map = {
    pending:   { tone: "warn",  label: "Pending" },
    approved:  { tone: "sage",  label: "Approved" },
    rejected:  { tone: "rose",  label: "Rejected" },
    cancelled: { tone: "muted", label: "Cancelled" },
  };
  const m = map[status] || map.cancelled;
  return <span className={`leave-status-chip tone-${m.tone}`}>{m.label}</span>;
}

// ---------------------------------------------------------------------------
// LeaveAdminTable — editable team balances. Self-loading; admin-only writes.
// Edits are entered as the CURRENT available value: saving re-bases both
// categories to today (stored balance := current available, as_of := today).
// ---------------------------------------------------------------------------
export function LeaveAdminTable({ reloadKey = 0 }) {
  const admin    = isAdmin();
  const settings = getAppSettings();
  const today    = todayInCT();

  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err,  setErr]  = useState(null);

  const refresh = useCallback(async () => {
    setBusy(true); setErr(null);
    try { setRows(await loadLeaveBalances()); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh, reloadKey]);

  const byUser = useMemo(() => new Map(rows.map(r => [r.userId, r])), [rows]);

  const patchRow = async (userId, patch) => {
    setRows(rs => rs.map(r => r.userId === userId ? { ...r, ...patch } : r));
    try { await updateLeaveBalance(userId, patch); }
    catch (e) { setErr(e.message || String(e)); refresh(); }
  };

  const setAvailable = (userId, which, val) => {
    const lb = byUser.get(userId); if (!lb) return;
    const c = computeLeaveAvailable(lb, settings, today);
    patchRow(userId, {
      vacationBalance: which === "vacation" ? val : c.vacationAvailable,
      sickBalance:     which === "sick"     ? val : c.sickAvailable,
      asOfDate: today,
    });
  };

  const adminRows = useMemo(() => {
    if (!admin) return [];
    return rows
      .map(r => ({ r, u: userById(r.userId) }))
      .filter(x => x.u)
      .sort((a, b) => (a.u.name || "").localeCompare(b.u.name || ""));
  }, [admin, rows]);

  if (!admin) return null;

  return (
    <section className="leave-admin">
      <header className="leave-admin-head">
        <h3>Team leave balances</h3>
        <span className="leave-admin-sub">
          {adminRows.length} tracked{busy ? " · refreshing…" : ""} · available accrues automatically each pay period
        </span>
      </header>
      {err && <div className="leave-err"><Icon name="warn" size={12}/> {err}</div>}
      <div className="leave-table-wrap">
        <table className="leave-table">
          <thead>
            <tr>
              <th className="leave-th-name">Employee</th>
              <th>Vacation avail.</th>
              <th>Vacation used</th>
              <th>Sick avail.</th>
              <th>Sick used</th>
              <th className="leave-th-accr">Accrues</th>
            </tr>
          </thead>
          <tbody>
            {adminRows.map(({ r, u }) => {
              const c = computeLeaveAvailable(r, settings, today);
              const tip = `Net balance as of ${fmtDate(r.asOfDate)} + ${c.periods} pay period${c.periods === 1 ? "" : "s"} accrued`;
              return (
                <tr key={r.userId} className={r.accrues ? "" : "is-noaccrue"}>
                  <td className="leave-td-name">
                    <span className={`avatar xs ${u.color}`}>{u.initials}</span>
                    <span className="leave-name-label">{u.name}</span>
                  </td>
                  <td title={r.accrues ? tip : "Not accruing"}>
                    <LeaveNum value={c.vacationAvailable} onCommit={(n) => setAvailable(r.userId, "vacation", n)}/>
                  </td>
                  <td>
                    <LeaveNum value={r.vacationUsed} muted onCommit={(n) => patchRow(r.userId, { vacationUsed: n })}/>
                  </td>
                  <td title={r.accrues ? tip : "Not accruing"}>
                    <LeaveNum value={c.sickAvailable} onCommit={(n) => setAvailable(r.userId, "sick", n)}/>
                  </td>
                  <td>
                    <LeaveNum value={r.sickUsed} muted onCommit={(n) => patchRow(r.userId, { sickUsed: n })}/>
                  </td>
                  <td className="leave-td-accr">
                    <button
                      type="button"
                      className={"leave-accr-toggle" + (r.accrues ? " on" : "")}
                      title={r.accrues ? "Accruing — click to pause" : "Not accruing — click to enable"}
                      onClick={() => patchRow(r.userId, { accrues: !r.accrues })}>
                      <span className="leave-accr-knob"/>
                    </button>
                  </td>
                </tr>
              );
            })}
            {adminRows.length === 0 && !busy && (
              <tr><td colSpan={6} className="leave-table-empty">No leave balances yet. Run the seed (scripts/seed_leave_balances.py) after applying the migration.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LeaveCard({ tone, label, available, used }) {
  return (
    <div className={`leave-card tone-${tone}`}>
      <div className="leave-card-label">{label}</div>
      <div className="leave-card-value">{hrs(available)}</div>
      <div className="leave-card-meta">available · {hrs(used)} used</div>
    </div>
  );
}

// Inline editable number; commits on blur / Enter when changed.
function LeaveNum({ value, onCommit, muted = false }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  return (
    <input
      className={"leave-num" + (muted ? " muted" : "")}
      type="number" step="0.01" inputMode="decimal"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={() => {
        const n = v === "" || v == null ? 0 : Number(v);
        if (Number.isFinite(n) && n !== Number(value)) onCommit(n);
        else setV(String(value));
      }}
    />
  );
}
