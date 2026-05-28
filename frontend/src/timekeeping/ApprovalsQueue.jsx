// ApprovalsQueue — admin's review surface.
//
// Two queues, sharing the same tab:
//   1. Pending CORRECTIONS — `timesheet_corrections` rows with status='pending'.
//      Time-sensitive ("forgot to punch out yesterday"); rendered first.
//   2. Pending WEEK approvals — `timesheet_weeks` rows with approval_status='submitted'.
//      Lower urgency; rendered below.
//
// Both queues refresh together. Approving a correction calls the
// timeclock-admin Edge Function (`resolve-correction`) which inserts the
// missing punch / applies the change via service-role and re-derives the
// affected day. Approving a week opens the existing WeekApprovalModal.

import React, { useEffect, useState, useCallback } from "react";
import { Icon } from "../icons";
import { UserTag } from "../primitives";
import {
  loadPendingApprovals, loadPendingCorrections,
  tkResolveCorrection, fmtClock,
} from "../data";
import { WeekApprovalModal } from "./WeekApprovalModal";

export function ApprovalsQueue({ onResolved }) {
  const [pending,    setPending]    = useState([]);
  const [corrections, setCorrections] = useState([]);
  const [open,       setOpen]       = useState(null);
  const [busy,       setBusy]       = useState(false);
  const [err,        setErr]        = useState(null);

  const refresh = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const [w, c] = await Promise.all([
        loadPendingApprovals(),
        loadPendingCorrections(),
      ]);
      setPending(w);
      setCorrections(c);
    } catch (e) {
      setErr(e.message || "load failed");
    } finally {
      setBusy(false);
    }
  }, []);

  // Notify parent (TimeAdminTab) that something was approved/rejected so the
  // Team view can refetch AND navigate to the affected date. Wraps the local
  // refresh so callers don't have to remember both. Forwards the payload
  // (kind/date/weekStart) up to the parent.
  const refreshAndNotify = useCallback(async (payload) => {
    await refresh();
    onResolved?.(payload);
  }, [refresh, onResolved]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="tk-approvals">
      <header className="tk-section-head">
        <h3>Awaiting review</h3>
        <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={busy}>
          <Icon name="undo" size={13}/> {busy ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {err && <div className="form-error">{err}</div>}

      {/* === 1. Pending CORRECTIONS ============================== */}
      <section className="tk-approvals-section">
        <header className="tk-approvals-section-head">
          <h4>
            Correction requests
            {corrections.length > 0 && (
              <span className="tk-approvals-section-count">{corrections.length}</span>
            )}
          </h4>
          <span className="tk-approvals-section-sub">
            Add-punch / note requests submitted from a user's timesheet.
          </span>
        </header>
        <ul className="tk-approvals-list">
          {corrections.map(c => (
            <CorrectionRow
              key={c.id}
              correction={c}
              onResolved={refreshAndNotify}
            />
          ))}
          {corrections.length === 0 && !busy && (
            <li className="tk-approvals-empty">No pending corrections.</li>
          )}
        </ul>
      </section>

      {/* === 2. Pending WEEK approvals ============================ */}
      <section className="tk-approvals-section">
        <header className="tk-approvals-section-head">
          <h4>
            Week submissions
            {pending.length > 0 && (
              <span className="tk-approvals-section-count">{pending.length}</span>
            )}
          </h4>
          <span className="tk-approvals-section-sub">
            Users who submitted their week for approval. Click Open to review and lock.
          </span>
        </header>
        <ul className="tk-approvals-list">
          {pending.map(w => (
            <li key={`${w.userId}:${w.weekStart}`} className="tk-approvals-row">
              <UserTag userId={w.userId} size="sm" nameOnly/>
              <span className="tk-approvals-week">Week of {w.weekStart}</span>
              <span className="tk-approvals-sub">submitted {timeAgo(w.submittedAt)}</span>
              <button className="btn btn-primary btn-sm"
                onClick={() => setOpen({ userId: w.userId, weekStart: w.weekStart })}>
                Open
              </button>
            </li>
          ))}
          {pending.length === 0 && !busy && (
            <li className="tk-approvals-empty">No pending week submissions.</li>
          )}
        </ul>
      </section>

      {open && (
        <WeekApprovalModal
          userId={open.userId}
          weekStart={open.weekStart}
          onClose={() => setOpen(null)}
          onResolved={() => refreshAndNotify({ kind: "week", weekStart: open.weekStart })}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------
// One pending correction row. Approve immediately; Reject opens a small
// inline pane for the optional rejection note.
// -------------------------------------------------------------------
function CorrectionRow({ correction, onResolved }) {
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason,    setReason]    = useState("");

  const approve = async () => {
    setBusy(true); setErr(null);
    try {
      await tkResolveCorrection(correction.id, "approved", null);
      onResolved?.({ kind: "correction", date: correction.date, decision: "approved" });
    } catch (e) { setErr(e.message || "approve failed"); }
    finally    { setBusy(false); }
  };

  const reject = async () => {
    setBusy(true); setErr(null);
    try {
      await tkResolveCorrection(correction.id, "rejected", reason.trim() || null);
      onResolved?.({ kind: "correction", date: correction.date, decision: "rejected" });
    } catch (e) { setErr(e.message || "reject failed"); }
    finally    { setBusy(false); }
  };

  return (
    <li className="tk-approvals-row tk-corr-row">
      <div className="tk-corr-row-meta">
        <UserTag userId={correction.userId} size="sm" nameOnly/>
        <span className="tk-corr-row-kind">
          <KindBadge kind={correction.kind}/>
          {kindLabel(correction)}
        </span>
        <span className="tk-corr-row-date">on {fmtFriendlyDate(correction.date)}</span>
      </div>

      {correction.reason && (
        <div className="tk-corr-row-reason">
          <Icon name="edit" size={11}/>
          <span>{correction.reason}</span>
        </div>
      )}

      {correction.payload?.note && (
        <div className="tk-corr-row-note">
          Note: {correction.payload.note}
        </div>
      )}

      <div className="tk-corr-row-foot">
        <span className="tk-corr-row-sub">submitted {timeAgo(correction.submittedAt)}</span>
        {!rejecting ? (
          <div className="tk-corr-row-actions">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setRejecting(true)}
              disabled={busy}
            >
              Reject…
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={approve}
              disabled={busy}
            >
              {busy ? "Applying…" : "Approve"}
            </button>
          </div>
        ) : (
          <div className="tk-corr-row-reject">
            <input
              type="text"
              className="form-input"
              placeholder="Reason (optional, shared with the user)"
              value={reason}
              onChange={e => setReason(e.target.value)}
              maxLength={300}
              autoFocus
            />
            <div className="tk-corr-row-actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => { setRejecting(false); setReason(""); setErr(null); }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="btn btn-warn btn-sm"
                onClick={reject}
                disabled={busy}
              >
                {busy ? "Rejecting…" : "Send back"}
              </button>
            </div>
          </div>
        )}
      </div>

      {err && <div className="form-error">{err}</div>}
    </li>
  );
}

// -------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------

function KindBadge({ kind }) {
  const map = {
    add_punch:           { tone: "accent", label: "Punch" },
    add_interval:        { tone: "accent", label: "Block" },
    edit_punch:          { tone: "blue",   label: "Edit" },
    delete_punch:        { tone: "rose",   label: "Delete" },
    reclassify_interval: { tone: "sage",   label: "Reclassify" },
    note:                { tone: "muted",  label: "Note" },
  };
  const m = map[kind] || map.note;
  return <span className={`tk-corr-kind-chip tone-${m.tone}`}>{m.label}</span>;
}

function kindLabel(c) {
  if (c.kind === "add_punch") {
    const when = c.payload?.punched_at ? fmtClock(c.payload.punched_at) : "a missing punch";
    return `Add a punch at ${when}`;
  }
  if (c.kind === "add_interval") {
    const p = c.payload || {};
    const span = (p.start_at && p.end_at) ? `${fmtClock(p.start_at)} – ${fmtClock(p.end_at)}` : "a time block";
    return p.is_out
      ? `Add an away block ${span}`
      : `Add a worked block ${span}`;
  }
  if (c.kind === "edit_punch")  return "Edit a punch";
  if (c.kind === "delete_punch")return "Delete a punch";
  if (c.kind === "reclassify_interval") return "Reclassify an interval";
  if (c.kind === "note")        return "Add a note";
  return c.kind;
}

function fmtFriendlyDate(iso) {
  if (!iso) return "—";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

function timeAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - +new Date(iso);
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
