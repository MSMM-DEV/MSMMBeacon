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
import { Icon } from "@/icons";
import {
  Alert, AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
  Badge, Button, EmptyState, Field, Input, Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue, Tabs, TabsList, TabsTrigger, TooltipProvider,
} from "@/ui";
import { UserTag } from "../primitives";
import {
  getUsers, getCurrentBeaconUser,
  loadNfcTags, loadMyEnrollSession,
  tkStartEnroll, tkCancelEnroll, tkEnrollTag, tkRetireTag,
  subscribeEnrollSession,
} from "../data";

// Radix Select cannot carry an empty-string item value, so the "no user yet"
// choice travels as a sentinel and is mapped back to "" at the boundary. The
// state shape (`target` / `reassignTo` are "" when unset) is unchanged.
const NO_USER = "__none__";
const NfcGlyph = (props) => <Icon name="nfc" {...props} />;

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

  const userItems = () => (
    <>
      <SelectItem value={NO_USER}>No user selected</SelectItem>
      {users.map(u => (
        <SelectItem key={u.id} value={u.id}>
          {u.displayName || u.firstName || u.email}
          {activeTags.some(t => t.userId === u.id) ? " (has active fob)" : ""}
        </SelectItem>
      ))}
    </>
  );

  return (
    <TooltipProvider delayDuration={280}>
      <div className="tka-nfc">
        <header className="tka-sectionhead">
          <div className="tka-sectionhead-titles">
            <h3 className="tka-sectionhead-title">NFC fobs</h3>
            <p className="tka-sectionhead-sub">
              Bind a fob's hardware UID to a person, check who a fob belongs to, or take one out of service.
            </p>
          </div>
        </header>

        {/* ---- capture card ---- */}
        <div className="tka-nfc-capture">
          {!session ? (
            <>
              <Tabs
                value={mode}
                onValueChange={(v) => { setMode(v); setErr(null); }}
                className="min-w-0"
              >
                <TabsList variant="segmented" aria-label="Capture mode">
                  <TabsTrigger value="enroll">
                    <Icon name="link" size={14}/> Enroll a fob
                  </TabsTrigger>
                  <TabsTrigger value="verify">
                    <Icon name="search" size={14}/> Verify a fob
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {mode === "enroll" ? (
                <>
                  <div className="tka-nfc-fields">
                    <Field label="User" htmlFor="tka-nfc-user">
                      <Select
                        value={target || NO_USER}
                        onValueChange={(v) => setTarget(v === NO_USER ? "" : v)}
                      >
                        <SelectTrigger id="tka-nfc-user" aria-label="User to enroll">
                          <SelectValue placeholder="Pick a user"/>
                        </SelectTrigger>
                        <SelectContent>{userItems()}</SelectContent>
                      </Select>
                    </Field>

                    <Field label="Tag label (optional)" htmlFor="tka-nfc-label">
                      <Input
                        id="tka-nfc-label"
                        value={label}
                        onChange={e => setLabel(e.target.value)}
                        placeholder="e.g. blue fob"
                      />
                    </Field>
                  </div>

                  <Button
                    variant="primary"
                    onClick={() => start("enroll")}
                    disabled={busy || !target}
                    loading={busy}
                  >
                    {!busy && <Icon name="nfc" size={15}/>}
                    Capture next tap (90 sec)
                  </Button>
                </>
              ) : (
                <>
                  <p className="tka-nfc-hint">
                    Tap any fob on a connected reader and Beacon will tell you who it is bound to.
                    No changes are made.
                  </p>
                  <Button variant="primary" onClick={() => start("verify")} disabled={busy} loading={busy}>
                    {!busy && <Icon name="search" size={15}/>}
                    Listen for next tap (90 sec)
                  </Button>
                </>
              )}
            </>
          ) : waiting ? (
            <div className="tka-nfc-waiting" role="status">
              <span className="tka-livedot is-lg" aria-hidden="true"/>
              <span className="tka-nfc-waiting-text">
                {mode === "verify"
                  ? "Listening. Tap a fob on any reader."
                  : <>Waiting to bind a fob to <strong>{userName(target)}</strong>. Tap on any reader.</>}
              </span>
              <Button variant="ghost" size="sm" onClick={cancel} disabled={busy}>Cancel</Button>
            </div>
          ) : mode === "verify" ? (
            <div className={`tka-nfc-result ${boundTag ? "is-found" : "is-unenrolled"}`}>
              <div className="tka-nfc-uid">
                <Icon name={boundTag ? "checkCircle" : "search"} size={15}/>
                <code className="num">{captured}</code>
              </div>
              <div className="tka-nfc-result-body">
                {boundTag ? (
                  <>
                    <Badge tone="success" size="sm"><Icon name="check" size={11}/> Enrolled</Badge>
                    <span>This fob belongs to <UserTag userId={boundTag.userId} size="sm" nameOnly/></span>
                    {boundTag.label ? <span className="tka-nfc-label">· {boundTag.label}</span> : null}
                  </>
                ) : (
                  <>
                    <Badge tone="neutral" size="sm"><Icon name="ban" size={11}/> Not enrolled</Badge>
                    <span className="tka-muted">No active user is bound to this fob.</span>
                  </>
                )}
              </div>
              <div className="tka-nfc-actions">
                <Button variant="default" onClick={cancel} disabled={busy}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="tka-nfc-result is-captured">
              <div className="tka-nfc-uid">
                <Icon name="checkCircle" size={15}/>
                <span>Captured UID</span>
                <code className="num">{captured}</code>
              </div>
              {boundTag && (
                <Alert tone="warning" title="This fob is already bound">
                  Currently bound to <UserTag userId={boundTag.userId} size="sm" nameOnly/>. Binding will reassign it.
                </Alert>
              )}
              <div className="tka-nfc-actions">
                <Button variant="ghost" onClick={cancel} disabled={busy}>Cancel</Button>
                <Button variant="primary" onClick={bind} disabled={busy || !target} loading={busy}>
                  {!busy && <Icon name="link" size={15}/>}
                  Bind to {userName(target)}
                </Button>
              </div>
            </div>
          )}

          {err && <Alert tone="danger">{err}</Alert>}
        </div>

        {/* ---- enrolled fobs ---- */}
        <section className="tka-nfc-list">
          <header className="tka-queuehead">
            <h4 className="tka-queuetitle">
              <Icon name="key" size={14}/>
              Active fobs
              <Badge tone="neutral" size="sm" className="num">{activeTags.length}</Badge>
            </h4>
          </header>

          {activeTags.length === 0 ? (
            <EmptyState
              compact
              icon={NfcGlyph}
              title="No fobs enrolled yet"
              description="Pick a user above, capture their next tap on a reader, and the fob will show up in this list."
            />
          ) : (
            <div className="bx-scroll-x tka-tablescroll">
              <table className="tka-table">
                <caption className="sr-only">Fobs currently bound to a user</caption>
                <thead>
                  <tr>
                    <th scope="col">Fob UID</th>
                    <th scope="col">Assigned to</th>
                    <th scope="col">Label</th>
                    <th scope="col">Last seen</th>
                    <th scope="col" className="tka-table-actions-head">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {activeTags.map((t) => {
                    const editing = reassignUid === t.uid;
                    return (
                      <tr key={t.uid}>
                        <td><code className="tka-uid num">{t.uid}</code></td>
                        <td><UserTag userId={t.userId} size="sm" nameOnly/></td>
                        <td className="tka-table-muted">{t.label || "–"}</td>
                        <td className="tka-table-muted num">
                          {t.lastSeenAt ? new Date(t.lastSeenAt).toLocaleDateString() : "never seen"}
                        </td>
                        <td>
                          {editing ? (
                            <div className="tka-nfc-reassign">
                              <Select
                                value={reassignTo || NO_USER}
                                onValueChange={(v) => setReassignTo(v === NO_USER ? "" : v)}
                              >
                                <SelectTrigger size="sm" aria-label={`Reassign fob ${t.uid} to`}>
                                  <SelectValue placeholder="Pick a user"/>
                                </SelectTrigger>
                                <SelectContent>{userItems()}</SelectContent>
                              </Select>
                              <Button
                                variant="primary"
                                size="icon-sm"
                                disabled={busy || !reassignTo}
                                aria-label="Confirm reassignment"
                                onClick={() => doReassign(t.uid, t.label)}
                              >
                                <Icon name="check" size={13}/>
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Cancel reassignment"
                                onClick={() => { setReassignUid(null); setReassignTo(""); }}
                              >
                                <Icon name="x" size={13}/>
                              </Button>
                            </div>
                          ) : (
                            <div className="tka-table-actions">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => { setReassignUid(t.uid); setReassignTo(""); setRetireUid(null); }}
                              >
                                <Icon name="refresh" size={13}/> Reassign
                              </Button>

                              <AlertDialog
                                open={retireUid === t.uid}
                                onOpenChange={(o) => { if (!o) setRetireUid(null); }}
                              >
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => { setRetireUid(t.uid); setReassignUid(null); }}
                                  >
                                    <Icon name="trash" size={13}/> Retire
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Retire this fob?</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      Fob <code className="tka-uid num">{t.uid}</code> stops working immediately and
                                      taps from it will no longer punch anyone in or out. Past punches are kept.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel disabled={busy}>Keep it active</AlertDialogCancel>
                                    <AlertDialogAction
                                      variant="destructive"
                                      disabled={busy}
                                      onClick={() => doRetire(t.uid)}
                                    >
                                      Retire fob
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </TooltipProvider>
  );
}
