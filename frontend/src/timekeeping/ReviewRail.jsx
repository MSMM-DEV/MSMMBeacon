// ReviewRail — the "Awaiting your review" strip that lives at the top of the
// Team canvas (Time Admin → Team). It surfaces the same two queues as the
// Approvals tab — pending corrections + submitted weeks — but in-context, so an
// admin can approve / reject / jump to the day WITHOUT leaving the canvas.
//
//   • Correction → Approve (immediate) · Reject (with reason) · Open day
//       "Open day" routes to the Day editor (onOpenUserDay) at the exact date.
//   • Week       → Review (opens WeekApprovalModal, hosted here).
//
// Re-fetches on `dataVersion` (bumped by the parent after any approval/edit),
// on mount, and via its own Refresh. Collapses to a slim "all caught up" bar
// when both queues are empty so it never wastes canvas real estate.

import React, { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons";
import {
  loadPendingCorrections, loadPendingApprovals,
  tkResolveCorrection, fmtClock, userById,
} from "../data";
import { WeekApprovalModal } from "./WeekApprovalModal";

export function ReviewRail({ dataVersion = 0, onResolved, onOpenUserDay }) {
  const [corrections, setCorrections] = useState([]);
  const [weeks, setWeeks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [openWeek, setOpenWeek] = useState(null);

  const refresh = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const [c, w] = await Promise.all([loadPendingCorrections(), loadPendingApprovals()]);
      setCorrections(c); setWeeks(w);
    } catch (e) {
      setErr(e.message || "load failed");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, dataVersion]);

  const total = corrections.length + weeks.length;

  const afterResolve = useCallback(async (payload) => {
    await refresh();
    onResolved?.(payload);
  }, [refresh, onResolved]);

  // Empty → slim, quiet "caught up" bar (still shows the refresh affordance).
  if (total === 0) {
    return (
      <div className="tk-rr is-empty">
        <span className="tk-rr-empty-text"><Icon name="check" size={13} /> Review queue clear — nothing awaiting approval.</span>
        <button className="tk-rr-refresh" onClick={refresh} disabled={busy} aria-label="Refresh review queue">
          <Icon name="refresh" size={12} />
        </button>
      </div>
    );
  }

  return (
    <div className={`tk-rr ${collapsed ? "is-collapsed" : ""}`}>
      <header className="tk-rr-head">
        <button className="tk-rr-toggle" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={14} />
          <span className="tk-rr-title">Awaiting your review</span>
          <span className="tk-rr-count">{total}</span>
        </button>
        <div className="tk-rr-head-tools">
          {err && <span className="tk-rr-err">{err}</span>}
          <button className="tk-rr-refresh" onClick={refresh} disabled={busy} aria-label="Refresh">
            <Icon name="refresh" size={12} /> {busy ? "…" : "Refresh"}
          </button>
        </div>
      </header>

      {!collapsed && (
        <div className="tk-rr-body">
          {corrections.length > 0 && (
            <section className="tk-rr-group">
              <div className="tk-rr-group-label"><Icon name="edit" size={12} /> Corrections <span className="tk-rr-group-n">{corrections.length}</span></div>
              <div className="tk-rr-cards">
                {corrections.map((c) => (
                  <CorrectionCard key={c.id} c={c} onResolved={afterResolve} onOpenUserDay={onOpenUserDay} />
                ))}
              </div>
            </section>
          )}

          {weeks.length > 0 && (
            <section className="tk-rr-group">
              <div className="tk-rr-group-label"><Icon name="calendar" size={12} /> Week submissions <span className="tk-rr-group-n">{weeks.length}</span></div>
              <div className="tk-rr-cards">
                {weeks.map((w) => {
                  const u = userById(w.userId);
                  return (
                    <div key={`${w.userId}:${w.weekStart}`} className="tk-rr-card tk-rr-week">
                      <div className="tk-rr-card-who">
                        {u && <span className={`avatar xs ${u.color}`}>{u.initials}</span>}
                        <span className="tk-rr-card-name">{u?.name || "User"}</span>
                      </div>
                      <div className="tk-rr-card-what">Week of {w.weekStart}</div>
                      <div className="tk-rr-card-sub">submitted {timeAgo(w.submittedAt)}</div>
                      <div className="tk-rr-card-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => onOpenUserDay?.({ userId: w.userId, date: w.weekStart })}>Open day</button>
                        <button className="btn btn-primary btn-sm" onClick={() => setOpenWeek({ userId: w.userId, weekStart: w.weekStart })}>Review week</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {openWeek && (
        <WeekApprovalModal
          userId={openWeek.userId}
          weekStart={openWeek.weekStart}
          onClose={() => setOpenWeek(null)}
          onResolved={() => { setOpenWeek(null); afterResolve({ kind: "week", weekStart: openWeek.weekStart }); }}
        />
      )}
    </div>
  );
}

function CorrectionCard({ c, onResolved, onOpenUserDay }) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState(null);
  const u = userById(c.userId);

  const act = async (decision, note) => {
    setBusy(true); setErr(null);
    try {
      await tkResolveCorrection(c.id, decision, note || null);
      onResolved?.({ kind: "correction", date: c.date, decision });
    } catch (e) {
      setErr(e.message || "failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tk-rr-card tk-rr-corr">
      <div className="tk-rr-card-who">
        {u && <span className={`avatar xs ${u.color}`}>{u.initials}</span>}
        <span className="tk-rr-card-name">{u?.name || "User"}</span>
        <KindChip kind={c.kind} />
      </div>
      <div className="tk-rr-card-what">{label(c)}</div>
      <div className="tk-rr-card-sub">{fmtFriendlyDate(c.date)} · {timeAgo(c.submittedAt)}</div>
      {c.reason && <div className="tk-rr-card-reason">“{c.reason}”</div>}

      {err && <div className="tk-rr-card-err">{err}</div>}

      {!rejecting ? (
        <div className="tk-rr-card-actions">
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onOpenUserDay?.({ userId: c.userId, date: c.date })}>Open day</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act("approved")}>{busy ? "…" : "Approve"}</button>
        </div>
      ) : (
        <div className="tk-rr-reject">
          <input type="text" className="form-input" placeholder="Reason (optional, shared with user)" value={reason} maxLength={300} autoFocus onChange={(e) => setReason(e.target.value)} />
          <div className="tk-rr-card-actions">
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setRejecting(false); setReason(""); }}>Cancel</button>
            <button className="btn btn-warn btn-sm" disabled={busy} onClick={() => act("rejected", reason.trim())}>{busy ? "…" : "Send back"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function KindChip({ kind }) {
  const map = {
    add_punch: ["accent", "Punch"], add_interval: ["accent", "Block"],
    edit_punch: ["blue", "Edit"], delete_punch: ["rose", "Delete"],
    reclassify_interval: ["sage", "Retag"], note: ["muted", "Note"],
  };
  const [tone, lbl] = map[kind] || map.note;
  return <span className={`tk-rr-kind tone-${tone}`}>{lbl}</span>;
}

function label(c) {
  const p = c.payload || {};
  if (c.kind === "add_interval") {
    const span = (p.start_at && p.end_at) ? `${fmtClock(p.start_at)} – ${fmtClock(p.end_at)}` : "a block";
    return p.is_out ? `Add away block ${span}` : `Add worked block ${span}`;
  }
  if (c.kind === "add_punch") return `Add punch${p.punched_at ? ` at ${fmtClock(p.punched_at)}` : ""}`;
  if (c.kind === "edit_punch") return "Edit a punch time";
  if (c.kind === "delete_punch") return "Delete a punch";
  if (c.kind === "reclassify_interval") return "Reclassify a block";
  if (c.kind === "note") return "Add a note";
  return c.kind;
}

function fmtFriendlyDate(iso) {
  if (!iso) return "—";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function timeAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - +new Date(iso);
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
