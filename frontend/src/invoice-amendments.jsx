import React, { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.jsx";
import {
  fmtMoney,
  userById,
  createAmendment,
  updateAmendment,
  deleteAmendment,
  uploadAmendmentFile,
  deleteAmendmentFile,
  amendmentFileUrl,
} from "./data.js";
import { amendmentsTotal, contractValue, contractBreakdown } from "./invoice-amendments.js";

// ============================================================================
// Contract AMENDMENTS — modal + breakdown popover.
//
// An amendment is one attachment + one dollar amount + one note. A line's
// Contract Value = contract amount + Σ amendments, and that amended figure is
// what the whole Invoice page reads (see invoice-amendments.js).
//
// AmendmentsModal manages the set for ONE line — either a project (the Total
// Contract Value) or one sub. ContractBreakdownPopover is the small anchored
// panel the ⤢ glyph in a Contract Value cell opens.
// ============================================================================

// Exact, human stamp — matches invoice-notes-thread.jsx's noteStamp so the two
// logs read identically.
function stamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// Open an amendment's attachment in a new tab via a short-lived signed URL.
// The bucket is private, so there is no durable public link to render.
async function openAttachment(filePath, onError) {
  try {
    const url = await amendmentFileUrl(filePath);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  } catch (e) {
    onError?.(e?.message || "Couldn't open the attachment.");
  }
}

// ---------------------------------------------------------------------------
// The editor row used both for "add new" and for editing an existing amendment.
// Three fields, always in the same order: attachment · amount · notes.
// ---------------------------------------------------------------------------
function AmendmentForm({ value, onChange, onSubmit, onCancel, busy, submitLabel, autoFocus }) {
  const fileInputRef = useRef(null);
  const amountRef = useRef(null);

  useEffect(() => {
    if (autoFocus) amountRef.current?.focus();
  }, [autoFocus]);

  const pickFile = (e) => {
    const f = e.target.files?.[0] || null;
    if (f) onChange({ ...value, file: f, fileName: f.name, filePath: value.filePath, removeFile: false });
    e.target.value = "";   // let the same file be re-picked after a remove
  };

  // A staged File (not yet uploaded) wins over an already-persisted attachment.
  const shownName = value.file?.name || (value.removeFile ? null : value.fileName);

  return (
    <div className="amd-form">
      <div className="amd-form-grid">
        {/* 1 · Attachment */}
        <label className="amd-field">
          <span className="amd-field-label">Attachment</span>
          {shownName ? (
            <div className="amd-file-chip" title={shownName}>
              <Icon name="attachment" size={12}/>
              <span className="amd-file-name">{shownName}</span>
              <button
                type="button"
                className="amd-file-x"
                title="Remove this attachment"
                onClick={() => onChange({ ...value, file: null, fileName: null, removeFile: true })}>
                <Icon name="x" size={11}/>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn sm amd-file-pick"
              onClick={() => fileInputRef.current?.click()}>
              <Icon name="upload" size={12}/> Choose file
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: "none" }}
            onChange={pickFile}
          />
        </label>

        {/* 2 · Amount */}
        <label className="amd-field amd-field-amount">
          <span className="amd-field-label">Amount</span>
          <div className="amd-money-input">
            <span className="amd-money-sign">$</span>
            <input
              ref={amountRef}
              className="input mono"
              type="number"
              step="0.01"
              inputMode="decimal"
              placeholder="0.00"
              value={value.amount}
              onChange={(e) => onChange({ ...value, amount: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
              }}
            />
          </div>
        </label>
      </div>

      {/* 3 · Notes */}
      <label className="amd-field">
        <span className="amd-field-label">Notes</span>
        <textarea
          className="input amd-notes-input"
          placeholder="What changed, and why — scope added, rate change, extension…"
          value={value.notes}
          onChange={(e) => onChange({ ...value, notes: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
          }}
        />
      </label>

      <div className="amd-form-foot">
        <span className="note-modal-hint"><kbd>⌘</kbd><kbd>↵</kbd> to save</span>
        <div className="amd-form-actions">
          {onCancel && (
            <button className="btn sm" onClick={onCancel} disabled={busy}>Cancel</button>
          )}
          <button className="btn primary sm" onClick={onSubmit} disabled={busy}>
            <Icon name="check" size={12}/> {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const EMPTY_DRAFT = { amount: "", notes: "", file: null, fileName: null, filePath: null, removeFile: false };

/**
 * AmendmentsModal — manage every amendment on one line.
 *
 * meta = {
 *   scope,        // { invoiceId } | { projectId, companyId, kind }
 *   scopeId,      // stable id used for the storage path
 *   title,        // line name, e.g. the project or sub firm
 *   subtitle,     // "Project total" / "Sub · Discipline"
 *   baseAmount,   // the stored contract amount this line amends
 *   baseLabel,    // what that base is called on this line
 *   list,         // already-loaded amendments (instant first paint)
 * }
 *
 * onChanged(list) is called after every successful mutation so the caller can
 * refresh its own state — the Contract Value must move the moment this closes.
 */
export function AmendmentsModal({ meta, onClose, onChanged }) {
  const [list, setList] = useState(meta.list || []);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [adding, setAdding] = useState((meta.list || []).length === 0);

  const setBoth = (next) => { setList(next); onChanged?.(next); };

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const total = amendmentsTotal(list);
  const value = contractValue(meta.baseAmount, list);

  // Resolve the staged file for a draft into { filePath, fileName } columns.
  // Uploads before the row write so a failed upload can't leave a row whose
  // attachment silently never arrived.
  const resolveFile = async (d, existing) => {
    if (d.file) {
      const up = await uploadAmendmentFile({ scopeId: meta.scopeId, file: d.file });
      // Replacing an attachment: drop the old binary once the new one is up.
      if (existing?.filePath) {
        try { await deleteAmendmentFile(existing.filePath); } catch { /* orphan blob is survivable */ }
      }
      return { filePath: up.filePath, fileName: up.fileName };
    }
    if (d.removeFile) {
      if (existing?.filePath) {
        try { await deleteAmendmentFile(existing.filePath); } catch { /* as above */ }
      }
      return { filePath: null, fileName: null };
    }
    return {};
  };

  const add = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const fileCols = await resolveFile(draft, null);
      const row = await createAmendment(meta.scope, {
        amount: draft.amount,
        notes: draft.notes,
        ...fileCols,
      });
      setBoth([...list, row]);
      setDraft(EMPTY_DRAFT);
      setAdding(false);
    } catch (e) {
      setError(e?.message || "Couldn't save the amendment.");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (busy || !editingId) return;
    setBusy(true); setError("");
    try {
      const existing = list.find(a => a.id === editingId);
      const fileCols = await resolveFile(editDraft, existing);
      const row = await updateAmendment(editingId, {
        amount: editDraft.amount,
        notes: editDraft.notes,
        ...fileCols,
      });
      setBoth(list.map(a => (a.id === editingId ? row : a)));
      setEditingId(null);
    } catch (e) {
      setError(e?.message || "Couldn't save the change.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (am) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await deleteAmendment(am.id, am.filePath);
      setBoth(list.filter(a => a.id !== am.id));
      setPendingDelete(null);
    } catch (e) {
      setError(e?.message || "Couldn't delete the amendment.");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (am) => {
    setEditingId(am.id);
    setEditDraft({
      amount: am.amount ?? "",
      notes: am.notes || "",
      file: null,
      fileName: am.fileName,
      filePath: am.filePath,
      removeFile: false,
    });
  };

  return createPortal(
    <>
      <div className="overlay" onClick={onClose}/>
      <div className="modal amd-modal" style={{ width: 580 }} role="dialog" aria-modal="true"
           aria-labelledby="amd-title">
        <div className="modal-head">
          <div className="note-modal-badge sage"><Icon name="file" size={15}/></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="drawer-eyebrow" style={{ marginBottom: 2 }}>
              Contract amendments{list.length ? ` · ${list.length}` : ""}
            </div>
            <h3 className="drawer-title note-modal-name" id="amd-title" title={meta.title}>
              {meta.title || "Project"}
            </h3>
            {meta.subtitle && <div className="amd-subtitle">{meta.subtitle}</div>}
          </div>
          <button className="drawer-close" onClick={onClose} title="Close"><Icon name="x" size={16}/></button>
        </div>

        <div className="modal-body amd-body">
          {/* Running total — the whole point of the screen, so it sits up top
              and updates the instant an amendment lands. */}
          <div className="amd-summary">
            <div className="amd-summary-line">
              <span>{meta.baseLabel || "Contract amount"}</span>
              <span className="mono num">{fmtMoney(meta.baseAmount || 0)}</span>
            </div>
            <div className={"amd-summary-line" + (total ? " has-value" : "")}>
              <span>Amendments{list.length ? ` (${list.length})` : ""}</span>
              <span className="mono num">{total >= 0 ? "+" : "−"}{fmtMoney(Math.abs(total))}</span>
            </div>
            <div className="amd-summary-line amd-summary-total">
              <span>Contract Value</span>
              <span className="mono num">{fmtMoney(value)}</span>
            </div>
          </div>

          {error && <div className="notes-thread-error"><Icon name="warn" size={12}/> {error}</div>}

          {/* Existing amendments, oldest first so the numbering matches the
              breakdown popover and never renumbers as new ones are added. */}
          <div className="amd-list">
            {list.length === 0 && !adding && (
              <div className="notes-thread-empty">
                <Icon name="file" size={22}/>
                <span>No amendments yet</span>
                <small>Add one to raise this line's Contract Value.</small>
              </div>
            )}
            {list.map((am, i) => {
              const u = userById(am.createdBy);
              const editing = editingId === am.id;
              const confirming = pendingDelete === am.id;
              return (
                <div key={am.id} className={"amd-entry" + (editing ? " editing" : "")}>
                  <div className="amd-entry-head">
                    <span className="amd-entry-no mono">#{i + 1}</span>
                    <span className="amd-entry-amount mono num">
                      {am.amount >= 0 ? "+" : "−"}{fmtMoney(Math.abs(am.amount))}
                    </span>
                    <span className="amd-entry-meta">
                      {u?.name ? `${u.name} · ` : ""}{stamp(am.createdAt)}
                    </span>
                    {!editing && (
                      <span className="amd-entry-actions">
                        <button className="row-btn" title="Edit this amendment"
                                onClick={() => startEdit(am)}>
                          <Icon name="edit" size={12}/>
                        </button>
                        <button className="row-btn" title="Delete this amendment"
                                style={{ color: "var(--rose)" }}
                                onClick={() => setPendingDelete(am.id)}>
                          <Icon name="trash" size={12}/>
                        </button>
                      </span>
                    )}
                  </div>

                  {editing ? (
                    <AmendmentForm
                      value={editDraft}
                      onChange={setEditDraft}
                      onSubmit={saveEdit}
                      onCancel={() => setEditingId(null)}
                      busy={busy}
                      submitLabel="Save changes"
                      autoFocus
                    />
                  ) : (
                    <>
                      {am.notes && <div className="amd-entry-notes">{am.notes}</div>}
                      {am.filePath ? (
                        <button
                          type="button"
                          className="amd-entry-file"
                          title={`Open ${am.fileName || "attachment"}`}
                          onClick={() => openAttachment(am.filePath, setError)}>
                          <Icon name="attachment" size={11}/>
                          <span className="amd-file-name">{am.fileName || "Attachment"}</span>
                          <Icon name="external" size={10}/>
                        </button>
                      ) : (
                        <div className="amd-entry-nofile">No attachment</div>
                      )}
                      {confirming && (
                        <div className="amd-confirm">
                          <span>Delete amendment #{i + 1}? This lowers the Contract Value by {fmtMoney(Math.abs(am.amount))}.</span>
                          <div className="amd-form-actions">
                            <button className="btn sm" onClick={() => setPendingDelete(null)} disabled={busy}>Cancel</button>
                            <button className="btn sm danger" onClick={() => remove(am)} disabled={busy}>
                              {busy ? "Deleting…" : "Delete"}
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add */}
          {adding ? (
            <div className="amd-add-panel">
              <div className="amd-add-title">New amendment</div>
              <AmendmentForm
                value={draft}
                onChange={setDraft}
                onSubmit={add}
                onCancel={list.length ? () => { setAdding(false); setDraft(EMPTY_DRAFT); } : null}
                busy={busy}
                submitLabel="Add amendment"
                autoFocus
              />
            </div>
          ) : (
            <button className="btn sm amd-add-btn" onClick={() => setAdding(true)}>
              <Icon name="plus" size={12}/> Add amendment
            </button>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * ContractBreakdownPopover — the panel behind the ⤢ glyph in a Contract Value
 * cell. Original contract amount, every amendment, then the total.
 *
 * Body-portalled and positioned from the trigger's rect, because the cell lives
 * inside the invoice table's `overflow` scroll containers — an absolutely
 * positioned child would be clipped by them.
 */
export function ContractBreakdownPopover({ anchorRect, meta, onClose, onManage }) {
  const ref = useRef(null);
  const breakdown = useMemo(
    () => contractBreakdown(meta.baseAmount, meta.list),
    [meta.baseAmount, meta.list],
  );

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    window.addEventListener("keydown", onKey);
    // `capture` so the close beats any row/cell click handler underneath.
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  if (!anchorRect) return null;

  // Clamp into the viewport so a cell near the right/bottom edge still shows
  // the whole panel.
  const W = 290;
  const left = Math.max(8, Math.min(anchorRect.left - W + anchorRect.width, window.innerWidth - W - 8));
  const openUp = anchorRect.bottom + 260 > window.innerHeight;
  const style = openUp
    ? { left, bottom: Math.max(8, window.innerHeight - anchorRect.top + 6), width: W }
    : { left, top: anchorRect.bottom + 6, width: W };

  return createPortal(
    <div className="amd-pop" style={style} ref={ref} role="dialog" aria-label="Contract value breakdown">
      <div className="amd-pop-head">
        <span className="amd-pop-title">{meta.title || "Contract Value"}</span>
        <button className="drawer-close" onClick={onClose} title="Close"><Icon name="x" size={13}/></button>
      </div>
      <div className="amd-pop-body">
        <div className="amd-pop-row">
          <span className="amd-pop-label">{meta.baseLabel || "Contract amount"}</span>
          <span className="mono num">{fmtMoney(breakdown.base)}</span>
        </div>
        {breakdown.items.length === 0 ? (
          <div className="amd-pop-empty">No amendments on this line.</div>
        ) : (
          breakdown.items.map(it => (
            <div className="amd-pop-row amd-pop-amend" key={it.id}>
              <span className="amd-pop-label" title={it.notes || undefined}>
                {it.label}
                {it.notes && <span className="amd-pop-note">{it.notes}</span>}
              </span>
              <span className="mono num">
                {it.amount >= 0 ? "+" : "−"}{fmtMoney(Math.abs(it.amount))}
              </span>
            </div>
          ))
        )}
        <div className="amd-pop-row amd-pop-total">
          <span className="amd-pop-label">Contract Value</span>
          <span className="mono num">{fmtMoney(breakdown.total)}</span>
        </div>
      </div>
      {onManage && (
        <button className="amd-pop-manage" onClick={() => { onClose(); onManage(); }}>
          <Icon name="file" size={11}/> Manage amendments
        </button>
      )}
    </div>,
    document.body,
  );
}
