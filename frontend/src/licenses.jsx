// LicensesTab — Licenses & Certifications status board.
//
// A card board, not a spreadsheet. Each license is a card fronted by a
// days-until-due gauge color-coded by urgency (≤30 / expired = red, 31–60 =
// amber, 61+ = green, no expiry = neutral). Cards group under urgency lanes so
// "what's expiring" reads at a glance. The summary tiles double as filters.
// Click any card to open the edit drawer (every field editable + attachments +
// delete); "Add license" opens the same drawer empty. All writes persist to
// beacon_v2.licenses / license_files.

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Icon } from "./icons.jsx";
import {
  loadLicenses, createLicense, updateLicense, deleteLicense,
  uploadLicenseFile, deleteLicenseFile, licenseFileUrl,
  licenseDaysUntil, licenseBand, licenseRunReminders,
  todayInCT, fmtDate, isAdmin,
} from "./data.js";

// Lane order + presentation, most urgent first.
const LANES = [
  { key: "expired",  label: "Expired",          tone: "red"   },
  { key: "critical", label: "Due within 30 days", tone: "red" },
  { key: "soon",     label: "Due in 31–60 days", tone: "amber" },
  { key: "healthy",  label: "61+ days out",      tone: "green" },
  { key: "none",     label: "No expiration",     tone: "grey"  },
];
const LANE_LABEL = Object.fromEntries(LANES.map(l => [l.key, l.label]));

export function LicensesTab() {
  const today = todayInCT();
  const admin = isAdmin();

  const [items, setItems]   = useState([]);
  const [busy,  setBusy]    = useState(true);
  const [err,   setErr]     = useState(null);
  const [q,     setQ]       = useState("");
  const [lane,  setLane]    = useState("all");      // band filter
  const [typeF, setTypeF]   = useState("all");
  const [stateF,setStateF]  = useState("all");
  const [editing, setEditing] = useState(null);     // license | "new" | null
  const [remindMsg, setRemindMsg] = useState(null);

  const refresh = useCallback(async () => {
    setBusy(true); setErr(null);
    try { setItems(await loadLicenses()); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Annotate with days-until + band once.
  const rows = useMemo(() => items.map(l => {
    const days = licenseDaysUntil(l.expirationDate, today);
    return { ...l, days, band: licenseBand(days) };
  }), [items, today]);

  const counts = useMemo(() => {
    const c = { all: rows.length, expired: 0, critical: 0, soon: 0, healthy: 0, none: 0 };
    for (const r of rows) c[r.band.key]++;
    return c;
  }, [rows]);

  const types  = useMemo(() => [...new Set(rows.map(r => r.type).filter(Boolean))].sort(), [rows]);
  const states = useMemo(() => [...new Set(rows.map(r => r.state).filter(Boolean))].sort(), [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(r => {
      if (lane !== "all" && r.band.key !== lane) return false;
      if (typeF !== "all" && r.type !== typeF) return false;
      if (stateF !== "all" && r.state !== stateF) return false;
      if (needle) {
        const hay = [r.entity, r.type, r.state, r.licenseNo, r.asceMNo, r.notes, ...(r.notifyEmails || [])]
          .join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [rows, q, lane, typeF, stateF]);

  // Sort within a lane: by days ascending (most overdue / soonest first); no-expiry by entity.
  const sortLane = (arr) => [...arr].sort((a, b) => {
    if (a.days == null && b.days == null) return a.entity.localeCompare(b.entity);
    if (a.days == null) return 1;
    if (b.days == null) return -1;
    return a.days - b.days;
  });

  const grouped = useMemo(() => {
    if (lane !== "all") return null;       // flat view when a single lane is filtered
    return LANES.map(L => ({ ...L, rows: sortLane(filtered.filter(r => r.band.key === L.key)) }))
      .filter(g => g.rows.length > 0);
  }, [filtered, lane]);

  const upsertItem = (lic) => setItems(prev => {
    const i = prev.findIndex(x => x.id === lic.id);
    if (i === -1) return [lic, ...prev];
    const next = [...prev]; next[i] = lic; return next;
  });
  const removeItem = (id) => setItems(prev => prev.filter(x => x.id !== id));

  const runReminders = async () => {
    setRemindMsg("Sending…");
    try {
      const { data, error } = await licenseRunReminders();
      if (error) throw error;
      setRemindMsg(`Sent ${data?.sent ?? 0} reminder${data?.sent === 1 ? "" : "s"} · checked ${data?.checked ?? 0}.`);
      refresh();
    } catch (e) {
      setRemindMsg(`Failed: ${e.message || e}`);
    } finally {
      setTimeout(() => setRemindMsg(null), 6000);
    }
  };

  return (
    <div className="licenses-page">
      {/* Action bar — the page title + description come from the shared page
          header (PAGE_META), so we only render the actions here. */}
      <header className="lic-head">
        <div className="lic-head-actions">
          {remindMsg && <span className="lic-remind-msg">{remindMsg}</span>}
          {admin && (
            <button className="btn btn-ghost btn-sm" onClick={runReminders}>
              <Icon name="mail" size={13}/> Send reminders now
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14}/> Add license
          </button>
        </div>
      </header>

      {/* Quick overview — what's expiring in the next 60 days */}
      <ExpiringTimeline
        rows={rows}
        onOpen={(r) => setEditing(r)}
        onShowOverdue={() => setLane("expired")}
      />

      {/* Summary tiles (clickable filters) */}
      <div className="lic-summary" role="tablist" aria-label="Filter by status">
        <SummaryTile active={lane === "all"}     onClick={() => setLane("all")}     tone="neutral" label="All"        count={counts.all}/>
        <SummaryTile active={lane === "expired"} onClick={() => setLane("expired")} tone="red"     label="Expired"    count={counts.expired}/>
        <SummaryTile active={lane === "critical"}onClick={() => setLane("critical")}tone="red"     label="≤ 30 days"  count={counts.critical}/>
        <SummaryTile active={lane === "soon"}    onClick={() => setLane("soon")}    tone="amber"   label="31–60 days" count={counts.soon}/>
        <SummaryTile active={lane === "healthy"} onClick={() => setLane("healthy")} tone="green"   label="61+ days"   count={counts.healthy}/>
        <SummaryTile active={lane === "none"}    onClick={() => setLane("none")}    tone="grey"    label="No expiry"  count={counts.none}/>
      </div>

      {/* Controls */}
      <div className="lic-controls">
        <label className="lic-search">
          <Icon name="search" size={14}/>
          <input type="search" placeholder="Search entity, type, license no, email…"
            value={q} onChange={e => setQ(e.target.value)}/>
          {q && <button className="lic-search-clear" onClick={() => setQ("")} aria-label="Clear"><Icon name="x" size={11}/></button>}
        </label>
        <select className="lic-select" value={typeF} onChange={e => setTypeF(e.target.value)}>
          <option value="all">All types</option>
          {types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="lic-select" value={stateF} onChange={e => setStateF(e.target.value)}>
          <option value="all">All states</option>
          {states.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {err && <div className="lic-err"><Icon name="warn" size={13}/> {err}</div>}

      {/* Board */}
      {busy && rows.length === 0 ? (
        <div className="lic-empty">Loading licenses…</div>
      ) : filtered.length === 0 ? (
        <div className="lic-empty">
          <Icon name="shield" size={22}/>
          <span>{rows.length === 0 ? "No licenses yet. Click “Add license” to create one." : "Nothing matches your filters."}</span>
        </div>
      ) : grouped ? (
        grouped.map(g => (
          <section key={g.key} className="lic-lane">
            <header className={`lic-lane-head tone-${g.tone}`}>
              <span className="lic-lane-dot"/>
              <h3>{g.label}</h3>
              <span className="lic-lane-count">{g.rows.length}</span>
            </header>
            <div className="lic-grid">
              {g.rows.map(r => <LicenseCard key={r.id} lic={r} onEdit={() => setEditing(r)}/>)}
            </div>
          </section>
        ))
      ) : (
        <div className="lic-grid lic-grid-flat">
          {sortLane(filtered).map(r => <LicenseCard key={r.id} lic={r} onEdit={() => setEditing(r)}/>)}
        </div>
      )}

      {editing && (
        <LicenseDrawer
          license={editing === "new" ? null : editing}
          knownTypes={types}
          knownStates={states}
          today={today}
          onClose={() => setEditing(null)}
          onSaved={(lic) => { upsertItem(lic); setEditing(prev => (prev === "new" ? lic : prev)); }}
          onDeleted={(id) => { removeItem(id); setEditing(null); }}
        />
      )}
    </div>
  );
}

function SummaryTile({ active, onClick, tone, label, count }) {
  return (
    <button type="button" role="tab" aria-selected={active}
      className={`lic-tile tone-${tone} ${active ? "is-active" : ""}`} onClick={onClick}>
      <span className="lic-tile-count">{count}</span>
      <span className="lic-tile-label">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Expiring-soon timeline — a today→+60d runway. Each license due in the window
// is plotted by its exact days-until-due and alternates above/below the axis so
// labels don't collide. Click a marker to open it; the overdue count links to
// the Expired lane.
// ---------------------------------------------------------------------------
const TL_WINDOW = 60;
function ExpiringTimeline({ rows, onOpen, onShowOverdue }) {
  const soon = useMemo(
    () => rows.filter(r => r.days != null && r.days >= 0 && r.days <= TL_WINDOW).sort((a, b) => a.days - b.days),
    [rows],
  );
  const overdue = useMemo(() => rows.filter(r => r.days != null && r.days < 0).length, [rows]);

  // Map days∈[0,60] → [6%,94%] so flags never clip the track edges.
  const posOf = (days) => 6 + (days / TL_WINDOW) * 88;

  return (
    <section className="lic-timeline">
      <header className="lic-timeline-head">
        <h3><Icon name="clock" size={14}/> Expiring soon</h3>
        <span className="lic-timeline-sub">
          Next 60 days · {soon.length} license{soon.length === 1 ? "" : "s"}
          {overdue > 0 && (
            <> · <button type="button" className="lic-tl-overdue" onClick={onShowOverdue}>{overdue} overdue</button></>
          )}
        </span>
      </header>

      {soon.length === 0 ? (
        <div className="lic-timeline-empty">
          <Icon name="check" size={14}/> Nothing expiring in the next 60 days.
        </div>
      ) : (
        <div className="lic-timeline-scroll">
          <div className="lic-timeline-track">
            <div className="lic-tl-zone lic-tl-zone-red"/>
            <div className="lic-tl-zone lic-tl-zone-amber"/>
            <div className="lic-tl-axis"/>
            <div className="lic-tl-divider"/>
            <span className="lic-tl-axis-label start">Today</span>
            <span className="lic-tl-axis-label mid">30 days</span>
            <span className="lic-tl-axis-label end">60 days</span>

            {soon.map((r, i) => (
              <button
                key={r.id}
                type="button"
                className={`lic-tl-marker tone-${r.band.tone} ${i % 2 === 0 ? "is-above" : "is-below"}`}
                style={{ left: `${posOf(r.days)}%` }}
                onClick={() => onOpen(r)}
                title={`${r.entity} — expires ${fmtDate(r.expirationDate)} (${r.days} day${r.days === 1 ? "" : "s"})`}
              >
                <span className="lic-tl-flag">
                  <span className="lic-tl-flag-name">{r.entity}</span>
                  <span className="lic-tl-flag-days">{r.days}d · {fmtDate(r.expirationDate)}</span>
                </span>
                <span className="lic-tl-stem"/>
                <span className="lic-tl-dot"/>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Card + days-until ring
// ---------------------------------------------------------------------------
function LicenseCard({ lic, onEdit }) {
  const { days, band } = lic;
  return (
    <button type="button" className="lic-card" data-band={band.key} onClick={onEdit}>
      <span className={`lic-card-spine tone-${band.tone}`}/>
      <DaysRing days={days} band={band}/>
      <div className="lic-card-body">
        <div className="lic-card-entity" title={lic.entity}>{lic.entity}</div>
        <div className="lic-card-chips">
          {lic.type  && <span className="lic-chip">{lic.type}</span>}
          {lic.state && <span className="lic-chip lic-chip-ghost">{lic.state}</span>}
        </div>
        <div className="lic-card-exp">
          <Icon name="calendar" size={12}/>
          {lic.expirationDate ? <>Expires {fmtDate(lic.expirationDate)}</> : <span className="lic-muted">No expiration</span>}
        </div>
        {(lic.licenseNo || lic.asceMNo) && (
          <div className="lic-card-meta">
            {lic.licenseNo && <span className="lic-meta" title="License no"><Icon name="hash" size={11}/>{lic.licenseNo}</span>}
            {lic.asceMNo   && <span className="lic-meta" title="ASCE M no">ASCE {lic.asceMNo}</span>}
          </div>
        )}
        <div className="lic-card-foot">
          <span className={`lic-foot-pill ${lic.emailEnabled ? "is-on" : "is-off"}`}
            title={lic.emailEnabled ? `Reminders on · ${lic.notifyEmails.length} recipient(s)` : "Reminders off"}>
            <Icon name="mail" size={11}/>{lic.notifyEmails.length}
          </span>
          {lic.files.length > 0 && (
            <span className="lic-foot-pill" title={`${lic.files.length} attachment(s)`}>
              <Icon name="link" size={11}/>{lic.files.length}
            </span>
          )}
          {lic.notes && <span className="lic-foot-note" title={lic.notes}><Icon name="note" size={11}/></span>}
        </div>
      </div>
    </button>
  );
}

function DaysRing({ days, band }) {
  const R = 26, C = 2 * Math.PI * R;
  const frac = days == null ? 1 : Math.max(0, Math.min(1, days / 90));
  const offset = C * (1 - frac);
  const num = days == null ? "—" : Math.abs(days);
  const lbl = days == null ? "no expiry"
    : days < 0  ? (Math.abs(days) === 1 ? "day overdue" : "days overdue")
    : days === 0 ? "due today"
    : days === 1 ? "day left" : "days left";
  return (
    <div className={`lic-ring tone-${band.tone}`} aria-hidden="true">
      <svg viewBox="0 0 64 64" width="60" height="60">
        <circle cx="32" cy="32" r={R} className="lic-ring-track" strokeWidth="5" fill="none"/>
        {days == null ? (
          <circle cx="32" cy="32" r={R} className="lic-ring-none" strokeWidth="5" fill="none" strokeDasharray="2 6"/>
        ) : (
          <circle cx="32" cy="32" r={R} className="lic-ring-fill" strokeWidth="5" fill="none"
            strokeDasharray={C} strokeDashoffset={offset} strokeLinecap="round"
            transform="rotate(-90 32 32)"/>
        )}
      </svg>
      <div className="lic-ring-center">
        <span className="lic-ring-num">{num}</span>
        <span className="lic-ring-lbl">{lbl}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit / create drawer
// ---------------------------------------------------------------------------
const BLANK = {
  entity: "", state: "", type: "", licenseNo: "", asceMNo: "",
  firstIssueDate: "", expirationDate: "", notifyEmails: [], emailEnabled: true, notes: "",
};

function LicenseDrawer({ license, knownTypes, knownStates, today, onClose, onSaved, onDeleted }) {
  const isNew = !license;
  const [form, setForm] = useState(() => license ? {
    entity: license.entity, state: license.state, type: license.type,
    licenseNo: license.licenseNo, asceMNo: license.asceMNo,
    firstIssueDate: license.firstIssueDate || "", expirationDate: license.expirationDate || "",
    notifyEmails: [...license.notifyEmails], emailEnabled: license.emailEnabled, notes: license.notes,
  } : { ...BLANK });
  const [files, setFiles] = useState(license?.files || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [upBusy, setUpBusy] = useState(false);
  const fileRef = useRef(null);
  const id = license?.id || null;

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const previewDays = licenseDaysUntil(form.expirationDate || null, today);
  const previewBand = licenseBand(previewDays);

  const save = async () => {
    if (!form.entity.trim()) { setErr("Entity is required."); return; }
    setBusy(true); setErr(null);
    try {
      const lic = id ? await updateLicense(id, form) : await createLicense(form);
      onSaved(lic);
      onClose();
    } catch (e) { setErr(e.message || "save failed"); }
    finally { setBusy(false); }
  };

  const doDelete = async () => {
    setBusy(true); setErr(null);
    try { await deleteLicense(id); onDeleted(id); }
    catch (e) { setErr(e.message || "delete failed"); setBusy(false); }
  };

  const onUpload = async (e) => {
    const picked = Array.from(e.target.files || []);
    if (!picked.length || !id) return;
    setUpBusy(true); setErr(null);
    try {
      const added = [];
      for (const f of picked) added.push(await uploadLicenseFile(id, f));
      const next = [...files, ...added];
      setFiles(next);
      onSaved({ ...license, files: next });
    } catch (e2) { setErr(e2.message || "upload failed"); }
    finally { setUpBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const removeFile = async (fileRow) => {
    try {
      await deleteLicenseFile(fileRow);
      const next = files.filter(f => f.id !== fileRow.id);
      setFiles(next);
      onSaved({ ...license, files: next });
    } catch (e) { setErr(e.message || "remove failed"); }
  };

  const openFile = async (fileRow) => {
    try { const url = await licenseFileUrl(fileRow.path); if (url) window.open(url, "_blank", "noopener"); }
    catch (e) { setErr(e.message || "could not open file"); }
  };

  return (
    <div className="lic-drawer-backdrop" onClick={onClose}>
      <aside className="lic-drawer" onClick={e => e.stopPropagation()}>
        <header className="lic-drawer-head">
          <div>
            <div className="lic-drawer-eyebrow">{isNew ? "New" : "Edit"} license</div>
            <h3 className="lic-drawer-title">{form.entity || "Untitled license"}</h3>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close"><Icon name="x" size={16}/></button>
        </header>

        <div className="lic-drawer-body">
          {/* Days-until preview */}
          <div className={`lic-drawer-preview tone-${previewBand.tone}`}>
            <DaysRing days={previewDays} band={previewBand}/>
            <div className="lic-drawer-preview-text">
              <strong>{previewBand.label}</strong>
              <span>{form.expirationDate ? `Expires ${fmtDate(form.expirationDate)}` : "No expiration set"}</span>
            </div>
          </div>

          <label className="lic-field">
            <span className="lic-field-label">Entity <em>*</em></span>
            <input className="form-input" value={form.entity} onChange={e => set("entity", e.target.value)}
              placeholder="MSMM Engineering, LLC / Jim Wilson"/>
          </label>

          <div className="lic-field-row">
            <label className="lic-field">
              <span className="lic-field-label">Type</span>
              <input className="form-input" list="lic-types" value={form.type}
                onChange={e => set("type", e.target.value)} placeholder="P.E. License"/>
              <datalist id="lic-types">{knownTypes.map(t => <option key={t} value={t}/>)}</datalist>
            </label>
            <label className="lic-field">
              <span className="lic-field-label">State</span>
              <input className="form-input" list="lic-states" value={form.state}
                onChange={e => set("state", e.target.value)} placeholder="LA"/>
              <datalist id="lic-states">{knownStates.map(s => <option key={s} value={s}/>)}</datalist>
            </label>
          </div>

          <div className="lic-field-row">
            <label className="lic-field">
              <span className="lic-field-label">License no</span>
              <input className="form-input" value={form.licenseNo} onChange={e => set("licenseNo", e.target.value)}/>
            </label>
            <label className="lic-field">
              <span className="lic-field-label">ASCE M no</span>
              <input className="form-input" value={form.asceMNo} onChange={e => set("asceMNo", e.target.value)}/>
            </label>
          </div>

          <div className="lic-field-row">
            <label className="lic-field">
              <span className="lic-field-label">First issue date</span>
              <input type="date" className="form-input" value={form.firstIssueDate || ""}
                onChange={e => set("firstIssueDate", e.target.value)}/>
            </label>
            <label className="lic-field">
              <span className="lic-field-label">Expiration date</span>
              <input type="date" className="form-input" value={form.expirationDate || ""}
                onChange={e => set("expirationDate", e.target.value)}/>
            </label>
          </div>

          <div className="lic-field">
            <span className="lic-field-label">Notification emails</span>
            <EmailChips value={form.notifyEmails} onChange={v => set("notifyEmails", v)}/>
            <span className="form-help" style={{ margin: "4px 0 0" }}>Type an address and press Enter or comma.</span>
          </div>

          <label className="lic-toggle-row">
            <span className="lic-field-label" style={{ margin: 0 }}>Email reminders</span>
            <button type="button" className={`lic-toggle ${form.emailEnabled ? "on" : ""}`}
              onClick={() => set("emailEnabled", !form.emailEnabled)}
              aria-pressed={form.emailEnabled}>
              <span className="lic-toggle-knob"/>
            </button>
            <span className="lic-toggle-state">{form.emailEnabled ? "On" : "Off"}</span>
          </label>

          <label className="lic-field">
            <span className="lic-field-label">Notes</span>
            <textarea className="form-input" rows={3} value={form.notes}
              onChange={e => set("notes", e.target.value)} placeholder="Renewal notes, submittal status…"/>
          </label>

          {/* Attachments */}
          <div className="lic-field">
            <span className="lic-field-label">Attachments</span>
            {isNew ? (
              <p className="form-help" style={{ margin: 0 }}>Save the license first to attach files.</p>
            ) : (
              <div className="lic-files">
                {files.map(f => (
                  <div key={f.id} className="lic-file-row">
                    <button type="button" className="lic-file-name" onClick={() => openFile(f)} title="Open">
                      <Icon name="link" size={12}/> {f.name}
                    </button>
                    <button type="button" className="lic-file-del" onClick={() => removeFile(f)} aria-label="Remove file">
                      <Icon name="trash" size={12}/>
                    </button>
                  </div>
                ))}
                {files.length === 0 && <p className="form-help" style={{ margin: 0 }}>No files attached.</p>}
                <label className="lic-file-add">
                  <input ref={fileRef} type="file" multiple onChange={onUpload} hidden/>
                  <span className="btn btn-ghost btn-sm">{upBusy ? "Uploading…" : "+ Add file"}</span>
                </label>
              </div>
            )}
          </div>

          {err && <div className="form-error">{err}</div>}
        </div>

        <footer className="lic-drawer-foot">
          {!isNew && (
            confirmDel ? (
              <div className="lic-confirm-del">
                <span>Delete this license?</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(false)} disabled={busy}>Cancel</button>
                <button className="btn btn-danger btn-sm" onClick={doDelete} disabled={busy}>Delete</button>
              </div>
            ) : (
              <button className="btn btn-ghost btn-danger-ghost" onClick={() => setConfirmDel(true)} disabled={busy}>
                <Icon name="trash" size={13}/> Delete
              </button>
            )
          )}
          <div className="lic-drawer-foot-right">
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? "Saving…" : isNew ? "Create license" : "Save"}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

function EmailChips({ value, onChange }) {
  const [draft, setDraft] = useState("");
  const add = (raw) => {
    const parts = String(raw).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setDraft("");
  };
  return (
    <div className="lic-emailchips">
      {value.map((e, i) => (
        <span key={`${e}-${i}`} className="lic-emailchip">
          {e}
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${e}`}>
            <Icon name="x" size={9}/>
          </button>
        </span>
      ))}
      <input
        className="lic-emailchip-input"
        value={draft}
        placeholder={value.length ? "Add…" : "email@msmmeng.com"}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); }
          else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => { if (draft.trim()) add(draft); }}
      />
    </div>
  );
}
