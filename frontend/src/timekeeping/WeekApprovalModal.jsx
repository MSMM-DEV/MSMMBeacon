// WeekApprovalModal — admin view of one user's 7-day week. Shows day
// timelines side-by-side, surface flags, exposes Approve / Reject. On
// approve, the week locks (no further user edits).

import React, { useEffect, useState } from "react";
import { Icon } from "@/icons";
import {
  Alert, Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, Skeleton, Textarea,
} from "@/ui";
import { UserTag } from "../primitives";
import { loadMyWeek, loadDayDetail, fmtHM, tkApproveWeek, tkRejectWeek } from "../data";
import { DayTimeline } from "./DayTimeline";

const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

export function WeekApprovalModal({ userId, weekStart, onClose, onResolved }) {
  const [data,     setData]     = useState(null);
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason,   setReason]   = useState("");

  useEffect(() => {
    let live = true;
    loadMyWeek(userId, weekStart).then(d => { if (live) setData(d); });
    return () => { live = false; };
  }, [userId, weekStart]);

  const approve = async () => {
    setBusy(true); setErr(null);
    try { await tkApproveWeek(userId, weekStart); onResolved?.(); onClose?.(); }
    catch (e) { setErr(e.message || "approve failed"); }
    finally { setBusy(false); }
  };

  const reject = async () => {
    if (!reason.trim()) { setErr("reason is required"); return; }
    setBusy(true); setErr(null);
    try { await tkRejectWeek(userId, weekStart, reason.trim()); onResolved?.(); onClose?.(); }
    catch (e) { setErr(e.message || "reject failed"); }
    finally { setBusy(false); }
  };

  if (!data) {
    return (
      <Dialog open onOpenChange={(o) => { if (!o) onClose?.(); }}>
        <DialogContent size="xl" className="tka-week">
          <DialogHeader>
            <p className="tka-eyebrow">Week review</p>
            <DialogTitle>Loading the week</DialogTitle>
            <DialogDescription>Fetching the seven days in this submission.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-2" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full"/>)}
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  const dayByDate = new Map((data.days || []).map(d => [d.date, d]));
  const slots = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${weekStart}T00:00:00`);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    return { date: dateStr, label: DOW[i], day: dayByDate.get(dateStr) };
  });

  // Worked time = at-desk (IN) minutes only; punched-out time never counts.
  const total = slots.reduce((acc, s) => acc + (s.day?.minutesWork || 0), 0);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <DialogContent size="xl" className="tka-week">
        <DialogHeader className="tka-week-head gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="tka-eyebrow">Week review</p>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span className="num">Week of {weekStart}</span>
              <UserTag userId={userId} nameOnly/>
            </DialogTitle>
            <DialogDescription>
              Approving locks the week so the user can no longer edit it.
            </DialogDescription>
          </div>
          <span className="tka-week-total num">{fmtHM(total)}</span>
        </DialogHeader>

        <DialogBody className="tka-week-body">
          {data.week?.rejectReason && (
            <Alert tone="warning" title="Previously returned">
              {data.week.rejectReason}
            </Alert>
          )}

          <ul className="tka-week-days">
            {slots.map(s => {
              const minutes = s.day?.minutesWork || 0;
              const f = s.day?.flags || {};
              return (
                <li key={s.date} className="tka-week-day">
                  <div className="tka-week-dayhead">
                    <span className="tka-week-dow">{s.label}</span>
                    <span className="tka-week-date num">{s.date.slice(5)}</span>
                    <span className="tka-week-hours num">{fmtHM(minutes)}</span>
                    <span className="tka-week-flags">
                      {f.missing_out && (
                        <Badge tone="danger" size="sm"><Icon name="warn" size={11}/> missing OUT</Badge>
                      )}
                      {f.overtime_min && (
                        <Badge tone="info" size="sm"><Icon name="clock" size={11}/> OT {fmtHM(f.overtime_min)}</Badge>
                      )}
                      {f.untagged_meeting && (
                        <Badge tone="danger" size="sm"><Icon name="warn" size={11}/> untagged gap</Badge>
                      )}
                    </span>
                  </div>
                  <DayTimelineForReview date={s.date} dayData={s.day} userId={userId}/>
                </li>
              );
            })}
          </ul>

          {rejectOpen && (
            <div className="tka-week-reject">
              <label className="tka-insp-label" htmlFor="tka-week-reason">Reason for return</label>
              <Textarea id="tka-week-reason" rows={2} value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="e.g. Wed has an open IN with no OUT; please add a correction."/>
              <p className="tka-insp-hint">
                The user gets an email with this reason and the week reopens for re-submission.
              </p>
            </div>
          )}

          {err && <Alert tone="danger">{err}</Alert>}
        </DialogBody>

        <DialogFooter>
          {!rejectOpen ? (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="destructive-soft" onClick={() => setRejectOpen(true)} disabled={busy}>
                Return for review
              </Button>
              <Button variant="primary" onClick={approve} disabled={busy} loading={busy}>
                {!busy && <Icon name="lock" size={15}/>}
                {busy ? "Approving" : "Approve and lock"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="default" onClick={() => { setRejectOpen(false); setReason(""); }} disabled={busy}>
                Back
              </Button>
              <Button variant="destructive" onClick={reject} disabled={busy || !reason.trim()} loading={busy}>
                {busy ? "Sending" : "Send back"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Small lazy wrapper so the modal renders fast on open and the per-day intervals
// load when their slot mounts. For the v1 we just lean on the existing day data
// from loadMyWeek (which only carries day rollups) and fetch intervals on demand.
function DayTimelineForReview({ date, userId }) {
  const [intervals, setIntervals] = useState(null);
  useEffect(() => {
    let live = true;
    loadDayDetail(userId, date).then(d => { if (live) setIntervals(d.intervals || []); });
    return () => { live = false; };
  }, [userId, date]);
  if (intervals === null) return <Skeleton className="h-5 w-full"/>;
  return <DayTimeline date={date} intervals={intervals} height={20} showHourGrid={false}/>;
}
