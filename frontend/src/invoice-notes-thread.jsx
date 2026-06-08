import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.jsx";
import {
  userById, getCurrentBeaconUser, isAdmin,
  addInvoiceNote, editInvoiceNote, deleteInvoiceNote, reloadInvoiceNotes,
} from "./data.js";

// Relative-age label for a note ("just now" / "5m ago" / "3h ago" / "2d ago" /
// "3w ago" / falls back to an absolute date past ~5 weeks). The exact timestamp
// is always shown alongside (noteStamp), so this is the at-a-glance read.
export function noteTimeAgo(iso) {
  if (!iso) return "";
  const then = +new Date(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 45)  return "just now";
  if (secs < 90)  return "1m ago";
  const mins = Math.round(secs / 60);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7)   return `${days}d ago`;
  const wks = Math.round(days / 7);
  if (wks < 5)    return `${wks}w ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Exact, human stamp: "Jun 8, 2026, 2:34 PM".
export function noteStamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// InvoiceNotesThread — the threaded Notes log for one Invoice project row.
// Append-only activity feed: a composer on top, then every note newest-first
// with author avatar, exact date/time + relative age, and (for the author or an
// Admin) inline edit / delete. Refetches on open so a user sees colleagues'
// posts made since the last full load. Optimistic add/edit/delete with revert.
// Every change is pushed up via onChange so the row's chip count stays live.
//
// meta = { id, name, log } — id is the (merged) anticipated_invoice row id the
// chip keys on; log is the row's already-loaded notesLog (instant first paint).
export function InvoiceNotesThread({ meta, onClose, onChange }) {
  const me = getCurrentBeaconUser();
  const meUser = userById(me?.id);
  const admin = isAdmin();

  // logRef is the single source of truth for computing the next list (avoids
  // stale closures across awaits); setBoth keeps state + parent in sync.
  const logRef = useRef(meta.log || []);
  const [log, setLog] = useState(meta.log || []);
  const setBoth = (next) => { logRef.current = next; setLog(next); onChange?.(next); };

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);          // posting in flight
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);     // initial refetch
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);
  const composerRef = useRef();

  const canModify = (n) => !n._pending && (admin || (n.authorId && me?.id === n.authorId));

  // Refetch on open — surfaces colleagues' notes since last full load.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const fresh = await reloadInvoiceNotes(meta.id);
        if (alive) setBoth(fresh);
      } catch {
        if (alive) setError("Couldn't refresh — showing last-loaded notes.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id]);

  // Esc closes the modal unless an inline editor/confirm is open (which handle
  // their own Esc to back out one level first).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !editingId && !pendingDelete) { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const post = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true); setError("");
    const temp = {
      id: `temp-${Date.now()}`, invoiceId: meta.id, authorId: me?.id || null,
      body: text, createdAt: new Date().toISOString(), editedAt: null, _pending: true,
    };
    setBoth([temp, ...logRef.current]);
    setDraft("");
    try {
      const saved = await addInvoiceNote(meta.id, text);
      setBoth(logRef.current.map(n => (n.id === temp.id ? saved : n)));
    } catch (e) {
      setBoth(logRef.current.filter(n => n.id !== temp.id));
      setDraft(text);
      setError(e.message || "Couldn't post the update.");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (n) => { setPendingDelete(null); setEditingId(n.id); setEditText(n.body); setError(""); };

  const saveEdit = async () => {
    const text = editText.trim();
    const id = editingId;
    if (!text || !id) return;
    const before = logRef.current;
    setBoth(before.map(n => (n.id === id
      ? { ...n, body: text, editedAt: new Date().toISOString(), _pending: true } : n)));
    setEditingId(null);
    try {
      const saved = await editInvoiceNote(id, text);
      setBoth(logRef.current.map(n => (n.id === id ? saved : n)));
    } catch (e) {
      setBoth(before);
      setError(e.message || "Couldn't save the edit.");
    }
  };

  const remove = async (n) => {
    const before = logRef.current;
    setBoth(before.filter(x => x.id !== n.id));
    try { await deleteInvoiceNote(n.id); }
    catch (e) { setBoth(before); setError(e.message || "Couldn't delete the update."); }
  };

  const count = log.length;

  return createPortal(
    <>
      <div className="overlay" onClick={onClose}/>
      <div className="modal notes-thread-modal" style={{ width: 540 }}>
        <div className="modal-head">
          <div className="note-modal-badge accent"><Icon name="note" size={15}/></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="drawer-eyebrow" style={{ marginBottom: 2 }}>
              Notes &amp; Updates{count ? ` · ${count}` : ""}
            </div>
            <h3 className="drawer-title note-modal-name" title={meta.name}>{meta.name || "Project"}</h3>
          </div>
          <button className="drawer-close" onClick={onClose} title="Close"><Icon name="x" size={16}/></button>
        </div>

        <div className="modal-body notes-thread-body">
          {/* Composer */}
          <div className="notes-composer">
            <span className={`avatar sm ${meUser?.color || ""}`}>{meUser?.initials || "··"}</span>
            <div className="notes-composer-main">
              <textarea
                ref={composerRef}
                className="input notes-composer-input"
                placeholder="Add an update — billing status, blockers, next steps…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); }
                }}
              />
              <div className="notes-composer-foot">
                <span className="note-modal-hint"><kbd>⌘</kbd><kbd>↵</kbd> to post</span>
                <button className="btn primary sm" onClick={post} disabled={!draft.trim() || busy}>
                  <Icon name="forward" size={12}/> {busy ? "Posting…" : "Post update"}
                </button>
              </div>
            </div>
          </div>

          {error && <div className="notes-thread-error"><Icon name="warn" size={12}/> {error}</div>}

          {/* Thread */}
          <div className="notes-thread-list">
            {loading && count === 0 ? (
              <div className="notes-thread-empty">Loading…</div>
            ) : count === 0 ? (
              <div className="notes-thread-empty">
                <Icon name="note" size={22}/>
                <span>No updates yet</span>
                <small>Be the first to add a note for this project.</small>
              </div>
            ) : (
              log.map((n) => {
                const u = userById(n.authorId);
                const editing = editingId === n.id;
                const confirming = pendingDelete === n.id;
                return (
                  <div key={n.id} className={"note-entry" + (n._pending ? " pending" : "")}>
                    <span className={`avatar xs ${u?.color || ""}`} title={u?.name || "Unknown"}>
                      {u?.initials || "··"}
                    </span>
                    <div className="note-entry-main">
                      <div className="note-entry-head">
                        <span className="note-entry-author">{u?.name || "Unknown"}</span>
                        <span className="note-entry-time" title={noteStamp(n.createdAt)}>
                          {noteStamp(n.createdAt)}
                          <span className="note-entry-ago"> · {noteTimeAgo(n.createdAt)}</span>
                        </span>
                        {n.editedAt && <span className="note-entry-edited">edited</span>}
                        {canModify(n) && !editing && !confirming && (
                          <span className="note-entry-actions">
                            <button type="button" title="Edit" onClick={() => startEdit(n)}>
                              <Icon name="edit" size={12}/>
                            </button>
                            <button type="button" title="Delete" onClick={() => { setEditingId(null); setPendingDelete(n.id); }}>
                              <Icon name="trash" size={12}/>
                            </button>
                          </span>
                        )}
                      </div>

                      {editing ? (
                        <div className="note-entry-edit">
                          <textarea
                            className="input"
                            autoFocus
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") { e.preventDefault(); setEditingId(null); }
                              else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(); }
                            }}
                          />
                          <div className="note-entry-edit-foot">
                            <button className="btn ghost sm" onClick={() => setEditingId(null)}>Cancel</button>
                            <button className="btn primary sm" onClick={saveEdit} disabled={!editText.trim()}>Save</button>
                          </div>
                        </div>
                      ) : confirming ? (
                        <div className="note-entry-confirm">
                          <span>Delete this update?</span>
                          <div className="note-entry-confirm-btns">
                            <button className="btn ghost sm" onClick={() => setPendingDelete(null)}>Cancel</button>
                            <button className="btn danger sm" onClick={() => { setPendingDelete(null); remove(n); }}>Delete</button>
                          </div>
                        </div>
                      ) : (
                        <div className="note-entry-body">{n.body}</div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
