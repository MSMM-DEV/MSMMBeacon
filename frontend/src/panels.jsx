import React, { useState, useRef } from "react";
import { Icon } from "./icons.jsx";
import { StatusChip, StarRating } from "./primitives.jsx";
import {
  getClientsOnly, getCompaniesOnly, buildClientOrCompanyOptions,
  getUsers, companyById, userById, fmtMoney, fmtDate, fmtDateTime, MONTHS,
  uploadInvoiceFile, deleteInvoiceFile, getInvoiceFileSignedUrl,
  uploadInvoicePartyFile, deleteInvoicePartyFile,
  ensureSubInvoiceRow, monthFolder, addProjectSub, addCompany,
  linkInvoiceToProject, findOrCreateProjectForInvoice,
  setSubInvoicePaid, setProjectPrimeCompany,
  mergeRefSummary,
  CONTRACT_TYPE_OPTIONS, PROJECT_ITEM_TYPE_OPTIONS, PROJECT_ITEM_STATUS_OPTIONS,
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
export const DetailDrawer = ({
  row, table, onClose, onUpdate, onForward, onAlert, onDelete,
  onCloseOut, onDemoteFromOrange, onMoveBack,
  linkedProjects, onOpenProject, linkedSubs, onAddSub,
  // Open Bids extras — all optional; only `openbids` table passes them.
  isAdmin = false,
  onApproveBid, onRejectBid, onClearBidApproval,
  onUploadBidPdf, onRemoveBidPdf, onOpenBidPdf,
  // Projects (tree item) extras — only the `projects` table passes them.
  projectItems = [], onAddProjectSub, onUpdateProjectSub, onRemoveProjectSub, onAddChild,
}) => {
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
      { k: "primeId",        label: "Prime",                   type: "clientOrFirm" },
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
      { k: "amount",         label: "Total Contract Value",    type: "money" },
      { k: "msmmAmount",     label: "MSMM Portion",            type: "money", readOnlyIf: () => !isAdmin, readOnlyHint: "Auto-calculated — admins only" },
      { k: "remainingStart", label: "Rollforward (from 2025)",   type: "money", readOnlyIf: () => !isAdmin, readOnlyHint: "Auto-calculated — admins only" },
      { k: "description",    label: "Description",             type: "textarea", placeholder: "Project scope / description…" },
      // Notes moved to the threaded, multi-author Notes log — opened from the
      // "Notes" chip on the Invoice row (InvoiceNotesThread). No single-text
      // editor here so the two stores can't diverge.
    ],
    events: [
      { k: "title",          label: "Title",                                           readOnlyIf: (r) => r.source === "outlook" },
      { k: "status",         label: "Status",                  type: "select", options: ["Booked","Happened"] },
      { k: "type",           label: "Type",                    type: "select", options: ["Partner","AI","Project","Meetings","Board Meetings","Event"] },
      { k: "stars",          label: "Rating",                  type: "stars" },
      { k: "dateTime",       label: "Date & Time",             type: "datetime",       readOnlyIf: (r) => r.source === "outlook" },
      { k: "attendees",      label: "Attendees from MSMM",     type: "users",          readOnlyIf: (r) => r.source === "outlook" },
      { k: "notes",          label: "Notes",                   type: "textarea" },
    ],
    hotleads: [
      { k: "title",          label: "Title" },
      { k: "type",           label: "Type",                    type: "select", options: ["Engineering","AI"] },
      { k: "stars",          label: "Rating",                  type: "stars" },
      // `company` field type feeds from the Clients list. For Hot Leads we
      // want BOTH clients AND companies available, so this drawer swaps in
      // the merged list via the `hotleadsCompany` custom type below.
      { k: "clientId",       label: "Client / Firm",           type: "clientOrFirm" },
      { k: "dateTime",       label: "Date & Time",             type: "datetime" },
      { k: "anticipatedAmount", label: "Anticipated Amount",   type: "money" },
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
    openbids: [
      { k: "rfqNumber",          label: "RFQ/RFP Number",           type: "mono" },
      { k: "clientId",           label: "Client / Parish",          type: "company" },
      { k: "serviceDescription", label: "Description of Service",
        type: "select",
        options: [
          "Civil Engineering Design Services",
          "Drainage and Stormwater Engineering",
          "Roadway and Infrastructure Design",
          "Water and Sewer Engineering Services",
          "Construction Engineering and Inspection",
          "Project Management Services",
          "Engineering Planning and Feasibility Studies",
          "Environmental and Coastal Engineering",
          "Traffic and Transportation Engineering",
          "Site Development Engineering",
          "Utility Infrastructure Engineering",
          "Flood Mitigation and Resilience Planning",
          "Surveying and Mapping Services",
          "Grant Support and Technical Assistance",
          "On-Call Engineering Services",
        ] },
      { k: "dueAt",              label: "Due Date",                 type: "datetime" },
      { k: "webLink",            label: "Web Link" },
      { k: "anticipatedAmount",  label: "Anticipated Amount",       type: "money" },
      { k: "notes",              label: "Notes",                    type: "textarea" },
      // Approval fields render via the dedicated approval panel below, NOT
      // as generic editable fields — admins flip status through the panel,
      // and the DB trigger gates writes anyway.
    ],
    projects: [
      { k: "projectId",       label: "Project ID",        type: "mono", readOnlyIf: () => true, readOnlyHint: "Permanent ID — can't be changed" },
      { k: "name",            label: "Project Name" },
      { k: "parentId",        label: "Parent project",    type: "projectParent" },
      { k: "itemType",        label: "Type",              type: "kvselect", options: PROJECT_ITEM_TYPE_OPTIONS },
      { k: "clientId",        label: "Client / Prime",    type: "clientOrFirm" },
      { k: "subs",            label: "Subs",              type: "projectSubs" },
      { k: "contractType",    label: "Contract Type",     type: "kvselect", options: CONTRACT_TYPE_OPTIONS, allowEmpty: true },
      { k: "contractAmount",  label: "Contract Amount",   type: "money" },
      { k: "startDate",       label: "Start Date",        type: "date" },
      { k: "dueDate",         label: "Due Date",          type: "date" },
      { k: "percentComplete", label: "Percent Complete",  type: "number" },
      { k: "managerId",       label: "Manager",           type: "user" },
      { k: "pmIds",           label: "Additional Project Managers", type: "users" },
      { k: "status",          label: "Status",            type: "kvselect", options: PROJECT_ITEM_STATUS_OPTIONS },
      { k: "addressLine1",    label: "Address Line 1" },
      { k: "addressLine2",    label: "Address Line 2" },
      { k: "city",            label: "City" },
      { k: "state",           label: "State" },
      { k: "pinCode",         label: "PIN Code" },
      { k: "notes",           label: "Notes",             type: "textarea" },
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
        // Outlook-synced datetimes are stored as UTC timestamptz (e.g.
        // "2026-12-10T15:30:00+00:00"). Run through fmtDateTime so the
        // drawer shows the local wall-clock ("Dec 10 · 9:30 AM") like the
        // table/calendar do — NOT the raw UTC ISO string.
        return <div className="field-readonly mono">{val ? fmtDateTime(val) : "—"}</div>;
      }
      if (f.type === "money") {
        return (
          <div className="field-readonly mono">
            {val != null && val !== "" ? fmtMoney(val) : <span className="muted">—</span>}
            {f.readOnlyHint && (
              <span className="muted" style={{ fontSize: 11, marginLeft: 8, fontFamily: "var(--font-body)" }}>
                {f.readOnlyHint}
              </span>
            )}
          </div>
        );
      }
      return <div className="field-readonly">{val || <span className="muted">—</span>}</div>;
    }
    if (f.type === "textarea") return <textarea className="textarea" defaultValue={val || ""} placeholder={f.placeholder} onBlur={e => set(e.target.value)}/>;
    if (f.type === "stars") return (
      <StarRating value={val == null ? null : Number(val)} onChange={v => set(v)}/>
    );
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
    // Value≠label select (machine enum keys → human labels), e.g. Type /
    // Status / Contract Type on a project item.
    if (f.type === "kvselect") return (
      <select className="select" value={val || ""} onChange={e => set(e.target.value || null)}>
        {f.allowEmpty && <option value="">—</option>}
        {(f.options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
    // Parent-project picker (tree). Exclude self; the updater + DB trigger
    // block deeper cycles (can't parent under a descendant).
    if (f.type === "projectParent") {
      const opts = (projectItems || [])
        .filter(it => it.projectId !== row.id)
        .map(it => ({ value: it.projectId, label: `${it.projectId} · ${it.name}` }));
      return (
        <SearchableSelect
          value={val || ""}
          options={opts}
          placeholder="None — top-level project"
          onChange={v => set(v || null)}
        />
      );
    }
    // Subs on a project item — persisted through the dedicated handlers
    // (add/update/remove keyed on company_id), NOT the generic {subs} patch.
    if (f.type === "projectSubs") {
      const subs = val || [];
      const avail = SUB_OPTIONS.filter(o => !subs.some(s => s.cId === o.value));
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {subs.length === 0 && (
            <div style={{
              fontSize: 12.5, color: "var(--text-soft)", fontStyle: "italic",
              padding: "6px 10px", background: "var(--surface-2)",
              border: "1px dashed var(--border)", borderRadius: 8,
            }}>
              No subs yet — pick a firm below to add one.
            </div>
          )}
          {subs.map((s, i) => (
            <div key={s.cId || i} className="subrow"
                 style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) 110px 30px" }}>
              <div className="field-readonly" style={{ fontSize: 12.5, alignSelf: "center" }}>
                {companyById(s.cId)?.name || "—"}
              </div>
              <input className="input" placeholder="Discipline (e.g. Survey)"
                     defaultValue={s.desc || ""}
                     onBlur={e => onUpdateProjectSub?.(s.cId, { desc: e.target.value })}/>
              <input className="input mono" type="number" placeholder="$" min="0"
                     defaultValue={s.amt ?? ""}
                     onBlur={e => onUpdateProjectSub?.(s.cId, { amt: e.target.value === "" ? 0 : Number(e.target.value) })}
                     style={{ fontFamily: "var(--font-mono)", textAlign: "right" }}/>
              <button className="row-btn" title="Remove sub"
                      onClick={() => onRemoveProjectSub?.(s.cId)} style={{ color: "var(--rose)" }}>
                <Icon name="trash" size={12}/>
              </button>
            </div>
          ))}
          <div style={{ marginTop: subs.length ? 4 : 2 }}>
            <SearchableSelect
              value=""
              options={avail}
              placeholder="Add a sub firm…"
              onChange={v => { if (v) onAddProjectSub?.(v); }}
            />
          </div>
        </div>
      );
    }
    return <input className="input" defaultValue={val || ""} onBlur={e => set(e.target.value)}/>;
  };

  const titleMap = {
    potential: "Potential Project",
    awaiting:  "Proposal",
    awarded:   "Awarded Project",
    closed:    "Closed Out Project",
    invoice:   "Anticipated Invoice",
    events:    "Event",
    clients:   "Client",
    companies: "Company",
    openbids:  "Open Bid",
    projects:  "Project",
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
            <h3 className="drawer-title">{row.name || row.title || row.rfqNumber || "—"}</h3>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {onForward && <button className="btn sm primary" onClick={onForward}><Icon name="forward" size={13}/>Move forward</button>}
            {onMoveBack && (
              <span className="move-back-group" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <span style={{ fontSize: 11.5, color: "var(--text-soft)" }}>Move back:</span>
                <button className="btn sm" onClick={() => onMoveBack("awaiting")} title="Reopen as Proposal">
                  <Icon name="back" size={12}/>Proposal
                </button>
                <button className="btn sm" onClick={() => onMoveBack("awarded")} title="Reopen as Awarded">
                  <Icon name="back" size={12}/>Awarded
                </button>
                <button className="btn sm" onClick={() => onMoveBack("invoice")} title="Reopen as Active (Invoice)">
                  <Icon name="back" size={12}/>Invoice
                </button>
              </span>
            )}
            {onDemoteFromOrange && (
              <button
                className="btn sm"
                onClick={onDemoteFromOrange}
                style={{ color: "var(--prob-orange)" }}
                title="Demote from Orange — the Invoice row is removed and the project reappears in Potential."
              >
                <Icon name="forward" size={13}/>Move to Potential
              </button>
            )}
            {onCloseOut && (
              <button
                className="btn sm"
                onClick={onCloseOut}
                style={{ color: "var(--rose)" }}
              >
                <Icon name="x" size={13}/>Close out
              </button>
            )}
            {onAddChild && (
              <button className="btn sm" onClick={onAddChild} title="Add a phase / subphase under this item">
                <Icon name="plus" size={13}/>Add child
              </button>
            )}
            {onAlert && <button className="btn sm" onClick={onAlert}><Icon name="bell" size={13}/>Alert</button>}
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
              <div className={"field-value" + (f.type === "textarea" || f.type === "subs" || f.type === "projectSubs" ? " multiline" : "")}>
                {renderInput(f)}
              </div>
            </div>
          ))}
          {table === "openbids" && (() => {
            const approver = row.approvedBy ? userById(row.approvedBy) : null;
            const stampedAt = row.approvedAt;
            const isPending  = (row.approvalStatus || "pending") === "pending";
            const isApproved = row.approvalStatus === "approved";
            const isRejected = row.approvalStatus === "rejected";
            return (
              <>
                <div className="section-title" style={{ marginTop: 22 }}>
                  <Icon name="check" size={12}/>Approval
                </div>
                <div className="bid-approval-panel">
                  <div className="bid-approval-state">
                    <span className={"chip " + (isApproved ? "sage" : isRejected ? "rose" : "muted")}
                          style={{ fontWeight: 600 }}>
                      <span className="chip-dot"/>
                      {isApproved ? "Approved" : isRejected ? "Rejected" : "Pending"}
                    </span>
                    {(isApproved || isRejected) && approver && (
                      <span className="bid-approval-meta-large">
                        by <strong>{approver.name}</strong>
                        {stampedAt && <> · <span className="mono">{new Date(stampedAt).toLocaleString()}</span></>}
                      </span>
                    )}
                  </div>
                  {isAdmin ? (
                    <div className="bid-approval-controls">
                      {!isApproved && onApproveBid && (
                        <button className="btn sm" onClick={onApproveBid}
                                style={{ borderColor: "var(--sage)", color: "var(--sage)" }}>
                          <Icon name="thumbsUp" size={13}/>Approve
                        </button>
                      )}
                      {!isRejected && onRejectBid && (
                        <button className="btn sm" onClick={onRejectBid}
                                style={{ borderColor: "var(--rose)", color: "var(--rose)" }}>
                          <Icon name="thumbsDown" size={13}/>Reject
                        </button>
                      )}
                      {(isApproved || isRejected) && onClearBidApproval && (
                        <button className="btn sm" onClick={onClearBidApproval}>
                          <Icon name="undo" size={13}/>Clear
                        </button>
                      )}
                    </div>
                  ) : (
                    isPending && (
                      <div style={{ fontSize: 12, color: "var(--text-soft)" }}>
                        <Icon name="lock" size={11}/> Only Admins can approve or reject a bid.
                      </div>
                    )
                  )}
                </div>

                <div className="section-title" style={{ marginTop: 22 }}>
                  <Icon name="export" size={12}/>RFQ/RFP PDF
                </div>
                <div className="bid-pdf-panel">
                  {row.pdfPath ? (
                    <div className="bid-pdf-row">
                      <button type="button" className="tool-chip on" onClick={onOpenBidPdf}
                              title={row.pdfName || "Open PDF"}>
                        <Icon name="check" size={11}/>
                        <span className="bid-pdf-name">{row.pdfName || "PDF attached"}</span>
                      </button>
                      {onRemoveBidPdf && (
                        <button type="button" className="row-btn" title="Remove PDF"
                                onClick={onRemoveBidPdf} style={{ color: "var(--rose)" }}>
                          <Icon name="x" size={11}/>
                        </button>
                      )}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "var(--text-soft)", marginBottom: 8 }}>
                      No PDF attached.
                    </div>
                  )}
                  <label className="tool-chip" style={{ cursor: "pointer" }}>
                    <Icon name="plus" size={11}/>
                    {row.pdfPath ? "Replace PDF…" : "Upload PDF…"}
                    <input type="file" accept="application/pdf,.pdf"
                           style={{ display: "none" }}
                           onChange={e => {
                             const f = e.target.files?.[0];
                             if (f && onUploadBidPdf) onUploadBidPdf(f);
                             e.target.value = "";
                           }}/>
                  </label>
                </div>

                {row.movedToProjectId && (
                  <>
                    <div className="section-title" style={{ marginTop: 22 }}>
                      <Icon name="forward" size={12}/>Moved Forward
                    </div>
                    <div className="chip accent" style={{ fontSize: 12 }}>
                      <Icon name="forward" size={11}/>
                      Linked to Proposals project · {row.movedToProjectId.slice(0, 8)}
                    </div>
                  </>
                )}
              </>
            );
          })()}
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
    // Invoice → Closed Out: the invoice rows flip to billing_state='closed'
    // (every month amount, attachment, and note is KEPT — just hidden from
    // the Invoices / In-Between tabs) and the upstream project flips to
    // status='closed_out'. If no upstream project exists, a new closed_out
    // project is minted from the invoice fields. See the confirmMove handler
    // in App.jsx for persistence details.
    "invoice→closed": {
      title: "Close out project",
      subtitle: "Billing history is kept · project moves to Closed Out",
      carried: ["year","name","projectNumber","pmIds"],
      newFields: [
        { k: "status", label: "Status", type: "pill", value: "Closed Out" },
        { k: "dateClosed", label: "Date Closed", type: "date", value: new Date().toISOString().substr(0,10) },
        { k: "reason", label: "Reason for Closure", type: "textarea", placeholder: "e.g. Project complete, contract ended, client descope…" },
      ]
    },
    // Move-back paths: reopen a Closed Out project. The project row stays
    // (same DB id) — only its `status` flips and stage-specific fields are
    // re-applied. Most close-out fields (role, contract amounts, stage_id,
    // probability, etc.) were nulled at close time, so the user re-enters
    // what's needed for the destination. closed→invoice also spawns a fresh
    // anticipated_invoice row.
    "closed→awaiting": {
      title: "Reopen as Proposal",
      subtitle: "Removes from Closed Out · returns to Proposals",
      carried: ["year","name","projectNumber","pmIds","dateSubmitted"],
      newFields: [
        { k: "status", label: "Status", type: "pill", value: "Proposal" },
        { k: "anticipatedResultDate", label: "Anticipated Result Date", type: "date" },
        { k: "notes", label: "Notes", type: "textarea", placeholder: "Reopen reason / next steps…" },
      ]
    },
    "closed→awarded": {
      title: "Reopen as Awarded",
      subtitle: "Removes from Closed Out · returns to Awarded",
      carried: ["year","name","projectNumber","pmIds","dateSubmitted"],
      newFields: [
        { k: "status", label: "Status", type: "pill", value: "Awarded" },
        { k: "stage", label: "Stage", type: "select", options: ["Multi-Use Contract","Single Use Contract (Project)","AE Selected List"], value: "Multi-Use Contract" },
        { k: "details", label: "Details", type: "textarea", placeholder: "Key notes, scope, team…" },
        { k: "pools", label: "Pools", placeholder: "e.g. IDIQ Pool C" },
        { k: "contractExpiry", label: "Contract Expiry", type: "date" },
      ]
    },
    "closed→invoice": {
      title: "Reopen as Active Project (Invoice)",
      subtitle: "Removes from Closed Out · status flips to Awarded · revives the project's Invoice rows (or spawns one)",
      carried: ["year","name","projectNumber","pmIds"],
      newFields: [
        { k: "_invoiceType", label: "Invoice Type", type: "select", options: ["ENG","PM"], value: "ENG",
          hint: "Determines how billing is categorized in Anticipated Invoice." },
        { k: "_amount",    label: "Contract Amount (optional)", type: "money", value: 0 },
        { k: "_remaining", label: "MSMM Remaining (optional)", type: "money", value: 0 },
      ]
    },
    // Open Bid → Proposals (awaiting). The bid's RFQ #, service description,
    // and due date carry into the Proposals row's `notes` (handled in
    // confirmMove); everything else is captured here. clientId carries
    // straight through. Bid row stays as historical breadcrumb linked via
    // moved_to_project_id.
    // Hot Lead → Proposals. MOVE semantics: a Proposals project is born from
    // the lead (title seeds the project name, notes carry over, client
    // carries straight through) and the lead row is removed — its purpose is
    // served. The toast offers Undo (re-inserts the lead + attendees).
    "hotleads→awaiting": {
      title: "Move to Proposals",
      subtitle: "Creates a Proposals project · the lead is removed (Undo available)",
      carried: ["title", "clientId"],
      newFields: [
        { k: "projectName",      label: "Project Name *",               placeholder: "Working title for the proposal", value: row.title || "" },
        { k: "year",             label: "Year",                         type: "number", value: new Date().getFullYear() },
        { k: "projectNumber",    label: "Project Number",               placeholder: "e.g. 26-101" },
        { k: "dateSubmitted",    label: "Date Submitted",               type: "date", value: new Date().toISOString().substr(0, 10) },
        { k: "anticipatedResultDate", label: "Anticipated Result Date", type: "date" },
        { k: "clientContract",   label: "Client Contract",              placeholder: "$ amount or contract #",
          value: row.anticipatedAmount != null ? fmtMoney(row.anticipatedAmount, false) : "" },
        { k: "msmmRemaining",    label: "MSMM Remaining",               type: "money", value: 0 },
        { k: "notes",            label: "Notes",                        type: "textarea", value: row.notes || "",
          placeholder: "Lead notes carry over — edit freely." },
      ],
    },
    "openbids→awaiting": {
      title: "Move to Proposals",
      subtitle: "Carries to Proposals · Open Bid stays as historical record",
      carried: ["clientId"],
      newFields: [
        { k: "projectName",      label: "Project Name *",                placeholder: "Working title for the submitted proposal" },
        { k: "year",             label: "Year",                          type: "number", value: new Date().getFullYear() },
        { k: "projectNumber",    label: "Project Number",                placeholder: "e.g. 24-101" },
        { k: "dateSubmitted",    label: "Date Submitted",                type: "date", value: new Date().toISOString().substr(0, 10) },
        { k: "anticipatedResultDate", label: "Anticipated Result Date",  type: "date" },
        { k: "clientContract",   label: "Client Contract",               placeholder: "$ amount or contract #",
          value: row.anticipatedAmount != null ? fmtMoney(row.anticipatedAmount, false) : "" },
        { k: "msmmContract",     label: "MSMM Contract #",               placeholder: "e.g. MSMM-2026-045" },
        { k: "msmmUsed",         label: "MSMM Used",                     type: "money", value: 0 },
        { k: "msmmRemaining",    label: "MSMM Remaining",                type: "money", value: 0 },
        { k: "notes",            label: "Notes",                         type: "textarea",
          placeholder: "RFQ # / service / due date are appended automatically." },
      ],
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
    year: "Year", name: "Project", title: "Lead", clientId: "Client", role: "Role", subs: "Subs",
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
  // Party-mode props — when partyKind is set, the modal targets
  // beacon_v2.invoice_party_files and ignores month-level state. Caller
  // passes partyKind ∈ ("msmm"|"prime"|"sub"), partyCompanyId (NULL for
  // 'msmm'), and `files` already filtered to that party.
  partyKind,
  partyCompanyId,
  partyInvoiceId,
  // Prime/total month mode only: the invoice number this month's project
  // total is billed under, plus its persist callback. One number per
  // (project, month) — see updateInvoiceMonthInvoiceNumber in App.jsx.
  invoiceNumber = "",
  onSaveInvoiceNumber,
  // Paid-lock gate (shared with the table cells). canUntickPaid = is the
  // current user an Admin; onRequestUntick opens the App-level confirm dialog.
  canUntickPaid = true,
  onRequestUntick,
  // Attachments are only allowed on actual months — false for a projected
  // month, which hides the upload UI (existing files stay viewable).
  canAttach = true,
  onClose, onChanged,
}) => {
  const isParty = !!partyKind;
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState("");
  const fileRef = useRef(null);
  // Staged files awaiting upload. Stored as File[] so the user can pick / drop
  // multiple times and we accumulate. Each upload submits them sequentially.
  const [picked, setPicked] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  // Counter avoids the dragover/dragleave flicker when the cursor crosses
  // child element boundaries inside the dropzone — we only deactivate when
  // the depth returns to 0.
  const dragDepthRef = useRef(0);
  // Local copy of paid state so the modal feels responsive while the round-trip
  // happens. Synced back to the parent via onChanged after the DB write.
  const [paid, setPaid] = useState(!!initialPaid);
  const [paidAt, setPaidAt] = useState(initialPaidAt);
  // Invoice number (prime/total month mode only). Local draft; persisted on
  // blur and again right before an upload so typing-then-uploading never
  // drops the number. Compares against the latest prop so re-saves are no-ops.
  const showInvNum = !isParty && kind === "prime";
  const [invNum, setInvNum] = useState(invoiceNumber || "");
  const flushInvNum = async () => {
    if (!showInvNum || !onSaveInvoiceNumber) return;
    const clean = invNum.trim();
    if (clean === (invoiceNumber || "").trim()) return;
    try {
      await onSaveInvoiceNumber(clean);
    } catch (e) {
      setError(e?.message || "Couldn't save invoice number");
    }
  };

  // Append picked files to the staged list, deduping by (name, size,
  // lastModified) so re-picking the same file is a no-op. FileList → Array
  // here so callers can pass either.
  const handlePickFiles = (fl) => {
    if (!fl || fl.length === 0) return;
    const incoming = Array.from(fl);
    setPicked(prev => {
      const seen = new Set(prev.map(f => `${f.name}::${f.size}::${f.lastModified || 0}`));
      const next = prev.slice();
      for (const f of incoming) {
        const k = `${f.name}::${f.size}::${f.lastModified || 0}`;
        if (!seen.has(k)) { next.push(f); seen.add(k); }
      }
      return next;
    });
    setError("");
  };
  const removeStaged = (idx) => {
    setPicked(prev => prev.filter((_, i) => i !== idx));
    // Clear the native input value so re-picking the same file works after a
    // removal (browsers suppress onChange when the same file is re-selected).
    if (fileRef.current) fileRef.current.value = "";
  };
  const clearAllStaged = () => {
    setPicked([]);
    if (fileRef.current) fileRef.current.value = "";
  };
  const onZoneDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    dragDepthRef.current += 1;
    setDragActive(true);
  };
  const onZoneDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };
  const onZoneDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const onZoneDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (busy) return;
    const fl = e.dataTransfer?.files;
    if (!fl || fl.length === 0) return;
    handlePickFiles(fl);
  };
  const fmtBytes = (n) => {
    if (n == null) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  const monthLabel = !isParty ? monthFolder(year, monthIdx) : "";
  // Party-mode headers describe the attach point (firm or MSMM line); month
  // mode keeps the existing "Project · Month" framing.
  const partyHeaderTitle = isParty
    ? (partyKind === "msmm"
        ? `MSMM files · ${projectName}`
        : partyKind === "prime"
          ? `Prime files · ${companyName || "Prime"} · ${projectName}`
          : `Sub files · ${companyName || "Sub"} · ${projectName}`)
    : "";
  const partySubhead = isParty
    ? (partyKind === "msmm"
        ? "Project-level attachments for the MSMM line"
        : partyKind === "prime"
          ? `Project-level attachments for ${companyName || "this prime"}`
          : `Project-level attachments for ${companyName || "this sub"}`)
    : "";
  const headerTitle = isParty ? partyHeaderTitle
    : kind === "sub"
      ? `Sub invoices · ${projectName} · ${monthLabel}`
      : `Prime invoice · ${projectName} · ${monthLabel}`;
  const subhead = isParty ? partySubhead
    : kind === "sub"
      ? `Sub: ${companyName || "—"}${amount != null ? ` · ${fmtMoney(amount)}` : ""}`
      : amount != null ? fmtMoney(amount) : "—";

  const applyPaid = async (next) => {
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

  const handleTogglePaid = (next) => {
    if (busy) return;
    if (kind !== "sub") return;
    // A paid invoice is locked: marking paid is open, un-ticking is admin-only
    // and confirmed (same gate as the table cells, via the App-level dialog).
    if (!next) {
      if (!canUntickPaid) {
        setError("This invoice is marked paid and locked — only an administrator can unmark it.");
        return;
      }
      onRequestUntick?.({
        label: `${companyName || "Sub"} · ${MONTHS[monthIdx]}`,
        onConfirm: () => applyPaid(false),
      });
      return;
    }
    applyPaid(true);
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
      if (isParty) {
        await deleteInvoicePartyFile({ fileId: file.id, filePath: file.file_path });
      } else {
        await deleteInvoiceFile({ kind, fileId: file.id, filePath: file.file_path });
      }
      await onChanged?.();
    } catch (e) {
      setError(e?.message || "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async () => {
    if (busy) return;
    if (picked.length === 0) { setError("Choose at least one file first"); return; }
    setBusy(true); setError("");
    // Persist the invoice number first so attaching a PDF without blurring the
    // field still captures the number the user just typed.
    await flushInvNum();
    // Resolve a parent sub_invoice row once (month mode only). Created on
    // demand so the user doesn't have to type an amount before attaching a PDF.
    let parentSubInvoiceId = subInvoiceId;
    if (!isParty && kind === "sub" && !parentSubInvoiceId) {
      try {
        const row = await ensureSubInvoiceRow({
          projectId, companyId, year, month: monthIdx + 1,
        });
        parentSubInvoiceId = row.id;
      } catch (e) {
        setError(e?.message || "Couldn't create sub_invoice row");
        setBusy(false);
        return;
      }
    }
    // Upload each staged file in sequence. Partial failures: keep the
    // unsuccessful files staged so the user can retry; show a single error
    // line naming the first failure. Successful uploads are pruned from
    // the staged list as we go.
    const failures = [];
    for (let i = 0; i < picked.length; i++) {
      const file = picked[i];
      try {
        if (isParty) {
          await uploadInvoicePartyFile({
            invoiceId: partyInvoiceId,
            projectId,
            partyKind,
            partyCompanyId,
            companyName,
            file,
            notes,
          });
        } else {
          await uploadInvoiceFile({
            kind, projectId, year, monthIdx,
            file, notes,
            primeInvoiceId,
            subInvoiceId: parentSubInvoiceId,
            companyId, companyName,
          });
        }
      } catch (e) {
        failures.push({ file, message: e?.message || "Upload failed" });
      }
    }
    // Drop the successes from staged; keep failures so the user can retry.
    const failedSet = new Set(failures.map(f => `${f.file.name}::${f.file.size}::${f.file.lastModified || 0}`));
    setPicked(prev => prev.filter(f =>
      failedSet.has(`${f.name}::${f.size}::${f.lastModified || 0}`)));
    if (failures.length === 0) {
      setNotes("");
      if (fileRef.current) fileRef.current.value = "";
    } else {
      setError(`${failures.length} of ${picked.length} failed — ${failures[0].message}`);
    }
    setBusy(false);
    await onChanged?.();
  };

  return (
    <>
      <div
        className="overlay"
        onClick={onClose}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
      />
      <div
        className="modal"
        style={{ width: 580, maxHeight: "86vh", display: "flex", flexDirection: "column" }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
      >
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
          {showInvNum && (
            <div className={"invoice-invnum-field" + (invNum.trim() ? " has-value" : "")}>
              <label className="invoice-invnum-label" htmlFor="prime-invnum">
                <Icon name="hash" size={12}/>
                Invoice number
              </label>
              <input
                id="prime-invnum"
                className="input invoice-invnum-input mono"
                value={invNum}
                onChange={(e) => setInvNum(e.target.value)}
                onBlur={flushInvNum}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
                disabled={busy}
                placeholder="e.g. INV-2026-014"
                autoComplete="off"
              />
              <div className="invoice-invnum-hint">
                The number this {monthLabel} project total is billed under — shown as a chip on the total cell.
              </div>
            </div>
          )}
          {!isParty && kind === "sub" && (
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

          {!canAttach ? (
            <div className="invoice-attach-locked">
              <Icon name="clock" size={14}/>
              <div>
                <strong>Attachments locked for this month</strong>
                <span>This month is still a projection — attachments can be added once it becomes an actual month.</span>
              </div>
            </div>
          ) : (
          <div>
            <div className="section-title">
              <Icon name="plus" size={12}/>
              Add a file
            </div>
            <input
              ref={fileRef}
              type="file"
              className="input"
              multiple
              onChange={(e) => handlePickFiles(e.target.files)}
              disabled={busy}
              style={{ width: "100%" }}
            />
            <div
              className={"invoice-dropzone"
                + (dragActive ? " dragover" : "")
                + (busy ? " is-busy" : "")}
              onDragEnter={onZoneDragEnter}
              onDragLeave={onZoneDragLeave}
              onDragOver={onZoneDragOver}
              onDrop={onZoneDrop}
              aria-label="Drag and drop files here"
              aria-busy={busy || undefined}
            >
              <div className="invoice-dropzone-prompt">
                <Icon name="export" size={14}/>
                <span>{dragActive
                  ? (picked.length > 0 ? "Drop to add to staged" : "Drop to attach")
                  : "or drag and drop file(s) here"}</span>
              </div>
            </div>
            {picked.length > 0 && (
              <ul className="invoice-staged-list" aria-label="Files staged for upload">
                {picked.map((f, i) => (
                  <li key={`${f.name}::${f.size}::${i}`}>
                    <Icon name="check" size={12}/>
                    <span className="invoice-staged-name mono" title={f.name}>{f.name}</span>
                    <span className="invoice-staged-size mono subtle">{fmtBytes(f.size)}</span>
                    <button
                      type="button"
                      className="invoice-staged-remove"
                      onClick={() => removeStaged(i)}
                      disabled={busy}
                      aria-label={`Remove ${f.name} from staged files`}
                    >
                      <Icon name="x" size={11}/>
                    </button>
                  </li>
                ))}
                {picked.length > 1 && (
                  <li className="invoice-staged-clear-row">
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={clearAllStaged}
                      disabled={busy}
                    >
                      Clear all ({picked.length})
                    </button>
                  </li>
                )}
              </ul>
            )}
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
          )}

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
            {canAttach && (
            <button className="btn primary sm"
                    onClick={handleUpload}
                    disabled={busy || picked.length === 0}>
              <Icon name="check" size={13}/>
              {busy
                ? (picked.length > 1 ? `Uploading ${picked.length}…` : "Uploading…")
                : (picked.length > 1 ? `Upload ${picked.length} files` : "Upload")}
            </button>
            )}
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
  onCompanyCreated,             // (uiCompanyRow) => mirror into App's companies state
}) => {
  const isPrime = kind === "prime";
  const [companyId, setCompanyId] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Inline "create a firm that isn't in the Directory yet" sub-flow. Firms
  // created here are stashed locally too (not just pushed up to App) so the
  // picker resolves the new selection immediately, independent of when the
  // parent's companies state flushes back down as a prop.
  const [creating, setCreating] = useState(false);
  const [localCompanies, setLocalCompanies] = useState([]);
  const [nf, setNf] = useState({ name: "", contact: "", email: "", phone: "" });
  const [nfBusy, setNfBusy] = useState(false);
  const [nfError, setNfError] = useState("");

  const needsProjectLink = !projectId;

  // Subs are external firms (Companies, not Clients). Filter the merged
  // _companies list to non-Client entries — same behavior as SubsEditor.
  // Locally-created firms are merged in (deduped by id) so a just-added firm
  // is selectable before the parent prop catches up.
  const seenIds = new Set((companies || []).map(c => c.id));
  const mergedCompanies = [
    ...(companies || []),
    ...localCompanies.filter(c => !seenIds.has(c.id)),
  ];
  const subOptions = mergedCompanies
    .filter(c => c.type !== "Client")
    .map(c => ({ value: c.id, label: c.name }));

  const beginCreate = (seedName = "") => {
    setNf({ name: seedName, contact: "", email: "", phone: "" });
    setNfError("");
    setCreating(true);
  };
  const cancelCreate = () => { setCreating(false); setNfError(""); };

  const saveNewFirm = async () => {
    const clean = nf.name.trim();
    if (!clean) { setNfError("Enter a firm name."); return; }
    // If the firm is actually already in the Directory (case-insensitive),
    // just select it instead of creating a near-duplicate.
    const dup = mergedCompanies.find(
      c => c.type !== "Client" && (c.name || "").trim().toLowerCase() === clean.toLowerCase()
    );
    if (dup) {
      setCompanyId(dup.id);
      setCreating(false);
      setError("");
      return;
    }
    setNfBusy(true); setNfError("");
    try {
      const uiRow = await addCompany({
        name: clean, contact: nf.contact, email: nf.email, phone: nf.phone,
      });
      setLocalCompanies(prev => [uiRow, ...prev]);
      onCompanyCreated?.(uiRow);   // mirror into App-wide companies state
      setCompanyId(uiRow.id);      // select the new firm in the picker
      setCreating(false);
      setError("");
    } catch (e) {
      setNfError(e?.message || "Could not add firm");
    } finally {
      setNfBusy(false);
    }
  };

  const canSubmit = !!companyId && !busy && !creating
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
      const { row: inserted, existed } = await addProjectSub({
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
      onAdded?.({ inserted, existed, linkedProjectId, invoiceId, autoLinkedProject, kind });
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
              {creating ? (
                <div className="newfirm-card">
                  <div className="newfirm-head">
                    <Icon name="briefcase" size={12}/>
                    <span className="newfirm-title">New firm</span>
                    <span className="newfirm-note">adds to the Directory</span>
                    <button type="button" className="newfirm-x" onClick={cancelCreate}
                            disabled={nfBusy} title="Cancel">
                      <Icon name="x" size={12}/>
                    </button>
                  </div>
                  <input className="input" autoFocus
                         placeholder="Firm name *"
                         value={nf.name}
                         disabled={nfBusy}
                         onChange={(e) => setNf(p => ({ ...p, name: e.target.value }))}
                         onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveNewFirm(); } }}/>
                  <div className="newfirm-grid">
                    <input className="input"
                           placeholder="Contact"
                           value={nf.contact}
                           disabled={nfBusy}
                           onChange={(e) => setNf(p => ({ ...p, contact: e.target.value }))}/>
                    <input className="input"
                           placeholder="Email"
                           value={nf.email}
                           disabled={nfBusy}
                           onChange={(e) => setNf(p => ({ ...p, email: e.target.value }))}/>
                  </div>
                  <input className="input"
                         placeholder="Phone"
                         value={nf.phone}
                         disabled={nfBusy}
                         onChange={(e) => setNf(p => ({ ...p, phone: e.target.value }))}/>
                  {nfError && <div className="newfirm-error">{nfError}</div>}
                  <div className="newfirm-actions">
                    <button type="button" className="btn sm" onClick={cancelCreate} disabled={nfBusy}>
                      Cancel
                    </button>
                    <button type="button" className="btn primary sm"
                            onClick={saveNewFirm} disabled={nfBusy || !nf.name.trim()}>
                      <Icon name="check" size={12}/>
                      {nfBusy ? "Adding…" : "Add & select"}
                    </button>
                  </div>
                </div>
              ) : (
                <SearchableSelect
                  value={companyId}
                  options={subOptions}
                  placeholder={isPrime ? "Search prime firms…" : "Search firms…"}
                  onChange={(v) => setCompanyId(v || "")}
                  onCreate={(term) => beginCreate(term)}
                  createLabel={isPrime ? "Add a new prime firm…" : "Add a new firm…"}
                />
              )}
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
            Firm not listed? Type its name and choose <strong>Create</strong> — it's added to the Directory.
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

// ---------- MergeModal ----------
// Consolidate 2+ duplicate Directory rows into one. The user picks which record
// to KEEP (the survivor); every reference on the others is repointed to it and
// the duplicates are deleted (server-side, transactional — see mergeEntities /
// 20260606130000_merge_entities.sql). All selected rows are the same kind (the
// table only lets you select one kind at a time). The MSMM company can never be
// deleted, so if it's in the set it's force-kept.
export const MergeModal = ({
  entities = [],
  kind = "Company",                 // "Client" | "Company"
  projectsByType, invoice, hotLeads = [], openBids = [],
  onClose, onConfirm,
}) => {
  const isClient = kind === "Client";
  // Per-entity reference blast radius, memoized off the in-memory slices.
  const summaries = React.useMemo(() => {
    const m = new Map();
    for (const e of entities) {
      m.set(e.id, mergeRefSummary(e, { projectsByType, invoice, hotLeads, openBids }));
    }
    return m;
  }, [entities, projectsByType, invoice, hotLeads, openBids]);

  // MSMM (company singleton) can't be deleted → it must be the survivor.
  const msmm = entities.find(e => e.isMsmm);
  // Default survivor: MSMM if present, else the richest (most-referenced) row —
  // keeping the one with the most history minimizes downstream surprise.
  const defaultSurvivor =
    msmm?.id ||
    entities.slice().sort(
      (a, b) => (summaries.get(b.id)?.total || 0) - (summaries.get(a.id)?.total || 0)
    )[0]?.id ||
    entities[0]?.id;

  const [survivorId, setSurvivorId] = useState(defaultSurvivor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const survivorLocked = !!msmm; // MSMM forces the survivor

  const survivor = entities.find(e => e.id === survivorId);
  const losers   = entities.filter(e => e.id !== survivorId);
  const totalRefs = losers.reduce((a, e) => a + (summaries.get(e.id)?.total || 0), 0);

  const nameOf = (e) => isClient ? (e.baseName || e.name) : e.name;
  const subOf  = (e) =>
    isClient ? (e.district || "") : (e.type && e.type !== "Multiple" ? e.type : "");

  const summaryLine = (s) => {
    if (!s || !s.total) return "No references";
    const bits = [];
    if (s.projects.length) bits.push(`${s.projects.length} project${s.projects.length > 1 ? "s" : ""}`);
    if (s.leadCount) bits.push(`${s.leadCount} lead${s.leadCount > 1 ? "s" : ""}`);
    if (s.bidCount)  bits.push(`${s.bidCount} bid${s.bidCount > 1 ? "s" : ""}`);
    return bits.join(" · ");
  };

  const handleSubmit = async () => {
    if (busy || !survivorId || losers.length === 0) return;
    setBusy(true); setError("");
    try {
      await onConfirm(survivorId, losers.map(e => e.id));
    } catch (e) {
      setError(e?.message || "Merge failed");
      setBusy(false);
    }
    // On success the parent closes the modal + reloads, so no setBusy(false) here.
  };

  return (
    <>
      <div className="overlay" onClick={busy ? undefined : onClose}/>
      <div className="modal merge-modal" style={{ width: 540 }}>
        <div className="modal-head">
          <div className="icon-badge"><Icon name="merge" size={16}/></div>
          <div style={{ flex: 1 }}>
            <div className="drawer-eyebrow" style={{ marginBottom: 2 }}>
              Directory · Merge
            </div>
            <h3 className="drawer-title" style={{ fontSize: 16 }}>
              Merge {entities.length} {isClient ? "clients" : "companies"} into one
            </h3>
            <div style={{ fontSize: 12, color: "var(--text-soft)", marginTop: 3 }}>
              Pick the record to <strong>keep</strong>. Every reference on the others —
              across Open Bids, Awaiting, Awarded, Closed Out, Potential, Invoice
              {isClient ? "" : ", sub-invoices"} and Hot Leads — moves to it, then the
              duplicates are deleted.
            </div>
          </div>
          <button className="drawer-close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={16}/>
          </button>
        </div>

        <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {survivorLocked && (
            <div className="merge-note">
              <Icon name="lock" size={12}/>
              <span><strong>MSMM</strong> can't be deleted, so it's kept as the surviving record.</span>
            </div>
          )}

          <div className="merge-cards">
            {entities.map(e => {
              const isSurv = e.id === survivorId;
              const s = summaries.get(e.id);
              const disabled = busy || (survivorLocked && !e.isMsmm);
              return (
                <button
                  key={e.id}
                  type="button"
                  className={"merge-card" + (isSurv ? " survivor" : " loser") + (disabled && !isSurv ? " is-disabled" : "")}
                  onClick={() => { if (!disabled && !survivorLocked) setSurvivorId(e.id); }}
                  disabled={disabled && !isSurv}
                  aria-pressed={isSurv}>
                  <span className={"merge-radio" + (isSurv ? " on" : "")}>
                    {isSurv && <Icon name="check" size={11}/>}
                  </span>
                  <span className="merge-card-main">
                    <span className="merge-card-name">
                      {nameOf(e)}
                      {e.isMsmm && <span className="merge-msmm-tag">MSMM</span>}
                    </span>
                    <span className="merge-card-sub">
                      {subOf(e) && <span className="merge-card-kindchip">{subOf(e)}</span>}
                      <span className="merge-card-refs">{summaryLine(s)}</span>
                    </span>
                  </span>
                  <span className={"merge-badge " + (isSurv ? "keep" : "drop")}>
                    {isSurv ? "Keep" : "Merge & delete"}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="merge-summary">
            <Icon name="forward" size={13}/>
            <span>
              {totalRefs > 0 ? (
                <><strong>{totalRefs}</strong> reference{totalRefs > 1 ? "s" : ""} will be repointed to{" "}
                <strong>{survivor ? nameOf(survivor) : "—"}</strong>.</>
              ) : (
                <>No references to repoint — the duplicate{losers.length > 1 ? "s" : ""} will just be removed.</>
              )}{" "}
              {losers.length} record{losers.length > 1 ? "s" : ""} deleted.
            </span>
          </div>

          <div className="merge-warn">
            <Icon name="warn" size={13}/>
            <span>This can't be undone. Storage attachments stay in place and remain visible on the kept record.</span>
          </div>

          {error && (
            <div style={{ color: "var(--rose)", fontSize: 12 }}>{error}</div>
          )}
        </div>

        <div className="modal-foot">
          <div style={{ fontSize: 11, color: "var(--text-soft)" }}>
            Profile fields (contact, email…) aren't merged — only references move.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn sm" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn primary sm" onClick={handleSubmit}
                    disabled={busy || !survivorId || losers.length === 0}>
              <Icon name="merge" size={13}/>
              {busy ? "Merging…" : `Merge ${losers.length} → 1`}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

// ---------- ConfirmDialog ----------
// Small reusable confirmation prompt. Renders above other modals (elevated
// z-index via .confirm-overlay/.confirm-modal) so it stacks correctly whether
// it's triggered from a table cell or from inside another open modal. `onConfirm`
// may be async; the dialog shows a working state and closes when it resolves.
export const ConfirmDialog = ({
  title = "Are you sure?",
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",        // "default" | "danger"
  icon = "warn",
  onConfirm, onClose,
}) => {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try { await onConfirm?.(); }
    catch { /* the underlying action surfaces its own toast on failure */ }
    onClose?.();
  };
  return (
    <>
      <div className="overlay confirm-overlay" onClick={busy ? undefined : onClose}/>
      <div className="modal confirm-modal" style={{ width: 420 }} role="alertdialog" aria-modal="true">
        <div className="modal-head">
          <div className={"icon-badge" + (tone === "danger" ? " danger" : "")}>
            <Icon name={icon} size={16}/>
          </div>
          <div style={{ flex: 1 }}>
            <h3 className="drawer-title" style={{ fontSize: 16 }}>{title}</h3>
          </div>
          <button className="drawer-close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={16}/>
          </button>
        </div>
        {message && (
          <div className="modal-body">
            <p className="confirm-message">{message}</p>
          </div>
        )}
        <div className="modal-foot" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button className="btn sm" onClick={onClose} disabled={busy}>{cancelLabel}</button>
          <button className={"btn sm " + (tone === "danger" ? "danger" : "primary")}
                  onClick={run} disabled={busy}>
            {!busy && tone === "danger" && <Icon name={icon} size={13}/>}
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
};
