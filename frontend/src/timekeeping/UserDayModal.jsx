// UserDayModal — the Time Admin "Day editor": a focused, fully-editable canvas
// for one user's day. Opened from the Team range canvas (click a person/cell)
// and from the ReviewRail "Open day" action.
//
// Layout (lg and up): a vertical timeline (EditableDayTimeline) on the left +
// a context "inspector" on the right that morphs between three states —
//   • a selected block      → retag (chip grid) · comment · fine-tune times · delete
//   • create mode           → carve a new Worked/Away block
//   • idle                  → legend + gesture tips + Add-block
// Below lg the inspector falls in under the canvas inside the dialog's single
// scroll region, so nothing overlaps and everything stays reachable.
//
// A familiar horizontal "day at a glance" bar sits above the canvas. Pending
// corrections for the day and a locked-week notice surface as inline banners so
// the admin can approve / unlock without leaving the canvas.
//
// All edits apply IMMEDIATELY (admin authority) via the data.js admin mutators,
// which write punches/intervals with the admin's JWT and re-derive the day. No
// Edge Function round-trip.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "@/icons";
import {
  Alert, AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
  Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, Textarea, TooltipProvider,
} from "@/ui";
import {
  loadDayDetail, loadWeekLock, loadCorrectionsForDay,
  fmtHM, fmtClock, todayInCT, userById,
  ctMinutesOfIso, ctWallMinToISO,
  TK_CATEGORY_LABEL, TK_CATEGORY_TONE,
  adminAddInterval, adminDeleteInterval, saveTimeBlock,
  tkUnlockWeek, tkResolveCorrection,
} from "../data";
import { EditableDayTimeline } from "./EditableDayTimeline";
import { DayTimeline } from "./DayTimeline";

const ADMIN_CATEGORIES = [
  ["work", "Working"], ["meeting", "Meeting"], ["travel", "Site visit"],
  ["lunch", "Lunch"], ["break", "Break"], ["eod", "Done for day"],
  ["vacation", "Vacation"], ["off", "Off"], ["meeting_untagged", "Untagged"],
];
const AWAY_CATEGORIES = ["lunch", "break", "meeting", "travel", "off", "eod"];

const pad2 = (n) => String(n).padStart(2, "0");
const minToHHMM = (m) => `${pad2(Math.floor(m / 60))}:${pad2(Math.round(m) % 60)}`;
const hhmmToMin = (s) => { const [h, m] = (s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const shiftDay = (iso, d) => { const x = new Date(`${iso}T12:00:00`); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
const fmtLong = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

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
  // The inspector has actionable content (edit or create) — drives the emphasis
  // treatment on the inspector column.
  const inspectorActive = (mode === "create" && !!createDraft) || !!selected;

  const minutesWork = day.day?.minutesWork || 0;
  const minutesMeeting = day.day?.minutesMeeting || 0;
  const minutesTravel = day.day?.minutesTravel || 0;
  const minutesUntagged = day.day?.minutesUntagged || 0;

  // ---- actions ----
  const guard = async (fn) => {
    if (editingBlocked) { setActionErr("This week is locked. Unlock it (or choose Edit anyway) first."); return; }
    if (savingRef.current) return;          // a write is already in flight
    savingRef.current = true;
    setSaving(true); setActionErr(null);
    try { await fn(); }
    catch (e) { setActionErr(e.message || "action failed"); }
    finally { savingRef.current = false; setSaving(false); }
  };

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

  // The punch-edit → re-derive → re-match → reclassify sequence lives in
  // data.js `saveTimeBlock`, shared with the Timesheet's block popover so the
  // two editors of the same object can't drift apart.
  const saveSelected = (draft) => guard(async () => {
    const sel = day.intervals.find((iv) => iv.id === draft.id);
    if (!sel) throw new Error("block no longer exists, reopen it");
    const { relocated } = await saveTimeBlock({
      interval: sel, userId, date,
      startMin: hhmmToMin(draft.start),
      endMin:   sel.endAt ? hhmmToMin(draft.end) : null,
      category: draft.category,
      notes:    draft.notes,
      // Self-service edits are the user's own, even though this editor is
      // shared with Time Admin — provenance should say who actually changed it.
      source:   selfMode ? "user" : "admin",
    });
    await refresh(); onDirty?.(); setMode("idle"); setSelectedId(null);
    flash(relocated ? "Block updated" : "Times saved, reopen the block to retag");
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

  const weekState = locked ? "locked" : (weekLock?.approvalStatus === "submitted" ? "submitted" : "open");

  return (
    <TooltipProvider delayDuration={280}>
      <Dialog open onOpenChange={(o) => { if (!o) onClose?.(); }}>
        <DialogContent
          size="full"
          className="tka-de"
          // The component keeps its own Escape handling: the first press drops
          // the inspector back to idle, the second closes the editor.
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader className="tka-de-head gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="tka-de-id">
              {user && <span className={`avatar sm ${user.color}`}>{user.initials}</span>}
              <div className="min-w-0">
                <p className="tka-eyebrow">{selfMode ? "My timesheet · Day editor" : "Time Admin · Day editor"}</p>
                <DialogTitle className="truncate">{selfMode ? "My day" : (user?.name || "User")}</DialogTitle>
              </div>
            </div>

            <DialogDescription className="sr-only">
              Edit punches, tags and comments for the selected day. Changes apply immediately.
            </DialogDescription>

            <div className="tka-de-nav">
              <Button variant="default" size="icon-sm" onClick={() => setDate(shiftDay(date, -1))} aria-label="Previous day">
                <Icon name="back" size={14}/>
              </Button>
              <input
                type="date"
                className="tka-dateinput"
                aria-label="Day editor date"
                value={date}
                max={todayInCT()}
                onChange={(e) => setDate(e.target.value || todayInCT())}
              />
              <Button
                variant="default"
                size="icon-sm"
                onClick={() => setDate(shiftDay(date, +1))}
                disabled={date >= todayInCT()}
                aria-label="Next day"
              >
                <Icon name="forward" size={14}/>
              </Button>
              {!isToday && (
                <Button variant="subtle" size="xs" onClick={() => setDate(todayInCT())}>
                  <Icon name="clock" size={12}/> Today
                </Button>
              )}
            </div>
          </DialogHeader>

          <DialogBody className="tka-de-body">
            <div className="tka-de-subhead">
              <span className="tka-de-date num">{fmtLong(date)}</span>
              {loading && <span className="tka-de-loading" role="status">refreshing</span>}
              <Badge
                tone={weekState === "locked" ? "danger" : weekState === "submitted" ? "brand" : "neutral"}
                size="sm"
              >
                <Icon name={weekState === "locked" ? "lock" : weekState === "submitted" ? "hourglass" : "dot"} size={11}/>
                {weekState === "locked" ? "Locked" : weekState === "submitted" ? "Submitted" : "Open"}
              </Badge>
            </div>

            {/* Stat strip */}
            <div className="tka-de-stats">
              <Stat label="Worked" value={fmtHM(minutesWork, { always: true })} tone="sage" big />
              <Stat label="Meetings" value={fmtHM(minutesMeeting, { always: true })} tone="blue" dim={minutesMeeting === 0} />
              <Stat label="Site visits" value={fmtHM(minutesTravel, { always: true })} tone="blue" dim={minutesTravel === 0} />
              <Stat label="Untagged" value={fmtHM(minutesUntagged, { always: true })} tone="rose" dim={minutesUntagged === 0} />
              <Stat label="Punches" value={(day.punches || []).length} tone="muted" />
            </div>

            {err && <Alert tone="danger" title="Could not load this day">{err}</Alert>}

            {/* Pending corrections banner */}
            {corrections.length > 0 && (
              <Alert
                tone="warning"
                icon={null}
                title={`${corrections.length} correction request${corrections.length === 1 ? "" : "s"} for this day`}
              >
                <ul className="tka-de-corrlist">
                  {corrections.map((c) => (
                    <li key={c.id} className="tka-de-corr">
                      <span className="tka-de-corr-text">{correctionLabel(c)}</span>
                      {c.reason && <span className="tka-de-corr-reason">{c.reason}</span>}
                      <span className="tka-de-corr-actions">
                        <Button variant="destructive-soft" size="sm" disabled={saving} onClick={() => resolveCorrection(c, "rejected")}>Reject</Button>
                        <Button variant="primary" size="sm" disabled={saving} onClick={() => resolveCorrection(c, "approved")}>Approve</Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </Alert>
            )}

            {/* Locked week banner */}
            {locked && (
              <Alert tone="danger" icon={null} title="This week was approved and locked" className="tka-de-lockbanner">
                <p className="m-0">
                  <Icon name="lock" size={12}/>{" "}
                  Locked{weekLock?.approvedAt ? ` on ${new Date(weekLock.approvedAt).toLocaleDateString()}` : ""}.
                  Editing changes the approved record.
                </p>
                <div className="tka-de-banner-actions">
                  {!allowLockedEdit && (
                    <Button variant="ghost" size="sm" disabled={saving} onClick={() => setAllowLockedEdit(true)}>Edit anyway</Button>
                  )}
                  <Button variant="destructive" size="sm" disabled={saving} onClick={unlockWeek}>Unlock week</Button>
                </div>
              </Alert>
            )}

            {/* Hero glance bar */}
            <div className="tka-de-hero">
              <span className="tka-eyebrow">Day at a glance</span>
              <div className="tka-de-herobar">
                <DayTimeline
                  date={date} intervals={day.intervals} height={28} showHourGrid={false}
                  onIntervalClick={selectInterval}
                  actionHint="Select this block."
                  // The editable canvas below is the same day, selectable.
                  focusable={false}
                />
              </div>
            </div>

            {/* Canvas + inspector */}
            <div className="tka-de-main">
              <div className="tka-de-canvas">
                <EditableDayTimeline
                  date={date}
                  intervals={day.intervals}
                  selectedId={selectedId}
                  disabled={editingBlocked || saving}
                  busy={saving}
                  onSelectInterval={selectInterval}
                />
              </div>

              <aside className={`tka-de-inspector ${inspectorActive ? "is-active" : "is-idle"}`} aria-label="Block inspector">
                {mode === "create" && createDraft ? (
                  <CreateForm
                    draft={createDraft}
                    setDraft={setCreateDraft}
                    saving={saving}
                    selfMode={selfMode}
                    onSubmit={submitCreate}
                    onCancel={() => { setMode("idle"); setCreateDraft(null); }}
                  />
                ) : selected ? (
                  <InspectorEdit
                    key={selected.id}
                    interval={selected}
                    saving={saving}
                    selfMode={selfMode}
                    onSave={saveSelected}
                    onDelete={() => deleteSelected(selected)}
                    onClose={() => { setMode("idle"); setSelectedId(null); }}
                  />
                ) : (
                  <IdlePanel onAdd={() => openCreate(null)} disabled={editingBlocked} selfMode={selfMode} />
                )}
                {actionErr && <Alert tone="danger" className="mt-2">{actionErr}</Alert>}
              </aside>
            </div>
          </DialogBody>

          <DialogFooter className="tka-de-foot sm:justify-between">
            <Button variant="default" onClick={() => openCreate(null)} disabled={editingBlocked}>
              <Icon name="plus" size={15}/> Add block
            </Button>
            <span className="tka-de-footnote">
              <Icon name="bolt" size={12}/>
              Edits apply immediately to {selfMode ? "your" : `${user?.name?.split(" ")[0] || "this user"}’s`} timesheet.
            </span>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </DialogFooter>

          {toast && (
            <div className="tka-de-toast" role="status">
              <Icon name="check" size={13}/> {toast}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
function Stat({ label, value, tone, big, dim }) {
  return (
    <div className={`tka-de-stat tone-${tone} ${dim ? "is-dim" : ""} ${big ? "is-big" : ""}`}>
      <span className="tka-de-stat-label">{label}</span>
      <span className="tka-de-stat-value num">{value}</span>
    </div>
  );
}

// ---- Inspector: selected block ----
function InspectorEdit({ interval, saving, selfMode = false, onSave, onDelete, onClose }) {
  const [category, setCategory] = useState(interval.category);
  const [notes, setNotes] = useState(interval.notes || "");
  const [start, setStart] = useState(minToHHMM(ctMinutesOfIso(interval.startAt)));
  const [end, setEnd] = useState(interval.endAt ? minToHHMM(ctMinutesOfIso(interval.endAt)) : "");
  const [confirmDel, setConfirmDel] = useState(false);
  const id = useId();

  const isOpen = interval.endAt == null;
  const presence = interval.isOut ? "Out" : "At desk";
  const startId = `${id}-start`;
  const endId = `${id}-end`;
  const notesId = `${id}-notes`;

  return (
    <div className="tka-insp">
      <header className="tka-insp-head">
        <div className="min-w-0">
          <p className="tka-eyebrow">Selected block</p>
          <p className="tka-insp-title num">
            {fmtClock(interval.startAt)} – {interval.endAt ? fmtClock(interval.endAt) : "now"}
          </p>
        </div>
        <Badge tone={interval.isOut ? "danger" : "success"} size="sm" dot>{presence}</Badge>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Deselect block">
          <Icon name="x" size={14}/>
        </Button>
      </header>

      {interval.outlookEventSubject && (
        <p className="tka-insp-outlook">
          <Icon name="link" size={12}/>
          {interval.outlookEventSubject}{interval.outlookEventLocation ? ` · ${interval.outlookEventLocation}` : ""}
        </p>
      )}

      <fieldset className="tka-insp-field">
        <legend className="tka-insp-label">Tag</legend>
        <div className="tka-chips" role="group" aria-label="Time block tag">
          {ADMIN_CATEGORIES.map(([v, l]) => (
            <button key={v} type="button"
              className={`tka-chip tone-${TK_CATEGORY_TONE[v] || "muted"} ${category === v ? "is-on" : ""}`}
              aria-pressed={category === v}
              onClick={() => setCategory(v)}>
              <span className="tka-chip-dot" aria-hidden="true"/>{l}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="tka-insp-field">
        <span className="tka-insp-label" id={`${id}-timeslabel`}>Times</span>
        <div className="tka-insp-times" role="group" aria-labelledby={`${id}-timeslabel`}>
          <label className="sr-only" htmlFor={startId}>Start time</label>
          <input id={startId} type="time" className="tka-dateinput num" value={start} onChange={(e) => setStart(e.target.value)} disabled={!interval.startPunchId} aria-label="Start time" />
          <Icon name="forward" size={13} className="tka-insp-arrow"/>
          <label className="sr-only" htmlFor={endId}>End time</label>
          <input
            id={endId}
            type="time"
            className="tka-dateinput num"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            disabled={isOpen || !interval.endPunchId}
            aria-label={isOpen ? "End time, open block ending now" : "End time"}
            title={isOpen ? "Open block ends at now" : "End time"}
          />
        </div>
        <p className="tka-insp-hint">
          {isOpen ? "Open block, so the end is now." : "Edit the start / end times, then Save changes."}
        </p>
      </div>

      <div className="tka-insp-field">
        <label className="tka-insp-label" htmlFor={notesId}>Comment</label>
        <Textarea id={notesId} rows={3} maxLength={400} value={notes}
          placeholder="Add a note about this block" onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="tka-insp-foot">
        <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive-soft" size="sm" disabled={saving}>
              <Icon name="trash" size={14}/> Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this block?</AlertDialogTitle>
              <AlertDialogDescription>
                The punches behind {fmtClock(interval.startAt)} to {interval.endAt ? fmtClock(interval.endAt) : "now"} are
                removed and {selfMode ? "your" : "the user's"} day is re-derived. This cannot be undone from here.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>Keep block</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={saving} onClick={onDelete}>
                Yes, delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Button variant="primary" disabled={saving} loading={saving}
          onClick={() => onSave({ id: interval.id, category, notes, start, end })}>
          {saving ? "Saving" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ---- Inspector: create block ----
function CreateForm({ draft, setDraft, saving, selfMode = false, onSubmit, onCancel }) {
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const id = useId();
  const startId = `${id}-new-start`;
  const endId = `${id}-new-end`;
  const noteId = `${id}-new-note`;
  return (
    <div className="tka-insp">
      <header className="tka-insp-head">
        <div className="min-w-0">
          <p className="tka-eyebrow">Add a block</p>
          <p className="tka-insp-title">New time</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onCancel} aria-label="Cancel new block">
          <Icon name="x" size={14}/>
        </Button>
      </header>

      <fieldset className="tka-insp-field">
        <legend className="tka-insp-label">This block was</legend>
        <div className="tka-seg" role="group" aria-label="Block type">
          <button type="button" className={`tka-seg-btn ${draft.isOut ? "is-on tone-rose" : ""}`} aria-pressed={draft.isOut} onClick={() => set({ isOut: true })}>Away</button>
          <button type="button" className={`tka-seg-btn ${!draft.isOut ? "is-on tone-sage" : ""}`} aria-pressed={!draft.isOut} onClick={() => set({ isOut: false, category: "work" })}>Worked</button>
        </div>
      </fieldset>

      {draft.isOut && (
        <fieldset className="tka-insp-field">
          <legend className="tka-insp-label">Tag</legend>
          <div className="tka-chips" role="group" aria-label="Away block tag">
            {AWAY_CATEGORIES.map((v) => (
              <button key={v} type="button"
                className={`tka-chip tone-${TK_CATEGORY_TONE[v] || "muted"} ${draft.category === v ? "is-on" : ""}`}
                aria-pressed={draft.category === v}
                onClick={() => set({ category: v })}>
                <span className="tka-chip-dot" aria-hidden="true"/>{TK_CATEGORY_LABEL[v] || v}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <div className="tka-insp-field">
        <span className="tka-insp-label" id={`${id}-newtimes`}>Times</span>
        <div className="tka-insp-times" role="group" aria-labelledby={`${id}-newtimes`}>
          <label className="sr-only" htmlFor={startId}>Start time</label>
          <input id={startId} type="time" className="tka-dateinput num" value={minToHHMM(draft.startMin)} onChange={(e) => set({ startMin: hhmmToMin(e.target.value) })} aria-label="Start time" />
          <Icon name="forward" size={13} className="tka-insp-arrow"/>
          <label className="sr-only" htmlFor={endId}>End time</label>
          <input id={endId} type="time" className="tka-dateinput num" value={minToHHMM(draft.endMin)} onChange={(e) => set({ endMin: hhmmToMin(e.target.value) })} aria-label="End time" />
        </div>
        <p className="tka-insp-hint num">{fmtHM(Math.max(0, draft.endMin - draft.startMin))} block</p>
      </div>

      <div className="tka-insp-field">
        <label className="tka-insp-label" htmlFor={noteId}>Comment</label>
        <Textarea id={noteId} rows={3} maxLength={400} value={draft.note}
          placeholder={draft.isOut ? (selfMode ? "Why were you away?" : "Why were they away?") : (selfMode ? "What were you working on?" : "What were they working on?")} onChange={(e) => set({ note: e.target.value })} />
      </div>

      <div className="tka-insp-foot">
        <Button variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={saving || draft.endMin - draft.startMin < 5} loading={saving} onClick={onSubmit}>
          {saving ? "Adding" : "Add block"}
        </Button>
      </div>
    </div>
  );
}

// ---- Inspector: idle ----
function IdlePanel({ onAdd, disabled, selfMode = false }) {
  return (
    <div className={`tka-idle ${selfMode ? "is-self" : ""}`}>
      <div className="tka-idle-legend">
        <span className="tka-idle-legenditem">
          <span className="tka-swatch tone-sage" aria-hidden="true"/> At desk, counts toward worked time
        </span>
        <span className="tka-idle-legenditem">
          <span className="tka-swatch tone-rose" aria-hidden="true"/> Out, never counts
        </span>
      </div>
      <ul className="tka-idle-tips">
        <li><Icon name="edit" size={13}/> Select a block to edit its times, tag, or note</li>
        <li><Icon name="clock" size={13}/> Set the start and end in the time fields, then Save</li>
        <li><Icon name="plus" size={13}/> Use Add block to enter time that is missing</li>
      </ul>
      <Button variant="default" onClick={onAdd} disabled={disabled} block>
        <Icon name="plus" size={15}/> Add a block
      </Button>
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
