import React, { useState, useRef } from "react";
import { Icon } from "./icons.jsx";
import { StatusChip } from "./primitives.jsx";
import {
  getClientsOnly, getCompaniesOnly, buildClientOrCompanyOptions,
  getUsers, companyById, userById, fmtMoney, fmtDate, MONTHS,
  uploadInvoiceFile, deleteInvoiceFile, getInvoiceFileSignedUrl,
  ensureSubInvoiceRow, monthFolder, addProjectSub,
  linkInvoiceToProject, findOrCreateProjectForInvoice,
  setSubInvoicePaid, setProjectPrimeCompany,
} from "./data.js";
import { SearchableSelect } from "./primitives.jsx";

// Multi-user picker used by both the PMs field and Events attendees.
// Search-as-you-type dropdown; selected users render as chips with remove-x.
// Kept tiny (no icons/icon package) so it composes neatly in a drawer field.
function UsersField({ value, onChange, placeholder = "Pick users…" }) {
  const USERS = getUsers();
  const ids = value || [];
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const available = USERS.filter(
    u => !ids.includes(u.id) && (!q || u.name.toLowerCase().includes(q.toLowerCase()))
  );
  return (
    <div className="tag-input" onClick={() => setOpen(true)} style={{ position: "relative" }}>
      {ids.map(uid => {
        const u = userById(uid); if (!u) return null;
        return (
          <span key={uid} className="tag">
            <span className={`avatar xs ${u.color}`}>{u.initials}</span>{u.name}
            <button type="button" onClick={(e) => { e.stopPropagation(); onChange(ids.filter(x => x !== uid)); }}>
              <Icon name="x" size={10}/>
            </button>
          </span>
        );
      })}
      <input
        placeholder={ids.length ? "Add another…" : placeholder}
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && available.length > 0 && (
        <div className="menu" style={{ left: 0, right: 0, top: "calc(100% + 4px)", position: "absolute", margin: 4 }}>
          {available.slice(0, 8).map(u => (
            <button key={u.id} type="button" className="menu-item"
                    onMouseDown={() => { onChange([...ids, u.id]); setQ(""); }}>
              <span className={`avatar xs ${u.color}`}>{u.initials}</span>
              <span>{u.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============ LINKED PROJECTS (drawer subsection for Directory rows) ============
// Renders a flat list of projects this client/company is associated with, each
// row chip-coded by status (Potential / Awaiting / Awarded / Closed) plus a
// small INV badge when the project has a linked anticipated_invoice row.
// Sort: Awaiting → Awarded → Potential → Closed Out, then year DESC inside.
const STATUS_CHIP = {
  potential:  { label: "Potential",  cls: "accent" },
  awaiting:   { label: "Awaiting",   cls: "blue"   },
  awarded:    { label: "Awarded",    cls: "sage"   },
  closed:     { label: "Closed",     cls: "muted"  },
};
const STATUS_ORDER = { awaiting: 1, awarded: 2, potential: 3, closed: 4 };

export function LinkedProjectsSection({ projects, onOpenProject }) {
  const sorted = [...(projects || [])].sort((a, b) => {
    const sA = STATUS_ORDER[a.statusKey] ?? 99;
    const sB = STATUS_ORDER[b.statusKey] ?? 99;
    if (sA !== sB) return sA - sB;
    return (b.year || 0) - (a.year || 0);
  });
  const projectCount = sorted.length;
  const invoiceCount = sorted.filter(p => p.hasInvoice).length;

  return (
    <div className="drawer-section linked-projects" style={{ marginTop: 22 }}>
      <div className="linked-projects-head">
        <div className="section-title" style={{ margin: 0 }}>
          <Icon name="briefcase" size={12}/>
          Linked Projects · {projectCount}
        </div>
        {invoiceCount > 0 && (
          <span className="linked-projects-breakdown mono">
            {invoiceCount} {invoiceCount === 1 ? "invoice" : "invoices"}
          </span>
        )}
      </div>
      {projectCount === 0 ? (
        <div className="drawer-section-empty">
          No projects link to this {/* eslint-disable-next-line */}
          entry yet.
        </div>
      ) : (
        <ul className="linked-projects-list">
          {sorted.map(p => {
            const meta = STATUS_CHIP[p.statusKey] || { label: p.statusKey, cls: "muted" };
            return (
              <li key={p.id}
                  className="linked-project"
                  data-status={p.statusKey}
                  onClick={() => onOpenProject?.(p.id, p.statusKey)}>
                <span className={`chip ${meta.cls}`}>{meta.label}</span>
                <span className="linked-project-year mono">{p.year || "—"}</span>
                <span className="linked-project-name">{p.name}</span>
                {p.hasInvoice && (
                  <span className="chip-mini invoice-badge"
                        title={p.invoiceTooltip || "Linked anticipated_invoice row"}>
                    INV
                  </span>
                )}
                <span className="linked-project-num mono subtle">{p.projectNumber || "—"}</span>
                <span className="linked-project-role chip muted">{p.role}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ============ LINKED SUBS (drawer subsection for Invoice rows) ============
// Shown below the editable fields when an Invoice row is open. Reads the
// linked project's project_subs (already on the project's `subs` array via
// the loader) and renders a compact list. Includes an inline "+ Add sub"
// trigger that opens the AddSubModal — same flow as the table's expand row.
export function LinkedSubsSection({ subs = [], invoiceLinked, onAddSub }) {
  return (
    <div className="drawer-section linked-subs" style={{ marginTop: 22 }}>
      <div className="linked-projects-head">
        <div className="section-title" style={{ margin: 0 }}>
          <Icon name="briefcase" size={12}/>
          Linked Subs · {subs.length}
        </div>
        <button
          type="button"
          className="invoice-add-sub-btn"
          onClick={onAddSub}
          title="Add a sub to this project"
          style={{ fontSize: 11 }}>
          <Icon name="plus" size={11}/>
          Add sub
        </button>
      </div>
      {!invoiceLinked && subs.length === 0 && (
        <div className="drawer-section-empty">
          No subs yet. Click "Add sub" — we'll wire this invoice to a project
          automatically.
        </div>
      )}
      {invoiceLinked && subs.length === 0 && (
        <div className="drawer-section-empty">
          No subs tracked on this project yet.
        </div>
      )}
      {subs.length > 0 && (
        <ul className="linked-subs-list">
          {subs.map((s, i) => {
            const company = companyById(s.cId);
            return (
              <li key={i} className="linked-sub">
                <span className="linked-sub-name">{company?.name || "—"}</span>
                <span className="linked-sub-discipline mono subtle">
                  {s.desc || "—"}
                </span>
                <span className="linked-sub-amount mono">
                  {s.amt ? fmtMoney(s.amt) : <span className="empty-cell">—</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ============ DETAIL DRAWER (read/edit a row) ============
export const DetailDrawer = ({ row, table, onClose, onUpdate, onForward, onAlert, onDelete, onCloseOut, linkedProjects, onOpenProject, linkedSubs, onAddSub }) => {
  if (!row) return null;

  // Two distinct lists:
  //   CLIENT_OPTIONS — beacon.clients rows only. Used by the drawer's
  //     f.type === "company" renderer (every such field is a clientId FK).
  //   SUB_OPTIONS — beacon.companies rows only (external firms). Used by
  //     the Subs editor inside f.type === "subs".
  // Before splitting these, the Subs picker was filtering a clients-only
  // list looking for non-clients — always returned empty.
  const CLIENT_OPTIONS         = getClientsOnly().map(c => ({ value: c.id, label: c.name }));
  const CLIENT_OR_FIRM_OPTIONS = buildClientOrCompanyOptions();
  const SUB_OPTIONS            = getCompaniesOnly().map(c => ({ value: c.id, label: c.name }));
  const USERS = getUsers();

  // The Directory tab merges Clients + Companies into one table. The drawer
  // routes to the right field block based on the row's `type` discriminator.
  const fieldsKey = table === "directory"
    ? (row.type === "Client" ? "clients" : "companies")
    : table;

  // Every column that appears in the corresponding table in tables.jsx must have
  // a field here so the drawer is the complete editor for the row.
  const fields = {
    potential: [
      { k: "year",           label: "Year",                    type: "number" },
      { k: "name",           label: "Project Name" },
      { k: "role",           label: "Prime or Sub",            type: "select", options: ["Prime","Sub"] },
      { k: "clientId",       label: "Client",                  type: "company" },
      { k: "amount",         label: "Total Contract Amount",   type: "money" },
      { k: "msmm",           label: "MSMM Amount",             type: "money" },
      { k: "subs",           label: "Subs",                    type: "subs" },
      { k: "pmIds",          label: "PMs",                     type: "users" },
      { k: "probability",    label: "Probability",             type: "select", options: ["High","Medium","Low","Orange"] },
      { k: "anticipatedInvoiceStartMonth", label: "Anticipated Invoice Start Month", type: "month",
        showIf: (r) => r.probability === "Orange" },
      { k: "notes",          label: "Notes",                   type: "textarea" },
      { k: "dates",          label: "Dates and Comments" },
      { k: "nextActionDate", label: "Next Action Date",        type: "date" },
      { k: "projectNumber",  label: "Project Number",          type: "mono" },
    ],
    awaiting: [
      { k: "year",           label: "Year",                    type: "number" },
      { k: "name",           label: "Project Name" },
      { k: "clientId",       label: "Client",                  type: "company" },
      { k: "role",           label: "Prime or Sub",            type: "select", options: ["Prime","Sub"] },
      { k: "subs",           label: "Subs",                    type: "subs" },
      { k: "status",         label: "Status",                  type: "status" },
      { k: "dateSubmitted",  label: "Date Submitted",          type: "date" },
      { k: "anticipatedResultDate", label: "Anticipated Result Date", type: "date" },
      { k: "clientContract", label: "Client Contract #",       type: "mono" },
      { k: "msmmContract",   label: "MSMM Contract #",         type: "mono" },
      { k: "msmmUsed",       label: "MSMM Used",               type: "money" },
      { k: "msmmRemaining",  label: "MSMM Remaining",          type: "money" },
      { k: "pmIds",          label: "PMs",                     type: "users" },
      { k: "notes",          label: "Notes",                   type: "textarea" },
      { k: "projectNumber",  label: "Project Number",          type: "mono" },
    ],
    awarded: [
      { k: "year",           label: "Year",                    type: "number" },
      { k: "name",           label: "Project Name" },
      { k: "clientId",       label: "Client",                  type: "company" },
      { k: "role",           label: "Prime or Sub",            type: "select", options: ["Prime","Sub"] },
      { k: "subs",           label: "Subs",                    type: "subs" },
      { k: "status",         label: "Status",                  type: "status" },
      { k: "stage",          label: "Stage",                   type: "select", options: ["Multi-Use Contract","Single Use Contract (Project)","AE Selected List","Design 30%","Design 60%","Design 90%","Draft Report","Construction Admin","Closeout"] },
      { k: "details",        label: "Details",                 type: "textarea" },
      { k: "pools",          label: "Pools" },
      { k: "dateSubmitted",  label: "Date Submitted",          type: "date" },
      { k: "contractExpiry", label: "Contract Expiry",         type: "date" },
      { k: "clientContract", label: "Client Contract #",       type: "mono" },
      { k: "msmmContract",   label: "MSMM Contract #",         type: "mono" },
      { k: "msmmUsed",       label: "MSMM Used",               type: "money" },
      { k: "msmmRemaining",  label: "MSMM Remaining",          type: "money" },
      { k: "pmIds",          label: "PMs",                     type: "users" },
      { k: "notes",          label: "Notes",                   type: "textarea" },
      { k: "projectNumber",  label: "Project Number",          type: "mono" },
    ],
    closed: [
      { k: "year",           label: "Year",                    type: "number" },
      { k: "name",           label: "Project Name" },
      { k: "clientId",       label: "Client",                  type: "company" },
      { k: "role",           label: "Prime or Sub",            type: "select", options: ["Prime","Sub"] },
      { k: "subs",           label: "Subs",                    type: "subs" },
      { k: "status",         label: "Status",                  type: "status" },
      { k: "dateSubmitted",  label: "Date Submitted",          type: "date" },
      { k: "dateClosed",     label: "Date Closed",             type: "date" },
      { k: "amount",         label: "Contract Amount",         type: "money" },
      { k: "reason",         label: "Reason for Closure",      type: "textarea" },
      { k: "clientContract", label: "Client Contract #",       type: "mono" },
      { k: "msmmContract",   label: "MSMM Contract #",         type: "mono" },
      { k: "pmIds",          label: "PMs",                     type: "users" },
      { k: "notes",          label: "Notes",                   type: "textarea" },
      { k: "projectNumber",  label: "Project Number",          type: "mono" },
    ],
    invoice: [
      { k: "name",           label: "Project Name" },
      { k: "projectNumber",  label: "Project Number",          type: "mono" },
      { k: "type",           label: "Type",                    type: "select", options: ["ENG","PM"] },
      { k: "pmIds",          label: "PMs",                     type: "users" },
      { k: "amount",         label: "Contract Amount",         type: "money" },
      { k: "remainingStart", label: "Remaining to Bill (Jan 1)", type: "money" },
    ],
    events: [
      { k: "title",          label: "Title",                                           readOnlyIf: (r) => r.source === "outlook" },
      { k: "status",         label: "Status",                  type: "select", options: ["Booked","Happened"] },
      { k: "type",           label: "Type",                    type: "select", options: ["Partner","AI","Project","Meetings","Board Meetings","Event"] },
      { k: "dateTime",       label: "Date & Time",             type: "datetime",       readOnlyIf: (r) => r.source === "outlook" },
      { k: "attendees",      label: "Attendees from MSMM",     type: "users",          readOnlyIf: (r) => r.source === "outlook" },
      { k: "notes",          label: "Notes",                   type: "textarea" },
    ],
    hotleads: [
      { k: "title",          label: "Title" },
      { k: "status",         label: "Status",                  type: "select", options: ["Scheduled","Happened"] },
      // `company` field type feeds from the Clients list. For Hot Leads we
      // want BOTH clients AND companies available, so this drawer swaps in
      // the merged list via the `hotleadsCompany` custom type below.
      { k: "clientId",       label: "Client / Firm",           type: "clientOrFirm" },
      { k: "dateTime",       label: "Date & Time",             type: "datetime" },
      { k: "attendees",      label: "Attendees from MSMM",     type: "users" },
      { k: "notes",          label: "Notes",                   type: "textarea" },
    ],
    clients: [
      // Edit baseName (not the merged display `name`) so the PATCH sends
      // just the raw name to beacon.clients.name. updateClients() in App.jsx
      // recomputes the merged display locally so project rows' Client cells
      // stay consistent without a reload.
      { k: "baseName",       label: "Client Name" },
      { k: "district",       label: "District / State" },
      { k: "orgType",        label: "Org Type",                type: "select", options: ["City","State","Federal","Local","Parish","Regional","Other"] },
      { k: "contact",        label: "Contact Person" },
      { k: "email",          label: "Email" },
      { k: "phone",          label: "Phone" },
      { k: "address",        label: "Address" },
      { k: "notes",          label: "Notes",                   type: "textarea" },
    ],
    companies: [
      { k: "name",           label: "Company Name" },
      { k: "type",           label: "Type",                    type: "select", options: ["Prime","Sub","Multiple"] },
      { k: "contact",        label: "Contact Person" },
      { k: "email",          label: "Email" },
      { k: "phone",          label: "Phone" },
      { k: "address",        label: "Address" },
      { k: "notes",          label: "Notes",                   type: "textarea" },
    ],
  }[fieldsKey] || [];

  const renderInput = (f) => {
    const val = row[f.k];
    const set = (v) => onUpdate(row.id, { [f.k]: v });
    const readOnly = !!(f.readOnlyIf && f.readOnlyIf(row));
    if (readOnly) {
      if (f.type === "users") {
        const ids = val || [];
        if (ids.length === 0) {
          return <div className="field-readonly muted">— no MSMM attendees</div>;
        }
        return (
          <div className="field-readonly">
            <div className="readonly-userlist">
              {ids.map(uid => {
                const u = userById(uid); if (!u) return null;
                return (
                  <span key={uid} className="readonly-user">
                    <span className={`avatar xs ${u.color}`}>{u.initials}</span>
                    {u.name}
                  </span>
                );
              })}
            </div>
          </div>
        );
      }
      if (f.type === "datetime") {
        return <div className="field-readonly mono">{val || "—"}</div>;
      }
      return <div className="field-readonly">{val || <span className="muted">—</span>}</div>;
    }
    if (f.type === "textarea") return <textarea className="textarea" defaultValue={val || ""} onBlur={e => set(e.target.value)}/>;
    if (f.type === "select") return (
      <select className="select" value={val || ""} onChange={e => set(e.target.value)}>
        <option value="">—</option>
        {f.options.map(o => <option key={o}>{o}</option>)}
      </select>
    );
    if (f.type === "company") {
      // Sub-role rows get the merged Client+Firm list so users can edit
      // the displayed prime firm alongside actual clients. Prime rows
      // stay clients-only (FK to beacon.clients allows nothing else).
      const opts = row.role === "Sub" ? CLIENT_OR_FIRM_OPTIONS : CLIENT_OPTIONS;
      const placeholder = row.role === "Sub" ? "Search clients or firms…" : "Search clients…";
      return (
        <SearchableSelect
          value={val || ""}
          options={opts}
          placeholder={placeholder}
          onChange={v => set(v || null)}
        />
      );
    }
    // Hot Leads have no role concept, but still want the merged list so
    // early-stage leads can reference either an actual client or an
    // external firm. updateHotLeads in App.jsx routes via routeClientPick.
    if (f.type === "clientOrFirm") return (
      <SearchableSelect
        value={val || ""}
        options={CLIENT_OR_FIRM_OPTIONS}
        placeholder="Search clients or firms…"
        onChange={v => set(v || null)}
      />
    );
    if (f.type === "user") return (
      <select className="select" value={val || ""} onChange={e => set(e.target.value)}>
        <option value="">—</option>
        {USERS.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    );
    if (f.type === "users") return (
      <UsersField value={val || []} onChange={set}
                  placeholder={f.placeholder || "Pick MSMM users…"}/>
    );
    if (f.type === "money") return (
      <input className="input" type="number" defaultValue={val || ""} onBlur={e => set(Number(e.target.value))}
        style={{ fontFamily: "var(--font-mono)" }}/>
    );
    if (f.type === "date" || f.type === "datetime") return (
      <input className="input" type={f.type === "datetime" ? "datetime-local" : "date"} defaultValue={val || ""} onBlur={e => set(e.target.value)}
        style={{ fontFamily: "var(--font-mono)" }}/>
    );
    if (f.type === "mono") return (
      <input className="input" defaultValue={val || ""} onBlur={e => set(e.target.value)}
        style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}/>
    );
    if (f.type === "month") return (
      <select className="select" value={val || ""}
              onChange={e => set(e.target.value === "" ? null : Number(e.target.value))}>
        <option value="">—</option>
        {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
      </select>
    );
    if (f.type === "status") return (
      <div><StatusChip status={val}/></div>
    );
    if (f.type === "subs") {
      const subs = val || [];
      const updateSub = (i, patch) => {
        const next = subs.map((s, j) => j === i ? { ...s, ...patch } : s);
        set(next);
      };
      const removeSub = (i) => set(subs.filter((_, j) => j !== i));
      const addSub = () => set([...subs, { cId: null, desc: "", amt: 0 }]);
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {subs.length === 0 && (
            <div style={{
              fontSize: 12.5, color: "var(--text-soft)", fontStyle: "italic",
              padding: "6px 10px", background: "var(--surface-2)",
              border: "1px dashed var(--border)", borderRadius: 8,
            }}>
              No subs yet — click "Add sub" below to add one.
            </div>
          )}
          {subs.map((s, i) => (
            <div key={i} className="subrow"
                 style={{ gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr) 110px 30px" }}>
              <SearchableSelect
                value={s.cId || ""}
                options={SUB_OPTIONS}
                placeholder="Search companies…"
                onChange={v => updateSub(i, { cId: v || null })}
              />
              <input
                className="input"
                placeholder="Discipline (e.g. Survey)"
                value={s.desc || ""}
                onChange={e => updateSub(i, { desc: e.target.value })}
              />
              <input
                className="input mono"
                type="number"
                placeholder="$"
                min="0"
                value={s.amt ?? ""}
                onChange={e => updateSub(i, { amt: e.target.value === "" ? 0 : Number(e.target.value) })}
                style={{ fontFamily: "var(--font-mono)", textAlign: "right" }}
              />
              <button
                className="row-btn"
                title="Remove sub"
                onClick={() => removeSub(i)}
                style={{ color: "var(--rose)" }}
              >
                <Icon name="trash" size={12}/>
              </button>
            </div>
          ))}
          <div style={{
            display: "flex", alignItems: "center",
            justifyContent: "space-between",
            marginTop: subs.length ? 4 : 2,
          }}>
            <button
              className="tool-chip"
              onClick={addSub}
              style={{ borderStyle: "solid", borderColor: "var(--accent-soft)", color: "var(--accent-ink)", background: "var(--accent-softer)" }}
            >
              <Icon name="plus" size={12}/>Add sub
            </button>
            {subs.length > 0 && (
              <span className="mono" style={{ fontSize: 11, color: "var(--text-soft)" }}>
                Total: {fmtMoney(subs.reduce((a, s) => a + (Number(s.amt) || 0), 0))}
              </span>
            )}
          </div>
        </div>
      );
    }
    return <input className="input" defaultValue={val || ""} onBlur={e => set(e.target.value)}/>;
  };

  const titleMap = {
    potential: "Potential Project",
    awaiting:  "Awaiting Verdict",
    awarded:   "Awarded Project",
    closed:    "Closed Out Project",
    invoice:   "Anticipated Invoice",
    events:    "Event",
    clients:   "Client",
    companies: "Company",
  };
  const titleLabel = table === "directory"
    ? (row.type === "Client" ? "Client" : "Company")
    : titleMap[table];

  return (
    <>
      <div className="overlay" onClick={onClose}/>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="drawer-eyebrow">
              <Icon name="briefcase" size={12}/>
              {titleLabel}
              {row.projectNumber && <span className="mono" style={{ marginLeft: 6, color: "var(--text-soft)" }}>· {row.projectNumber}</span>}
            </div>
            <h3 className="drawer-title">{row.name || row.title}</h3>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {onForward && <button className="btn sm primary" onClick={onForward}><Icon name="forward" size={13}/>Move forward</button>}
            {onCloseOut && (
              <button
                className="btn sm"
                onClick={onCloseOut}
                style={{ color: "var(--rose)" }}
              >
                <Icon name="x" size={13}/>Close out
              </button>
            )}
            <button className="btn sm" onClick={onAlert}><Icon name="bell" size={13}/>Alert</button>
            <button className="drawer-close" onClick={onClose}><Icon name="x" size={16}/></button>
          </div>
        </div>
        <div className="drawer-body">
          {table === "events" && row.source === "outlook" && (
            <div className="drawer-outlook-banner">
              <span className="outlook-banner-mark"><Icon name="mail" size={11}/></span>
              <span className="outlook-banner-text">
                Synced from Outlook
                {row.outlookOrganizer?.email && (
                  <span className="muted"> · organized by {row.outlookOrganizer.name || row.outlookOrganizer.email}</span>
                )}
              </span>
              {row.outlookWebLink && (
                <a className="outlook-banner-link"
                   href={row.outlookWebLink}
                   target="_blank"
                   rel="noreferrer noopener">
                  Edit in Outlook
                  <Icon name="link" size={10}/>
                </a>
              )}
            </div>
          )}
          {fields.filter(f => !f.showIf || f.showIf(row)).map(f => (
            <div key={f.k} className="field">
              <div className="field-label">{f.label}</div>
              <div className={"field-value" + (f.type === "textarea" || f.type === "subs" ? " multiline" : "")}>
                {renderInput(f)}
              </div>
            </div>
          ))}
          {table === "events" && (row.outlookExternalAttendees || []).length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 22 }}>
                <Icon name="users" size={12}/>
                External invitees · {row.outlookExternalAttendees.length}
              </div>
              <div className="ext-chips">
                {row.outlookExternalAttendees.map((a, i) => (
                  <span key={`${a.email}-${i}`}
                        className={"ext-chip" + (a.response === "declined" ? " declined" : a.response === "accepted" ? " accepted" : "")}
                        title={`${a.name || a.email} · ${a.response || "no response"}`}>
                    {a.name && <span className="ext-chip-name">{a.name}</span>}
                    <span className="ext-chip-email mono">{a.email}</span>
                  </span>
                ))}
              </div>
            </>
          )}
          {row.sourceId && (
            <>
              <div className="section-title" style={{ marginTop: 22 }}><Icon name="link" size={12}/>Linked history</div>
              <div className="chip accent" style={{ fontSize: 12 }}>
                <Icon name="forward" size={11}/>
                Carried forward from previous stage · {row.sourceId}
              </div>
            </>
          )}
          {table === "directory" && linkedProjects && (
            <LinkedProjectsSection
              projects={linkedProjects}
              onOpenProject={onOpenProject}
            />
          )}
          {table === "invoice" && (
            <LinkedSubsSection
              subs={linkedSubs || []}
              invoiceLinked={!!row.sourceId}
              onAddSub={onAddSub}
            />
          )}
        </div>
        <div className="drawer-foot">
          {onDelete && (
            <button
              className="btn ghost sm"
              style={{ color: "var(--rose)" }}
              onClick={onDelete}
            >
              <Icon name="trash" size={13}/>Delete
            </button>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, color: "var(--text-soft)", fontSize: 12 }}>
            <Icon name="check" size={12}/>Local-only (wire writes to Supabase next)
          </div>
        </div>
      </div>
    </>
  );
};

// ============ MOVE-FORWARD SLIDE PANEL ============
export const MoveForwardPanel = ({ row, from, to, onClose, onConfirm }) => {
  const configs = {
    "awaiting→awarded": {
      title: "Mark project as Awarded",
      subtitle: "Carries to Awarded Projects",
      carried: ["year","name","clientId","role","subs","dateSubmitted","clientContract","msmmContract","msmmUsed","msmmRemaining","projectNumber","pmIds"],
      newFields: [
        { k: "status", label: "Status", type: "pill", value: "Awarded" },
        { k: "stage", label: "Stage", type: "select", options: ["Multi-Use Contract","Single Use Contract (Project)","AE Selected List","Design 30%"], value: "Multi-Use Contract" },
        { k: "details", label: "Details", type: "textarea", placeholder: "Key notes, scope, team…" },
        { k: "pools", label: "Pools", placeholder: "e.g. IDIQ Pool C" },
        { k: "contractExpiry", label: "Contract Expiry", type: "date" },
      ]
    },
    "awaiting→closed": {
      title: "Close out project",
      subtitle: "Carries to Closed Out Projects",
      carried: ["year","name","clientId","role","subs","dateSubmitted","notes","clientContract","msmmContract","projectNumber","pmIds"],
      newFields: [
        { k: "status", label: "Status", type: "pill", value: "Closed Out" },
        { k: "dateClosed", label: "Date Closed", type: "date", value: new Date().toISOString().substr(0,10) },
        { k: "reason", label: "Reason for Closure", type: "textarea", placeholder: "e.g. Client descope, lost bid, cancelled…" },
      ]
    },
    // Awarded → Potential: COPY semantics (Awarded row stays as the
    // historical log; the new Potential row represents it as a billing
    // candidate in the pipeline).
    "awarded→potential": {
      title: "Track as Potential billing candidate",
      subtitle: "Creates a Potential row linked to this Awarded project · Awarded row stays",
      carried: ["year","name","clientId","role","subs","pmIds","notes","projectNumber","msmmUsed","msmmRemaining"],
      newFields: [
        { k: "probability", label: "Probability", type: "select", options: ["High","Medium","Low","Orange"], value: "High" },
        { k: "nextActionDate", label: "Next Action Date", type: "date" },
        { k: "dates", label: "Dates and Comments", placeholder: "e.g. decision on 4/2/26" },
      ]
    },
    // Awarded → Invoice: COPY semantics. Prompts for the invoice-only
    // fields (type = ENG/PM) that don't live on the Awarded row.
    "awarded→invoice": {
      title: "Create Invoice row from Awarded",
      subtitle: "Carries to Anticipated Invoice · Awarded row stays",
      carried: ["year","name","projectNumber","pmIds","msmmRemaining"],
      newFields: [
        { k: "_invoiceType", label: "Invoice Type", type: "select", options: ["ENG","PM"], value: "ENG",
          hint: "Determines how billing is categorized in Anticipated Invoice." },
      ]
    },
    // Potential → Invoice: COPY semantics. Same invoice-only prompt.
    "potential→invoice": {
      title: "Create Invoice row from Potential",
      subtitle: "Carries to Anticipated Invoice · Potential row stays",
      carried: ["year","name","projectNumber","pmIds"],
      newFields: [
        { k: "_invoiceType", label: "Invoice Type", type: "select", options: ["ENG","PM"], value: "ENG",
          hint: "Determines how billing is categorized in Anticipated Invoice." },
      ]
    },
    // Invoice → Closed Out: the invoice row is removed and the upstream
    // project flips to status='closed_out'. If no upstream project exists, a
    // new closed_out project is minted from the invoice fields. See the
    // confirmMove handler in App.jsx for persistence details.
    "invoice→closed": {
      title: "Close out project",
      subtitle: "Invoice row is removed · project moves to Closed Out",
      carried: ["year","name","projectNumber","pmIds"],
      newFields: [
        { k: "status", label: "Status", type: "pill", value: "Closed Out" },
        { k: "dateClosed", label: "Date Closed", type: "date", value: new Date().toISOString().substr(0,10) },
        { k: "reason", label: "Reason for Closure", type: "textarea", placeholder: "e.g. Project complete, contract ended, client descope…" },
      ]
    },
  };

  const key = `${from}→${to}`;
  const cfg = configs[key];
  const [data, setData] = useState(() => {
    const d = {};
    (cfg?.newFields || []).forEach(f => { d[f.k] = f.value ?? ""; });
    return d;
  });

  if (!cfg) return null;

  const labels = {
    year: "Year", name: "Project", clientId: "Client", role: "Role", subs: "Subs",
    notes: "Notes", projectNumber: "Project #", dateSubmitted: "Submitted",
    clientContract: "Client Contract", msmmContract: "MSMM Contract",
    msmmUsed: "MSMM Used", msmmRemaining: "MSMM Rem.", pmIds: "PMs",
  };
  const formatCarried = (k) => {
    const v = row[k];
    if (v == null || v === "") return "—";
    if (k === "clientId") return companyById(v)?.name || "—";
    if (k === "pmIds") return (v || []).map(id => userById(id)?.name).filter(Boolean).join(", ") || "—";
    if (k === "subs") return (v || []).map(s => `${companyById(s.cId)?.name?.split(" ")[0] || s.desc || "Sub"} (${fmtMoney(s.amt)})`).join(", ") || "—";
    if (k === "msmmUsed" || k === "msmmRemaining") return fmtMoney(v);
    if (k === "dateSubmitted") return fmtDate(v);
    return v;
  };

  const renderField = (f) => {
    const val = data[f.k];
    const set = (v) => setData(d => ({ ...d, [f.k]: v }));
    if (f.type === "pill") return <span className="chip accent" style={{ fontWeight: 600 }}><span className="chip-dot"/>{val}</span>;
    if (f.type === "select") return (
      <select className="select" value={val} onChange={e => set(e.target.value)}>
        {f.options.map(o => <option key={o}>{o}</option>)}
      </select>
    );
    if (f.type === "date") return <input className="input" type="date" value={val} onChange={e => set(e.target.value)} style={{ fontFamily: "var(--font-mono)" }}/>;
    if (f.type === "money") return <input className="input" type="number" value={val} onChange={e => set(Number(e.target.value))} style={{ fontFamily: "var(--font-mono)" }}/>;
    if (f.type === "textarea") return <textarea className="textarea" value={val} placeholder={f.placeholder} onChange={e => set(e.target.value)}/>;
    return <input className="input" value={val} placeholder={f.placeholder} onChange={e => set(e.target.value)}/>;
  };

  return (
    <>
      <div className="overlay" onClick={onClose}/>
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="drawer-eyebrow">
              <Icon name="forward" size={12}/>{cfg.subtitle}
            </div>
            <h3 className="drawer-title">{cfg.title}</h3>
          </div>
          <button className="drawer-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="drawer-body">
          <div className="carried-section">
            <div className="carried-title"><Icon name="check" size={11}/>Carried forward · locked</div>
            <dl className="carried-grid">
              {cfg.carried.map(k => (
                <React.Fragment key={k}>
                  <dt>{labels[k] || k}</dt>
                  <dd>{formatCarried(k)}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
          <div className="section-title"><Icon name="sparkles" size={12}/>New fields required</div>
          {cfg.newFields.map(f => (
            <div key={f.k} className="field">
              <div className="field-label">{f.label}</div>
              <div className={"field-value" + (f.type === "textarea" ? " multiline" : "")}>
                {renderField(f)}
                {f.hint && <div style={{ fontSize: 11.5, color: "var(--text-soft)", marginTop: 4 }}>{f.hint}</div>}
              </div>
            </div>
          ))}
        </div>
        <div className="drawer-foot">
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          <button className="btn primary sm" onClick={() => onConfirm(data)}>
            <Icon name="forward" size={13}/>{cfg.title}
          </button>
        </div>
      </div>
    </>
  );
};

// ============ ALERT MODAL ============
// `anchors` (from App.jsx via getRowAnchors(tab, row)) is an array of
// populated date fields on this row — e.g. [{field:'anticipated_result_date',
// uiField:'anticipatedResultDate', label:'Anticipated result', value:'2026-04-30',
// hasTime:false}]. When present, the modal shows:
//   • anchor chips — which existing date on the row to anchor to
//   • offset chips — how far before the anchor to fire (30m/1h/1d/2d/custom)
// Selecting both fills the date+time inputs; inputs remain source-of-truth
// so the user can fine-tune afterwards.
const OFFSET_PRESETS = [
  { key: "30m", label: "30 min before", minutes: -30 },
  { key: "1h",  label: "1 hr before",   minutes: -60 },
  { key: "1d",  label: "1 day before",  minutes: -1440 },
  { key: "2d",  label: "2 days before", minutes: -2880 },
];
const DEFAULT_ANCHOR_HOUR = 9; // date-only anchors use 09:00 local as the anchor time
const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago"; }
  catch { return "America/Chicago"; }
})();

function computeFromAnchor(anchor, offsetMinutes) {
  // anchor.value may be an ISO date ('YYYY-MM-DD') or a timestamptz string.
  const iso = String(anchor.value || "");
  let baseMs;
  if (anchor.hasTime) {
    const dt = new Date(iso);
    if (isNaN(dt)) return null;
    baseMs = dt.getTime();
  } else {
    const s = iso.substr(0, 10);
    const [y, m, d] = s.split("-").map(Number);
    if (!y) return null;
    baseMs = new Date(y, (m || 1) - 1, d || 1, DEFAULT_ANCHOR_HOUR, 0, 0).getTime();
  }
  const targetMs = baseMs + offsetMinutes * 60_000;
  const t = new Date(targetMs);
  const pad = n => String(n).padStart(2, "0");
  return {
    date: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`,
    time: `${pad(t.getHours())}:${pad(t.getMinutes())}`,
  };
}

export const AlertModal = ({ row, anchors = [], onClose, onConfirm }) => {
  const USERS = getUsers();
  const [recipients, setRecipients] = useState([...(row.pmIds || [])]);
  const [date, setDate] = useState(new Date(Date.now() + 5 * 86400000).toISOString().substr(0, 10));
  const [time, setTime] = useState("09:00");
  const [recur, setRecur] = useState("one-time");
  const [message, setMessage] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickQ, setPickQ] = useState("");
  const [anchorField, setAnchorField] = useState(null);
  const [offsetKey, setOffsetKey]     = useState(null);

  const available = USERS.filter(u => !recipients.includes(u.id) &&
    (!pickQ || u.name.toLowerCase().includes(pickQ.toLowerCase())));

  const pickAnchor = (a) => {
    setAnchorField(a.field);
    if (offsetKey) {
      const preset = OFFSET_PRESETS.find(p => p.key === offsetKey);
      const r = preset && computeFromAnchor(a, preset.minutes);
      if (r) { setDate(r.date); setTime(r.time); }
    }
  };
  const pickOffset = (preset) => {
    setOffsetKey(preset.key);
    const a = anchors.find(x => x.field === anchorField) || anchors[0];
    if (!a) return;
    if (!anchorField) setAnchorField(a.field);
    const r = computeFromAnchor(a, preset.minutes);
    if (r) { setDate(r.date); setTime(r.time); }
  };
  const clearAnchor = () => { setAnchorField(null); setOffsetKey(null); };
  const onManualDate = (v) => { setDate(v); setOffsetKey(null); };
  const onManualTime = (v) => { setTime(v); setOffsetKey(null); };

  return (
    <>
      <div className="overlay" onClick={onClose}/>
      <div className="modal">
        <div className="modal-head">
          <div className="icon-badge"><Icon name="bell" size={16}/></div>
          <div style={{ flex: 1 }}>
            <div className="drawer-eyebrow" style={{ marginBottom: 2 }}>Set alert</div>
            <h3 className="drawer-title" style={{ fontSize: 16 }}>{row.name || row.title}</h3>
            <div style={{ fontSize: 12, color: "var(--text-soft)", marginTop: 3 }}>
              Beacon will email tagged users at the scheduled time with a link to this row.
            </div>
          </div>
          <button className="drawer-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>Notify</div>
            <div className="tag-input" onClick={() => setPicking(true)} style={{ position: "relative" }}>
              {recipients.map(uid => {
                const u = userById(uid); if (!u) return null;
                return <span key={uid} className="tag"><span className={`avatar xs ${u.color}`}>{u.initials}</span>{u.name}
                  <button onClick={(e) => { e.stopPropagation(); setRecipients(recipients.filter(x => x !== uid)); }}>
                    <Icon name="x" size={10}/></button></span>;
              })}
              <input placeholder={recipients.length ? "Add another…" : "Pick MSMM users…"}
                value={pickQ}
                onChange={e => { setPickQ(e.target.value); setPicking(true); }}
                onFocus={() => setPicking(true)}
                onBlur={() => setTimeout(() => setPicking(false), 150)}
              />
              {picking && available.length > 0 && (
                <div className="menu" style={{ left: 0, right: 0, top: "calc(100% + 4px)", position: "absolute", margin: 4 }}>
                  {available.slice(0, 6).map(u => (
                    <button key={u.id} className="menu-item"
                      onMouseDown={() => { setRecipients([...recipients, u.id]); setPickQ(""); }}>
                      <span className={`avatar xs ${u.color}`}>{u.initials}</span>
                      <span>{u.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {anchors.length > 0 && (
            <div>
              <div className="field-label" style={{ marginBottom: 6 }}>Anchor to</div>
              <div className="alert-anchor-chips">
                {anchors.map(a => (
                  <button key={a.field} type="button"
                    className={"anchor-chip" + (anchorField === a.field ? " active" : "")}
                    onClick={() => pickAnchor(a)}>
                    <span className="anchor-chip-label">{a.label}</span>
                    <span className="anchor-chip-date">{fmtDate(a.value)}</span>
                  </button>
                ))}
                <button type="button"
                  className={"anchor-chip" + (anchorField === null ? " active" : "")}
                  onClick={clearAnchor}>
                  <span className="anchor-chip-label">None (pick manually)</span>
                </button>
              </div>
              <div className="alert-offset-chips" style={{ marginTop: 8 }}>
                {OFFSET_PRESETS.map(p => (
                  <button key={p.key} type="button"
                    disabled={!anchorField && anchors.length === 0}
                    className={"offset-chip" + (offsetKey === p.key ? " active" : "")}
                    onClick={() => pickOffset(p)}>{p.label}</button>
                ))}
                <button type="button"
                  className={"offset-chip" + (offsetKey === null ? " active" : "")}
                  onClick={() => setOffsetKey(null)}>Custom…</button>
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <div className="field-label" style={{ marginBottom: 6 }}>First alert date</div>
              <input className="input" type="date" value={date} onChange={e => onManualDate(e.target.value)}
                style={{ fontFamily: "var(--font-mono)" }}/>
            </div>
            <div>
              <div className="field-label" style={{ marginBottom: 6 }}>Time</div>
              <input className="input" type="time" value={time} onChange={e => onManualTime(e.target.value)}
                style={{ fontFamily: "var(--font-mono)" }}/>
            </div>
          </div>

          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>Recurrence</div>
            <div className="radio-row">
              {["one-time","weekly","biweekly","monthly","custom"].map(r => (
                <button key={r} className={"radio-chip" + (recur === r ? " active" : "")}
                  onClick={() => setRecur(r)}>{r}</button>
              ))}
            </div>
          </div>

          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>Message (optional)</div>
            <textarea className="textarea" value={message} onChange={e => setMessage(e.target.value)}
              placeholder="e.g. Reminder: verdict expected this week. Check in with client PM."/>
          </div>
        </div>
        <div className="modal-foot">
          <div style={{ fontSize: 12, color: "var(--text-soft)", display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="clock" size={12}/>
            First send {fmtDate(date)} at {time} · {recur === "one-time" ? "does not repeat" : `repeats ${recur}`}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" onClick={onClose}>Cancel</button>
            <button className="btn primary sm" onClick={() => {
              const preset = OFFSET_PRESETS.find(p => p.key === offsetKey);
              onConfirm({
                recipients, date, time, recur, message,
                anchorField,
                anchorOffsetMinutes: preset ? preset.minutes : null,
                timezone: BROWSER_TZ,
              });
            }}>
              <Icon name="bell" size={13}/>Schedule alert
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

// ============ INVOICE FILES MODAL ============
// Triggered from the paperclip overlay on any month cell in the Invoice tab.
// Lists every PDF currently attached to that (project, kind, month) cell with
// open + delete actions, and lets the user upload a new file. For sub
// invoices, a sub_invoices row is auto-created via ensureSubInvoiceRow if
// none exists yet — so users can upload without first having to type in an
// amount.
//
// Props:
//   kind          'prime' | 'sub'
//   projectId     uuid of the project (= source_project_id on prime)
//   projectName   string (for the modal header)
//   year          int
//   monthIdx      0..11
//   files         current attachment array — re-fetched after each
//                 successful upload/delete via onChanged()
//   primeInvoiceId   (kind='prime' only) anticipated_invoice.id
//   subInvoiceId     (kind='sub' only)   nullable; ensureSubInvoiceRow auto-creates if null
//   companyId        (kind='sub' only)
//   companyName      (kind='sub' only)
//   amount           current cell amount — shown in the header echo
export const InvoiceFilesModal = ({
  kind, projectId, projectName,
  year, monthIdx,
  files = [],
  primeInvoiceId, subInvoiceId, companyId, companyName,
  amount,
  paid: initialPaid = false,
  paidAt: initialPaidAt = null,
  onClose, onChanged,
}) => {
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState("");
  const fileRef = useRef(null);
  const [picked, setPicked] = useState(null);
  // Local copy of paid state so the modal feels responsive while the round-trip
  // happens. Synced back to the parent via onChanged after the DB write.
  const [paid, setPaid] = useState(!!initialPaid);
  const [paidAt, setPaidAt] = useState(initialPaidAt);

  const monthLabel = monthFolder(year, monthIdx);
  const headerTitle = kind === "sub"
    ? `Sub invoices · ${projectName} · ${monthLabel}`
    : `Prime invoice · ${projectName} · ${monthLabel}`;
  const subhead = kind === "sub"
    ? `Sub: ${companyName || "—"}${amount != null ? ` · ${fmtMoney(amount)}` : ""}`
    : amount != null ? fmtMoney(amount) : "—";

  const handleTogglePaid = async (next) => {
    if (busy) return;
    if (kind !== "sub") return;
    if (!subInvoiceId) {
      // Need a sub_invoice row to attach paid status to. Create one first.
      try {
        const row = await ensureSubInvoiceRow({
          projectId, companyId, year, month: monthIdx + 1,
        });
        // Caller's state may not have this id yet — refresh after.
        await setSubInvoicePaid(row.id, next);
      } catch (e) {
        setError(e?.message || "Mark paid failed");
        return;
      }
    } else {
      try {
        await setSubInvoicePaid(subInvoiceId, next);
      } catch (e) {
        setError(e?.message || "Mark paid failed");
        return;
      }
    }
    setPaid(next);
    setPaidAt(next ? new Date().toISOString() : null);
    await onChanged?.();
  };

  const handleOpen = async (filePath) => {
    try {
      const url = await getInvoiceFileSignedUrl(filePath, 60);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(e?.message || "Couldn't open file");
    }
  };

  const handleDelete = async (file) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await deleteInvoiceFile({ kind, fileId: file.id, filePath: file.file_path });
      await onChanged?.();
    } catch (e) {
      setError(e?.message || "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async () => {
    if (busy) return;
    if (!picked) { setError("Choose a file first"); return; }
    setBusy(true); setError("");
    try {
      let parentSubInvoiceId = subInvoiceId;
      if (kind === "sub" && !parentSubInvoiceId) {
        const row = await ensureSubInvoiceRow({
          projectId, companyId, year, month: monthIdx + 1,
        });
        parentSubInvoiceId = row.id;
      }
      await uploadInvoiceFile({
        kind, projectId, year, monthIdx,
        file: picked,
        notes,
        primeInvoiceId,
        subInvoiceId: parentSubInvoiceId,
        companyId, companyName,
      });
      setPicked(null);
      setNotes("");
      if (fileRef.current) fileRef.current.value = "";
      await onChanged?.();
    } catch (e) {
      setError(e?.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="overlay" onClick={onClose}/>
      <div className="modal" style={{ width: 580, maxHeight: "86vh", display: "flex", flexDirection: "column" }}>
        <div className="modal-head">
          <div className="icon-badge"><Icon name="link" size={16}/></div>
          <div style={{ flex: 1 }}>
            <div className="drawer-eyebrow" style={{ marginBottom: 2 }}>Invoice files</div>
            <h3 className="drawer-title" style={{ fontSize: 16 }}>{headerTitle}</h3>
            <div style={{ fontSize: 12, color: "var(--text-soft)", marginTop: 3 }}>
              {subhead}
            </div>
          </div>
          <button className="drawer-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>

        <div className="modal-body" style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
          {kind === "sub" && (
            <label className={"invoice-paid-toggle-row" + (paid ? " paid" : "")}>
              <input
                type="checkbox"
                checked={paid}
                disabled={busy}
                onChange={(e) => handleTogglePaid(e.target.checked)}
              />
              <div className="invoice-paid-toggle-text">
                <span className="invoice-paid-toggle-label">
                  {paid ? "Paid" : "Pending"}
                </span>
                {paid && paidAt && (
                  <span className="invoice-paid-toggle-stamp mono">
                    marked {fmtDate(paidAt)}
                  </span>
                )}
                {!paid && (
                  <span className="invoice-paid-toggle-hint">
                    Tick when this sub's invoice has been paid.
                  </span>
                )}
              </div>
            </label>
          )}
          <div>
            <div className="section-title" style={{ marginTop: 0 }}>
              <Icon name="briefcase" size={12}/>
              Existing files · {files.length}
            </div>
            {files.length === 0 ? (
              <div className="drawer-section-empty" style={{ marginTop: 4 }}>
                No files attached yet.
              </div>
            ) : (
              <ul className="invoice-files-modal-list">
                {files.map(f => (
                  <li key={f.id}>
                    <span className="invoice-file-name mono" title={f.file_name}>
                      {f.file_name}
                    </span>
                    <span className="invoice-file-date mono subtle">
                      {fmtDate(f.uploaded_at)}
                    </span>
                    <button type="button" className="btn ghost sm"
                            onClick={() => handleOpen(f.file_path)}
                            disabled={busy}>
                      <Icon name="link" size={12}/>Open
                    </button>
                    <button type="button" className="btn ghost sm"
                            style={{ color: "var(--rose)" }}
                            onClick={() => handleDelete(f)}
                            disabled={busy}>
                      <Icon name="trash" size={12}/>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <div className="section-title">
              <Icon name="plus" size={12}/>
              Add a file
            </div>
            <input
              ref={fileRef}
              type="file"
              className="input"
              onChange={(e) => setPicked(e.target.files?.[0] || null)}
              disabled={busy}
              style={{ width: "100%" }}
            />
            <div className="field" style={{ marginTop: 10, gridTemplateColumns: "1fr" }}>
              <div className="field-label">Notes (optional)</div>
              <div className="field-value">
                <textarea className="textarea" rows={2}
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          disabled={busy}
                          placeholder="Anything worth remembering about this invoice…"/>
              </div>
            </div>
          </div>

          {error && (
            <div style={{ color: "var(--rose)", fontSize: 12 }}>
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <div style={{ fontSize: 11, color: "var(--text-soft)" }}>
            Bucket: <span className="mono">invoices</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" onClick={onClose} disabled={busy}>Close</button>
            <button className="btn primary sm"
                    onClick={handleUpload}
                    disabled={busy || !picked}>
              <Icon name="check" size={13}/>
              {busy ? "Uploading…" : "Upload"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

// ============ ADD SUB MODAL ============
// Triggered from the "+ Add sub" row inside an expanded Invoice project, or
// from the Subs section in the Invoice drawer. Three fields — Company,
// Service, Total Amount — and that's it.
//
// If the underlying invoice happens to be unlinked (no source_project_id),
// we set up the link transparently on submit: try to match an existing
// project by project_number+year, otherwise auto-create a stub. The user
// never sees a picker — they already identified the project by clicking on
// the invoice row.
//
// Props:
//   projectId               null when the invoice isn't linked yet
//   invoiceRow              full invoice UI row (used for auto-link metadata)
//   projectName             header label (falls back to invoiceRow.name)
//   existingSubsCount       used to compute the new ord (1-indexed)
//   companies               full _companies list (clients filtered out)
//   invoiceId               required when projectId is null (so we can link)
//   onAdded({inserted, linkedProjectId?, autoLinkedProject?})
export const AddSubModal = ({
  projectId, projectName,
  existingSubsCount = 0,
  companies,
  invoiceId,
  invoiceRow,
  kind = "sub",                 // 'sub' (default) | 'prime'
  onClose, onAdded,
}) => {
  const isPrime = kind === "prime";
  const [companyId, setCompanyId] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const needsProjectLink = !projectId;

  // Subs are external firms (Companies, not Clients). Filter the merged
  // _companies list to non-Client entries — same behavior as SubsEditor.
  const subOptions = (companies || [])
    .filter(c => c.type !== "Client")
    .map(c => ({ value: c.id, label: c.name }));

  const canSubmit = !!companyId && !busy
    && (!needsProjectLink || !!invoiceId);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    if (needsProjectLink && !invoiceId) {
      setError("Missing invoice id — can't auto-link.");
      return;
    }
    setBusy(true); setError("");
    try {
      let effectiveProjectId = projectId;
      let linkedProjectId    = null;
      let autoLinkedProject  = null;
      if (needsProjectLink) {
        // Look up the project by project_number+year, or create a stub.
        const result = await findOrCreateProjectForInvoice(invoiceRow);
        effectiveProjectId = result.projectId;
        linkedProjectId    = result.projectId;
        autoLinkedProject  = result;
        // Wire the invoice to whichever project we resolved.
        await linkInvoiceToProject(invoiceId, effectiveProjectId);
      }
      const inserted = await addProjectSub({
        projectId: effectiveProjectId,
        companyId,
        discipline: discipline.trim() || null,
        amount: amount === "" ? null : Number(amount),
        ord: existingSubsCount + 1,
        kind,
      });
      // For a prime entry, mirror the company onto projects.prime_company_id
      // so the role/consistency check stays satisfied and the rest of the
      // app sees the upstream firm without inferring it from project_subs.
      if (isPrime) {
        await setProjectPrimeCompany(effectiveProjectId, companyId);
      }
      onAdded?.({ inserted, linkedProjectId, invoiceId, autoLinkedProject, kind });
    } catch (e) {
      setError(e?.message || "Add sub failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="overlay" onClick={onClose}/>
      <div className="modal" style={{ width: 480 }}>
        <div className="modal-head">
          <div className="icon-badge"><Icon name="plus" size={16}/></div>
          <div style={{ flex: 1 }}>
            <div className="drawer-eyebrow" style={{ marginBottom: 2 }}>
              {isPrime ? "Add prime" : "Add sub"}
            </div>
            <h3 className="drawer-title" style={{ fontSize: 16 }}>
              {projectName || invoiceRow?.name || "Project"}
            </h3>
            <div style={{ fontSize: 12, color: "var(--text-soft)", marginTop: 3 }}>
              {isPrime
                ? "The Prime is the upstream firm hiring MSMM on this project. Enter the contract amount; monthly billing tracks beneath."
                : "Subs are firms hired on this project. Enter their total contract amount; monthly invoices live on the row that appears beneath."}
            </div>
          </div>
          <button className="drawer-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>

        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {needsProjectLink && (
            <div style={{
              display: "flex", alignItems: "flex-start", gap: 8,
              padding: "8px 12px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              marginBottom: 6,
              fontSize: 11.5, color: "var(--text-soft)", lineHeight: 1.45,
            }}>
              <Icon name="link" size={11}/>
              <span>
                This invoice isn't linked to a project yet — we'll set that
                up automatically when you save.
              </span>
            </div>
          )}
          <div className="field">
            <div className="field-label">{isPrime ? "Prime firm *" : "Company *"}</div>
            <div className="field-value">
              <SearchableSelect
                value={companyId}
                options={subOptions}
                placeholder={isPrime ? "Search prime firms…" : "Search firms…"}
                onChange={(v) => setCompanyId(v || "")}
              />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Service / discipline</div>
            <div className="field-value">
              <input className="input"
                     placeholder="e.g. Survey, Civil, MEP"
                     value={discipline}
                     onChange={(e) => setDiscipline(e.target.value)}
                     disabled={busy}/>
            </div>
          </div>
          <div className="field">
            <div className="field-label">Total amount</div>
            <div className="field-value">
              <input className="input mono"
                     type="number" min="0" step="any"
                     placeholder="$0"
                     value={amount}
                     onChange={(e) => setAmount(e.target.value)}
                     disabled={busy}
                     style={{ fontFamily: "var(--font-mono)" }}/>
            </div>
          </div>
          {error && (
            <div style={{ color: "var(--rose)", fontSize: 12, marginTop: 6 }}>
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <div style={{ fontSize: 11, color: "var(--text-soft)" }}>
            Need a firm not listed? Add it via the Directory tab.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn primary sm" onClick={handleSubmit} disabled={!canSubmit}>
              <Icon name="check" size={13}/>
              {busy ? "Saving…" : (isPrime ? "Add prime" : "Add sub")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
