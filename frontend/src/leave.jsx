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
import { Badge, EmptyState, Button } from "@/ui";
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
    <section className="tsx-bal" aria-labelledby="tsx-bal-title">
      <header className="tsx-bal-head">
        <div className="tsx-bal-headline">
          <h3 className="tsx-bal-title" id="tsx-bal-title">Leave balance</h3>
          <p className="tsx-bal-sub">
            Accrues {vacRate.toFixed(2)} vacation and {sickRate.toFixed(2)} sick hours
            {" "}each pay period. Next on {fmtDate(nextPay)}.
          </p>
        </div>
        {action && <div className="tsx-bal-action">{action}</div>}
      </header>

      {balance ? (() => {
        const c = computeLeaveAvailable(balance, settings, today);
        return (
          <div className="tsx-bal-grid">
            <LeaveCard tone="sage" icon="sun"  label="Vacation"   available={c.vacationAvailable} used={balance.vacationUsed}/>
            <LeaveCard tone="blue" icon="bell" label="Sick leave" available={c.sickAvailable}     used={balance.sickUsed}/>
          </div>
        );
      })() : busy ? (
        <p className="tsx-muted-note">Loading your balance…</p>
      ) : (
        <EmptyState
          compact
          title="No leave is tracked for your account"
          description="An admin adds you to the leave roster in Time Admin, and your vacation and sick balances start accruing each pay period."
        />
      )}
    </section>
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
    <section className="tsx-leave" aria-label="My leave">
      {err && (
        <p className="tsx-note tone-bad" role="alert">
          <Icon name="warn" size={13}/><span>{err}</span>
        </p>
      )}

      <LeaveBalanceCards
        balance={balance}
        settings={settings}
        busy={busy}
        action={(
          <Button
            variant="primary"
            onClick={onRequest || undefined}
            disabled={!onRequest}
          >
            <Icon name="sun" size={14}/> Request leave
          </Button>
        )}
      />

      <section className="tsx-leave-sec" aria-labelledby="leave-upcoming-title">
        <header className="tsx-leave-sechead">
          <h4 id="leave-upcoming-title">Upcoming leave</h4>
          <p>Approved time off that has not ended yet.</p>
        </header>

        {upcoming.length === 0 ? (
          <EmptyState
            compact
            title={busy ? "Checking approved leave" : "No upcoming leave"}
            description="Approved requests that end today or later show up here with their dates and hours."
          />
        ) : (
          <ul className="tsx-leave-upcoming">
            {upcoming.map(r => (
              <li key={r.id} className={`tsx-leave-up tone-${r.leaveType === "sick" ? "blue" : "sage"}`}>
                <span className="tsx-leave-up-icon" aria-hidden="true"><Icon name="check" size={15}/></span>
                <span className="tsx-leave-up-main">
                  <span className="tsx-leave-up-kind">{r.leaveType === "sick" ? "Sick leave" : "Vacation"}</span>
                  <span className="tsx-leave-up-dates num">
                    {fmtDate(r.dateStart)}{r.dateEnd !== r.dateStart ? ` – ${fmtDate(r.dateEnd)}` : ""}
                  </span>
                </span>
                <span className="tsx-leave-up-hours num">{hrs(r.totalHours)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="tsx-leave-sec" aria-labelledby="leave-requests-title">
        <header className="tsx-leave-sechead">
          <h4 id="leave-requests-title">My requests</h4>
          <p>Pending items first, with older outcomes below.</p>
          {busy && <span className="tsx-leave-refresh" role="status">refreshing…</span>}
        </header>

        {grouped.length === 0 ? (
          !busy && (
            <EmptyState
              compact
              title="No leave requests yet"
              description="Use Request leave to book vacation or sick time. Every request you send lands here with its status."
              action={onRequest ? (
                <Button variant="default" onClick={onRequest}>
                  <Icon name="sun" size={14}/> Request leave
                </Button>
              ) : null}
            />
          )
        ) : (
          <div className="tsx-leave-groups">
            {grouped.map(group => (
              <section key={group.key} className={`tsx-leave-group is-${group.key}`} aria-label={group.label}>
                <h5>{group.label}</h5>
                <ul className="tsx-leave-reqs">
                  {group.rows.map(r => (
                    <LeaveRequestRow key={r.id} request={r} onCancel={cancel}/>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function LeaveRequestRow({ request: r, onCancel }) {
  return (
    <li className={`tsx-leave-req is-${r.status}`}>
      <span className={`tsx-leave-req-dot tone-${r.leaveType === "sick" ? "blue" : "sage"}`} aria-hidden="true"/>
      <div className="tsx-leave-req-main">
        <div className="tsx-leave-req-top">
          <span className="tsx-leave-req-kind">{r.leaveType === "sick" ? "Sick leave" : "Vacation"}</span>
          <span className="tsx-leave-req-dates num">
            {fmtDate(r.dateStart)}{r.dateEnd !== r.dateStart ? ` – ${fmtDate(r.dateEnd)}` : ""}
          </span>
          <span className="tsx-leave-req-hours num">{hrs(r.totalHours)}</span>
        </div>
        {r.reason && <p className="tsx-leave-req-reason">{r.reason}</p>}
        {r.status === "rejected" && r.reviewNote && (
          <p className="tsx-leave-req-note">Admin: {r.reviewNote}</p>
        )}
      </div>
      <div className="tsx-leave-req-side">
        <LeaveStatusChip status={r.status}/>
        {r.status === "pending" && (
          <Button variant="ghost" size="xs" onClick={() => onCancel(r.id)}>
            Cancel
          </Button>
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
    <div className="tsx-leave-banners" role="status" aria-live="polite">
      {active.map(r => {
        const admin = userById(r.reviewedBy);
        const kind  = r.leaveType === "sick" ? "Sick leave" : "Vacation";
        const tone  = r.leaveType === "sick" ? "blue" : "sage";
        const onNow = r.dateStart <= today && today <= r.dateEnd;
        const range = (r.dateEnd && r.dateEnd !== r.dateStart)
          ? `${fmtDate(r.dateStart)} – ${fmtDate(r.dateEnd)}`
          : fmtDate(r.dateStart);
        return (
          <div key={r.id} className={`tsx-leave-banner tone-${tone}`}>
            <span className="tsx-leave-banner-seal" aria-hidden="true"><Icon name="check" size={16}/></span>
            <div className="tsx-leave-banner-copy">
              <span className="tsx-leave-banner-title">
                {kind} approved{admin ? <> by <strong>{admin.name}</strong></> : null}
              </span>
              <span className="tsx-leave-banner-meta">
                <Badge tone={onNow ? "success" : "neutral"} size="sm">
                  {onNow ? "On leave now" : "Upcoming"}
                </Badge>
                <span className="num">{range}</span>
                <span aria-hidden="true">·</span>
                <span className="num">{hrs(r.totalHours)}</span>
              </span>
            </div>
            <span className="tsx-leave-banner-until">
              <span className="tsx-leave-banner-until-key">until</span>
              <span className="tsx-leave-banner-until-val num">{fmtDate(r.dateEnd)}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function LeaveStatusChip({ status }) {
  const map = {
    pending:   { tone: "brand",   label: "Pending",   icon: "hourglass" },
    approved:  { tone: "success", label: "Approved",  icon: "check" },
    rejected:  { tone: "danger",  label: "Rejected",  icon: "x" },
    cancelled: { tone: "neutral", label: "Cancelled", icon: "ban" },
  };
  const m = map[status] || map.cancelled;
  return (
    <Badge tone={m.tone}>
      <Icon name={m.icon} size={11}/>
      {m.label}
    </Badge>
  );
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
    <section className="tsx-leave-sec tsx-leaveadmin" aria-labelledby="tsx-leaveadmin-title">
      <header className="tsx-leave-sechead">
        <h4 id="tsx-leaveadmin-title">Team leave balances</h4>
        <p>
          {adminRows.length} tracked. Available accrues automatically each pay period.
        </p>
        {busy && <span className="tsx-leave-refresh" role="status">refreshing…</span>}
      </header>

      {err && (
        <p className="tsx-note tone-bad" role="alert">
          <Icon name="warn" size={13}/><span>{err}</span>
        </p>
      )}

      <div className="bx-scroll-x tsx-leaveadmin-wrap">
        <table className="tsx-leaveadmin-table">
          <thead>
            <tr>
              <th scope="col" className="tsx-leaveadmin-th-name">Employee</th>
              <th scope="col">Vacation available</th>
              <th scope="col">Vacation used</th>
              <th scope="col">Sick available</th>
              <th scope="col">Sick used</th>
              <th scope="col" className="tsx-leaveadmin-th-accr">Accrues</th>
            </tr>
          </thead>
          <tbody>
            {adminRows.map(({ r, u }) => {
              const c = computeLeaveAvailable(r, settings, today);
              const tip = `Net balance as of ${fmtDate(r.asOfDate)} plus ${c.periods} pay period${c.periods === 1 ? "" : "s"} accrued`;
              return (
                <tr key={r.userId} className={r.accrues ? "" : "is-noaccrue"}>
                  <th scope="row" className="tsx-leaveadmin-td-name">
                    {/* The flex wrapper is load-bearing: `vertical-align:
                        middle` on the avatar and the name aligns each to the
                        parent's baseline + half x-height, not to each other,
                        which left the initials sitting a hair off the name.
                        Flex centres them against one another instead. */}
                    <span className="tsx-leaveadmin-who">
                      <span className={`avatar xs ${u.color}`}>{u.initials}</span>
                      <span className="tsx-leaveadmin-name">{u.name}</span>
                    </span>
                  </th>
                  <td title={r.accrues ? tip : "Not accruing"}>
                    <LeaveNum value={c.vacationAvailable} label={`Vacation available for ${u.name}`}
                      onCommit={(n) => setAvailable(r.userId, "vacation", n)}/>
                  </td>
                  <td>
                    <LeaveNum value={r.vacationUsed} muted label={`Vacation used by ${u.name}`}
                      onCommit={(n) => patchRow(r.userId, { vacationUsed: n })}/>
                  </td>
                  <td title={r.accrues ? tip : "Not accruing"}>
                    <LeaveNum value={c.sickAvailable} label={`Sick available for ${u.name}`}
                      onCommit={(n) => setAvailable(r.userId, "sick", n)}/>
                  </td>
                  <td>
                    <LeaveNum value={r.sickUsed} muted label={`Sick used by ${u.name}`}
                      onCommit={(n) => patchRow(r.userId, { sickUsed: n })}/>
                  </td>
                  <td className="tsx-leaveadmin-td-accr">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!r.accrues}
                      aria-label={`Accrual for ${u.name}`}
                      className={"tsx-toggle" + (r.accrues ? " is-on" : "")}
                      title={r.accrues ? "Accruing. Click to pause." : "Not accruing. Click to enable."}
                      onClick={() => patchRow(r.userId, { accrues: !r.accrues })}>
                      <span className="tsx-toggle-knob"/>
                    </button>
                  </td>
                </tr>
              );
            })}
            {adminRows.length === 0 && !busy && (
              <tr>
                <td colSpan={6} className="tsx-leaveadmin-empty">
                  No leave balances yet. Run the seed (scripts/seed_leave_balances.py) after applying the migration.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LeaveCard({ tone, icon, label, available, used }) {
  return (
    <div className={`tsx-bal-card tone-${tone}`}>
      <span className="tsx-bal-card-key">
        <span className="tsx-bal-card-icon" aria-hidden="true"><Icon name={icon} size={14}/></span>
        {label}
      </span>
      <span className="tsx-bal-card-val num">{hrs(available)}</span>
      <span className="tsx-bal-card-meta">available now</span>
      <span className="tsx-bal-card-used num">{hrs(used)} used to date</span>
    </div>
  );
}

// Inline editable number; commits on blur / Enter when changed.
function LeaveNum({ value, onCommit, muted = false, label }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  return (
    <input
      className={"tsx-leavenum num" + (muted ? " is-muted" : "")}
      type="number" step="0.01" inputMode="decimal"
      aria-label={label}
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
