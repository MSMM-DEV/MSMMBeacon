import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import {
  loadAdminAlerts, loadAlertFires, load24hVitals,
  setAlertActive, deleteAlert, retryAlertFire, setAlertRecipients, runAlertTickNow,
  userById,
} from "./data.js";
import {
  Alert,
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Badge, Button,
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  EmptyState, InputGroup, Skeleton, Tooltip,
} from "@/ui";

// ============================================================================
// AlertsAdmin — "Dispatch Desk" for the alert system. Lives inside AdminPanel
// as the second tab. Admin-only.
//
// Visual identity: warm paper base, a quiet masthead, monospace timestamps and
// status chips that pair a semantic tint with an icon and a word, so state is
// never carried by colour alone. The live indicator flips to "Live" whenever a
// fire has recorded in the last ~5 minutes — a quiet "the system is awake"
// signal, not a decoration.
//
// Semantic tokens follow the product-wide contract: sage = delivered, clay =
// failed, ochre/brand = needs attention, steel = paused or informational.
// ============================================================================

// Map beacon_v2.alert_subject_enum → {UI tab key, friendly label}. v2
// collapsed the 8-value v1 enum to 4: every project status maps to
// 'project'; 'hotlead' became 'lead'; 'invoice' and 'event' are unchanged.
// For 'project' subjects, the friendly label is refined per-row by
// looking at the underlying project's UI-status field (see AlertDispatchCard).
const SUBJECT_META = {
  project:  { tab: "project", label: "Project"  },
  invoice:  { tab: "invoice", label: "Invoice"  },
  event:    { tab: "events",  label: "Event"    },
  lead:     { tab: "hotleads", label: "Lead"    },
};

// Icon per subject family, so the kind of thing an alert watches is legible
// without reading the label.
const SUBJECT_ICON = {
  project: "briefcase",
  invoice: "wallet",
  event:   "calendar",
  lead:    "star",
};

// Project status → user-facing label. Mirrors how the adapters in data.js
// stamp `status` on each adapted UI row (Potential rows leave it unset).
const PROJECT_STATUS_LABEL = {
  "Proposal":         "Proposal",
  // Legacy label — rows shaped before the Proposals rename.
  "Awaiting Verdict": "Proposal",
  "Awarded":          "Awarded",
  "Closed Out":       "Closed Out",
};

const RECUR_LABEL = {
  one_time: "one-off",
  weekly:   "weekly",
  biweekly: "bi-weekly",
  monthly:  "monthly",
  custom:   "custom",
};

// Fire status → semantic tone + icon + word. Three cues per state, so the
// chips stay readable for colour-blind users and in high-contrast modes.
const FIRE_STATUS = {
  sent:       { tone: "success", icon: "checkCircle", label: "sent" },
  failed:     { tone: "danger",  icon: "danger",      label: "failed" },
  skipped:    { tone: "brand",   icon: "pause",       label: "skipped" },
  pending:    { tone: "neutral", icon: "hourglass",   label: "pending" },
  processing: { tone: "info",    icon: "refresh",     label: "processing" },
};

// The house placeholder for an absent value (en dash, never an em dash).
const EMPTY = "–";

// --------------------------------------------------------------------------
// Formatting helpers kept local to the dispatch view — mono/ISO flavors to
// match the operator-console aesthetic.
// --------------------------------------------------------------------------
const pad = n => String(n).padStart(2, "0");
function fmtMono(iso) {
  if (!iso) return EMPTY;
  const d = new Date(iso);
  if (isNaN(+d)) return EMPTY;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtTimeMono(iso) {
  if (!iso) return EMPTY;
  const d = new Date(iso);
  if (isNaN(+d)) return EMPTY;
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

const AlertsEmptyIcon = (props) => <Icon name="bell" {...props} />;

// --------------------------------------------------------------------------
// Masthead: title, live/idle state and the last-tick stamp
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
    <header className="dsp-masthead">
      <div className="dsp-masthead-text">
        <p className="dsp-eyebrow">Beacon · Dispatch</p>
        <h3 className="dsp-title">Alert rules</h3>
      </div>
      <div className="dsp-status">
        <Badge tone={live ? "success" : "neutral"} dot>
          {live ? "Live" : "Idle"}
        </Badge>
        <span className="dsp-tick">
          <span className="dsp-tick-label">last tick</span>
          <span className="dsp-mono">{lastTick ? fmtTimeMono(lastTick) : "never"}</span>
          {lastTick && <span className="dsp-tick-rel">{relative(lastTick)}</span>}
        </span>
      </div>
    </header>
  );
}

// --------------------------------------------------------------------------
// Vitals strip: five counts, each with an icon so the tint is never the only
// thing distinguishing them.
// --------------------------------------------------------------------------
function VitalsStrip({ vitals }) {
  const cells = [
    { key: "active",  label: "Active",        value: vitals.active,  tone: "info",    icon: "bell" },
    { key: "sent",    label: "Sent (24h)",    value: vitals.sent,    tone: "success", icon: "checkCircle" },
    { key: "failed",  label: "Failed (24h)",  value: vitals.failed,  tone: "danger",  icon: "danger" },
    { key: "skipped", label: "Skipped (24h)", value: vitals.skipped, tone: "brand",   icon: "pause" },
    { key: "pending", label: "Pending",       value: vitals.pending, tone: "neutral", icon: "hourglass" },
  ];
  return (
    <dl className="dsp-vitals">
      {cells.map(c => (
        <div key={c.key} className="dsp-vital" data-tone={c.tone}>
          <dt className="dsp-vital-label">
            <Icon name={c.icon} size={12} />
            <span>{c.label}</span>
          </dt>
          <dd className="dsp-vital-value num">{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// --------------------------------------------------------------------------
// Status chip for a fire
// --------------------------------------------------------------------------
function StatusChip({ status }) {
  const s = (status || "").toLowerCase();
  const meta = FIRE_STATUS[s];
  if (!meta) return <Badge tone="neutral">{s}</Badge>;
  return (
    <Badge tone={meta.tone}>
      <Icon name={meta.icon} size={11} />
      {meta.label}
    </Badge>
  );
}

// --------------------------------------------------------------------------
// Fire log (expanded view for one alert)
// --------------------------------------------------------------------------
function FireLog({ fires, onRetry }) {
  if (!fires) {
    return (
      <div className="dsp-firelog-loading" role="status" aria-live="polite">
        <span className="sr-only">Loading fire history</span>
        {[0, 1, 2].map(i => (
          <Skeleton key={i} className="h-3.5" style={{ opacity: 1 - i * 0.22 }} />
        ))}
      </div>
    );
  }
  if (fires.length === 0) {
    return <p className="dsp-firelog-empty">No fires recorded yet.</p>;
  }
  return (
    <ol className="dsp-firelog">
      {fires.map(f => (
        <li key={f.id} className="dsp-fire">
          <span className="dsp-mono dsp-fire-time">{fmtMono(f.scheduled_at)}</span>
          <StatusChip status={f.status}/>
          {f.attempts > 1 && (
            <span className="dsp-fire-attempts num" title="Attempts">
              <span className="sr-only">Attempt </span>#{f.attempts}
            </span>
          )}
          {f.error_message && <span className="dsp-fire-err">{f.error_message}</span>}
          {!f.error_message && f.fired_at && f.status === "sent" && (
            <span className="dsp-fire-note">
              dispatched <span className="dsp-mono">{fmtTimeMono(f.fired_at)}</span>
            </span>
          )}
          {f.status === "failed" && (
            <Button variant="ghost" size="xs" className="dsp-fire-retry" onClick={() => onRetry(f)}>
              <Icon name="bolt" size={12}/>Re-enqueue
            </Button>
          )}
        </li>
      ))}
    </ol>
  );
}

// --------------------------------------------------------------------------
// Recipients editor — a Dialog, so Escape, focus trapping and aria wiring
// come from Radix rather than being hand-rolled inside the row.
// --------------------------------------------------------------------------
function RecipientsEditor({ initial, users, onCancel, onSave }) {
  const [ids, setIds] = useState(initial.map(u => u.id));
  const [q, setQ]     = useState("");
  const available = users.filter(u =>
    !ids.includes(u.id) && (!q || (u.name || "").toLowerCase().includes(q.toLowerCase()))
  );
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Recipients</DialogTitle>
          <DialogDescription>
            Saving replaces the whole list. {ids.length} selected.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="dsp-recip-body">
          <ul className="dsp-recip-tags">
            {ids.map(uid => {
              const u = userById(uid); if (!u) return null;
              return (
                <li key={uid} className="dsp-recip-tag">
                  <span className={`avatar xs ${u.color}`} aria-hidden="true">{u.initials}</span>
                  <span className="bx-truncate">{u.name}</span>
                  <button
                    type="button"
                    className="dsp-recip-remove"
                    aria-label={`Remove ${u.name}`}
                    onClick={() => setIds(ids.filter(x => x !== uid))}
                  >
                    <Icon name="x" size={12}/>
                  </button>
                </li>
              );
            })}
            {ids.length === 0 && <li className="dsp-recip-none">No one tagged yet.</li>}
          </ul>

          <InputGroup
            leading={<Icon name="search" size={14}/>}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Add someone"
            aria-label="Search people to add"
          />

          {available.length > 0 && (
            <ul className="dsp-recip-options">
              {available.slice(0, 8).map(u => (
                <li key={u.id}>
                  <button
                    type="button"
                    className="dsp-recip-option"
                    onClick={() => { setIds([...ids, u.id]); setQ(""); }}
                  >
                    <span className={`avatar xs ${u.color}`} aria-hidden="true">{u.initials}</span>
                    <span className="bx-truncate">{u.name}</span>
                    <Icon name="plus" size={13} className="dsp-recip-add"/>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="default" onClick={onCancel}>Cancel</Button>
          <Button type="button" variant="primary" onClick={() => onSave(ids)}>
            <Icon name="check" size={14}/>Save recipients
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------
// One alert row — owns its own expand/confirm/edit state.
// --------------------------------------------------------------------------
function AlertDispatchCard({ alert: a, subjectRow, users, onChanged, flash }) {
  const [expanded, setExpanded]   = useState(false);
  const [fires, setFires]         = useState(null);
  const [loadingFires, setLF]     = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editingRec, setEditingRec] = useState(false);
  const [busy, setBusy]             = useState(false);

  // For 'project' subjects, refine the label by looking at the underlying
  // project's UI-status. Potential rows have no `status` field on the
  // adapted UI row, so they fall back to the generic "Project" label.
  let meta = SUBJECT_META[a.subject_table] || { label: a.subject_table, tab: "" };
  if (a.subject_table === "project" && subjectRow) {
    const refined = PROJECT_STATUS_LABEL[subjectRow.status];
    meta = { ...meta, label: refined || "Potential" };
  }
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

  const offsetPhrase = a.anchor_field && a.anchor_offset_minutes != null
    ? `${
        Math.abs(a.anchor_offset_minutes) >= 1440
          ? `${Math.abs(a.anchor_offset_minutes) / 1440}d`
          : Math.abs(a.anchor_offset_minutes) >= 60
            ? `${Math.abs(a.anchor_offset_minutes) / 60}h`
            : `${Math.abs(a.anchor_offset_minutes)}m`
      } ${a.anchor_offset_minutes < 0 ? "before" : "after"} ${a.anchor_field.replace(/_/g, " ")}`
    : null;

  return (
    <li className="dsp-row" data-paused={a.is_active ? undefined : true}>
      <div className="dsp-row-top">
        <button
          type="button"
          className="dsp-row-main"
          onClick={toggleExpand}
          aria-expanded={expanded}
        >
          <span className="dsp-row-chevron" aria-hidden="true">
            <Icon name="chevronRight" size={14}/>
          </span>
          <span className="dsp-row-body">
            <span className="dsp-row-subject">
              <span className="dsp-subject-name bx-truncate">{subjName}</span>
              {subjNumber && <span className="dsp-subject-num num">#{subjNumber}</span>}
              {!a.is_active && (
                <Badge tone="info"><Icon name="pause" size={11}/>Paused</Badge>
              )}
            </span>
            <span className="dsp-row-meta">
              <span className="dsp-kind">
                <Icon name={SUBJECT_ICON[a.subject_table] || "note"} size={12}/>
                {meta.label}
              </span>
              <span className="dsp-sep" aria-hidden="true">·</span>
              <span>{RECUR_LABEL[a.recurrence] || a.recurrence}</span>
              <span className="dsp-sep" aria-hidden="true">·</span>
              <span>
                {a.recurrence === "one_time" ? "fires" : "next"}{" "}
                <span className="dsp-mono">{fmtMono(a.first_fire_at)}</span>
              </span>
              {offsetPhrase && (
                <>
                  <span className="dsp-sep" aria-hidden="true">·</span>
                  <span className="dsp-mono">{offsetPhrase}</span>
                </>
              )}
            </span>
          </span>
          <span className="dsp-row-recip">
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
          </span>
        </button>

        <div className="dsp-row-actions">
          <Tooltip label={a.is_active ? "Pause this alert" : "Resume this alert"}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={doPauseResume}
              disabled={busy}
              aria-label={a.is_active ? `Pause the alert on ${subjName}` : `Resume the alert on ${subjName}`}
            >
              <Icon name={a.is_active ? "pause" : "play"} size={14}/>
            </Button>
          </Tooltip>
          <Tooltip label="Edit recipients">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setEditingRec(v => !v)}
              disabled={busy}
              aria-label={`Edit recipients for the alert on ${subjName}`}
            >
              <Icon name="users" size={14}/>
            </Button>
          </Tooltip>
          <Tooltip label="Delete this alert">
            <Button
              variant="ghost"
              size="icon-sm"
              className="hover:bg-[var(--rose-soft)] hover:text-[var(--rose-ink)]"
              onClick={() => setConfirming(true)}
              disabled={busy}
              aria-label={`Delete the alert on ${subjName}`}
            >
              <Icon name="trash" size={14}/>
            </Button>
          </Tooltip>
        </div>
      </div>

      {a.message && (
        <p className="dsp-message">
          <Icon name="mail" size={12}/>
          <span>{a.message}</span>
        </p>
      )}

      <AlertDialog open={confirming} onOpenChange={(open) => { if (!open) setConfirming(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this alert?</AlertDialogTitle>
            <AlertDialogDescription>
              The alert on {subjName} and its whole fire history are removed. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" loading={busy} disabled={busy} onClick={doDelete}>
              <Icon name="trash" size={14}/>Delete alert
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {editingRec && (
        <RecipientsEditor
          initial={recipients}
          users={users}
          onCancel={() => setEditingRec(false)}
          onSave={doSaveRecipients}
        />
      )}

      {expanded && (
        <div className="dsp-firelog-wrap">
          <div className="dsp-firelog-head">
            <Icon name="clock" size={12}/>
            <span className="dsp-firelog-title">Fire history</span>
            <span className="dsp-firelog-sub">last 12</span>
            <Button variant="ghost" size="xs" onClick={pullFires} disabled={loadingFires}>
              <Icon name="refresh" size={12}/>
              {loadingFires ? "Refreshing…" : "Refresh"}
            </Button>
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
    <section className="dsp">
      <DispatchMasthead lastTick={vitals.lastTick}/>
      <VitalsStrip vitals={vitals}/>

      <div className="dsp-toolbar">
        <div className="dsp-filters" role="group" aria-label="Filter alerts">
          {[
            { k: "all",    label: "All" },
            { k: "active", label: "Active" },
            { k: "paused", label: "Paused" },
          ].map(f => (
            <button key={f.k}
                    type="button"
                    className="dsp-filter"
                    aria-pressed={filter === f.k}
                    onClick={() => setFilter(f.k)}>{f.label}</button>
          ))}
        </div>
        <div className="dsp-toolbar-actions">
          <Tooltip label="Re-fetch alerts and vitals">
            <Button variant="default" size="sm" onClick={refresh} disabled={loading}>
              <Icon name="refresh" size={14}/>Refresh
            </Button>
          </Tooltip>
          <Tooltip label="Run the dispatcher once as this admin session">
            <Button variant="primary" size="sm" onClick={doRunTick} loading={ticking} disabled={ticking}>
              {ticking ? "Ticking…" : <><Icon name="bolt" size={14}/>Run tick now</>}
            </Button>
          </Tooltip>
        </div>
      </div>

      {tickResult && (
        <Alert tone="info" className="dsp-tickbanner items-center">
          <span className="dsp-tickbanner-text">
            {tickResult.disabled
              ? "Dispatcher is disabled (ALERTS_ENABLED ≠ true)."
              : `Processed ${tickResult.processed ?? 0} · sent ${tickResult.sent ?? 0} · failed ${tickResult.failed ?? 0} · skipped ${tickResult.skipped ?? 0}`}
          </span>
          <button
            type="button"
            className="dsp-tickbanner-close"
            onClick={() => setTickResult(null)}
            aria-label="Dismiss the tick summary"
          >
            <Icon name="x" size={13}/>
          </button>
        </Alert>
      )}

      {error && (
        <Alert tone="danger" title="The dispatch log could not be loaded">{error}</Alert>
      )}

      {loading && (
        <div className="dsp-loading" role="status" aria-live="polite">
          <span className="sr-only">Loading dispatch log</span>
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="dsp-loading-row" style={{ opacity: 1 - i * 0.18 }}>
              <div className="min-w-0 flex-1">
                <Skeleton className="h-3.5 w-[46%]"/>
                <Skeleton className="mt-2 h-2.5 w-[70%]"/>
              </div>
              <Skeleton className="size-6 shrink-0 rounded-full"/>
            </div>
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <EmptyState
          icon={AlertsEmptyIcon}
          title={alerts.length === 0 ? "No alerts scheduled" : "Nothing matches this filter"}
          description={
            alerts.length === 0
              ? "Ring the bell icon on any project, invoice, event or lead row to schedule the first one."
              : "Every alert is filtered out. Switch back to All to see the full list."
          }
          action={
            alerts.length === 0
              ? null
              : <Button variant="default" onClick={() => setFilter("all")}>Show all</Button>
          }
        />
      )}

      {filtered.length > 0 && (
        <ul className="dsp-list">
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
      )}

      {toast && (
        <div className="adm-toast" role="status" aria-live="polite">
          <span className="adm-toast-icon" data-tone={toast.icon === "x" ? "danger" : "ok"}>
            <Icon name={toast.icon} size={12} stroke={2.2}/>
          </span>
          <span className="adm-toast-msg">{toast.msg}</span>
        </div>
      )}
    </section>
  );
}
