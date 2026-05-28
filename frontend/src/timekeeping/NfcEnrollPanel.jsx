// NfcEnrollPanel — admin tool to enroll, verify, reassign, and retire NFC fobs.
//
// The fob's hardware UID is the identity; "enrollment" binds that UID to a user
// in beacon_v2.nfc_tags. Nothing is written onto the tag.
//
// Two capture intents share one capture session (nfc_enroll_sessions, keyed by
// admin). A physical tap always arrives from a reader device (Pi/kiosk or the
// macOS PC/SC tester) via timeclock-punch — browsers can't read USB NFC — so
// "Capture next tap" + "Verify a fob" both wait for that POST to land the UID.
//
//   • Enroll  — pick a user, capture the next tap, bind (reassigns if the UID
//               was already someone else's).
//   • Verify  — capture the next tap and show who it belongs to. No write.
//   • Reassign / Retire — act on an already-enrolled fob from the list. No tap.

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { Icon } from "../icons";
import { UserTag } from "../primitives";
import {
  getUsers, getCurrentBeaconUser,
  loadNfcTags, loadMyEnrollSession,
  tkStartEnroll, tkCancelEnroll, tkEnrollTag, tkRetireTag,
  subscribeEnrollSession,
} from "../data";

export function NfcEnrollPanel() {
  const me = getCurrentBeaconUser();

  const [tags, setTags]       = useState([]);
  const [session, setSession] = useState(null);
  const [mode, setMode]       = useState("enroll");   // 'enroll' | 'verify'
  const [target, setTarget]   = useState("");
  const [label,  setLabel]    = useState("");
  const [busy, setBusy]       = useState(false);
  const [err,  setErr]        = useState(null);

  // Per-row state for the fob list.
  const [reassignUid, setReassignUid] = useState(null);
  const [reassignTo,  setReassignTo]  = useState("");
  const [retireUid,   setRetireUid]   = useState(null);

  const refreshTags    = useCallback(async () => setTags(await loadNfcTags()), []);
  const refreshSession = useCallback(async () => setSession(await loadMyEnrollSession()), []);

  useEffect(() => { refreshTags(); refreshSession(); }, [refreshTags, refreshSession]);
  useEffect(() => {
    if (!me?.id) return undefined;
    return subscribeEnrollSession(me.id, refreshSession);
  }, [me?.id, refreshSession]);

  const users    = useMemo(() => getUsers().filter(u => u.isEnabled !== false), []);
  const userName = useCallback((id) => {
    const u = users.find(x => x.id === id);
    return u ? (u.displayName || u.firstName || u.email) : "unknown user";
  }, [users]);

  const activeTags = tags.filter(t => t.active);
  const tagFor = (uid) => activeTags.find(t => t.uid === uid) || null;

  const captured   = session?.captured_uid || null;
  const waiting    = !!session && !captured;
  const boundTag   = captured ? tagFor(captured) : null;     // who the captured UID belongs to now

  // ---- capture lifecycle -------------------------------------------------
  const start = async (which) => {
    if (which === "enroll" && !target) { setErr("Pick a user to enroll first."); return; }
    setMode(which); setErr(null); setBusy(true);
    try {
      // Verify has no real target; park the session on the admin's own row.
      await tkStartEnroll(which === "enroll" ? target : me.id);
      await refreshSession();
    } catch (e) { setErr(e.message || "Couldn't start capture."); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true); setErr(null);
    try { await tkCancelEnroll(); await refreshSession(); }
    catch (e) { setErr(e.message || "Cancel failed."); }
    finally { setBusy(false); }
  };

  const bind = async () => {
    if (!captured || !target) return;
    setBusy(true); setErr(null);
    try {
      await tkEnrollTag(target, captured, label || null);
      await refreshTags(); await refreshSession();
      setLabel(""); setTarget("");
    } catch (e) { setErr(e.message || "Bind failed."); }
    finally { setBusy(false); }
  };

  // ---- list actions (no tap) ---------------------------------------------
  const doReassign = async (uid, oldLabel) => {
    if (!reassignTo) return;
    setBusy(true); setErr(null);
    try {
      await tkEnrollTag(reassignTo, uid, oldLabel || null);
      await refreshTags();
      setReassignUid(null); setReassignTo("");
    } catch (e) { setErr(e.message || "Reassign failed."); }
    finally { setBusy(false); }
  };

  const doRetire = async (uid) => {
    setBusy(true); setErr(null);
    try { await tkRetireTag(uid); await refreshTags(); setRetireUid(null); }
    catch (e) { setErr(e.message || "Retire failed."); }
    finally { setBusy(false); }
  };

  const UserOptions = () => (
    <>
      <option value="">— pick a user —</option>
      {users.map(u => (
        <option key={u.id} value={u.id}>
          {u.displayName || u.firstName || u.email}
          {activeTags.some(t => t.userId === u.id) ? " (has active fob)" : ""}
        </option>
      ))}
    </>
  );

  return (
    <div className="tk-enroll">
      <header className="tk-section-head">
        <h3>NFC fobs</h3>
        <span className="tk-section-sub">Enroll · verify · reassign · retire</span>
      </header>

      {/* ---- capture card ---- */}
      <div className="tk-enroll-form">
        {!session ? (
          <>
            <div className="tk-enroll-modes" role="tablist" aria-label="Capture mode">
              <button role="tab" aria-selected={mode === "enroll"}
                className={`tk-enroll-mode-btn ${mode === "enroll" ? "is-active" : ""}`}
                onClick={() => { setMode("enroll"); setErr(null); }}>
                <Icon name="link" size={14}/> Enroll a fob
              </button>
              <button role="tab" aria-selected={mode === "verify"}
                className={`tk-enroll-mode-btn ${mode === "verify" ? "is-active" : ""}`}
                onClick={() => { setMode("verify"); setErr(null); }}>
                <Icon name="search" size={14}/> Verify a fob
              </button>
            </div>

            {mode === "enroll" ? (
              <>
                <div className="form-row">
                  <label className="form-label">User</label>
                  <select className="form-input" value={target} onChange={e => setTarget(e.target.value)}>
                    <UserOptions/>
                  </select>
                </div>
                <div className="form-row">
                  <label className="form-label">Tag label (optional)</label>
                  <input className="form-input" value={label} onChange={e => setLabel(e.target.value)}
                    placeholder="e.g. blue fob"/>
                </div>
                <button className="btn btn-primary" onClick={() => start("enroll")} disabled={busy || !target}>
                  <Icon name="bell" size={14}/> Capture next tap (90 sec)
                </button>
              </>
            ) : (
              <>
                <p className="tk-enroll-hint">
                  Tap any fob on a connected reader and Beacon will tell you who it's bound to.
                  No changes are made.
                </p>
                <button className="btn btn-primary" onClick={() => start("verify")} disabled={busy}>
                  <Icon name="search" size={14}/> Listen for next tap (90 sec)
                </button>
              </>
            )}
          </>
        ) : waiting ? (
          <div className="tk-enroll-waiting">
            <span className="tk-pulse"/>
            {mode === "verify"
              ? "Listening — tap a fob on any reader…"
              : <>Waiting to bind a fob to <strong>{userName(target)}</strong> — tap on any reader…</>}
            <button className="btn btn-ghost btn-sm" onClick={cancel} disabled={busy}>Cancel</button>
          </div>
        ) : mode === "verify" ? (
          <div className={`tk-enroll-result ${boundTag ? "is-found" : "is-unenrolled"}`}>
            <div className="tk-enroll-uid">
              <Icon name={boundTag ? "check" : "search"} size={14}/>
              <code>{captured}</code>
            </div>
            <div className="tk-enroll-result-body">
              {boundTag ? (
                <>This fob belongs to <UserTag userId={boundTag.userId} size="sm" nameOnly/>
                  {boundTag.label ? <span className="tk-enroll-row-label"> · {boundTag.label}</span> : null}</>
              ) : (
                <span className="tk-enroll-muted">Not enrolled — no active user is bound to this fob.</span>
              )}
            </div>
            <div className="tk-enroll-actions">
              <button className="btn btn-ghost" onClick={cancel} disabled={busy}>Done</button>
            </div>
          </div>
        ) : (
          <div className="tk-enroll-captured">
            <div className="tk-enroll-uid">
              <Icon name="check" size={14}/> Captured UID: <code>{captured}</code>
            </div>
            {boundTag && (
              <div className="tk-enroll-warn">
                <Icon name="bell" size={13}/>
                Currently bound to <UserTag userId={boundTag.userId} size="sm" nameOnly/> —
                binding will reassign this fob.
              </div>
            )}
            <div className="tk-enroll-actions">
              <button className="btn btn-ghost" onClick={cancel} disabled={busy}>Cancel</button>
              <button className="btn btn-primary" onClick={bind} disabled={busy || !target}>
                <Icon name="link" size={14}/> Bind to {userName(target)}
              </button>
            </div>
          </div>
        )}
        {err && <div className="form-error">{err}</div>}
      </div>

      {/* ---- enrolled fobs ---- */}
      <section className="tk-enroll-list">
        <h4>Active fobs ({activeTags.length})</h4>
        <ul>
          {activeTags.map((t, i) => {
            const editing  = reassignUid === t.uid;
            const retiring = retireUid === t.uid;
            return (
              <li key={t.uid} className="tk-enroll-row" style={{ animationDelay: `${Math.min(i, 8) * 28}ms` }}>
                <code>{t.uid}</code>
                <UserTag userId={t.userId} size="sm" nameOnly/>
                <span className="tk-enroll-row-label">{t.label || "—"}</span>
                <span className="tk-enroll-row-seen">
                  {t.lastSeenAt ? `seen ${new Date(t.lastSeenAt).toLocaleDateString()}` : "never seen"}
                </span>

                {editing ? (
                  <div className="tk-enroll-reassign">
                    <select className="form-input" value={reassignTo} onChange={e => setReassignTo(e.target.value)}>
                      <UserOptions/>
                    </select>
                    <button className="btn btn-primary btn-sm" disabled={busy || !reassignTo}
                      onClick={() => doReassign(t.uid, t.label)}><Icon name="check" size={13}/></button>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => { setReassignUid(null); setReassignTo(""); }}><Icon name="x" size={13}/></button>
                  </div>
                ) : retiring ? (
                  <div className="tk-enroll-row-actions tk-enroll-confirm">
                    <span>Retire this fob?</span>
                    <button className="btn btn-warn btn-sm" disabled={busy} onClick={() => doRetire(t.uid)}>Retire</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setRetireUid(null)}>No</button>
                  </div>
                ) : (
                  <div className="tk-enroll-row-actions">
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => { setReassignUid(t.uid); setReassignTo(""); setRetireUid(null); }}>
                      <Icon name="refresh" size={13}/> Reassign
                    </button>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => { setRetireUid(t.uid); setReassignUid(null); }}>
                      <Icon name="trash" size={13}/> Retire
                    </button>
                  </div>
                )}
              </li>
            );
          })}
          {activeTags.length === 0 && <li className="tk-enroll-empty">No fobs enrolled yet.</li>}
        </ul>
      </section>
    </div>
  );
}
