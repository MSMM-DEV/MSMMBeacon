// ApprovalsQueue — admin view of submitted weeks awaiting approval. Click
// a row to open WeekApprovalModal for that user/week.

import React, { useEffect, useState, useCallback } from "react";
import { Icon } from "../icons";
import { UserTag } from "../primitives";
import { loadPendingApprovals } from "../data";
import { WeekApprovalModal } from "./WeekApprovalModal";

export function ApprovalsQueue() {
  const [pending, setPending] = useState([]);
  const [open,    setOpen]    = useState(null);
  const [busy,    setBusy]    = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try { setPending(await loadPendingApprovals()); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="tk-approvals">
      <header className="tk-section-head">
        <h3>Awaiting approval</h3>
        <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={busy}>
          <Icon name="undo" size={13}/> Refresh
        </button>
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
          <li className="tk-approvals-empty">All caught up — no pending approvals.</li>
        )}
      </ul>

      {open && (
        <WeekApprovalModal
          userId={open.userId}
          weekStart={open.weekStart}
          onClose={() => setOpen(null)}
          onResolved={refresh}
        />
      )}
    </div>
  );
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
