// WeekApprovalModal — admin view of one user's 7-day week. Shows day
// timelines side-by-side, surface flags, exposes Approve / Reject. On
// approve, the week locks (no further user edits).

import React, { useEffect, useState } from "react";
import { Icon } from "../icons";
import { UserTag } from "../primitives";
import { loadMyWeek, fmtHM, tkApproveWeek, tkRejectWeek } from "../data";
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
      <div className="modal-backdrop"><div className="modal modal-wide">
        <div className="modal-body">Loading…</div>
      </div></div>
    );
  }

  const dayByDate = new Map((data.days || []).map(d => [d.date, d]));
  const slots = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${weekStart}T00:00:00`);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    return { date: dateStr, label: DOW[i], day: dayByDate.get(dateStr) };
  });

  const total = slots.reduce((acc, s) =>
    acc + (s.day?.minutesWork || 0) + (s.day?.minutesMeeting || 0) + (s.day?.minutesTravel || 0), 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-eyebrow">Week review</div>
          <h3 className="modal-title">
            Week of {weekStart} · <UserTag userId={userId} nameOnly/>
          </h3>
          <div className="modal-head-meta">{fmtHM(total)}</div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-body">
          {data.week?.rejectReason && (
            <div className="tk-banner tk-banner-warn">
              Previously returned: {data.week.rejectReason}
            </div>
          )}

          <ul className="tk-week-review-days">
            {slots.map(s => {
              const minutes = (s.day?.minutesWork || 0) + (s.day?.minutesMeeting || 0) + (s.day?.minutesTravel || 0);
              const f = s.day?.flags || {};
              return (
                <li key={s.date} className="tk-week-review-day">
                  <div className="tk-week-review-day-head">
                    <span className="tk-week-review-day-label">{s.label}</span>
                    <span className="tk-week-review-day-date">{s.date.slice(5)}</span>
                    <span className="tk-week-review-day-total">{fmtHM(minutes)}</span>
                    {f.missing_out      && <span className="tk-week-flag-chip tone-rose"  >missing OUT</span>}
                    {f.overtime_min     && <span className="tk-week-flag-chip tone-blue"  >OT {fmtHM(f.overtime_min)}</span>}
                    {f.untagged_meeting && <span className="tk-week-flag-chip tone-rose"  >untagged gap</span>}
                  </div>
                  <DayTimelineForReview date={s.date} dayData={s.day} userId={userId}/>
                </li>
              );
            })}
          </ul>

          {rejectOpen && (
            <div className="tk-reject-pane">
              <label className="form-label">Reason for return</label>
              <textarea className="form-input" rows={2} value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="e.g. Wed has an open IN with no OUT; please add a correction."/>
              <p className="form-help">The user gets an email with this reason and the week reopens for re-submission.</p>
            </div>
          )}

          {err && <div className="form-error">{err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          {!rejectOpen ? (
            <>
              <button className="btn btn-warn" onClick={() => setRejectOpen(true)} disabled={busy}>
                Return for review…
              </button>
              <button className="btn btn-primary" onClick={approve} disabled={busy}>
                {busy ? "Approving…" : "Approve & lock"}
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={() => { setRejectOpen(false); setReason(""); }} disabled={busy}>
                Back
              </button>
              <button className="btn btn-warn" onClick={reject} disabled={busy || !reason.trim()}>
                {busy ? "Sending…" : "Send back"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Small lazy wrapper so the modal renders fast on open and the per-day intervals
// load when their slot mounts. For the v1 we just lean on the existing day data
// from loadMyWeek (which only carries day rollups) and fetch intervals on demand.
import { loadDayDetail } from "../data";
function DayTimelineForReview({ date, userId }) {
  const [intervals, setIntervals] = useState(null);
  useEffect(() => {
    let live = true;
    loadDayDetail(userId, date).then(d => { if (live) setIntervals(d.intervals || []); });
    return () => { live = false; };
  }, [userId, date]);
  if (intervals === null) return <div className="tk-day-empty">Loading…</div>;
  return <DayTimeline date={date} intervals={intervals} height={20} showHourGrid={false}/>;
}
