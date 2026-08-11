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
//
// Visual grammar: queue-level actions (refresh) sit in the section header;
// per-row decisions sit at the right edge of the row they act on, so a bulk
// control can never be mistaken for a single-record one.

import React, { useEffect, useState, useCallback } from "react";
import { Icon } from "@/icons";
import {
  Alert, Badge, Button, EmptyState, Input, Separator, TooltipProvider,
} from "@/ui";
import { UserTag } from "../primitives";
import {
  loadPendingApprovals, loadPendingCorrections,
  tkResolveCorrection, fmtClock,
} from "../data";
import { WeekApprovalModal } from "./WeekApprovalModal";

const InboxGlyph    = (props) => <Icon name="inbox" {...props} />;
const CalendarGlyph = (props) => <Icon name="calendar" {...props} />;

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

  const total = corrections.length + pending.length;

  return (
    <TooltipProvider delayDuration={280}>
      <div className="tka-approvals">
        <header className="tka-sectionhead">
          <div className="tka-sectionhead-titles">
            <h3 className="tka-sectionhead-title">Awaiting review</h3>
            <p className="tka-sectionhead-sub">
              {total > 0
                ? `${total} item${total === 1 ? "" : "s"} need a decision before payroll closes.`
                : "Nothing is waiting on you right now."}
            </p>
          </div>
          <div className="tka-sectionhead-tools">
            <Button variant="default" size="sm" onClick={refresh} disabled={busy} loading={busy}>
              {!busy && <Icon name="refresh" size={14}/>}
              {busy ? "Refreshing" : "Refresh"}
            </Button>
          </div>
        </header>

        {err && <Alert tone="danger" title="Could not load the review queues">{err}</Alert>}

        {/* === 1. Pending CORRECTIONS ============================== */}
        <section className="tka-queue">
          <header className="tka-queuehead">
            <h4 className="tka-queuetitle">
              <Icon name="edit" size={14}/>
              Correction requests
              {corrections.length > 0 && (
                <Badge tone="brand" size="sm" className="num">{corrections.length}</Badge>
              )}
            </h4>
            <p className="tka-queuesub">
              Add-punch and note requests submitted from a user's timesheet.
            </p>
          </header>

          {corrections.length === 0 && !busy ? (
            <EmptyState
              compact
              icon={InboxGlyph}
              title="No pending corrections"
              description="When someone submits a fix from their timesheet, it lands here for approval."
            />
          ) : (
            <ul className="tka-rows">
              {corrections.map(c => (
                <CorrectionRow
                  key={c.id}
                  correction={c}
                  onResolved={refreshAndNotify}
                />
              ))}
            </ul>
          )}
        </section>

        <Separator/>

        {/* === 2. Pending WEEK approvals ============================ */}
        <section className="tka-queue">
          <header className="tka-queuehead">
            <h4 className="tka-queuetitle">
              <Icon name="calendar" size={14}/>
              Week submissions
              {pending.length > 0 && (
                <Badge tone="brand" size="sm" className="num">{pending.length}</Badge>
              )}
            </h4>
            <p className="tka-queuesub">
              Users who submitted their week for approval. Open one to review and lock it.
            </p>
          </header>

          {pending.length === 0 && !busy ? (
            <EmptyState
              compact
              icon={CalendarGlyph}
              title="No pending week submissions"
              description="Weeks appear here once a user submits their timesheet for approval."
            />
          ) : (
            <ul className="tka-rows">
              {pending.map(w => (
                <li key={`${w.userId}:${w.weekStart}`} className="tka-row">
                  <div className="tka-row-main">
                    <div className="tka-row-who">
                      <UserTag userId={w.userId} size="sm" nameOnly/>
                      <Badge tone="brand" size="sm">
                        <Icon name="hourglass" size={11}/> Pending
                      </Badge>
                    </div>
                    <div className="tka-row-what num">Week of {w.weekStart}</div>
                    <div className="tka-row-sub">submitted {timeAgo(w.submittedAt)}</div>
                  </div>
                  <div className="tka-row-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setOpen({ userId: w.userId, weekStart: w.weekStart })}
                    >
                      Open week
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
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
    </TooltipProvider>
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
    <li className="tka-row is-correction">
      <div className="tka-row-main">
        <div className="tka-row-who">
          <UserTag userId={correction.userId} size="sm" nameOnly/>
          <KindBadge kind={correction.kind}/>
          <Badge tone="brand" size="sm">
            <Icon name="hourglass" size={11}/> Pending
          </Badge>
        </div>

        <div className="tka-row-what">{kindLabel(correction)}</div>
        <div className="tka-row-sub">
          <span className="num">on {fmtFriendlyDate(correction.date)}</span>
          <span className="tka-dot" aria-hidden="true">·</span>
          <span>submitted {timeAgo(correction.submittedAt)}</span>
        </div>

        {correction.reason && (
          <p className="tka-row-quote">
            <Icon name="note" size={12}/>
            <span>{correction.reason}</span>
          </p>
        )}

        {correction.payload?.note && (
          <p className="tka-row-note">Note: {correction.payload.note}</p>
        )}

        {err && <Alert tone="danger" className="mt-2">{err}</Alert>}
      </div>

      {!rejecting ? (
        <div className="tka-row-actions">
          <Button
            variant="destructive-soft"
            size="sm"
            onClick={() => setRejecting(true)}
            disabled={busy}
          >
            <Icon name="x" size={14}/> Reject
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={approve}
            disabled={busy}
            loading={busy}
          >
            {!busy && <Icon name="check" size={14}/>}
            {busy ? "Applying" : "Approve"}
          </Button>
        </div>
      ) : (
        <div className="tka-row-reject">
          <Input
            type="text"
            placeholder="Reason (optional, shared with the user)"
            value={reason}
            onChange={e => setReason(e.target.value)}
            maxLength={300}
            aria-label="Rejection reason"
            autoFocus
          />
          <div className="tka-row-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setRejecting(false); setReason(""); setErr(null); }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={reject}
              disabled={busy}
              loading={busy}
            >
              {busy ? "Rejecting" : "Send back"}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

// -------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------

function KindBadge({ kind }) {
  const map = {
    add_punch:           { tone: "brand",   icon: "plus",    label: "Punch" },
    add_interval:        { tone: "brand",   icon: "plus",    label: "Block" },
    edit_punch:          { tone: "info",    icon: "edit",    label: "Edit" },
    delete_punch:        { tone: "danger",  icon: "trash",   label: "Delete" },
    reclassify_interval: { tone: "success", icon: "tag",     label: "Reclassify" },
    note:                { tone: "neutral", icon: "note",    label: "Note" },
  };
  const m = map[kind] || map.note;
  return (
    <Badge tone={m.tone} size="sm">
      <Icon name={m.icon} size={11}/> {m.label}
    </Badge>
  );
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
  if (!iso) return "–";
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
