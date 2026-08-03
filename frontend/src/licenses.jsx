// LicensesTab — Licenses & Certifications register.
//
// Urgency is the whole point of this page, so it is stated three ways at
// once: a 60-day runway across the top, a status filter strip, and a
// per-row band badge. The band itself comes from licenseBand() in data.js
// and is never recomputed here — this file only decides how it looks.
//
// Colour is never the sole signal. Every band renders an icon and a word
// ("Expired", "12 days left") alongside its tint, so the register stays
// readable in greyscale and for colour-blind users.
//
// Clicking a row (or its Edit control) opens the same dialog used by "Add
// license" — every field editable, plus attachments and delete. All writes
// persist to beacon_v2.licenses / license_files.

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Icon } from "./icons.jsx";
import {
  Alert, AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger, EmptyState,
  Field, Input, InputGroup, Label, SkeletonTable, Switch, Textarea,
  Tooltip, TooltipProvider,
} from "@/ui";
import {
  loadLicenses, createLicense, updateLicense, deleteLicense,
  uploadLicenseFile, deleteLicenseFile, licenseFileUrl,
  licenseDaysUntil, licenseBand, licenseRunReminders,
  todayInCT, fmtDate, isAdmin,
} from "./data.js";

// Lane order + presentation, most urgent first. Keys and order match
// licenseBand()'s `key` values exactly.
const LANES = [
  { key: "expired",  label: "Expired",            tone: "red"   },
  { key: "critical", label: "Due within 30 days", tone: "red"   },
  { key: "soon",     label: "Due in 31–60 days",  tone: "amber" },
  { key: "healthy",  label: "61+ days out",       tone: "green" },
  { key: "none",     label: "No expiration",      tone: "grey"  },
];

// How each band is DRAWN. `icon` and `short` exist so the band is legible
// without colour; `badge` picks the semantic token family (clay = expired
// or critical, ochre = approaching, sage = healthy, neutral = no expiry).
const BAND_UI = {
  expired:  { icon: "danger",      badge: "danger",  short: "Expired"     },
  critical: { icon: "warn",        badge: "danger",  short: "Due ≤ 30 days" },
  soon:     { icon: "clock",       badge: "brand",   short: "Due 31–60 days" },
  healthy:  { icon: "checkCircle", badge: "success", short: "61+ days"    },
  none:     { icon: "minus",       badge: "neutral", short: "No expiry"   },
};
const bandUi = (key) => BAND_UI[key] || BAND_UI.none;

const shieldIcon  = (props) => <Icon name="shield"  size={20} {...props} />;
const filterIcon  = (props) => <Icon name="filter"  size={20} {...props} />;

// Plain-text day count, for accessible names and tooltips.
function daysText(days) {
  if (days == null) return "No expiry";
  const n = Math.abs(days);
  if (days < 0)   return `${n} day${n === 1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  return `${n} day${n === 1 ? "" : "s"} left`;
}

// Same string, with the numeral in tabular figures.
function DaysLabel({ days }) {
  if (days == null) return <>No expiry</>;
  const n = Math.abs(days);
  if (days < 0)   return <><span className="num">{n}</span> day{n === 1 ? "" : "s"} overdue</>;
  if (days === 0) return <>Due today</>;
  return <><span className="num">{n}</span> day{n === 1 ? "" : "s"} left</>;
}

function BandBadge({ band, days, className }) {
  const ui = bandUi(band.key);
  return (
    <Badge tone={ui.badge} className={className}>
      <Icon name={ui.icon} size={12} />
      <DaysLabel days={days} />
    </Badge>
  );
}

const Dash = () => <span className="lcx-dash" aria-hidden="true">–</span>;

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

  // One section per lane when nothing is filtered, otherwise a single
  // unlabelled section holding the same sorted rows.
  const sections = grouped || [{ key: "flat", label: null, rows: sortLane(filtered) }];
  const filtersOn = lane !== "all" || typeF !== "all" || stateF !== "all" || q.trim() !== "";

  return (
    <TooltipProvider delayDuration={250}>
      <div className="lcx-page">
        {/* Action bar. The page title + description come from the shared
            page header (PAGE_META), so only the actions live here. */}
        <div className="lcx-actions">
          {remindMsg && <span className="lcx-remindmsg" role="status">{remindMsg}</span>}
          {admin && (
            <Button variant="default" onClick={runReminders}>
              <Icon name="mail" size={14} /> Send reminders now
            </Button>
          )}
          <Button variant="primary" onClick={() => setEditing("new")}>
            <Icon name="plus" size={15} /> Add license
          </Button>
        </div>

        {/* Quick overview — what's expiring in the next 60 days */}
        <ExpiringTimeline
          rows={rows}
          onOpen={(r) => setEditing(r)}
          onShowOverdue={() => setLane("expired")}
        />

        <section className="lcx-register" aria-labelledby="lcx-register-head">
          <div className="bx-sectionhead">
            <h2 id="lcx-register-head">All licenses</h2>
            <span className="bx-rule" />
            <p className="lcx-count">
              <span className="num">{filtered.length}</span>
              {filtered.length === rows.length ? " total" : <> of <span className="num">{rows.length}</span></>}
            </p>
          </div>

          {/* Status filter strip. Each entry pairs a tint with an icon and a
              word so the band is never signalled by colour alone. */}
          <div className="lcx-filters bx-scroll-x" role="group" aria-label="Filter by expiry status">
            <StatusFilter active={lane === "all"} onClick={() => setLane("all")} bandKey={null}
              icon="checklist" label="All" count={counts.all} />
            {LANES.map(L => (
              <StatusFilter key={L.key} active={lane === L.key} onClick={() => setLane(L.key)}
                bandKey={L.key} icon={bandUi(L.key).icon} label={bandUi(L.key).short} count={counts[L.key]} />
            ))}
          </div>

          {/* Search + attribute filters */}
          <div className="lcx-toolbar">
            <InputGroup
              type="search"
              className="lcx-search"
              aria-label="Search licenses"
              placeholder="Search entity, type, license no, email…"
              value={q}
              onChange={e => setQ(e.target.value)}
              leading={<Icon name="search" size={15} />}
              trailing={q ? (
                <button type="button" className="lcx-clear" onClick={() => setQ("")} aria-label="Clear search">
                  <Icon name="x" size={13} />
                </button>
              ) : null}
            />
            <FilterMenu label="Type"  allLabel="All types"  value={typeF}  options={types}  onChange={setTypeF} />
            <FilterMenu label="State" allLabel="All states" value={stateF} options={states} onChange={setStateF} />
          </div>

          {err && (
            <Alert tone="danger" title="Could not load licenses">{err}</Alert>
          )}

          {busy && rows.length === 0 ? (
            <SkeletonTable rows={6} cols={7} />
          ) : filtered.length === 0 ? (
            rows.length === 0 ? (
              <EmptyState
                icon={shieldIcon}
                title="No licenses tracked yet"
                description="Add a company or individual license with its expiration date and Beacon will count down to it, group it by urgency, and email the people you list at 60, 30, 14, 7 and 1 days out."
                action={<Button variant="primary" onClick={() => setEditing("new")}><Icon name="plus" size={15} /> Add license</Button>}
              />
            ) : (
              <EmptyState
                icon={filterIcon}
                title="No licenses match these filters"
                description="Nothing in the register matches the current status, type, state and search combination. Widen a filter or clear the search to see the rest."
                action={filtersOn ? (
                  <Button variant="default" onClick={() => { setLane("all"); setTypeF("all"); setStateF("all"); setQ(""); }}>
                    <Icon name="undo" size={14} /> Reset filters
                  </Button>
                ) : null}
              />
            )
          ) : (
            <div className="lcx-tablewrap bx-scroll-x">
              <table className="lcx-table">
                <caption className="sr-only">
                  Licenses and certifications, sorted by days until expiry.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Entity</th>
                    <th scope="col">Type</th>
                    <th scope="col">State</th>
                    <th scope="col">License no</th>
                    <th scope="col">Expires</th>
                    <th scope="col">Reminders</th>
                    <th scope="col"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                {sections.map(g => (
                  <tbody key={g.key}>
                    {g.label && (
                      <tr className="lcx-grouprow">
                        <th scope="colgroup" colSpan={8}>
                          <span className={`lcx-groupmark lcx-band-${g.key}`} aria-hidden="true">
                            <Icon name={bandUi(g.key).icon} size={13} />
                          </span>
                          <span className="lcx-grouplabel">{g.label}</span>
                          <span className="lcx-groupcount num">{g.rows.length}</span>
                        </th>
                      </tr>
                    )}
                    {g.rows.map(r => (
                      <LicenseRow key={r.id} lic={r} onEdit={() => setEditing(r)} />
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </section>

        {editing && (
          <LicenseDialog
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
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Filter controls
// ---------------------------------------------------------------------------
function StatusFilter({ active, onClick, bandKey, icon, label, count }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${label}, ${count} license${count === 1 ? "" : "s"}`}
      className={`lcx-filter ${bandKey ? `lcx-band-${bandKey}` : "lcx-band-all"}`}
    >
      <Icon name={icon} size={14} className="lcx-filter-icon" />
      <span className="lcx-filter-label">{label}</span>
      <span className="lcx-filter-count num">{count}</span>
    </button>
  );
}

function FilterMenu({ label, allLabel, value, options, onChange }) {
  const isOn = value !== "all";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="default"
          className={`lcx-filtermenu ${isOn ? "is-on" : ""}`}
          aria-label={`${label}: ${isOn ? value : allLabel}`}
        >
          <span className="lcx-filtermenu-text">{isOn ? value : allLabel}</span>
          <Icon name="chevronDown" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value="all">{allLabel}</DropdownMenuRadioItem>
          {options.map(o => (
            <DropdownMenuRadioItem key={o} value={o}>{o}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
    <section className="lcx-tl" aria-labelledby="lcx-tl-head">
      <div className="bx-sectionhead">
        <h2 id="lcx-tl-head">Expiring soon</h2>
        <span className="bx-rule" />
        <p className="lcx-tl-sub">
          Next 60 days, <span className="num">{soon.length}</span> license{soon.length === 1 ? "" : "s"}
        </p>
        {overdue > 0 && (
          <Button
            variant="destructive-soft"
            size="xs"
            onClick={onShowOverdue}
            aria-label={`Show ${overdue} overdue license${overdue === 1 ? "" : "s"}`}
          >
            <Icon name="danger" size={13} />
            <span className="num">{overdue}</span> overdue
          </Button>
        )}
      </div>

      {soon.length === 0 ? (
        <p className="lcx-tl-empty">
          <Icon name="checkCircle" size={15} />
          Nothing expiring in the next 60 days.
        </p>
      ) : (
        <div className="lcx-tl-scroll bx-scroll-x">
          <div className="lcx-tl-track">
            <div className="lcx-tl-zone lcx-tl-zone-near" aria-hidden="true" />
            <div className="lcx-tl-zone lcx-tl-zone-far" aria-hidden="true" />
            <div className="lcx-tl-axis" aria-hidden="true" />
            <div className="lcx-tl-divider" aria-hidden="true" />
            <span className="lcx-tl-tick start">Today</span>
            <span className="lcx-tl-tick mid num">30 days</span>
            <span className="lcx-tl-tick end num">60 days</span>

            {/* The <button> is the flag itself so the focus ring lands on a
                real box rather than on the zero-width marker column. */}
            {soon.map((r, i) => (
              <div
                key={r.id}
                className={`lcx-tl-marker lcx-band-${r.band.key} ${i % 2 === 0 ? "is-above" : "is-below"}`}
                style={{ left: `${posOf(r.days)}%` }}
              >
                <span className="lcx-tl-stem" aria-hidden="true" />
                <span className="lcx-tl-dot" aria-hidden="true" />
                <button
                  type="button"
                  className="lcx-tl-flag"
                  onClick={() => onOpen(r)}
                  aria-label={`${r.entity}, expires ${fmtDate(r.expirationDate)}, ${daysText(r.days)}. Open to edit.`}
                >
                  <span className="lcx-tl-flag-name">{r.entity}</span>
                  <span className="lcx-tl-flag-days">
                    <Icon name={bandUi(r.band.key).icon} size={10} />
                    <DaysLabel days={r.days} />
                  </span>
                  <span className="lcx-tl-flag-date num">{fmtDate(r.expirationDate)}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Register row
// ---------------------------------------------------------------------------
function LicenseRow({ lic, onEdit }) {
  const { days, band } = lic;
  const open = (e) => { e.stopPropagation(); onEdit(); };
  return (
    <tr className={`lcx-row lcx-band-${band.key}`} onClick={onEdit}>
      <td className="lcx-cell-status" data-label="Status">
        <BandBadge band={band} days={days} />
      </td>

      <td className="lcx-cell-entity" data-label="Entity">
        <button type="button" className="lcx-rowbtn" onClick={open}>{lic.entity}</button>
        {(lic.files.length > 0 || lic.notes) && (
          <span className="lcx-rowmeta">
            {lic.files.length > 0 && (
              <span className="lcx-metaitem">
                <Icon name="attachment" size={11} />
                <span className="num">{lic.files.length}</span>
                <span className="sr-only"> attachment{lic.files.length === 1 ? "" : "s"}</span>
              </span>
            )}
            {lic.notes && (
              <span className="lcx-metaitem"><Icon name="note" size={11} /> Notes</span>
            )}
          </span>
        )}
      </td>

      <td data-label="Type">{lic.type || <Dash />}</td>
      <td data-label="State">{lic.state || <Dash />}</td>

      <td className="lcx-cell-no" data-label="License no">
        {lic.licenseNo ? <span className="num">{lic.licenseNo}</span> : <Dash />}
        {lic.asceMNo && <span className="lcx-subline">ASCE <span className="num">{lic.asceMNo}</span></span>}
      </td>

      <td className="lcx-cell-exp" data-label="Expires">
        {lic.expirationDate ? <span className="num">{fmtDate(lic.expirationDate)}</span> : <Dash />}
      </td>

      <td data-label="Reminders">
        <Badge tone={lic.emailEnabled ? "neutral" : "outline"} className={lic.emailEnabled ? "" : "opacity-70"}>
          <Icon name={lic.emailEnabled ? "bellRing" : "ban"} size={11} />
          {lic.emailEnabled
            ? <><span className="num">{lic.notifyEmails.length}</span> on</>
            : "Off"}
        </Badge>
      </td>

      <td className="lcx-cell-actions">
        <Tooltip label={`Edit ${lic.entity}`}>
          <Button variant="ghost" size="icon-sm" onClick={open} aria-label={`Edit ${lic.entity}`}>
            <Icon name="edit" size={14} />
          </Button>
        </Tooltip>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Edit / create dialog
// ---------------------------------------------------------------------------
const BLANK = {
  entity: "", state: "", type: "", licenseNo: "", asceMNo: "",
  firstIssueDate: "", expirationDate: "", notifyEmails: [], emailEnabled: true, notes: "",
};

function LicenseDialog({ license, knownTypes, knownStates, today, onClose, onSaved, onDeleted }) {
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

  // Purely decorative runway fill: 90 days of headroom, clamped.
  const meterFrac = previewDays == null ? 1 : Math.max(0, Math.min(1, previewDays / 90));
  const entityInvalid = !!err && !form.entity.trim();

  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent size="lg" aria-describedby="lcx-dialog-desc">
          <DialogHeader>
            <DialogTitle>{isNew ? "New license" : (form.entity || "Untitled license")}</DialogTitle>
            <DialogDescription id="lcx-dialog-desc">
              {isNew
                ? "Track a company or individual license, its expiration, and who gets reminded."
                : "Edit details, reminder recipients, and attachments."}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="lcx-form">
            {/* Days-until preview */}
            <div className={`lcx-preview lcx-band-${previewBand.key}`}>
              <div className="lcx-preview-top">
                <Badge tone={bandUi(previewBand.key).badge}>
                  <Icon name={bandUi(previewBand.key).icon} size={12} />
                  {previewBand.label}
                </Badge>
                <span className="lcx-preview-days"><DaysLabel days={previewDays} /></span>
              </div>
              <div className="lcx-meter" aria-hidden="true">
                <span style={{ width: `${meterFrac * 100}%` }} />
              </div>
              <p className="lcx-preview-sub">
                {form.expirationDate
                  ? <>Expires <span className="num">{fmtDate(form.expirationDate)}</span></>
                  : "No expiration set"}
              </p>
            </div>

            <Field label="Entity" htmlFor="lcx-entity" required>
              <Input
                id="lcx-entity"
                value={form.entity}
                onChange={e => set("entity", e.target.value)}
                aria-invalid={entityInvalid || undefined}
                placeholder="MSMM Engineering, LLC / Jim Wilson"
              />
            </Field>

            <div className="lcx-form-row">
              <Field label="Type" htmlFor="lcx-type">
                <Input id="lcx-type" list="lcx-types" value={form.type}
                  onChange={e => set("type", e.target.value)} placeholder="P.E. License" />
                <datalist id="lcx-types">{knownTypes.map(t => <option key={t} value={t} />)}</datalist>
              </Field>
              <Field label="State" htmlFor="lcx-state">
                <Input id="lcx-state" list="lcx-states" value={form.state}
                  onChange={e => set("state", e.target.value)} placeholder="LA" />
                <datalist id="lcx-states">{knownStates.map(s => <option key={s} value={s} />)}</datalist>
              </Field>
            </div>

            <div className="lcx-form-row">
              <Field label="License no" htmlFor="lcx-licenseno">
                <Input id="lcx-licenseno" className="num" value={form.licenseNo}
                  onChange={e => set("licenseNo", e.target.value)} />
              </Field>
              <Field label="ASCE M no" htmlFor="lcx-asce">
                <Input id="lcx-asce" className="num" value={form.asceMNo}
                  onChange={e => set("asceMNo", e.target.value)} />
              </Field>
            </div>

            <div className="lcx-form-row">
              <Field label="First issue date" htmlFor="lcx-first">
                <Input id="lcx-first" type="date" className="num" value={form.firstIssueDate || ""}
                  onChange={e => set("firstIssueDate", e.target.value)} />
              </Field>
              <Field label="Expiration date" htmlFor="lcx-exp">
                <Input id="lcx-exp" type="date" className="num" value={form.expirationDate || ""}
                  onChange={e => set("expirationDate", e.target.value)} />
              </Field>
            </div>

            <Field
              label="Notification emails"
              htmlFor="lcx-emails"
              hint="Type an address and press Enter or comma."
            >
              <EmailChips inputId="lcx-emails" value={form.notifyEmails} onChange={v => set("notifyEmails", v)} />
            </Field>

            <div className="lcx-switchrow">
              <div className="lcx-switchtext">
                <Label htmlFor="lcx-remind">Email reminders</Label>
                <p>Sent at 60, 30, 14, 7 and 1 days before expiry.</p>
              </div>
              <Switch
                id="lcx-remind"
                checked={form.emailEnabled}
                onCheckedChange={() => set("emailEnabled", !form.emailEnabled)}
              />
              <span className="lcx-switchstate">{form.emailEnabled ? "On" : "Off"}</span>
            </div>

            <Field label="Notes" htmlFor="lcx-notes">
              <Textarea id="lcx-notes" rows={3} value={form.notes}
                onChange={e => set("notes", e.target.value)} placeholder="Renewal notes, submittal status…" />
            </Field>

            {/* Attachments */}
            <Field label="Attachments">
              {isNew ? (
                <p className="lcx-hint">Save the license first to attach files.</p>
              ) : (
                <div className="lcx-files">
                  {files.map(f => (
                    <div key={f.id} className="lcx-file">
                      <button type="button" className="lcx-file-name" onClick={() => openFile(f)}>
                        <Icon name="attachment" size={13} />
                        <span className="bx-truncate">{f.name}</span>
                        <span className="sr-only">, open in a new tab</span>
                      </button>
                      <Tooltip label="Remove file">
                        <Button variant="ghost" size="icon-sm" onClick={() => removeFile(f)}
                          aria-label={`Remove ${f.name}`}>
                          <Icon name="trash" size={13} />
                        </Button>
                      </Tooltip>
                    </div>
                  ))}
                  {files.length === 0 && <p className="lcx-hint">No files attached.</p>}
                  <input ref={fileRef} type="file" multiple onChange={onUpload} hidden />
                  <Button variant="subtle" size="sm" loading={upBusy}
                    onClick={() => fileRef.current?.click()}>
                    {upBusy ? "Uploading…" : <><Icon name="upload" size={14} /> Add file</>}
                  </Button>
                </div>
              )}
            </Field>

            {err && <Alert tone="danger">{err}</Alert>}
          </DialogBody>

          <DialogFooter>
            {!isNew && (
              <Button variant="destructive-soft" onClick={() => setConfirmDel(true)} disabled={busy}
                className="sm:mr-auto">
                <Icon name="trash" size={14} /> Delete
              </Button>
            )}
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={save} loading={busy}>
              {busy ? "Saving…" : isNew ? "Create license" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this license?</AlertDialogTitle>
            <AlertDialogDescription>
              {form.entity || "This license"} and its attachments will be removed from the register,
              and its reminder emails will stop. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={doDelete} disabled={busy}>
              Delete license
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function EmailChips({ value, onChange, inputId }) {
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
    <div className="lcx-chips">
      {value.map((e, i) => (
        <span key={`${e}-${i}`} className="lcx-chip">
          <span className="bx-truncate">{e}</span>
          <button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${e}`}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      <input
        id={inputId}
        className="lcx-chip-input"
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
