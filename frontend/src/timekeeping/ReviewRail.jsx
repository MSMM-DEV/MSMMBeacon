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
//
// Rail-level controls (collapse, refresh) live in the header; the decisions
// that mutate one record live inside that record's card. Pending state is
// carried by a badge with an icon and a word, never by colour alone.

import React, { useCallback, useEffect, useState } from "react";
import { Icon } from "@/icons";
import { Alert, Badge, Button, Input, TooltipProvider } from "@/ui";
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
      <div className="tka-rail is-clear">
        <span className="tka-rail-clear">
          <span className="tka-rail-clear-icon"><Icon name="check" size={13}/></span>
          Review queue clear. Nothing is awaiting approval.
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          disabled={busy}
          aria-label="Refresh review queue"
        >
          <Icon name="refresh" size={13}/>
        </Button>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={280}>
      <div className={`tka-rail ${collapsed ? "is-collapsed" : ""}`}>
        <header className="tka-rail-head">
          <button
            type="button"
            className="tka-rail-toggle"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={15}/>
            <span className="tka-rail-title">Awaiting your review</span>
            <Badge tone="brand" size="sm" className="num">{total}</Badge>
          </button>

          <div className="tka-rail-tools">
            {err && <span className="tka-rail-err" role="alert">{err}</span>}
            <Button
              variant="ghost"
              size="sm"
              onClick={refresh}
              disabled={busy}
              loading={busy}
              aria-label="Refresh review queue"
            >
              {!busy && <Icon name="refresh" size={13}/>}
              <span className="tka-rail-refresh-label">Refresh</span>
            </Button>
          </div>
        </header>

        {!collapsed && (
          <div className="tka-rail-body">
            {corrections.length > 0 && (
              <section className="tka-rail-group">
                <h4 className="tka-rail-grouphead">
                  <Icon name="edit" size={13}/>
                  Corrections
                  <Badge tone="neutral" size="sm" className="num">{corrections.length}</Badge>
                </h4>
                <div className="tka-rail-cards">
                  {corrections.map((c) => (
                    <CorrectionCard key={c.id} c={c} onResolved={afterResolve} onOpenUserDay={onOpenUserDay} />
                  ))}
                </div>
              </section>
            )}

            {weeks.length > 0 && (
              <section className="tka-rail-group">
                <h4 className="tka-rail-grouphead">
                  <Icon name="calendar" size={13}/>
                  Week submissions
                  <Badge tone="neutral" size="sm" className="num">{weeks.length}</Badge>
                </h4>
                <div className="tka-rail-cards">
                  {weeks.map((w) => {
                    const u = userById(w.userId);
                    return (
                      <article key={`${w.userId}:${w.weekStart}`} className="tka-rail-card">
                        <header className="tka-rail-card-who">
                          {u && <span className={`avatar xs ${u.color}`}>{u.initials}</span>}
                          <span className="tka-rail-card-name">{u?.name || "User"}</span>
                          <Badge tone="brand" size="sm">
                            <Icon name="hourglass" size={11}/> Pending
                          </Badge>
                        </header>
                        <p className="tka-rail-card-what num">Week of {w.weekStart}</p>
                        <p className="tka-rail-card-sub">submitted {timeAgo(w.submittedAt)}</p>
                        <div className="tka-rail-card-actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onOpenUserDay?.({ userId: w.userId, date: w.weekStart })}
                          >
                            Open day
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => setOpenWeek({ userId: w.userId, weekStart: w.weekStart })}
                          >
                            Review week
                          </Button>
                        </div>
                      </article>
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
    </TooltipProvider>
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
    <article className="tka-rail-card">
      <header className="tka-rail-card-who">
        {u && <span className={`avatar xs ${u.color}`}>{u.initials}</span>}
        <span className="tka-rail-card-name">{u?.name || "User"}</span>
        <KindChip kind={c.kind} />
      </header>

      <p className="tka-rail-card-what">{label(c)}</p>
      <p className="tka-rail-card-sub num">{fmtFriendlyDate(c.date)} · {timeAgo(c.submittedAt)}</p>
      {c.reason && (
        <p className="tka-rail-card-quote">
          <Icon name="note" size={12}/>
          <span>{c.reason}</span>
        </p>
      )}

      {err && <Alert tone="danger" className="mt-1">{err}</Alert>}

      {!rejecting ? (
        <div className="tka-rail-card-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onOpenUserDay?.({ userId: c.userId, date: c.date })}
          >
            Open day
          </Button>
          <Button
            variant="destructive-soft"
            size="sm"
            disabled={busy}
            onClick={() => setRejecting(true)}
          >
            Reject
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            loading={busy}
            onClick={() => act("approved")}
          >
            {!busy && <Icon name="check" size={14}/>}
            Approve
          </Button>
        </div>
      ) : (
        <div className="tka-rail-card-reject">
          <Input
            type="text"
            placeholder="Reason (optional, shared with user)"
            value={reason}
            maxLength={300}
            autoFocus
            aria-label="Rejection reason"
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="tka-rail-card-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => { setRejecting(false); setReason(""); }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              loading={busy}
              onClick={() => act("rejected", reason.trim())}
            >
              Send back
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

function KindChip({ kind }) {
  const map = {
    add_punch:           ["brand",   "plus",  "Punch"],
    add_interval:        ["brand",   "plus",  "Block"],
    edit_punch:          ["info",    "edit",  "Edit"],
    delete_punch:        ["danger",  "trash", "Delete"],
    reclassify_interval: ["success", "tag",   "Retag"],
    note:                ["neutral", "note",  "Note"],
  };
  const [tone, icon, lbl] = map[kind] || map.note;
  return (
    <Badge tone={tone} size="sm">
      <Icon name={icon} size={11}/> {lbl}
    </Badge>
  );
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
  if (!iso) return "–";
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
