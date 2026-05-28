// CorrectionModal — user picks a day, sees their time intervals as blocks,
// and proposes start/end edits per block. Each modified punch generates one
// pending `edit_punch` correction row for the admin to review.

import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import {
  submitCorrection, loadDayDetail, getCurrentBeaconUser,
  fmtClock, todayInCT, TK_CATEGORY_LABEL,
} from "../data";

// Categories a user can attach to an "Away" block. Excludes auto-only labels
// (work / meeting_untagged / eod / vacation / holiday) — those are assigned by
// the classifier or the approval flow, not picked when carving a manual gap.
const AWAY_CATEGORIES = ["lunch", "break", "meeting", "travel", "off"];

export function CorrectionModal({ date: initialDate, onClose, onSubmitted }) {
  const me = getCurrentBeaconUser();

  const [date,       setDate]       = useState(initialDate || todayInCT());
  const [intervals,  setIntervals]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [loadErr,    setLoadErr]    = useState(null);

  // Committed edits per interval:
  //   { [intervalId]: { startLocal: "HH:MM"|null, endLocal: "HH:MM"|null, description: string } }
  const [edits,      setEdits]      = useState({});
  const [expandedId, setExpandedId] = useState(null);
  const [draft,      setDraft]      = useState({ start: "", end: "", description: "" });

  // User-added new blocks (not tied to an existing interval). Each carves a
  // sub-range of the day as Away (out) or Worked (in) and submits as ONE atomic
  // add_interval correction.
  //   each: { id, start: "HH:MM", end: "HH:MM", isOut: bool, category, description }
  const [newBlocks, setNewBlocks] = useState([]);

  const [busy,       setBusy]       = useState(false);
  const [submitErr,  setSubmitErr]  = useState(null);

  useEffect(() => {
    if (!me?.id) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadErr(null);
    setEdits({});
    setExpandedId(null);
    setNewBlocks([]);
    loadDayDetail(me.id, date)
      .then(d => { if (!cancelled) setIntervals(d.intervals || []); })
      .catch(e => { if (!cancelled) setLoadErr(e.message || "failed to load day"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [me?.id, date]);

  const startEdit = (iv) => {
    const e = edits[iv.id] || {};
    setExpandedId(iv.id);
    setDraft({
      start:       e.startLocal  ?? toLocalHHMM(iv.startAt),
      end:         e.endLocal    ?? (iv.endAt ? toLocalHHMM(iv.endAt) : ""),
      description: e.description ?? "",
    });
  };

  const saveEdit = (iv) => {
    const origStart = toLocalHHMM(iv.startAt);
    const origEnd   = iv.endAt ? toLocalHHMM(iv.endAt) : null;
    const startChanged = !!iv.startPunchId && !!draft.start && draft.start !== origStart;
    const endChanged   = !!iv.endPunchId   && !!origEnd     && !!draft.end && draft.end !== origEnd;
    const next = { ...edits };
    if (!startChanged && !endChanged) {
      delete next[iv.id];
    } else {
      next[iv.id] = {
        startLocal:  startChanged ? draft.start : null,
        endLocal:    endChanged   ? draft.end   : null,
        description: draft.description.trim(),
      };
    }
    setEdits(next);
    setExpandedId(null);
  };

  const cancelEdit = () => { setExpandedId(null); setDraft({ start: "", end: "", description: "" }); };

  const clearEdit = (id) => {
    const next = { ...edits };
    delete next[id];
    setEdits(next);
  };

  const addNewBlock = () => {
    // Default to Away/Lunch — the overwhelmingly common case is "I forgot to
    // punch out for lunch," which the user fixes by carving an out block.
    setNewBlocks(b => [...b, {
      id: `new-${Date.now()}-${b.length}`,
      start: "", end: "", isOut: true, category: "lunch", description: "",
    }]);
  };
  const updateNewBlock = (id, patch) => {
    setNewBlocks(b => b.map(x => x.id === id ? { ...x, ...patch } : x));
  };
  const removeNewBlock = (id) => {
    setNewBlocks(b => b.filter(x => x.id !== id));
  };

  const changeCount = useMemo(() => {
    let n = 0;
    for (const e of Object.values(edits)) {
      if (e.startLocal) n++;
      if (e.endLocal)   n++;
    }
    // A new block is one atomic correction; it only counts once it has BOTH
    // ends (a single boundary can't define an interval).
    for (const nb of newBlocks) {
      if (nb.start && nb.end) n++;
    }
    return n;
  }, [edits, newBlocks]);

  const submit = async () => {
    if (changeCount === 0) return;
    setBusy(true); setSubmitErr(null);
    try {
      const tasks = [];
      for (const iv of intervals) {
        const e = edits[iv.id];
        if (!e) continue;
        const desc = (e.description || "").trim();
        const prefix = desc ? `${desc} — ` : "";
        if (e.startLocal && iv.startPunchId) {
          tasks.push(submitCorrection({
            date,
            kind:    "edit_punch",
            payload: { punch_id: iv.startPunchId, punched_at: localToISO(date, e.startLocal) },
            reason:  `${prefix}Edit start of block ${fmtClock(iv.startAt)} → ${fmtLocalHHMM(e.startLocal)}`,
          }));
        }
        if (e.endLocal && iv.endPunchId) {
          tasks.push(submitCorrection({
            date,
            kind:    "edit_punch",
            payload: { punch_id: iv.endPunchId, punched_at: localToISO(date, e.endLocal) },
            reason:  `${prefix}Edit end of block ${fmtClock(iv.endAt)} → ${fmtLocalHHMM(e.endLocal)}`,
          }));
        }
      }
      for (const nb of newBlocks) {
        if (!nb.start || !nb.end) continue;
        const desc = (nb.description || "").trim();
        const prefix = desc ? `${desc} — ` : "";
        const category = nb.isOut ? nb.category : "work";
        const kindLabel = nb.isOut ? "away" : "worked";
        const catLabel = nb.isOut ? ` (${TK_CATEGORY_LABEL[nb.category] || nb.category})` : "";
        tasks.push(submitCorrection({
          date,
          kind:    "add_interval",
          payload: {
            start_at: localToISO(date, nb.start),
            end_at:   localToISO(date, nb.end),
            is_out:   nb.isOut,
            category,
            note:     desc || null,
          },
          reason:  `${prefix}Add ${kindLabel} block ${fmtLocalHHMM(nb.start)} – ${fmtLocalHHMM(nb.end)}${catLabel}`,
        }));
      }
      await Promise.all(tasks);
      onSubmitted?.();
      onClose?.();
    } catch (e) {
      setSubmitErr(e.message || "submission failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal-eyebrow">Timesheet</div>
            <h3 className="modal-title">Request a Correction</h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16}/>
          </button>
        </div>

        <div className="modal-body">
          <div className="form-row">
            <label className="form-label">Day</label>
            <input
              type="date"
              className="form-input tk-correction-date"
              value={date}
              max={todayInCT()}
              onChange={e => setDate(e.target.value || todayInCT())}
            />
            <p className="form-help">
              Your admin will review the request before it lands on your timesheet.
            </p>
          </div>

          <div className="form-row">
            <label className="form-label">Your time blocks</label>
            {loading && <p className="form-help">Loading…</p>}
            {loadErr && <div className="form-error">{loadErr}</div>}
            {!loading && !loadErr && intervals.length === 0 && newBlocks.length === 0 && (
              <p className="form-help">No time blocks on this day. Pick a different day, or click <strong>Add New Time</strong>.</p>
            )}
            {!loading && (intervals.length > 0 || newBlocks.length > 0) && (
              <ul className="tk-correction-blocks">
                {intervals.map(iv => {
                  const e = edits[iv.id];
                  const isExpanded = expandedId === iv.id;
                  return (
                    <li key={iv.id} className={`tk-correction-block${e ? " is-edited" : ""}`}>
                      <div className="tk-correction-block-row">
                        <span className="tk-correction-block-time">
                          {renderTime(iv.startAt, e?.startLocal)}
                          <span className="tk-correction-block-sep">—</span>
                          {iv.endAt
                            ? renderTime(iv.endAt, e?.endLocal)
                            : <em className="tk-correction-block-open">Open</em>}
                        </span>
                        {!isExpanded && (
                          <div className="tk-correction-block-actions">
                            {e && (
                              <button className="btn btn-ghost btn-sm" onClick={() => clearEdit(iv.id)}
                                title="Undo this block's edit">
                                Undo
                              </button>
                            )}
                            <button className="btn btn-ghost btn-sm" onClick={() => startEdit(iv)}>
                              Modify
                            </button>
                          </div>
                        )}
                      </div>
                      {isExpanded && (
                        <div className="tk-correction-block-edit">
                          <label className="tk-correction-block-field">
                            <span className="form-label">Start</span>
                            <input type="time" className="form-input"
                              value={draft.start}
                              disabled={!iv.startPunchId}
                              onChange={evt => setDraft(d => ({ ...d, start: evt.target.value }))}/>
                          </label>
                          <label className="tk-correction-block-field">
                            <span className="form-label">End</span>
                            <input type="time" className="form-input"
                              value={draft.end}
                              disabled={!iv.endPunchId}
                              onChange={evt => setDraft(d => ({ ...d, end: evt.target.value }))}/>
                          </label>
                          <label className="tk-correction-block-field tk-correction-block-field-wide">
                            <span className="form-label">Description</span>
                            <textarea className="form-input" rows={2}
                              placeholder="What were you doing during this block?"
                              value={draft.description}
                              maxLength={400}
                              onChange={evt => setDraft(d => ({ ...d, description: evt.target.value }))}/>
                          </label>
                          <div className="tk-correction-block-edit-actions">
                            <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>Cancel</button>
                            <button className="btn btn-primary btn-sm" onClick={() => saveEdit(iv)}>Save</button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
                {newBlocks.map(nb => (
                  <li key={nb.id} className="tk-correction-block is-new">
                    <div className="tk-correction-block-row">
                      <span className="tk-correction-block-time">
                        <em className="tk-correction-block-open">
                          {nb.isOut ? "Away" : "Worked"} block
                          {nb.start && nb.end
                            ? <> · {fmtLocalHHMM(nb.start)} – {fmtLocalHHMM(nb.end)}</>
                            : null}
                        </em>
                      </span>
                      <div className="tk-correction-block-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => removeNewBlock(nb.id)}>
                          Remove
                        </button>
                      </div>
                    </div>
                    <div className="tk-correction-block-edit">
                      <div className="tk-correction-block-field tk-correction-block-field-wide">
                        <span className="form-label">This block was</span>
                        <div className="tk-presence-toggle" role="group" aria-label="Block type">
                          <button type="button"
                            className={`btn btn-sm ${nb.isOut ? "btn-primary" : "btn-ghost"}`}
                            onClick={() => updateNewBlock(nb.id, { isOut: true })}>
                            Away
                          </button>
                          <button type="button"
                            className={`btn btn-sm ${!nb.isOut ? "btn-primary" : "btn-ghost"}`}
                            onClick={() => updateNewBlock(nb.id, { isOut: false })}>
                            Worked
                          </button>
                        </div>
                      </div>
                      {nb.isOut && (
                        <label className="tk-correction-block-field">
                          <span className="form-label">Reason</span>
                          <select className="form-input"
                            value={nb.category}
                            onChange={evt => updateNewBlock(nb.id, { category: evt.target.value })}>
                            {AWAY_CATEGORIES.map(c => (
                              <option key={c} value={c}>{TK_CATEGORY_LABEL[c] || c}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label className="tk-correction-block-field">
                        <span className="form-label">Start</span>
                        <input type="time" className="form-input"
                          value={nb.start}
                          onChange={evt => updateNewBlock(nb.id, { start: evt.target.value })}/>
                      </label>
                      <label className="tk-correction-block-field">
                        <span className="form-label">End</span>
                        <input type="time" className="form-input"
                          value={nb.end}
                          onChange={evt => updateNewBlock(nb.id, { end: evt.target.value })}/>
                      </label>
                      <label className="tk-correction-block-field tk-correction-block-field-wide">
                        <span className="form-label">Description</span>
                        <textarea className="form-input" rows={2}
                          placeholder={nb.isOut
                            ? "Why were you away during this block?"
                            : "What were you working on during this block?"}
                          value={nb.description}
                          maxLength={400}
                          onChange={evt => updateNewBlock(nb.id, { description: evt.target.value })}/>
                      </label>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {submitErr && <div className="form-error">{submitErr}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <div className="tk-correction-foot-right">
            <button className="btn btn-ghost" onClick={addNewBlock} disabled={busy || loading}>
              Add New Time
            </button>
            <button className="btn btn-primary" onClick={submit} disabled={busy || changeCount === 0}>
              {busy ? "Submitting…" : "Request change"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function renderTime(originalIso, newLocal) {
  if (!newLocal) return <span>{fmtClock(originalIso)}</span>;
  return (
    <span>
      <s className="tk-correction-orig">{fmtClock(originalIso)}</s>
      &nbsp;<strong>{fmtLocalHHMM(newLocal)}</strong>
    </span>
  );
}

function toLocalHHMM(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function localToISO(dateYMD, hhmm) {
  return new Date(`${dateYMD}T${hhmm}:00`).toISOString();
}

function fmtLocalHHMM(hhmm) {
  if (!hhmm) return "";
  const [hStr, mStr] = hhmm.split(":");
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${(mStr || "00").padStart(2, "0")} ${ampm}`;
}
