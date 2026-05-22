// NfcEnrollPanel — admin tool to bind NFC fobs to users.
//
// Flow (Plan §9):
//   1. Admin picks a user from the dropdown.
//   2. Admin clicks "Capture next tap". A row lands in
//      beacon_v2.nfc_enroll_sessions keyed by admin.id.
//   3. The Pi sees the next unenrolled UID and posts it via timeclock-punch;
//      the function fills nfc_enroll_sessions.captured_uid.
//   4. Realtime surfaces the captured UID here.
//   5. Admin confirms ↔ tag is bound (timeclock-admin enroll-tag).

import React, { useEffect, useState, useCallback } from "react";
import { Icon } from "../icons";
import { UserTag } from "../primitives";
import {
  getUsers, getCurrentBeaconUser,
  loadNfcTags, loadMyEnrollSession,
  tkStartEnroll, tkCancelEnroll, tkEnrollTag,
  subscribeEnrollSession,
} from "../data";

export function NfcEnrollPanel() {
  const me           = getCurrentBeaconUser();
  const [tags, setTags] = useState([]);
  const [target, setTarget] = useState("");
  const [label,  setLabel]  = useState("");
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState(null);

  const refreshTags = useCallback(async () => {
    setTags(await loadNfcTags());
  }, []);

  const refreshSession = useCallback(async () => {
    setSession(await loadMyEnrollSession());
  }, []);

  useEffect(() => {
    refreshTags();
    refreshSession();
  }, [refreshTags, refreshSession]);

  useEffect(() => {
    if (!me?.id) return undefined;
    return subscribeEnrollSession(me.id, refreshSession);
  }, [me?.id, refreshSession]);

  const start = async () => {
    if (!target) { setErr("pick a user first"); return; }
    setBusy(true); setErr(null);
    try { await tkStartEnroll(target); await refreshSession(); }
    catch (e) { setErr(e.message || "start failed"); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true); setErr(null);
    try { await tkCancelEnroll(); await refreshSession(); }
    catch (e) { setErr(e.message || "cancel failed"); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!session?.captured_uid) return;
    setBusy(true); setErr(null);
    try {
      await tkEnrollTag(target, session.captured_uid, label || null);
      await refreshTags();
      await refreshSession();
      setLabel(""); setTarget("");
    } catch (e) { setErr(e.message || "bind failed"); }
    finally { setBusy(false); }
  };

  const users = getUsers().filter(u => u.isEnabled !== false);
  const tagsByUser = new Map();
  for (const t of tags) {
    if (!t.active) continue;
    tagsByUser.set(t.userId, t);
  }

  return (
    <div className="tk-enroll">
      <header className="tk-section-head">
        <h3>NFC enrollment</h3>
        <span className="tk-section-sub">Bind a fob to a user</span>
      </header>

      <div className="tk-enroll-form">
        <div className="form-row">
          <label className="form-label">User</label>
          <select className="form-input" value={target}
            onChange={e => setTarget(e.target.value)}
            disabled={!!session?.captured_uid}>
            <option value="">— pick a user —</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>
                {u.displayName || u.firstName || u.email}
                {tagsByUser.has(u.id) ? " (has active tag)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label className="form-label">Tag label (optional)</label>
          <input className="form-input" value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="e.g. blue fob"/>
        </div>
        {!session ? (
          <button className="btn btn-primary" onClick={start} disabled={busy || !target}>
            Capture next tap (90 sec)
          </button>
        ) : session.captured_uid ? (
          <div className="tk-enroll-captured">
            <div className="tk-enroll-uid">
              <Icon name="check" size={14}/> Captured UID: <code>{session.captured_uid}</code>
            </div>
            <div className="tk-enroll-actions">
              <button className="btn btn-ghost"   onClick={cancel}  disabled={busy}>Cancel</button>
              <button className="btn btn-primary" onClick={confirm} disabled={busy || !target}>
                Bind to user
              </button>
            </div>
          </div>
        ) : (
          <div className="tk-enroll-waiting">
            <span className="tk-pulse"/> Waiting for the next NFC tap on any Pi…
            <button className="btn btn-ghost btn-sm" onClick={cancel} disabled={busy}>Cancel</button>
          </div>
        )}
        {err && <div className="form-error">{err}</div>}
      </div>

      <section className="tk-enroll-list">
        <h4>Active fobs ({tags.filter(t => t.active).length})</h4>
        <ul>
          {tags.filter(t => t.active).map(t => (
            <li key={t.uid} className="tk-enroll-row">
              <code>{t.uid}</code>
              <UserTag userId={t.userId} size="sm" nameOnly/>
              <span className="tk-enroll-row-label">{t.label || "—"}</span>
              <span className="tk-enroll-row-seen">
                {t.lastSeenAt ? `last seen ${new Date(t.lastSeenAt).toLocaleString()}` : "never seen"}
              </span>
            </li>
          ))}
          {tags.filter(t => t.active).length === 0 && (
            <li className="tk-enroll-empty">No fobs enrolled yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
