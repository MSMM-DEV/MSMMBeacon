import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import {
  loadAdminAlerts, loadAlertFires, load24hVitals,
  setAlertActive, deleteAlert, retryAlertFire, setAlertRecipients, runAlertTickNow,
  userById,
} from "./data.js";

// ============================================================================
// AlertsAdmin — "Dispatch Desk" for the alert system. Lives inside AdminPanel
// as the third tab. Admin-only.
//
// Visual identity: warm paper base, letter-pressed masthead, monospace
// timestamps, signal-light status chips. The LIVE indicator pulses whenever
// a fire has recorded in the last ~5 minutes — a quiet "the system is awake"
// signal, not a decoration.
// ============================================================================

// Map beacon.alert_subject_enum → {UI tab key, friendly label} so we can
// resolve subject rows (held in App.jsx) and label the "from where" chip.
const SUBJECT_META = {
  potential:  { tab: "potential", label: "Potential"  },
  awaiting:   { tab: "awaiting",  label: "Awaiting"   },
  awarded:    { tab: "awarded",   label: "Awarded"    },
  soq:        { tab: "soq",       label: "SOQ"        },
  closed_out: { tab: "closed",    label: "Closed Out" },
  invoice:    { tab: "invoice",   label: "Invoice"    },
  event:      { tab: "events",    label: "Event"      },
};

const RECUR_LABEL = {
  one_time: "one-off",
  weekly:   "weekly",
  biweekly: "bi-weekly",
  monthly:  "monthly",
  custom:   "custom",
};

// --------------------------------------------------------------------------
// Formatting helpers kept local to the dispatch view — mono/ISO flavors to
// match the operator-console aesthetic.
// --------------------------------------------------------------------------
const pad = n => String(n).padStart(2, "0");
function fmtMono(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(+d)) return "—";
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtTimeMono(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(+d)) return "—";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function relative(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0)      return "in the future";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// --------------------------------------------------------------------------
// Masthead: letterpressed rule + live pulse + last-tick stamp
// --------------------------------------------------------------------------
function DispatchMasthead({ lastTick }) {
  const [, tick] = useState(0);
  // Force a re-render every 10s so the "last tick · Xs ago" relative stamp
  // stays fresh without needing to reload the vitals every time.
  useEffect(() => {
    const id = setInterval(() => tick(t => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);
  const live = !!lastTick && (Date.now() - new Date(lastTick).getTime() < 5 * 60_000);
  return (
    <header className="dispatch-masthead">
      <div className="dispatch-rule"/>
      <div className="dispatch-eyebrow">Beacon · Dispatch</div>
      <div className={"dispatch-live" + (live ? " on" : "")}>
        <span className="dispatch-pulse" aria-hidden="true"/>
        <span className="dispatch-live-label">{live ? "LIVE" : "IDLE"}</span>
        <span className="dispatch-tick-stamp">
          last tick {lastTick ? fmtTimeMono(lastTick) : "never"}
          {lastTick && <span className="dispatch-tick-rel"> · {relative(lastTick)}</span>}
        </span>
      </div>
    </header>
  );
}

// --------------------------------------------------------------------------
// Vitals strip: 5 large numerics with tiny category labels
// --------------------------------------------------------------------------
function VitalsStrip({ vitals }) {
  const cells = [
    { key: "active",  label: "Active",        value: vitals.active,  tone: "accent" },
    { key: "sent",    label: "Sent (24h)",    value: vitals.sent,    tone: "ok" },
    { key: "failed",  label: "Failed (24h)",  value: vitals.failed,  tone: "bad" },
    { key: "skipped", label: "Skipped (24h)", value: vitals.skipped, tone: "amber" },
    { key: "pending", label: "Pending",       value: vitals.pending, tone: "mute" },
  ];
  return (
    <div className="dispatch-vitals">
      {cells.map(c => (
        <div key={c.key} className={`vital vital-${c.tone}`}>
          <div className="vital-value">{c.value}</div>
          <div className="vital-label">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------
// Signal-light status chip for a fire
// --------------------------------------------------------------------------
function StatusChip({ status }) {
  const s = (status || "").toLowerCase();
  const label =
    s === "sent"       ? "sent" :
    s === "failed"     ? "failed" :
    s === "skipped"    ? "skipped" :
    s === "pending"    ? "pending" :
    s === "processing" ? "processing" : s;
  return <span className={`sig sig-${s}`}><span className="sig-dot"/>{label}</span>;
}

// --------------------------------------------------------------------------
// Fire log (expanded view for one alert)
// --------------------------------------------------------------------------
function FireLog({ fires, onRetry }) {
  if (!fires) return <div className="fire-log-loading">Loading fires…</div>;
  if (fires.length === 0) return <div className="fire-log-empty">No fires recorded yet.</div>;
  return (
    <ol className="fire-log">
      {fires.map(f => (
        <li key={f.id} className={`fire-row fire-${f.status}`}>
          <span className="fire-time">{fmtMono(f.scheduled_at)}</span>
          <StatusChip status={f.status}/>
          {f.attempts > 1 && <span className="fire-attempts">#{f.attempts}</span>}
          {f.error_message && <span className="fire-err">{f.error_message}</span>}
          {!f.error_message && f.fired_at && f.status === "sent" && (
            <span className="fire-fired">dispatched {fmtTimeMono(f.fired_at)}</span>
          )}
          {f.status === "failed" && (
            <button className="fire-retry" onClick={() => onRetry(f)} title="Re-enqueue">
              <Icon name="bolt" size={11}/>retry
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

// --------------------------------------------------------------------------
// Recipients editor (inline, opens under the alert row)
// --------------------------------------------------------------------------
function RecipientsEditor({ initial, users, onCancel, onSave }) {
  const [ids, setIds] = useState(initial.map(u => u.id));
  const [q, setQ]     = useState("");
  const available = users.filter(u =>
    !ids.includes(u.id) && (!q || (u.name || "").toLowerCase().includes(q.toLowerCase()))
  );
  return (
    <div className="recip-edit">
      <div className="recip-edit-head">
        <Icon name="users" size={12}/><span>Recipients</span>
        <span className="recip-edit-sub">replace-all · {ids.length} selected</span>
      </div>
      <div className="recip-tags">
        {ids.map(uid => {
          const u = userById(uid); if (!u) return null;
          return (
            <span key={uid} className="recip-tag">
              <span className={`avatar xs ${u.color}`}>{u.initials}</span>{u.name}
              <button onClick={() => setIds(ids.filter(x => x !== uid))} aria-label="Remove">
                <Icon name="x" size={10}/>
              </button>
            </span>
          );
        })}
        {ids.length === 0 && <span className="recip-tag recip-empty">no one tagged</span>}
      </div>
      <div className="recip-search">
        <Icon name="search" size={12}/>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Add someone…"
        />
      </div>
      {available.length > 0 && (
        <div className="recip-menu">
          {available.slice(0, 8).map(u => (
            <button key={u.id} className="recip-menu-item"
                    onClick={() => { setIds([...ids, u.id]); setQ(""); }}>
              <span className={`avatar xs ${u.color}`}>{u.initials}</span>
              <span>{u.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="recip-edit-foot">
        <button className="btn sm" onClick={onCancel}>Cancel</button>
        <button className="btn primary sm" onClick={() => onSave(ids)}>
          <Icon name="check" size={12}/>Save recipients
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// One alert card — owns its own expand/confirm/edit state.
// --------------------------------------------------------------------------
function AlertDispatchCard({ alert: a, subjectRow, users, onChanged, flash }) {
  const [expanded, setExpanded]   = useState(false);
  const [fires, setFires]         = useState(null);
  const [loadingFires, setLF]     = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editingRec, setEditingRec] = useState(false);
  const [busy, setBusy]             = useState(false);

  const meta = SUBJECT_META[a.subject_table] || { label: a.subject_table, tab: "" };
  const subjName = subjectRow?.name || subjectRow?.title || "(missing row)";
  const subjNumber = subjectRow?.projectNumber || "";
  const recipients = a.recipients || [];

  const pullFires = async () => {
    setLF(true);
    try { setFires(await loadAlertFires(a.id, 12)); }
    finally { setLF(false); }
  };

  const toggleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && fires === null) await pullFires();
  };

  const doPauseResume = async () => {
    setBusy(true);
    try {
      await setAlertActive(a.id, !a.is_active);
      flash(a.is_active ? "Alert paused" : "Alert resumed", "check");
      onChanged?.();
    } catch (e) { flash(e.message || "Pause/resume failed", "x"); }
    finally { setBusy(false); }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await deleteAlert(a.id);
      flash("Alert deleted", "trash");
      onChanged?.();
    } catch (e) { flash(e.message || "Delete failed", "x"); setConfirming(false); }
    finally { setBusy(false); }
  };

  const doSaveRecipients = async (ids) => {
    setBusy(true);
    try {
      await setAlertRecipients(a.id, ids);
      flash(`Recipients updated · ${ids.length}`, "check");
      setEditingRec(false);
      onChanged?.();
    } catch (e) { flash(e.message || "Recipient save failed", "x"); }
    finally { setBusy(false); }
  };

  const doRetry = async (fire) => {
    try {
      await retryAlertFire(a.id);
      flash("Fire re-enqueued", "bolt");
      // Optimistic: pending row will appear on next fires fetch
      await pullFires();
      onChanged?.();
    } catch (e) { flash(e.message || "Retry failed", "x"); }
  };

  return (
    <li className={"dispatch-card" + (a.is_active ? "" : " paused")}>
      <div className="dispatch-card-top">
        <button className="dispatch-card-main" onClick={toggleExpand}>
          <div className="dispatch-card-subject">
            <span className="dispatch-card-subject-name">{subjName}</span>
            {subjNumber && <span className="dispatch-card-subject-num">#{subjNumber}</span>}
            {!a.is_active && <span className="dispatch-card-paused">paused</span>}
          </div>
          <div className="dispatch-card-meta">
            <span className={`dispatch-tag tag-${meta.tab}`}>{meta.label}</span>
            <span className="dispatch-dot"/>
            <span className="dispatch-meta-item">{RECUR_LABEL[a.recurrence] || a.recurrence}</span>
            <span className="dispatch-dot"/>
            <span className="dispatch-meta-item">
              {a.recurrence === "one_time" ? "fires" : "next"} <span className="mono">{fmtMono(a.first_fire_at)}</span>
            </span>
            {a.anchor_field && a.anchor_offset_minutes != null && (
              <>
                <span className="dispatch-dot"/>
                <span className="dispatch-meta-item mono">
                  {Math.abs(a.anchor_offset_minutes) >= 1440
                    ? `${Math.abs(a.anchor_offset_minutes)/1440}d`
                    : Math.abs(a.anchor_offset_minutes) >= 60
                      ? `${Math.abs(a.anchor_offset_minutes)/60}h`
                      : `${Math.abs(a.anchor_offset_minutes)}m`
                  } {a.anchor_offset_minutes < 0 ? "before" : "after"} {a.anchor_field.replace(/_/g, " ")}
                </span>
              </>
            )}
          </div>
          <div className="dispatch-card-recip">
            {recipients.slice(0, 4).map(u => {
              const ux = userById(u.id);
              return (
                <span key={u.id}
                      className={`avatar xs ${ux?.color || ""}`}
                      title={u.display_name || u.first_name || u.email}>
                  {ux?.initials || ((u.first_name || u.email || "?")[0]).toUpperCase()}
                </span>
              );
            })}
            {recipients.length > 4 && (
              <span className="avatar xs avatar-more">+{recipients.length - 4}</span>
            )}
          </div>
          <Icon name="chevronRight" size={12}/>
        </button>
        <div className="dispatch-card-actions">
          <button className="iconbtn-sm" title={a.is_active ? "Pause" : "Resume"}
                  onClick={doPauseResume} disabled={busy}>
            <Icon name={a.is_active ? "ban" : "check"} size={12}/>
          </button>
          <button className="iconbtn-sm" title="Edit recipients"
                  onClick={() => setEditingRec(v => !v)} disabled={busy}>
            <Icon name="users" size={12}/>
          </button>
          <button className="iconbtn-sm iconbtn-danger" title="Delete"
                  onClick={() => setConfirming(true)} disabled={busy}>
            <Icon name="trash" size={12}/>
          </button>
        </div>
      </div>

      {a.message && (
        <div className="dispatch-message">
          <Icon name="mail" size={10}/>
          <span>{a.message}</span>
        </div>
      )}

      {confirming && (
        <div className="dispatch-confirm">
          <Icon name="trash" size={12}/>
          <span>Delete this alert and its fire history?</span>
          <div className="dispatch-confirm-actions">
            <button className="btn sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
            <button className="btn danger sm" onClick={doDelete} disabled={busy}>
              <Icon name="trash" size={11}/>Delete
            </button>
          </div>
        </div>
      )}

      {editingRec && (
        <RecipientsEditor
          initial={recipients}
          users={users}
          onCancel={() => setEditingRec(false)}
          onSave={doSaveRecipients}
        />
      )}

      {expanded && (
        <div className="dispatch-firelog-wrap">
          <div className="fire-log-head">
            <Icon name="clock" size={11}/>Fire history
            <span className="fire-log-sub">last 12</span>
            <button className="fire-log-refresh" onClick={pullFires} disabled={loadingFires}>
              {loadingFires ? "refreshing…" : "refresh"}
            </button>
          </div>
          <FireLog fires={fires} onRetry={doRetry}/>
        </div>
      )}
    </li>
  );
}

// --------------------------------------------------------------------------
// Root component
// --------------------------------------------------------------------------
export function AlertsAdmin({ subjectLookup = {}, users = [], onChanged }) {
  const [alerts, setAlerts]   = useState([]);
  const [vitals, setVitals]   = useState({ active: 0, sent: 0, failed: 0, skipped: 0, pending: 0, lastTick: null });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");
  const [toast, setToast]     = useState(null);
  const [ticking, setTicking] = useState(false);
  const [tickResult, setTickResult] = useState(null);
  const [filter, setFilter]   = useState("all"); // all | active | paused | failed24h

  const flash = (msg, icon = "check") => {
    setToast({ msg, icon });
    setTimeout(() => setToast(null), 2800);
  };

  const refresh = async () => {
    setError("");
    try {
      const [a, v] = await Promise.all([loadAdminAlerts(), load24hVitals()]);
      setAlerts(a); setVitals(v);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Poll vitals every 30s so the LIVE indicator stays honest. Alerts list
  // changes rarely; only re-pull on user action or explicit refresh.
  useEffect(() => {
    const id = setInterval(async () => {
      try { setVitals(await load24hVitals()); } catch { /* ignore */ }
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  const doRunTick = async () => {
    setTicking(true); setTickResult(null);
    try {
      const res = await runAlertTickNow();
      setTickResult(res);
      const parts = [];
      if (res?.processed != null) parts.push(`${res.processed} processed`);
      if (res?.sent)     parts.push(`${res.sent} sent`);
      if (res?.failed)   parts.push(`${res.failed} failed`);
      if (res?.skipped)  parts.push(`${res.skipped} skipped`);
      if (res?.disabled) parts.push("disabled");
      flash(parts.length ? `Tick · ${parts.join(" · ")}` : "Tick complete", "bolt");
      await refresh();
    } catch (e) {
      flash(e.message || "Tick failed", "x");
    } finally {
      setTicking(false);
    }
  };

  const filtered = useMemo(() => {
    if (filter === "all")    return alerts;
    if (filter === "active") return alerts.filter(a => a.is_active);
    if (filter === "paused") return alerts.filter(a => !a.is_active);
    return alerts;
  }, [alerts, filter]);

  const lookupSubject = (a) => subjectLookup?.[a.subject_table]?.[a.subject_row_id] || null;

  return (
    <section className="dispatch">
      <DispatchMasthead lastTick={vitals.lastTick}/>
      <VitalsStrip vitals={vitals}/>

      <div className="dispatch-toolbar">
        <div className="dispatch-filter-chips">
          {[
            { k: "all",    label: "All" },
            { k: "active", label: "Active" },
            { k: "paused", label: "Paused" },
          ].map(f => (
            <button key={f.k}
                    className={"dispatch-filter" + (filter === f.k ? " active" : "")}
                    onClick={() => setFilter(f.k)}>{f.label}</button>
          ))}
        </div>
        <div className="dispatch-toolbar-spacer"/>
        <button className="dispatch-btn ghost" onClick={refresh} disabled={loading} title="Re-fetch alerts + vitals">
          <Icon name="sparkles" size={11}/>Refresh
        </button>
        <button className="dispatch-btn primary" onClick={doRunTick} disabled={ticking}
                title="POST to /functions/v1/send-alert once as this admin session">
          <Icon name="bolt" size={11}/>{ticking ? "Ticking…" : "Run tick now"}
        </button>
      </div>

      {tickResult && (
        <div className="dispatch-tick-banner">
          <Icon name="bolt" size={11}/>
          <span>
            {tickResult.disabled
              ? "Dispatcher is disabled (ALERTS_ENABLED ≠ true)."
              : `Processed ${tickResult.processed ?? 0} · sent ${tickResult.sent ?? 0} · failed ${tickResult.failed ?? 0} · skipped ${tickResult.skipped ?? 0}`}
          </span>
          <button className="dispatch-tick-close" onClick={() => setTickResult(null)} aria-label="Dismiss">
            <Icon name="x" size={10}/>
          </button>
        </div>
      )}

      {error && <div className="dispatch-error"><Icon name="x" size={12}/><span>{error}</span></div>}
      {loading && <div className="dispatch-empty">Loading dispatch log…</div>}
      {!loading && filtered.length === 0 && (
        <div className="dispatch-empty">
          {alerts.length === 0
            ? "No alerts scheduled yet. Ring the bell icon on any row to set one."
            : "No alerts match this filter."}
        </div>
      )}

      <ul className="dispatch-list">
        {filtered.map(a => (
          <AlertDispatchCard
            key={a.id}
            alert={a}
            subjectRow={lookupSubject(a)}
            users={users}
            onChanged={async () => { await refresh(); onChanged?.(); }}
            flash={flash}
          />
        ))}
      </ul>

      {toast && (
        <div className="admin-toast">
          <span className="toast-icon"><Icon name={toast.icon} size={11} stroke={2.2}/></span>
          {toast.msg}
        </div>
      )}
    </section>
  );
}
