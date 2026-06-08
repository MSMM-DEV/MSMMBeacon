// TimeOffTab — vacation + sick leave tracker.
//
// Everyone sees their own balances (read-only). Admins additionally get an
// editable team table. Balances accrue every pay period (every other
// Wednesday) automatically — the displayed "available" = stored net balance
// (as of its as_of_date) + accrued periods × rate, computed live in
// computeLeaveAvailable (mirrors the beacon_v2.v_leave_balances view).
//
// Admin edits are entered as the CURRENT available value: saving re-bases both
// categories to today (stored balance := current available, as_of := today) so
// the number the admin typed is what shows, and accrual continues from today.
// (A future phase adds employee leave REQUESTS + admin approval, which will
// decrement balance / increment used.)

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Icon } from "./icons.jsx";
import {
  getCurrentBeaconUser, isAdmin, getUsers, userById, getAppSettings,
  loadLeaveBalances, computeLeaveAvailable, leaveNextPayDate,
  updateLeaveBalance, todayInCT, fmtDate,
} from "./data.js";

const hrs = (n) => `${(Math.round((n || 0) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} hrs`;

export function TimeOffTab() {
  const me       = getCurrentBeaconUser();
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
  useEffect(() => { refresh(); }, [refresh]);

  const byUser = useMemo(() => new Map(rows.map(r => [r.userId, r])), [rows]);
  const mine   = me ? byUser.get(me.id) : null;

  const patchRow = async (userId, patch) => {
    setRows(rs => rs.map(r => r.userId === userId ? { ...r, ...patch } : r));
    try { await updateLeaveBalance(userId, patch); }
    catch (e) { setErr(e.message || String(e)); refresh(); }
  };

  // Edit an "available" figure → re-base BOTH categories to today so moving the
  // shared as_of_date can't silently drop the other category's accrual.
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

  const vacRate  = settings.leaveVacationAccrual || 0;
  const sickRate = settings.leaveSickAccrual || 0;
  const nextPay  = leaveNextPayDate(settings, today);

  return (
    <div className="leave-page">
      {/* Personal summary — everyone */}
      <section className="leave-hero">
        <div className="leave-hero-head">
          <h3 className="leave-hero-title">My time off</h3>
          <span className="leave-hero-sub">
            Accrues {vacRate.toFixed(2)} vacation · {sickRate.toFixed(2)} sick hrs each pay period
            {" · next "}{fmtDate(nextPay)}
          </span>
        </div>
        {mine ? (() => {
          const c = computeLeaveAvailable(mine, settings, today);
          return (
            <div className="leave-hero-cards">
              <LeaveCard tone="sage"  label="Vacation" available={c.vacationAvailable} used={mine.vacationUsed}/>
              <LeaveCard tone="blue"  label="Sick leave" available={c.sickAvailable}   used={mine.sickUsed}/>
            </div>
          );
        })() : (
          <p className="leave-empty-note">
            {busy ? "Loading…" : "No leave is tracked for your account."}
          </p>
        )}
      </section>

      {err && <div className="leave-err"><Icon name="warn" size={12}/> {err}</div>}

      {/* Admin team table */}
      {admin && (
        <section className="leave-admin">
          <header className="leave-admin-head">
            <h3>Team leave balances</h3>
            <span className="leave-admin-sub">
              {adminRows.length} tracked{busy ? " · refreshing…" : ""} · available accrues automatically each pay period
            </span>
          </header>
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
      )}
    </div>
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
