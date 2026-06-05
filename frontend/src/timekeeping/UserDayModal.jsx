// UserDayModal — the Time Admin "Day editor": a focused, fully-editable canvas
// for one user's day. Opened from the Team range canvas (click a person/cell)
// and from the ReviewRail "Open day" action.
//
// Layout (desktop): a draggable vertical timeline (EditableDayTimeline) on the
// left + a context "inspector" on the right that morphs between three states —
//   • a selected block      → retag (chip grid) · comment · fine-tune times · delete
//   • create mode           → carve a new Worked/Away block
//   • idle                  → legend + gesture tips + Add-block
// A familiar horizontal "day at a glance" bar sits above the canvas. Pending
// corrections for the day and a locked-week notice surface as inline banners so
// the admin can approve / unlock without leaving the canvas.
//
// All edits apply IMMEDIATELY (admin authority) via the data.js admin mutators,
// which write punches/intervals with the admin's JWT and re-derive the day. No
// Edge Function round-trip.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import {
  loadDayDetail, loadWeekLock, loadCorrectionsForDay,
  fmtHM, fmtClock, todayInCT, userById,
  ctMinutesOfIso, ctWallMinToISO,
  TK_CATEGORY_LABEL, TK_CATEGORY_TONE,
  adminEditPunches, adminAddInterval, adminDeleteInterval, adminReclassifyInterval,
  tkUnlockWeek, tkResolveCorrection,
} from "../data";
import { EditableDayTimeline } from "./EditableDayTimeline";
import { DayTimeline } from "./DayTimeline";

const ADMIN_CATEGORIES = [
  ["work", "Working"], ["meeting", "Meeting"], ["travel", "Travel"],
  ["lunch", "Lunch"], ["break", "Break"], ["eod", "Done for day"],
  ["vacation", "Vacation"], ["off", "Off"], ["meeting_untagged", "Untagged"],
];
const AWAY_CATEGORIES = ["lunch", "break", "meeting", "travel", "off", "eod"];

const pad2 = (n) => String(n).padStart(2, "0");
const minToHHMM = (m) => `${pad2(Math.floor(m / 60))}:${pad2(Math.round(m) % 60)}`;
const hhmmToMin = (s) => { const [h, m] = (s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const shiftDay = (iso, d) => { const x = new Date(`${iso}T12:00:00`); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
const fmtLong = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const findByBounds = (list, startISO, endISO) => {
  const ws = +new Date(startISO);
  return (list || []).find((iv) =>
    Math.abs(+new Date(iv.startAt) - ws) < 60000 &&
    (endISO == null ? iv.endAt == null : (iv.endAt && Math.abs(+new Date(iv.endAt) - +new Date(endISO)) < 60000)));
};

export function UserDayModal({ userId, initialDate, onClose, onDirty, selfMode = false }) {
  const [date, setDate] = useState(initialDate || todayInCT());
  const [day, setDay] = useState({ date, intervals: [], punches: [], day: null });
  const [weekLock, setWeekLock] = useState(null);
  const [corrections, setCorrections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("idle");          // idle | edit | create
  const [createDraft, setCreateDraft] = useState(null);
  const [allowLockedEdit, setAllowLockedEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [toast, setToast] = useState(null);

  const user = useMemo(() => userById(userId), [userId]);
  const toastTimer = useRef(null);
  const savingRef = useRef(false);   // in-flight lock (closes the setState gap)
  const flash = (msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true); setErr(null);
    try {
      const [d, wk, corr] = await Promise.all([
        loadDayDetail(userId, date),
        loadWeekLock(userId, date),
        loadCorrectionsForDay(userId, date),
      ]);
      setDay(d); setWeekLock(wk); setCorrections(corr);
    } catch (e) {
      setErr(e.message || "could not load");
    } finally {
      setLoading(false);
    }
  }, [userId, date]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setSelectedId(null); setMode("idle"); setAllowLockedEdit(false); }, [date, userId]);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { if (mode !== "idle" || selectedId) { setMode("idle"); setSelectedId(null); } else onClose?.(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, mode, selectedId]);

  if (!userId) return null;

  const locked = !!weekLock?.locked;
  const editingBlocked = locked && !allowLockedEdit;
  const selected = day.intervals.find((iv) => iv.id === selectedId) || null;
  const isToday = date === todayInCT();

  const minutesWork = day.day?.minutesWork || 0;
  const minutesMeeting = day.day?.minutesMeeting || 0;
  const minutesTravel = day.day?.minutesTravel || 0;
  const minutesUntagged = day.day?.minutesUntagged || 0;

  // ---- actions ----
  const guard = async (fn) => {
    if (editingBlocked) { setActionErr("This week is locked — unlock it (or choose Edit anyway) first."); return; }
    if (savingRef.current) return;          // a write is already in flight
    savingRef.current = true;
    setSaving(true); setActionErr(null);
    try { await fn(); }
    catch (e) { setActionErr(e.message || "action failed"); }
    finally { savingRef.current = false; setSaving(false); }
  };

  const onCommitEdits = (edits) => guard(async () => {
    await adminEditPunches(edits, userId, date);
    await refresh(); onDirty?.(); flash("Times updated");
  });

  const openCreate = (range) => {
    setSelectedId(null);
    setCreateDraft({
      startMin: range?.startMin ?? 12 * 60,
      endMin: range?.endMin ?? 12 * 60 + 30,
      isOut: true,
      category: "lunch",
      note: "",
    });
    setMode("create");
  };

  const submitCreate = () => guard(async () => {
    const { startMin, endMin, isOut, category, note } = createDraft;
    if (endMin - startMin < 5) throw new Error("block must be at least 5 minutes");
    await adminAddInterval({
      userId, date,
      startISO: ctWallMinToISO(date, startMin),
      endISO: ctWallMinToISO(date, endMin),
      isOut, category, note,
    });
    await refresh(); onDirty?.(); setMode("idle"); setCreateDraft(null); flash(isOut ? "Away block added" : "Worked block added");
  });

  const selectInterval = (iv) => { setMode("edit"); setSelectedId(iv.id); setCreateDraft(null); };

  const saveSelected = (draft) => guard(async () => {
    const sel = day.intervals.find((iv) => iv.id === draft.id);
    if (!sel) throw new Error("block no longer exists — reopen it");
    const baseStart = ctMinutesOfIso(sel.startAt);
    const baseEnd = sel.endAt ? ctMinutesOfIso(sel.endAt) : null;
    const newStart = hhmmToMin(draft.start);
    const newEnd = sel.endAt ? hhmmToMin(draft.end) : null;
    if (newEnd != null && newEnd - newStart < 5) throw new Error("end must be at least 5 minutes after start");

    const startChanged = !!sel.startPunchId && newStart !== baseStart;
    const endChanged = !!sel.endPunchId && !!sel.endAt && newEnd !== baseEnd;
    let finalStartISO = sel.startAt, finalEndISO = sel.endAt;
    const edits = [];
    if (startChanged) { finalStartISO = ctWallMinToISO(date, newStart); edits.push({ id: sel.startPunchId, punchedAt: finalStartISO }); }
    if (endChanged) { finalEndISO = ctWallMinToISO(date, newEnd); edits.push({ id: sel.endPunchId, punchedAt: finalEndISO }); }
    if (edits.length) await adminEditPunches(edits, userId, date);

    const catChanged = draft.category !== sel.category;
    const noteChanged = (draft.notes || "") !== (sel.notes || "");
    let relocated = true;
    if (catChanged || noteChanged) {
      let targetId = sel.id;
      if (edits.length) {
        // Punch IDs survive fn_rebuild_user_day (it re-derives intervals from
        // the SAME punches), so re-match on punch id — far more reliable than
        // timestamp bounds, which can collide on shared boundaries.
        const fresh = await loadDayDetail(userId, date);
        const match =
          fresh.intervals.find((iv) => iv.startPunchId && iv.startPunchId === sel.startPunchId) ||
          fresh.intervals.find((iv) => iv.endPunchId && iv.endPunchId === sel.endPunchId) ||
          findByBounds(fresh.intervals, finalStartISO, finalEndISO);
        targetId = match ? match.id : null;
        relocated = !!match;
      }
      if (targetId) {
        await adminReclassifyInterval(targetId, {
          category: draft.category, notes: draft.notes, outlookEventId: sel.outlookEventId,
        }, userId, date);
      }
    }
    await refresh(); onDirty?.(); setMode("idle"); setSelectedId(null);
    flash(relocated ? "Block updated" : "Times saved — reopen the block to retag");
  });

  const deleteSelected = (sel) => guard(async () => {
    await adminDeleteInterval(sel, userId, date);
    await refresh(); onDirty?.(); setMode("idle"); setSelectedId(null); flash("Block deleted");
  });

  const unlockWeek = () => guard(async () => {
    await tkUnlockWeek(userId, weekLock.weekStart);
    await refresh(); onDirty?.(); flash("Week unlocked");
  });

  const resolveCorrection = (c, decision) => guard(async () => {
    await tkResolveCorrection(c.id, decision, null);
    await refresh(); onDirty?.(); flash(decision === "approved" ? "Correction approved" : "Correction rejected");
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal tk-de" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="tk-de-title">

        {/* Header */}
        <header className="tk-de-head">
          <div className="tk-de-id">
            {user && <span className={`avatar sm ${user.color}`}>{user.initials}</span>}
            <div>
              <div className="tk-de-eyebrow">{selfMode ? "My timesheet · Day editor" : "Time Admin · Day editor"}</div>
              <h2 id="tk-de-title" className="tk-de-title">{selfMode ? "My day" : (user?.name || "User")}</h2>
            </div>
          </div>

          <div className="tk-de-nav">
            <button type="button" className="tk-icon-btn" onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day"><Icon name="back" size={14} /></button>
            <input type="date" className="tk-day-input" value={date} max={todayInCT()} onChange={(e) => setDate(e.target.value || todayInCT())} />
            <button type="button" className="tk-icon-btn" onClick={() => setDate(shiftDay(date, +1))} disabled={date >= todayInCT()} aria-label="Next day"><Icon name="forward" size={14} /></button>
            {!isToday && <button type="button" className="tk-pill-btn" onClick={() => setDate(todayInCT())}><Icon name="clock" size={11} /> Today</button>}
          </div>

          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </header>

        <div className="tk-de-subhead">
          <span className="tk-de-date">{fmtLong(date)}</span>
          {loading && <span className="tk-de-loading">refreshing…</span>}
          <span className={`tk-de-weekchip is-${weekLock?.approvalStatus || "open"}`}>
            {locked ? <><Icon name="lock" size={11} /> Locked</> : (weekLock?.approvalStatus === "submitted" ? "Submitted" : "Open")}
          </span>
        </div>

        {/* Stat strip */}
        <div className="tk-de-stats">
          <Stat label="Worked" value={fmtHM(minutesWork, { always: true })} tone="green" big />
          <Stat label="Meetings" value={fmtHM(minutesMeeting, { always: true })} tone="blue" dim={minutesMeeting === 0} />
          <Stat label="Travel" value={fmtHM(minutesTravel, { always: true })} tone="blue" dim={minutesTravel === 0} />
          <Stat label="Untagged" value={fmtHM(minutesUntagged, { always: true })} tone="rose" dim={minutesUntagged === 0} />
          <Stat label="Punches" value={(day.punches || []).length} tone="muted" />
        </div>

        {err && <div className="tk-de-banner is-error"><Icon name="ban" size={13} /> Couldn't load: {err}</div>}

        {/* Pending corrections banner */}
        {corrections.length > 0 && (
          <div className="tk-de-banner is-review">
            <Icon name="bell" size={13} />
            <div className="tk-de-banner-body">
              <strong>{corrections.length} correction request{corrections.length === 1 ? "" : "s"}</strong> for this day from the user.
              <ul className="tk-de-corr-list">
                {corrections.map((c) => (
                  <li key={c.id} className="tk-de-corr">
                    <span className="tk-de-corr-text">{correctionLabel(c)}</span>
                    {c.reason && <span className="tk-de-corr-reason">“{c.reason}”</span>}
                    <span className="tk-de-corr-actions">
                      <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => resolveCorrection(c, "rejected")}>Reject</button>
                      <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => resolveCorrection(c, "approved")}>Approve</button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Locked week banner */}
        {locked && (
          <div className="tk-de-banner is-locked">
            <Icon name="lock" size={13} />
            <div className="tk-de-banner-body">
              This week was approved &amp; locked{weekLock?.approvedAt ? ` on ${new Date(weekLock.approvedAt).toLocaleDateString()}` : ""}. Editing changes the approved record.
            </div>
            <div className="tk-de-banner-actions">
              {!allowLockedEdit && <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setAllowLockedEdit(true)}>Edit anyway</button>}
              <button className="btn btn-warn btn-sm" disabled={saving} onClick={unlockWeek}>Unlock week</button>
            </div>
          </div>
        )}

        {/* Hero glance bar */}
        <div className="tk-de-hero">
          <span className="tk-de-hero-label">Day at a glance</span>
          <div className="tk-de-hero-bar">
            <DayTimeline date={date} intervals={day.intervals} height={28} showHourGrid={false} onIntervalClick={selectInterval} />
          </div>
        </div>

        {/* Canvas + inspector */}
        <div className="tk-de-main">
          <div className="tk-de-canvas">
            <EditableDayTimeline
              date={date}
              intervals={day.intervals}
              selectedId={selectedId}
              disabled={editingBlocked || saving}
              busy={saving}
              onSelectInterval={selectInterval}
              onCommitEdits={onCommitEdits}
              onCreateRange={openCreate}
            />
          </div>

          <aside className="tk-de-inspector">
            {mode === "create" && createDraft ? (
              <CreateForm
                draft={createDraft}
                setDraft={setCreateDraft}
                saving={saving}
                onSubmit={submitCreate}
                onCancel={() => { setMode("idle"); setCreateDraft(null); }}
              />
            ) : selected ? (
              <InspectorEdit
                key={selected.id}
                interval={selected}
                saving={saving}
                onSave={saveSelected}
                onDelete={() => deleteSelected(selected)}
                onClose={() => { setMode("idle"); setSelectedId(null); }}
              />
            ) : (
              <IdlePanel onAdd={() => openCreate(null)} disabled={editingBlocked} />
            )}
            {actionErr && <div className="tk-de-inspector-err"><Icon name="ban" size={12} /> {actionErr}</div>}
          </aside>
        </div>

        <footer className="tk-de-foot">
          <span className="tk-de-foot-note">
            <Icon name="bolt" size={12} /> Edits apply immediately to {selfMode ? "your" : `${user?.name?.split(" ")[0] || "this user"}’s`} timesheet.
          </span>
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </footer>

        {toast && <div className="tk-de-toast"><Icon name="check" size={13} /> {toast}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Stat({ label, value, tone, big, dim }) {
  return (
    <div className={`tk-de-stat tone-${tone} ${dim ? "is-dim" : ""} ${big ? "is-big" : ""}`}>
      <div className="tk-de-stat-label">{label}</div>
      <div className="tk-de-stat-value">{value}</div>
    </div>
  );
}

// ---- Inspector: selected block ----
function InspectorEdit({ interval, saving, onSave, onDelete, onClose }) {
  const [category, setCategory] = useState(interval.category);
  const [notes, setNotes] = useState(interval.notes || "");
  const [start, setStart] = useState(minToHHMM(ctMinutesOfIso(interval.startAt)));
  const [end, setEnd] = useState(interval.endAt ? minToHHMM(ctMinutesOfIso(interval.endAt)) : "");
  const [confirmDel, setConfirmDel] = useState(false);

  const isOpen = interval.endAt == null;
  const presence = interval.isOut ? "Out" : "At desk";

  return (
    <div className="tk-de-insp">
      <header className="tk-de-insp-head">
        <div>
          <div className="tk-de-insp-eyebrow">Selected block</div>
          <div className="tk-de-insp-title">
            {fmtClock(interval.startAt)} – {interval.endAt ? fmtClock(interval.endAt) : "now"}
          </div>
        </div>
        <span className={`tk-de-presence ${interval.isOut ? "is-out" : "is-in"}`}>
          <span className="tk-de-presence-dot" />{presence}
        </span>
        <button type="button" className="tk-icon-btn tk-de-insp-x" onClick={onClose} aria-label="Deselect"><Icon name="x" size={13} /></button>
      </header>

      {interval.outlookEventSubject && (
        <div className="tk-de-insp-outlook"><Icon name="link" size={12} /> {interval.outlookEventSubject}{interval.outlookEventLocation ? ` · ${interval.outlookEventLocation}` : ""}</div>
      )}

      <div className="tk-de-field">
        <span className="tk-de-field-label">Tag</span>
        <div className="tk-de-chips">
          {ADMIN_CATEGORIES.map(([v, l]) => (
            <button key={v} type="button"
              className={`tk-de-chip tone-${TK_CATEGORY_TONE[v] || "muted"} ${category === v ? "is-on" : ""}`}
              onClick={() => setCategory(v)}>
              <span className="tk-de-chip-dot" />{l}
            </button>
          ))}
        </div>
      </div>

      <div className="tk-de-field tk-de-field-times">
        <span className="tk-de-field-label">Times</span>
        <div className="tk-de-time-row">
          <input type="time" className="form-input" value={start} onChange={(e) => setStart(e.target.value)} disabled={!interval.startPunchId} />
          <span className="tk-de-time-arrow">→</span>
          <input type="time" className="form-input" value={end} onChange={(e) => setEnd(e.target.value)} disabled={isOpen || !interval.endPunchId} />
        </div>
        <span className="tk-de-field-hint">{isOpen ? "Open block — end is “now”." : "Or drag the block / its edges on the canvas."}</span>
      </div>

      <div className="tk-de-field">
        <span className="tk-de-field-label">Comment</span>
        <textarea className="form-input" rows={3} maxLength={400} value={notes}
          placeholder="Add a note about this block…" onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="tk-de-insp-foot">
        {!confirmDel ? (
          <button type="button" className="btn btn-ghost tk-de-del" disabled={saving} onClick={() => setConfirmDel(true)}>
            <Icon name="trash" size={13} /> Delete
          </button>
        ) : (
          <div className="tk-de-del-confirm">
            <span>Delete block?</span>
            <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setConfirmDel(false)}>No</button>
            <button type="button" className="btn btn-warn btn-sm" disabled={saving} onClick={onDelete}>Yes, delete</button>
          </div>
        )}
        <button type="button" className="btn btn-primary" disabled={saving}
          onClick={() => onSave({ id: interval.id, category, notes, start, end })}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ---- Inspector: create block ----
function CreateForm({ draft, setDraft, saving, onSubmit, onCancel }) {
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <div className="tk-de-insp">
      <header className="tk-de-insp-head">
        <div>
          <div className="tk-de-insp-eyebrow">Add a block</div>
          <div className="tk-de-insp-title">New time</div>
        </div>
      </header>

      <div className="tk-de-field">
        <span className="tk-de-field-label">This block was</span>
        <div className="tk-de-presence-toggle">
          <button type="button" className={`tk-de-seg ${draft.isOut ? "is-on tone-rose" : ""}`} onClick={() => set({ isOut: true })}>Away</button>
          <button type="button" className={`tk-de-seg ${!draft.isOut ? "is-on tone-green" : ""}`} onClick={() => set({ isOut: false, category: "work" })}>Worked</button>
        </div>
      </div>

      {draft.isOut && (
        <div className="tk-de-field">
          <span className="tk-de-field-label">Tag</span>
          <div className="tk-de-chips">
            {AWAY_CATEGORIES.map((v) => (
              <button key={v} type="button"
                className={`tk-de-chip tone-${TK_CATEGORY_TONE[v] || "muted"} ${draft.category === v ? "is-on" : ""}`}
                onClick={() => set({ category: v })}>
                <span className="tk-de-chip-dot" />{TK_CATEGORY_LABEL[v] || v}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="tk-de-field tk-de-field-times">
        <span className="tk-de-field-label">Times</span>
        <div className="tk-de-time-row">
          <input type="time" className="form-input" value={minToHHMM(draft.startMin)} onChange={(e) => set({ startMin: hhmmToMin(e.target.value) })} />
          <span className="tk-de-time-arrow">→</span>
          <input type="time" className="form-input" value={minToHHMM(draft.endMin)} onChange={(e) => set({ endMin: hhmmToMin(e.target.value) })} />
        </div>
        <span className="tk-de-field-hint">{fmtHM(Math.max(0, draft.endMin - draft.startMin))} block</span>
      </div>

      <div className="tk-de-field">
        <span className="tk-de-field-label">Comment</span>
        <textarea className="form-input" rows={3} maxLength={400} value={draft.note}
          placeholder={draft.isOut ? "Why were they away?" : "What were they working on?"} onChange={(e) => set({ note: e.target.value })} />
      </div>

      <div className="tk-de-insp-foot">
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={saving || draft.endMin - draft.startMin < 5} onClick={onSubmit}>
          {saving ? "Adding…" : "Add block"}
        </button>
      </div>
    </div>
  );
}

// ---- Inspector: idle ----
function IdlePanel({ onAdd, disabled }) {
  return (
    <div className="tk-de-idle">
      <div className="tk-de-idle-legend">
        <span className="tk-de-legend-item"><span className="tk-de-legend-sw tone-green" /> At desk · counts</span>
        <span className="tk-de-legend-item"><span className="tk-de-legend-sw tone-rose" /> Out · never counts</span>
      </div>
      <ul className="tk-de-tips">
        <li><Icon name="sort" size={12} /> Drag a block to move it</li>
        <li><Icon name="columns" size={12} /> Drag a block’s top/bottom edge to resize</li>
        <li><Icon name="plus" size={12} /> Drag an empty area to add a block</li>
        <li><Icon name="edit" size={12} /> Click a block to retag, comment or delete</li>
      </ul>
      <button type="button" className="btn btn-ghost tk-de-idle-add" onClick={onAdd} disabled={disabled}>
        <Icon name="plus" size={14} /> Add a block
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
function correctionLabel(c) {
  const p = c.payload || {};
  if (c.kind === "add_interval") {
    const span = (p.start_at && p.end_at) ? `${fmtClock(p.start_at)} – ${fmtClock(p.end_at)}` : "a block";
    return p.is_out ? `Add away block ${span}` : `Add worked block ${span}`;
  }
  if (c.kind === "add_punch") return `Add a punch${p.punched_at ? ` at ${fmtClock(p.punched_at)}` : ""}`;
  if (c.kind === "edit_punch") return "Edit a punch time";
  if (c.kind === "delete_punch") return "Delete a punch";
  if (c.kind === "reclassify_interval") return "Reclassify a block";
  if (c.kind === "note") return "Add a note";
  return c.kind;
}
