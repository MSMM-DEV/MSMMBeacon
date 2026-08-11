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
  projectItemDescendantIds,
} from "./data.js";
import { SearchableSelect } from "./primitives.jsx";
import { HOT_LEAD_STAR_MAX } from "./star-rating.js";
import { INVOICE_TYPE_OPTIONS } from "./invoice-perspectives.js";
import {
  Sheet, SheetContent, SheetHeader, SheetBody, SheetFooter, SheetTitle, SheetDescription,
  Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription,
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle,
  AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
  Alert, Badge, Button, EmptyState,
} from "@/ui";

// ==========================================================================
// SHARED DRAWER + MODAL LAYER
//
// Every overlay below is a Radix surface from `@/ui` — Sheet for the record
// drawer and the pipeline transition, Dialog for the forms, AlertDialog for
// the confirms. Focus trapping, escape-to-close, focus restore, scroll lock
// and the aria wiring therefore come from the kit rather than being
// hand-rolled per panel.
//
// Control flow is deliberately unchanged: App.jsx mounts each of these only
// while it is open, so `open` is hard-wired true and `onOpenChange` funnels
// straight back into the caller's own `onClose`. Same props in, same
// callbacks out.
// ==========================================================================

/** Product-wide placeholder for an empty value (en dash, never an em dash). */
const EMPTY = "–";

/**
 * Radix dismisses a modal surface on any pointer-down outside its content.
 * `SearchableSelect` renders its option list through a portal on <body>,
 * i.e. outside the panel, so picking an option would otherwise close the
 * whole drawer. Keep the panel open for those interactions only; a click on
 * the scrim still closes as before.
 */
function keepOpenForPortalMenus(e) {
  const t = e?.detail?.originalEvent?.target;
  if (t && t.nodeType === 1 && typeof t.closest === "function"
      && t.closest(".searchable-menu, .searchable-select, .menu")) {
    e.preventDefault();
  }
}

/** `onOpenChange` adaptor: the panel is mounted only while open, so the only
 *  transition Radix can report is open → closed. */
const closeVia = (onClose) => (open) => { if (!open) onClose?.(); };

/* Right-side record panel from `sm` up, full-height bottom sheet below it.
   The kit's `side="right"` variant supplies the desktop geometry; these
   `max-sm:` overrides re-anchor the panel to the bottom edge and swap the
   slide axis by retargeting tw-animate's enter/exit translate variables. */
const SHEET_SIDE_TO_BOTTOM = [
  "bx-panelkit",
  "sm:w-[min(94vw,680px)]",
  "max-sm:inset-x-0 max-sm:inset-y-auto max-sm:left-0 max-sm:right-0 max-sm:bottom-0",
  "max-sm:h-[94dvh] max-sm:w-full max-sm:max-w-none",
  "max-sm:rounded-t-[var(--radius-xl)] max-sm:border-l-0 max-sm:border-t",
  "max-sm:[--tw-enter-translate-x:0px] max-sm:[--tw-exit-translate-x:0px]",
  "max-sm:[--tw-enter-translate-y:100%] max-sm:[--tw-exit-translate-y:100%]",
].join(" ");

/** Uppercase section heading used to break a long panel body into real groups.
 *
 *  No trailing rule. The heading used to run a hairline from the title out to
 *  the panel's right edge, which stacked against the borders the panel already
 *  draws — the sheet header's own bottom border directly above the first
 *  section, and the dashed field separators below it — and read as a doubled
 *  line rather than as one divider. The uppercase, muted, tracked heading is
 *  enough of a break on its own, and the gap between sections does the rest. */
function PanelSection({ icon, title, count, action, children, className = "" }) {
  return (
    <section className={"min-w-0" + (className ? " " + className : "")}>
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <h3 className="m-0 flex min-w-0 items-center gap-1.5 text-[length:var(--fs-xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-muted)]">
          {icon ? <Icon name={icon} size={12}/> : null}
          <span className="truncate">{title}</span>
          {count != null && (
            <span className="num rounded-[var(--radius-full)] bg-[var(--surface-3)] px-1.5 py-px text-[length:var(--fs-2xs)] font-semibold text-[var(--text-muted)]">
              {count}
            </span>
          )}
        </h3>
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** One label + control row. Stacks on phones, two columns from `sm` up. */
function PanelField({ label, hint, required, multiline = false, children }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 border-b border-dashed border-[var(--border)] py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,140px)_minmax(0,1fr)] sm:gap-4">
      <div className={"flex items-start gap-1 text-[length:var(--fs-xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]" + (multiline ? "" : " sm:pt-2")}>
        <span className="min-w-0 break-words">{label}</span>
        {required ? <span className="text-[var(--destructive)]" aria-hidden="true">*</span> : null}
      </div>
      <div className="min-w-0">
        {children}
        {hint ? (
          <p className="m-0 mt-1 text-[length:var(--fs-xs)] leading-[var(--lh-snug)] text-[var(--text-soft)]">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

/** Definition row used by the read-only "carried forward" summaries. */
function PanelDefRow({ term, children }) {
  return (
    <div className="grid grid-cols-[minmax(0,132px)_minmax(0,1fr)] items-baseline gap-3 py-1.5">
      <dt className="min-w-0 break-words text-[length:var(--fs-xs)] font-medium uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">{term}</dt>
      <dd className="m-0 min-w-0 break-words text-[length:var(--fs-sm)] text-[var(--text)]">{children}</dd>
    </div>
  );
}

/* Status vocabulary. Semantics are fixed product-wide (see design/README
   section 2): sage = awarded/approved, clay = closed out/rejected,
   brand = awaiting/attention, steel = paused or in-between,
   neutral = potential. Never signalled by colour alone — every badge below
   carries both a label and a glyph. */
const STATUS_TONE = {
  "Potential":        { tone: "neutral", icon: "dot" },
  "Proposal":         { tone: "brand",   icon: "hourglass" },
  "Awaiting Verdict": { tone: "brand",   icon: "hourglass" },
  "Awarded":          { tone: "success", icon: "checkCircle" },
  "Closed Out":       { tone: "danger",  icon: "ban" },
  "Booked":           { tone: "info",    icon: "calendar" },
  "Scheduled":        { tone: "brand",   icon: "calendarClock" },
  "Happened":         { tone: "neutral", icon: "check" },
};

function RecordStatusBadge({ status }) {
  if (!status) return null;
  const meta = STATUS_TONE[status] || { tone: "neutral", icon: "dot" };
  return (
    <Badge tone={meta.tone}>
      <Icon name={meta.icon} size={12}/>
      {status}
    </Badge>
  );
}

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
            <button type="button"
                    aria-label={`Remove ${u.name}`}
                    onClick={(e) => { e.stopPropagation(); onChange(ids.filter(x => x !== uid)); }}>
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
// row badged by status (Potential / Awaiting / Awarded / Closed) plus a small
// INV marker when the project has a linked anticipated_invoice row.
// Sort: Awaiting → Awarded → Potential → Closed Out, then year DESC inside.
const STATUS_CHIP = {
  potential:  { label: "Potential",  tone: "neutral", icon: "dot" },
  awaiting:   { label: "Awaiting",   tone: "brand",   icon: "hourglass" },
  awarded:    { label: "Awarded",    tone: "success", icon: "checkCircle" },
  closed:     { label: "Closed",     tone: "danger",  icon: "ban" },
};
const STATUS_ORDER = { awaiting: 1, awarded: 2, potential: 3, closed: 4 };

const LIST_ROW =
  "group flex w-full min-w-0 items-start gap-3 rounded-[var(--radius-sm)] px-2 py-2.5 text-left " +
  "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] " +
  "hover:bg-[var(--surface-2)] active:bg-[var(--surface-3)] " +
  "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]";

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
    <PanelSection
      icon="briefcase"
      title="Linked projects"
      count={projectCount}
      className="mt-5"
      action={invoiceCount > 0 ? (
        <span className="num shrink-0 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
          {invoiceCount} {invoiceCount === 1 ? "invoice" : "invoices"}
        </span>
      ) : null}
    >
      {projectCount === 0 ? (
        <EmptyState
          compact
          title="No linked projects"
          description="Projects appear here once this record is set as their client, prime or sub."
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-px p-0">
          {sorted.map(p => {
            const meta = STATUS_CHIP[p.statusKey] || { label: p.statusKey, tone: "neutral", icon: "dot" };
            return (
              <li key={p.id} className="min-w-0">
                <button
                  type="button"
                  className={LIST_ROW}
                  data-status={p.statusKey}
                  onClick={() => onOpenProject?.(p.id, p.statusKey)}
                >
                  <Badge tone={meta.tone} className="mt-px">
                    <Icon name={meta.icon} size={12}/>
                    {meta.label}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[length:var(--fs-sm)] font-medium text-[var(--text)]">
                      {p.name}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
                      <span className="num">{p.year || EMPTY}</span>
                      <span aria-hidden="true">·</span>
                      <span className="num">{p.projectNumber || EMPTY}</span>
                      <span aria-hidden="true">·</span>
                      <span className="truncate">{p.role}</span>
                      {p.hasInvoice && (
                        <Badge
                          tone="info"
                          size="sm"
                          title={p.invoiceTooltip || "Linked anticipated_invoice row"}
                        >
                          <Icon name="wallet" size={11}/>
                          INV
                        </Badge>
                      )}
                    </span>
                  </span>
                  <Icon
                    name="chevronRight"
                    size={14}
                    className="mt-1 shrink-0 text-[var(--text-soft)] transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] group-hover:translate-x-0.5"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </PanelSection>
  );
}

// ============ LINKED SUBS (drawer subsection for Invoice rows) ============
// Shown below the editable fields when an Invoice row is open. Reads the
// linked project's project_subs (already on the project's `subs` array via
// the loader) and renders a compact list. Includes an inline "Add sub"
// trigger that opens the AddSubModal — same flow as the table's expand row.
export function LinkedSubsSection({ subs = [], invoiceLinked, onAddSub }) {
  const total = subs.reduce((a, s) => a + (Number(s.amt) || 0), 0);
  return (
    <PanelSection
      icon="briefcase"
      title="Linked subs"
      count={subs.length}
      className="mt-5"
      action={
        <Button
          type="button"
          size="xs"
          variant="subtle"
          onClick={onAddSub}
          title="Add a sub to this project"
        >
          <Icon name="plus" size={12}/>
          Add sub
        </Button>
      }
    >
      {subs.length === 0 ? (
        <EmptyState
          compact
          title="No subs yet"
          description={invoiceLinked
            ? "No subs are tracked on this project yet."
            : "Choose “Add sub” and Beacon links this invoice to a project for you."}
        />
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-px p-0">
            {subs.map((s, i) => {
              const company = companyById(s.cId);
              return (
                <li
                  key={i}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 rounded-[var(--radius-sm)] px-2 py-2 hover:bg-[var(--surface-2)]"
                >
                  <span className="min-w-0 truncate text-[length:var(--fs-sm)] font-medium text-[var(--text)]">
                    {company?.name || EMPTY}
                  </span>
                  <span className="num shrink-0 text-[length:var(--fs-sm)] tabular-nums text-[var(--text)]">
                    {s.amt ? fmtMoney(s.amt) : <span className="text-[var(--text-soft)]">{EMPTY}</span>}
                  </span>
                  <span className="col-span-2 min-w-0 truncate text-[length:var(--fs-xs)] text-[var(--text-soft)]">
                    {s.desc || EMPTY}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-[var(--border)] px-2 pt-2">
            <span className="text-[length:var(--fs-xs)] uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
              Total
            </span>
            <span className="num text-[length:var(--fs-sm)] font-semibold text-[var(--text)]">
              {fmtMoney(total)}
            </span>
          </div>
        </>
      )}
    </PanelSection>
  );
}

// ============ DETAIL DRAWER (read/edit a row) ============
// Field groups. Purely presentational: the per-table `fields` arrays below
// stay the single source of truth for WHICH fields exist and in what order —
// this map only decides which heading a field sits under, and any field not
// listed here falls through into a trailing "More" group so the drawer is
// still the complete editor for the row.
const FIELD_GROUPS = [
  { id: "overview", title: "Overview", icon: "clipboard",
    keys: ["year","name","title","localId","projectNumber","rfqNumber","parentId","itemType",
           "type","baseName","district","orgType","stars","probability"] },
  { id: "parties", title: "People and firms", icon: "users",
    keys: ["clientId","primeId","role","subs","pmIds","managerId","attendees"] },
  { id: "contact", title: "Contact", icon: "mail",
    keys: ["contact","email","phone","address"] },
  { id: "commercial", title: "Contract and money", icon: "wallet",
    keys: ["amount","msmm","msmmUsed","msmmRemaining","remainingStart","anticipatedAmount",
           "clientContract","msmmContract","contractType","contractAmount","pools",
           "anticipatedInvoiceStartMonth","laborCost","expenseCost","billedServices",
           "billedExpenses","billedTaxes","totalBilled"] },
  { id: "schedule", title: "Dates and status", icon: "calendar",
    keys: ["status","stage","dateTime","dueAt","dateSubmitted","anticipatedResultDate",
           "contractExpiry","dateClosed","nextActionDate","dates","startDate","dueDate",
           "percentComplete"] },
  { id: "location", title: "Location", icon: "pin",
    keys: ["addressLine1","addressLine2","city","state","pinCode"] },
  { id: "narrative", title: "Notes and detail", icon: "note",
    keys: ["notes","details","description","reason","serviceDescription","webLink"] },
];

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
      { k: "type",           label: "Type",                    type: "select", options: INVOICE_TYPE_OPTIONS },
      { k: "pmIds",          label: "PMs",                     type: "users" },
      { k: "amount",         label: "Total Contract Value",    type: "money" },
      // Linked-pair MSMM is edited on the expanded HZ sub row, not in this
      // project-level drawer. Unlinked rows keep their legacy derived fallback.
      { k: "remainingStart", label: "Rollforward (from 2025)",   type: "money", readOnlyIf: () => !isAdmin, readOnlyHint: "Auto-calculated, admins only" },
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
      { k: "stars",          label: "Rating",                  type: "stars", max: HOT_LEAD_STAR_MAX },
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
      { k: "localId",         label: row.parentId ? "Phase / Subphase ID" : "Project ID", type: "mono" },
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
      { k: "laborCost",       label: "Total Labor Cost",     type: "money" },
      { k: "expenseCost",     label: "Total Expense Cost",   type: "money" },
      { k: "billedServices",  label: "Billed: Services",     type: "money" },
      { k: "billedExpenses",  label: "Billed: Expenses",     type: "money" },
      { k: "billedTaxes",     label: "Billed: Taxes",        type: "money" },
      { k: "totalBilled",     label: "Total Billed / Paid",  type: "money" },
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
          return <div className="field-readonly muted">No MSMM attendees</div>;
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
        return <div className="field-readonly mono num">{val ? fmtDateTime(val) : EMPTY}</div>;
      }
      if (f.type === "money") {
        return (
          <div className="field-readonly mono num">
            {val != null && val !== "" ? fmtMoney(val) : <span className="muted">{EMPTY}</span>}
            {f.readOnlyHint && (
              <span className="muted" style={{ fontSize: 11, marginLeft: 8, fontFamily: "var(--font-body)" }}>
                {f.readOnlyHint}
              </span>
            )}
          </div>
        );
      }
      return <div className="field-readonly">{val || <span className="muted">{EMPTY}</span>}</div>;
    }
    if (f.type === "textarea") return <textarea className="textarea" defaultValue={val || ""} placeholder={f.placeholder} onBlur={e => set(e.target.value)}/>;
    if (f.type === "stars") return (
      <StarRating value={val == null ? null : Number(val)} max={f.max} onChange={v => set(v)}/>
    );
    if (f.type === "select") return (
      <select className="select" value={val || ""} onChange={e => set(e.target.value)}>
        <option value="">{EMPTY}</option>
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
        <option value="">{EMPTY}</option>
        {USERS.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    );
    if (f.type === "users") return (
      <UsersField value={val || []} onChange={set}
                  placeholder={f.placeholder || "Pick MSMM users…"}/>
    );
    if (f.type === "money") return (
      <input className="input mono num" type="number" defaultValue={val || ""} onBlur={e => set(Number(e.target.value))}
        style={{ fontFamily: "var(--font-mono)" }}/>
    );
    if (f.type === "date" || f.type === "datetime") return (
      <input className="input mono num" type={f.type === "datetime" ? "datetime-local" : "date"} defaultValue={val || ""} onBlur={e => set(e.target.value)}
        style={{ fontFamily: "var(--font-mono)" }}/>
    );
    if (f.type === "mono") return (
      <input className="input mono num" defaultValue={val || ""} onBlur={e => set(e.target.value)}
        style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}/>
    );
    if (f.type === "month") return (
      <select className="select" value={val || ""}
              onChange={e => set(e.target.value === "" ? null : Number(e.target.value))}>
        <option value="">{EMPTY}</option>
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
        <div className="flex min-w-0 flex-col gap-2">
          {subs.length === 0 && (
            <p className="m-0 rounded-[var(--radius-sm)] border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
              No subs yet. Use the button below to add one.
            </p>
          )}
          {subs.map((s, i) => (
            <div key={i}
                 className="grid min-w-0 grid-cols-1 gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_110px_32px] sm:items-center">
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
                className="input mono num"
                type="number"
                placeholder="$"
                min="0"
                value={s.amt ?? ""}
                onChange={e => updateSub(i, { amt: e.target.value === "" ? 0 : Number(e.target.value) })}
                style={{ fontFamily: "var(--font-mono)", textAlign: "right" }}
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Remove sub"
                title="Remove sub"
                className="justify-self-end text-[var(--rose)] hover:bg-[var(--rose-soft)] hover:text-[var(--rose-ink)]"
                onClick={() => removeSub(i)}
              >
                <Icon name="trash" size={13}/>
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" size="xs" variant="subtle" onClick={addSub}>
              <Icon name="plus" size={12}/>Add sub
            </Button>
            {subs.length > 0 && (
              <span className="num text-[length:var(--fs-xs)] text-[var(--text-soft)]">
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
        {f.allowEmpty && <option value="">{EMPTY}</option>}
        {(f.options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
    // Parent-project picker (tree). Exclude self; the updater + DB trigger
    // block deeper cycles (can't parent under a descendant).
    if (f.type === "projectParent") {
      // Exclude self + own descendants — re-parenting under those would be a
      // cycle (the App guard + DB trigger also block it, but don't offer it).
      const blocked = new Set([row.id, ...projectItemDescendantIds(projectItems || [], row.id)]);
      const opts = (projectItems || [])
        .filter(it => !blocked.has(it.id))
        .map(it => ({ value: it.id, label: `${it.localId} · ${it.name}` }));
      return (
        <SearchableSelect
          value={val || ""}
          options={opts}
          placeholder="None, top-level project"
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
        <div className="flex min-w-0 flex-col gap-2">
          {subs.length === 0 && (
            <p className="m-0 rounded-[var(--radius-sm)] border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
              No subs yet. Pick a firm below to add one.
            </p>
          )}
          {subs.map((s, i) => (
            <div key={s.cId || i}
                 className="grid min-w-0 grid-cols-1 gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_110px_32px] sm:items-center">
              <div className="min-w-0 truncate text-[length:var(--fs-sm)] font-medium text-[var(--text)]">
                {companyById(s.cId)?.name || EMPTY}
              </div>
              <input className="input" placeholder="Discipline (e.g. Survey)"
                     defaultValue={s.desc || ""}
                     onBlur={e => onUpdateProjectSub?.(s.cId, { desc: e.target.value })}/>
              <input className="input mono num" type="number" placeholder="$" min="0"
                     defaultValue={s.amt ?? ""}
                     onBlur={e => onUpdateProjectSub?.(s.cId, { amt: e.target.value === "" ? 0 : Number(e.target.value) })}
                     style={{ fontFamily: "var(--font-mono)", textAlign: "right" }}/>
              <Button type="button" size="icon-sm" variant="ghost"
                      aria-label="Remove sub" title="Remove sub"
                      className="justify-self-end text-[var(--rose)] hover:bg-[var(--rose-soft)] hover:text-[var(--rose-ink)]"
                      onClick={() => onRemoveProjectSub?.(s.cId)}>
                <Icon name="trash" size={13}/>
              </Button>
            </div>
          ))}
          <SearchableSelect
            value=""
            options={avail}
            placeholder="Add a sub firm…"
            onChange={v => { if (v) onAddProjectSub?.(v); }}
          />
        </div>
      );
    }
    return <input className="input" defaultValue={val || ""} onBlur={e => set(e.target.value)}/>;
  };

  // Every table the drawer can open needs an entry. `hotleads` was missing, so
  // on Leads & Bids the badge rendered with no text at all — which is why it
  // read as a bare, unexplained icon rather than as a label for the kind of
  // record on screen. (The Deleted tabs pass a no-op onOpenDrawer and never
  // reach here, so they need no entry.)
  const titleMap = {
    potential: "Potential Project",
    awaiting:  "Proposal",
    awarded:   "Awarded Project",
    closed:    "Closed Out Project",
    invoice:   "Anticipated Invoice",
    events:    "Event",
    clients:   "Client",
    companies: "Company",
    hotleads:  "Hot Lead",
    openbids:  "Open Bid",
    projects:  "Project",
  };
  const titleLabel = table === "directory"
    ? (row.type === "Client" ? "Client" : "Company")
    : titleMap[table];

  // ---- Presentation-only derivations -------------------------------------
  const visibleFields = fields.filter(f => !f.showIf || f.showIf(row));
  const grouped = FIELD_GROUPS
    .map(g => ({ ...g, items: visibleFields.filter(f => g.keys.includes(f.k)) }))
    .filter(g => g.items.length > 0);
  const claimed = new Set(grouped.flatMap(g => g.items.map(f => f.k)));
  const leftovers = visibleFields.filter(f => !claimed.has(f.k));
  if (leftovers.length) grouped.push({ id: "more", title: "More", icon: "sliders", items: leftovers });

  const recordTitle = row.name || row.title || row.rfqNumber || EMPTY;
  const clientName  = row.clientId ? (companyById(row.clientId)?.name || null) : null;
  const headerBits  = [];
  if (row.year) headerBits.push(String(row.year));
  if (clientName) headerBits.push(clientName);
  if (row.role) headerBits.push(row.role);
  const headerMoney = [row.amount, row.contractAmount, row.anticipatedAmount]
    .find(v => v != null && v !== "");

  const hasStageActions = !!(onMoveBack || onDemoteFromOrange || onCloseOut || onAddChild);

  return (
    <Sheet open onOpenChange={closeVia(onClose)}>
      <SheetContent
        side="right"
        className={SHEET_SIDE_TO_BOTTOM}
        onPointerDownOutside={keepOpenForPortalMenus}
        onFocusOutside={keepOpenForPortalMenus}
        onInteractOutside={keepOpenForPortalMenus}
      >
        <SheetHeader className="gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* No icon. The badge already says what the record is, in words,
                and a briefcase glyph in front of "Hot Lead" or "Company" adds
                no information the label doesn't carry — it was the same
                picture on every record type. */}
            <Badge tone="outline">{titleLabel}</Badge>
            {row.projectNumber && (
              <span className="num text-[length:var(--fs-xs)] text-[var(--text-soft)]">
                #{row.projectNumber}
              </span>
            )}
            <RecordStatusBadge status={row.status}/>
          </div>
          <SheetTitle className="break-words text-[length:var(--fs-xl)] leading-[var(--lh-tight)]">
            {recordTitle}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {headerBits.length > 0 ? (
              <span className="min-w-0 break-words">{headerBits.join(" · ")}</span>
            ) : (
              <span>Record detail</span>
            )}
            {headerMoney != null && (
              <span className="num font-semibold text-[var(--text)]">{fmtMoney(headerMoney)}</span>
            )}
          </SheetDescription>
        </SheetHeader>

        <SheetBody className="flex flex-col gap-5">
          {table === "events" && row.source === "outlook" && (
            <Alert tone="info" icon={null} className="items-center gap-2">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <Icon name="mail" size={13}/>
                <span className="font-semibold">Synced from Outlook</span>
                {row.outlookOrganizer?.email && (
                  <span className="min-w-0 break-words opacity-80">
                    organized by {row.outlookOrganizer.name || row.outlookOrganizer.email}
                  </span>
                )}
                {row.outlookWebLink && (
                  <a className="inline-flex items-center gap-1 font-semibold underline underline-offset-2"
                     href={row.outlookWebLink}
                     target="_blank"
                     rel="noreferrer noopener">
                    Edit in Outlook
                    <Icon name="external" size={11}/>
                  </a>
                )}
              </span>
            </Alert>
          )}

          {hasStageActions && (
            <PanelSection icon="forward" title="Move this record">
              <div className="flex flex-wrap items-center gap-2">
                {onMoveBack && (
                  <>
                    <span className="text-[length:var(--fs-xs)] text-[var(--text-soft)]">Reopen as</span>
                    <Button type="button" size="sm" onClick={() => onMoveBack("awaiting")} title="Reopen as Proposal">
                      <Icon name="back" size={13}/>Proposal
                    </Button>
                    <Button type="button" size="sm" onClick={() => onMoveBack("awarded")} title="Reopen as Awarded">
                      <Icon name="back" size={13}/>Awarded
                    </Button>
                    <Button type="button" size="sm" onClick={() => onMoveBack("invoice")} title="Reopen as Active (Invoice)">
                      <Icon name="back" size={13}/>Invoice
                    </Button>
                  </>
                )}
                {onDemoteFromOrange && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={onDemoteFromOrange}
                    title="Demote from Orange. The Invoice row is removed and the project reappears in Potential."
                  >
                    <Icon name="back" size={13}/>Move to Potential
                  </Button>
                )}
                {onAddChild && (
                  <Button type="button" size="sm" onClick={onAddChild} title="Add a phase / subphase under this item">
                    <Icon name="plus" size={13}/>Add child
                  </Button>
                )}
                {onCloseOut && (
                  <Button type="button" size="sm" variant="destructive-soft" onClick={onCloseOut}>
                    <Icon name="ban" size={13}/>Close out
                  </Button>
                )}
              </div>
            </PanelSection>
          )}

          {grouped.map(g => (
            <PanelSection key={g.id} icon={g.icon} title={g.title}>
              <div className="min-w-0">
                {g.items.map(f => (
                  <PanelField
                    key={f.k}
                    label={f.label}
                    multiline={f.type === "textarea" || f.type === "subs" || f.type === "projectSubs"}
                  >
                    {renderInput(f)}
                  </PanelField>
                ))}
              </div>
            </PanelSection>
          ))}

          {table === "openbids" && (() => {
            const approver = row.approvedBy ? userById(row.approvedBy) : null;
            const stampedAt = row.approvedAt;
            const isPending  = (row.approvalStatus || "pending") === "pending";
            const isApproved = row.approvalStatus === "approved";
            const isRejected = row.approvalStatus === "rejected";
            return (
              <>
                <PanelSection icon="shieldCheck" title="Approval">
                  <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge tone={isApproved ? "success" : isRejected ? "danger" : "neutral"}>
                        <Icon name={isApproved ? "checkCircle" : isRejected ? "ban" : "hourglass"} size={12}/>
                        {isApproved ? "Approved" : isRejected ? "Rejected" : "Pending"}
                      </Badge>
                      {(isApproved || isRejected) && approver && (
                        <span className="min-w-0 text-[length:var(--fs-xs)] text-[var(--text-muted)]">
                          by <strong className="font-semibold text-[var(--text)]">{approver.name}</strong>
                          {stampedAt && <> · <span className="num">{new Date(stampedAt).toLocaleString()}</span></>}
                        </span>
                      )}
                    </div>
                    {isAdmin ? (
                      <div className="flex flex-wrap gap-2">
                        {!isApproved && onApproveBid && (
                          <Button type="button" size="sm" onClick={onApproveBid}
                                  className="border-[var(--sage-line)] text-[var(--sage-ink)] hover:bg-[var(--sage-soft)]">
                            <Icon name="thumbsUp" size={13}/>Approve
                          </Button>
                        )}
                        {!isRejected && onRejectBid && (
                          <Button type="button" size="sm" variant="destructive-soft" onClick={onRejectBid}>
                            <Icon name="thumbsDown" size={13}/>Reject
                          </Button>
                        )}
                        {(isApproved || isRejected) && onClearBidApproval && (
                          <Button type="button" size="sm" variant="ghost" onClick={onClearBidApproval}>
                            <Icon name="undo" size={13}/>Clear
                          </Button>
                        )}
                      </div>
                    ) : (
                      isPending && (
                        <p className="m-0 flex items-center gap-1.5 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
                          <Icon name="lock" size={12}/> Only Admins can approve or reject a bid.
                        </p>
                      )
                    )}
                  </div>
                </PanelSection>

                <PanelSection icon="attachment" title="RFQ/RFP PDF">
                  <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
                    {row.pdfPath ? (
                      <div className="flex min-w-0 items-center gap-2">
                        <Button type="button" size="sm" variant="subtle" onClick={onOpenBidPdf}
                                className="min-w-0 flex-1 justify-start"
                                title={row.pdfName || "Open PDF"}>
                          <Icon name="file" size={13}/>
                          <span className="min-w-0 truncate">{row.pdfName || "PDF attached"}</span>
                        </Button>
                        {onRemoveBidPdf && (
                          <Button type="button" size="icon-sm" variant="ghost"
                                  aria-label="Remove PDF" title="Remove PDF"
                                  className="text-[var(--rose)] hover:bg-[var(--rose-soft)] hover:text-[var(--rose-ink)]"
                                  onClick={onRemoveBidPdf}>
                            <Icon name="x" size={13}/>
                          </Button>
                        )}
                      </div>
                    ) : (
                      <p className="m-0 text-[length:var(--fs-xs)] text-[var(--text-soft)]">No PDF attached.</p>
                    )}
                    <Button asChild size="sm" variant="default" className="self-start">
                      <label className="cursor-pointer">
                        <Icon name="upload" size={13}/>
                        {row.pdfPath ? "Replace PDF…" : "Upload PDF…"}
                        <input type="file" accept="application/pdf,.pdf"
                               className="sr-only"
                               onChange={e => {
                                 const f = e.target.files?.[0];
                                 if (f && onUploadBidPdf) onUploadBidPdf(f);
                                 e.target.value = "";
                               }}/>
                      </label>
                    </Button>
                  </div>
                </PanelSection>

                {row.movedToProjectId && (
                  <PanelSection icon="forward" title="Moved forward">
                    <p className="m-0 flex min-w-0 flex-wrap items-center gap-2 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
                      <Icon name="link" size={13}/>
                      Linked to a Proposals project
                      <span className="num text-[var(--text-soft)]">{row.movedToProjectId.slice(0, 8)}</span>
                    </p>
                  </PanelSection>
                )}
              </>
            );
          })()}

          {table === "events" && (row.outlookExternalAttendees || []).length > 0 && (
            <PanelSection icon="users" title="External invitees" count={row.outlookExternalAttendees.length}>
              <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {row.outlookExternalAttendees.map((a, i) => (
                  <li key={`${a.email}-${i}`}>
                    <Badge
                      tone={a.response === "declined" ? "danger" : a.response === "accepted" ? "success" : "neutral"}
                      className="max-w-full"
                      title={`${a.name || a.email} · ${a.response || "no response"}`}
                    >
                      <Icon
                        name={a.response === "declined" ? "x" : a.response === "accepted" ? "check" : "dot"}
                        size={11}
                      />
                      <span className="min-w-0 truncate">{a.name || a.email}</span>
                    </Badge>
                  </li>
                ))}
              </ul>
            </PanelSection>
          )}

          {row.sourceId && (
            <PanelSection icon="link" title="Linked history">
              <p className="m-0 flex min-w-0 flex-wrap items-center gap-2 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
                <Icon name="forward" size={13}/>
                Carried forward from a previous stage
                <span className="num text-[var(--text-soft)]">{row.sourceId}</span>
              </p>
            </PanelSection>
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
        </SheetBody>

        <SheetFooter className="flex-wrap justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {onDelete && (
              <Button type="button" size="sm" variant="destructive-soft" onClick={onDelete}>
                <Icon name="trash" size={13}/>Delete
              </Button>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {onAlert && (
              <Button type="button" size="sm" onClick={onAlert}>
                <Icon name="bell" size={13}/>Alert
              </Button>
            )}
            {onForward ? (
              <Button type="button" size="sm" variant="primary" onClick={onForward}>
                <Icon name="forward" size={13}/>Move forward
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={onClose}>Done</Button>
            )}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
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
        { k: "_invoiceType", label: "Invoice Type", type: "select", options: INVOICE_TYPE_OPTIONS, value: "ENG",
          hint: "Determines how billing is categorized in Anticipated Invoice." },
      ]
    },
    // Potential → Invoice: COPY semantics. Same invoice-only prompt.
    "potential→invoice": {
      title: "Create Invoice row from Potential",
      subtitle: "Carries to Anticipated Invoice · Potential row stays",
      carried: ["year","name","projectNumber","pmIds"],
      newFields: [
        { k: "_invoiceType", label: "Invoice Type", type: "select", options: INVOICE_TYPE_OPTIONS, value: "ENG",
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
        { k: "_invoiceType", label: "Invoice Type", type: "select", options: INVOICE_TYPE_OPTIONS, value: "ENG",
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
          placeholder: "Lead notes carry over. Edit freely." },
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
    if (v == null || v === "") return EMPTY;
    if (k === "clientId") return companyById(v)?.name || EMPTY;
    if (k === "pmIds") return (v || []).map(id => userById(id)?.name).filter(Boolean).join(", ") || EMPTY;
    if (k === "subs") return (v || []).map(s => `${companyById(s.cId)?.name?.split(" ")[0] || s.desc || "Sub"} (${fmtMoney(s.amt)})`).join(", ") || EMPTY;
    if (k === "msmmUsed" || k === "msmmRemaining") return fmtMoney(v);
    if (k === "dateSubmitted") return fmtDate(v);
    return v;
  };

  const renderField = (f) => {
    const val = data[f.k];
    const set = (v) => setData(d => ({ ...d, [f.k]: v }));
    if (f.type === "pill") return <RecordStatusBadge status={val}/>;
    if (f.type === "select") return (
      <select className="select" value={val} onChange={e => set(e.target.value)}>
        {f.options.map(o => <option key={o}>{o}</option>)}
      </select>
    );
    if (f.type === "date") return <input className="input mono num" type="date" value={val} onChange={e => set(e.target.value)} style={{ fontFamily: "var(--font-mono)" }}/>;
    if (f.type === "money") return <input className="input mono num" type="number" value={val} onChange={e => set(Number(e.target.value))} style={{ fontFamily: "var(--font-mono)" }}/>;
    if (f.type === "textarea") return <textarea className="textarea" value={val} placeholder={f.placeholder} onChange={e => set(e.target.value)}/>;
    return <input className="input" value={val} placeholder={f.placeholder} onChange={e => set(e.target.value)}/>;
  };

  // Stage vocabulary for the from → to transition strip. Presentation only:
  // `from` / `to` themselves are untouched and still drive `configs`.
  const STAGE_LABEL = {
    potential: "Potential",
    awaiting:  "Proposal",
    awarded:   "Awarded",
    closed:    "Closed Out",
    invoice:   "Anticipated Invoice",
    hotleads:  "Hot Lead",
    openbids:  "Open Bid",
  };
  const STAGE_TONE = {
    potential: "neutral", awaiting: "brand",  awarded: "success",
    closed:    "danger",  invoice:  "info",   hotleads: "brand", openbids: "brand",
  };
  const fromLabel = STAGE_LABEL[from] || from;
  const toLabel   = STAGE_LABEL[to]   || to;
  const rowLabel  = row.name || row.title || row.rfqNumber || EMPTY;

  return (
    <Sheet open onOpenChange={closeVia(onClose)}>
      <SheetContent
        side="right"
        className={SHEET_SIDE_TO_BOTTOM}
        onPointerDownOutside={keepOpenForPortalMenus}
        onFocusOutside={keepOpenForPortalMenus}
        onInteractOutside={keepOpenForPortalMenus}
      >
        <SheetHeader className="gap-2">
          <Badge tone="outline" className="self-start">
            <Icon name="forward" size={11}/>
            Move forward
          </Badge>
          <SheetTitle className="break-words text-[length:var(--fs-xl)] leading-[var(--lh-tight)]">
            {cfg.title}
          </SheetTitle>
          <SheetDescription className="break-words">{cfg.subtitle}</SheetDescription>
        </SheetHeader>

        <SheetBody className="flex flex-col gap-5">
          {/* The transition itself, stated once and unmistakably. */}
          <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <p className="m-0 mb-2 truncate text-[length:var(--fs-sm)] font-semibold text-[var(--text)]" title={rowLabel}>
              {rowLabel}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex flex-col gap-1">
                <span className="text-[length:var(--fs-2xs)] uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">From</span>
                <Badge tone={STAGE_TONE[from] || "neutral"}>{fromLabel}</Badge>
              </span>
              <Icon name="forward" size={16} className="mt-4 shrink-0 text-[var(--text-soft)]"/>
              <span className="flex flex-col gap-1">
                <span className="text-[length:var(--fs-2xs)] uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">To</span>
                <Badge tone={STAGE_TONE[to] || "neutral"}>{toLabel}</Badge>
              </span>
            </div>
          </div>

          <PanelSection icon="lock" title="Carried forward" count={cfg.carried.length}>
            <p className="m-0 mb-2 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
              These values copy across as they are. They cannot be edited here.
            </p>
            <dl className="m-0 divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1">
              {cfg.carried.map(k => (
                <PanelDefRow key={k} term={labels[k] || k}>{formatCarried(k)}</PanelDefRow>
              ))}
            </dl>
          </PanelSection>

          <PanelSection icon="compose" title="Fields to complete" count={cfg.newFields.length}>
            <div className="min-w-0">
              {cfg.newFields.map(f => {
                const required = /\s\*$/.test(f.label);
                return (
                  <PanelField
                    key={f.k}
                    label={f.label.replace(/\s*\*$/, "")}
                    required={required}
                    hint={f.hint}
                    multiline={f.type === "textarea"}
                  >
                    {renderField(f)}
                  </PanelField>
                );
              })}
            </div>
          </PanelSection>
        </SheetBody>

        <SheetFooter className="flex-wrap justify-between gap-2">
          <span className="min-w-0 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
            {cfg.carried.length} carried, {cfg.newFields.length} to complete
          </span>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button type="button" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="button" size="sm" variant="primary" onClick={() => onConfirm(data)}>
              <Icon name="forward" size={13}/>{cfg.title}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
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

// Chip button used by the anchor / offset / recurrence pickers. Selection is
// carried by aria-pressed and a check glyph as well as by colour.
const CHIP_BTN =
  "inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-full)] border px-3 py-1 " +
  "text-[length:var(--fs-xs)] font-medium " +
  "transition-[background-color,border-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)] " +
  "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] active:translate-y-px " +
  "disabled:pointer-events-none disabled:opacity-45";
const CHIP_OFF =
  "border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]";
const CHIP_ON =
  "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent-ink)]";
const chipCls = (on) => `${CHIP_BTN} ${on ? CHIP_ON : CHIP_OFF}`;

const RECUR_LABEL = {
  "one-time": "Does not repeat",
  weekly:     "Weekly",
  biweekly:   "Every 2 weeks",
  monthly:    "Monthly",
  custom:     "Custom",
};

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
    <Dialog open onOpenChange={closeVia(onClose)}>
      <DialogContent
        size="md"
        className="bx-panelkit"
        onPointerDownOutside={keepOpenForPortalMenus}
        onFocusOutside={keepOpenForPortalMenus}
        onInteractOutside={keepOpenForPortalMenus}
      >
        <DialogHeader className="gap-2">
          <Badge tone="outline" className="self-start">
            <Icon name="bell" size={11}/>
            Set alert
          </Badge>
          <DialogTitle className="break-words">{row.name || row.title}</DialogTitle>
          <DialogDescription>
            Beacon emails the tagged users at the scheduled time with a link to this row.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-5">
          <PanelSection icon="users" title="Notify" count={recipients.length}>
            <div className="tag-input" onClick={() => setPicking(true)} style={{ position: "relative" }}>
              {recipients.map(uid => {
                const u = userById(uid); if (!u) return null;
                return <span key={uid} className="tag"><span className={`avatar xs ${u.color}`}>{u.initials}</span>{u.name}
                  <button type="button"
                          aria-label={`Remove ${u.name}`}
                          onClick={(e) => { e.stopPropagation(); setRecipients(recipients.filter(x => x !== uid)); }}>
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
                    <button key={u.id} type="button" className="menu-item"
                      onMouseDown={() => { setRecipients([...recipients, u.id]); setPickQ(""); }}>
                      <span className={`avatar xs ${u.color}`}>{u.initials}</span>
                      <span>{u.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {recipients.length === 0 && (
              <p className="m-0 mt-1.5 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
                Nobody is tagged yet, so this alert will not reach anyone.
              </p>
            )}
          </PanelSection>

          {anchors.length > 0 && (
            <PanelSection icon="link" title="Anchor to a date on this row">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Anchor date">
                {anchors.map(a => {
                  const on = anchorField === a.field;
                  return (
                    <button key={a.field} type="button"
                      aria-pressed={on}
                      className={chipCls(on)}
                      onClick={() => pickAnchor(a)}>
                      {on && <Icon name="check" size={11}/>}
                      <span>{a.label}</span>
                      <span className="num opacity-70">{fmtDate(a.value)}</span>
                    </button>
                  );
                })}
                <button type="button"
                  aria-pressed={anchorField === null}
                  className={chipCls(anchorField === null)}
                  onClick={clearAnchor}>
                  {anchorField === null && <Icon name="check" size={11}/>}
                  None (pick manually)
                </button>
              </div>
              <p className="m-0 mt-2 mb-1.5 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
                Fire this far before the anchor. A date without a time is treated as
                <span className="num"> {String(DEFAULT_ANCHOR_HOUR).padStart(2, "0")}:00</span> local.
              </p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Offset before the anchor">
                {OFFSET_PRESETS.map(p => (
                  <button key={p.key} type="button"
                    disabled={!anchorField && anchors.length === 0}
                    aria-pressed={offsetKey === p.key}
                    className={chipCls(offsetKey === p.key)}
                    onClick={() => pickOffset(p)}>
                    {offsetKey === p.key && <Icon name="check" size={11}/>}
                    {p.label}
                  </button>
                ))}
                <button type="button"
                  aria-pressed={offsetKey === null}
                  className={chipCls(offsetKey === null)}
                  onClick={() => setOffsetKey(null)}>
                  {offsetKey === null && <Icon name="check" size={11}/>}
                  Custom…
                </button>
              </div>
            </PanelSection>
          )}

          <PanelSection icon="calendarClock" title="When">
            <div className="grid grid-cols-1 gap-3 xs:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="beacon-alert-date"
                       className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
                  First alert date
                </label>
                <input id="beacon-alert-date" className="input mono num" type="date" value={date}
                       onChange={e => onManualDate(e.target.value)}
                       style={{ fontFamily: "var(--font-mono)" }}/>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="beacon-alert-time"
                       className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
                  Time
                </label>
                <input id="beacon-alert-time" className="input mono num" type="time" value={time}
                       onChange={e => onManualTime(e.target.value)}
                       style={{ fontFamily: "var(--font-mono)" }}/>
              </div>
            </div>
            <p className="m-0 mt-2 flex flex-wrap items-center gap-1.5 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
              <Icon name="info" size={12}/>
              Times are read in your browser timezone,
              <span className="num font-medium text-[var(--text-muted)]">{BROWSER_TZ}</span>
            </p>
          </PanelSection>

          <PanelSection icon="refresh" title="Recurrence">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Recurrence">
              {["one-time","weekly","biweekly","monthly","custom"].map(r => (
                <button key={r} type="button"
                  aria-pressed={recur === r}
                  className={chipCls(recur === r)}
                  onClick={() => setRecur(r)}>
                  {recur === r && <Icon name="check" size={11}/>}
                  {RECUR_LABEL[r] || r}
                </button>
              ))}
            </div>
          </PanelSection>

          <PanelSection icon="note" title="Message">
            <textarea className="textarea" value={message} onChange={e => setMessage(e.target.value)}
              aria-label="Alert message (optional)"
              placeholder="e.g. Reminder: verdict expected this week. Check in with client PM."/>
            <p className="m-0 mt-1 text-[length:var(--fs-xs)] text-[var(--text-soft)]">Optional.</p>
          </PanelSection>
        </DialogBody>

        <DialogFooter className="max-sm:flex-col sm:justify-between">
          <p className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
            <Icon name="clock" size={12}/>
            <span className="min-w-0">
              First send <span className="num font-medium text-[var(--text-muted)]">{fmtDate(date)}</span> at{" "}
              <span className="num font-medium text-[var(--text-muted)]">{time}</span> ·{" "}
              {recur === "one-time" ? "does not repeat" : `repeats ${recur}`}
            </span>
          </p>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button type="button" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="button" size="sm" variant="primary" onClick={() => {
              const preset = OFFSET_PRESETS.find(p => p.key === offsetKey);
              onConfirm({
                recipients, date, time, recur, message,
                anchorField,
                anchorOffsetMinutes: preset ? preset.minutes : null,
                timezone: BROWSER_TZ,
              });
            }}>
              <Icon name="bell" size={13}/>Schedule alert
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
                    {f.notes && (
                      <div className="invoice-file-note" title={f.notes}>
                        <Icon name="edit" size={11}/>
                        <span>{f.notes}</span>
                      </div>
                    )}
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
      setError("Missing invoice id, cannot auto-link.");
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
    <Dialog open onOpenChange={closeVia(onClose)}>
      <DialogContent
        size="md"
        className="bx-panelkit"
        onPointerDownOutside={keepOpenForPortalMenus}
        onFocusOutside={keepOpenForPortalMenus}
        onInteractOutside={keepOpenForPortalMenus}
      >
        <DialogHeader className="gap-2">
          <Badge tone="outline" className="self-start">
            <Icon name="plus" size={11}/>
            {isPrime ? "Add prime" : "Add sub"}
          </Badge>
          <DialogTitle className="break-words">
            {projectName || invoiceRow?.name || "Project"}
          </DialogTitle>
          <DialogDescription>
            {isPrime
              ? "The Prime is the upstream firm hiring MSMM on this project. Enter the contract amount; monthly billing tracks beneath."
              : "Subs are firms hired on this project. Enter their total contract amount; monthly invoices live on the row that appears beneath."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          {needsProjectLink && (
            <Alert tone="info">
              This invoice isn't linked to a project yet. Beacon sets that link up
              automatically when you save.
            </Alert>
          )}

          <div className="min-w-0">
            <PanelField label={isPrime ? "Prime firm" : "Company"} required multiline={creating}>
              {creating ? (
                <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
                  <div className="flex items-center gap-2">
                    <Icon name="briefcase" size={13}/>
                    <span className="text-[length:var(--fs-sm)] font-semibold text-[var(--text)]">New firm</span>
                    <span className="text-[length:var(--fs-xs)] text-[var(--text-soft)]">adds to the Directory</span>
                    <Button type="button" size="icon-sm" variant="ghost"
                            className="ml-auto" aria-label="Cancel new firm" title="Cancel"
                            onClick={cancelCreate} disabled={nfBusy}>
                      <Icon name="x" size={13}/>
                    </Button>
                  </div>
                  <input className="input" autoFocus
                         aria-label="Firm name"
                         aria-invalid={nfError ? "true" : undefined}
                         placeholder="Firm name *"
                         value={nf.name}
                         disabled={nfBusy}
                         onChange={(e) => setNf(p => ({ ...p, name: e.target.value }))}
                         onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveNewFirm(); } }}/>
                  <div className="grid grid-cols-1 gap-2 xs:grid-cols-2">
                    <input className="input"
                           aria-label="Contact"
                           placeholder="Contact"
                           value={nf.contact}
                           disabled={nfBusy}
                           onChange={(e) => setNf(p => ({ ...p, contact: e.target.value }))}/>
                    <input className="input"
                           aria-label="Email"
                           placeholder="Email"
                           value={nf.email}
                           disabled={nfBusy}
                           onChange={(e) => setNf(p => ({ ...p, email: e.target.value }))}/>
                  </div>
                  <input className="input"
                         aria-label="Phone"
                         placeholder="Phone"
                         value={nf.phone}
                         disabled={nfBusy}
                         onChange={(e) => setNf(p => ({ ...p, phone: e.target.value }))}/>
                  {nfError && (
                    <p role="alert" className="m-0 text-[length:var(--fs-xs)] text-[var(--destructive)]">{nfError}</p>
                  )}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" size="sm" onClick={cancelCreate} disabled={nfBusy}>
                      Cancel
                    </Button>
                    <Button type="button" size="sm" variant="primary" loading={nfBusy}
                            onClick={saveNewFirm} disabled={nfBusy || !nf.name.trim()}>
                      {!nfBusy && <Icon name="check" size={13}/>}
                      {nfBusy ? "Adding…" : "Add & select"}
                    </Button>
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
            </PanelField>
            <PanelField label="Service / discipline">
              <input className="input"
                     aria-label="Service or discipline"
                     placeholder="e.g. Survey, Civil, MEP"
                     value={discipline}
                     onChange={(e) => setDiscipline(e.target.value)}
                     disabled={busy}/>
            </PanelField>
            <PanelField label="Total amount">
              <input className="input mono num"
                     aria-label="Total amount"
                     type="number" min="0" step="any"
                     placeholder="$0"
                     value={amount}
                     onChange={(e) => setAmount(e.target.value)}
                     disabled={busy}
                     style={{ fontFamily: "var(--font-mono)" }}/>
            </PanelField>
          </div>

          {error && <Alert tone="danger" role="alert">{error}</Alert>}
        </DialogBody>

        <DialogFooter className="max-sm:flex-col sm:justify-between">
          <p className="m-0 min-w-0 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
            Firm not listed? Type its name and choose <strong className="font-semibold">Create</strong> to
            add it to the Directory.
          </p>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button type="button" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="button" size="sm" variant="primary" loading={busy}
                    onClick={handleSubmit} disabled={!canSubmit}>
              {!busy && <Icon name="check" size={13}/>}
              {busy ? "Saving…" : (isPrime ? "Add prime" : "Add sub")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <Dialog open onOpenChange={busy ? undefined : closeVia(onClose)}>
      <DialogContent size="md" className="bx-panelkit">
        <DialogHeader className="gap-2">
          <Badge tone="outline" className="self-start">
            <Icon name="merge" size={11}/>
            Directory merge
          </Badge>
          <DialogTitle className="break-words">
            Merge {entities.length} {isClient ? "clients" : "companies"} into one
          </DialogTitle>
          <DialogDescription>
            Pick the record to <strong className="font-semibold text-[var(--text)]">keep</strong>. Every
            reference on the others (across Open Bids, Awaiting, Awarded, Closed Out, Potential, Invoice
            {isClient ? "" : ", sub-invoices"} and Hot Leads) moves to it, then the duplicates are deleted.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          {survivorLocked && (
            <Alert tone="info" icon={null}>
              <span className="flex items-start gap-2">
                <Icon name="lock" size={13} className="mt-px shrink-0"/>
                <span><strong className="font-semibold">MSMM</strong> can't be deleted, so it is kept as the surviving record.</span>
              </span>
            </Alert>
          )}

          <div className="flex flex-col gap-2" role="radiogroup" aria-label="Record to keep">
            {entities.map(e => {
              const isSurv = e.id === survivorId;
              const s = summaries.get(e.id);
              const disabled = busy || (survivorLocked && !e.isMsmm);
              return (
                <button
                  key={e.id}
                  type="button"
                  role="radio"
                  className={
                    "flex w-full min-w-0 items-start gap-3 rounded-[var(--radius-md)] border p-3 text-left " +
                    "transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-out)] " +
                    "focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] " +
                    "disabled:cursor-not-allowed disabled:opacity-60 " +
                    (isSurv
                      ? "border-[var(--sage-line)] bg-[var(--sage-soft)]"
                      : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]")
                  }
                  onClick={() => { if (!disabled && !survivorLocked) setSurvivorId(e.id); }}
                  disabled={disabled && !isSurv}
                  aria-checked={isSurv}>
                  <span
                    aria-hidden="true"
                    className={
                      "mt-px grid size-[18px] shrink-0 place-items-center rounded-full border " +
                      (isSurv
                        ? "border-[var(--sage)] bg-[var(--sage)] text-[var(--success-foreground)]"
                        : "border-[var(--border-strong)] bg-[var(--surface)]")
                    }>
                    {isSurv && <Icon name="check" size={11} stroke={3}/>}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate text-[length:var(--fs-sm)] font-semibold text-[var(--text)]">
                        {nameOf(e)}
                      </span>
                      {e.isMsmm && <Badge tone="brand" size="sm">MSMM</Badge>}
                    </span>
                    <span className="flex min-w-0 flex-wrap items-center gap-2 text-[length:var(--fs-xs)] text-[var(--text-muted)]">
                      {subOf(e) && <Badge tone="outline" size="sm">{subOf(e)}</Badge>}
                      <span className="min-w-0 truncate">{summaryLine(s)}</span>
                    </span>
                  </span>
                  <Badge tone={isSurv ? "success" : "danger"} className="mt-px shrink-0">
                    <Icon name={isSurv ? "check" : "trash"} size={11}/>
                    {isSurv ? "Keep" : "Merge & delete"}
                  </Badge>
                </button>
              );
            })}
          </div>

          <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
            <Icon name="forward" size={14} className="mt-px shrink-0"/>
            <span className="min-w-0">
              {totalRefs > 0 ? (
                <><strong className="num font-semibold text-[var(--text)]">{totalRefs}</strong> reference{totalRefs > 1 ? "s" : ""} will be repointed to{" "}
                <strong className="font-semibold text-[var(--text)]">{survivor ? nameOf(survivor) : EMPTY}</strong>.</>
              ) : (
                <>No references to repoint. The duplicate{losers.length > 1 ? "s" : ""} will just be removed.</>
              )}{" "}
              <span className="num">{losers.length}</span> record{losers.length > 1 ? "s" : ""} deleted.
            </span>
          </div>

          <Alert tone="warning">
            This can't be undone. Storage attachments stay in place and remain visible on the kept record.
          </Alert>

          {error && <Alert tone="danger" role="alert">{error}</Alert>}
        </DialogBody>

        <DialogFooter className="max-sm:flex-col sm:justify-between">
          <p className="m-0 min-w-0 text-[length:var(--fs-xs)] text-[var(--text-soft)]">
            Profile fields (contact, email…) aren't merged; only references move.
          </p>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button type="button" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="button" size="sm" variant="destructive" loading={busy}
                    onClick={handleSubmit}
                    disabled={busy || !survivorId || losers.length === 0}>
              {!busy && <Icon name="merge" size={13}/>}
              {busy ? "Merging…" : `Merge ${losers.length} → 1`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ---------- ConfirmDialog ----------
// Small reusable confirmation prompt. Built on the kit's AlertDialog so it is
// a real alertdialog (assertive role, no accidental outside-click dismissal)
// and so it stacks above whatever surface raised it. `onConfirm` may be
// async; the dialog shows a working state and closes when it resolves.
export const ConfirmDialog = ({
  title = "Are you sure?",
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  hideCancel = false,      // alert mode — show only the confirm button
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
  const isDanger = tone === "danger";
  return (
    <AlertDialog open onOpenChange={busy ? undefined : closeVia(onClose)}>
      <AlertDialogContent className="bx-panelkit z-[130]">
        <AlertDialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={
                "grid size-9 shrink-0 place-items-center rounded-[var(--radius-md)] border " +
                (isDanger
                  ? "border-[var(--rose-line)] bg-[var(--rose-soft)] text-[var(--rose-ink)]"
                  : "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent-ink)]")
              }>
              <Icon name={icon} size={17}/>
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
              {message ? (
                <AlertDialogDescription className="break-words">{message}</AlertDialogDescription>
              ) : (
                <AlertDialogDescription className="sr-only">
                  {isDanger ? "This action cannot be undone." : "Confirm to continue."}
                </AlertDialogDescription>
              )}
            </div>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {!hideCancel && (
            <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          )}
          <AlertDialogAction
            variant={isDanger ? "destructive" : "primary"}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={(e) => { e.preventDefault(); run(); }}>
            {!busy && isDanger && <Icon name={icon} size={13}/>}
            {busy ? "Working…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

// ---------- AddContractProjectModal ----------
// Multi-project contracts (Multi-Use Contract / AE Selected List, or an unset
// stage) can carry SEVERAL invoice projects under one awarded contract. This is
// step 2 of that flow (step 1 is the "add another?" confirm): it prompts for the
// new project number, validates it is unique within the Invoice table via the
// `validate(number)` prop (returns an error string or null), then hands the
// number to `onSubmit`. The new invoice row shares the contract's name / PMs /
// type; only the project number differs. Renders above other modals.
export const AddContractProjectModal = ({
  projectName, existingNumber, invType, validate, onSubmit, onClose,
}) => {
  const [num, setNum] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const trimmed = num.trim();
  const liveError = trimmed ? (validate?.(trimmed) || "") : "";
  const submit = async () => {
    if (busy) return;
    const problem = validate?.(trimmed);
    if (problem) { setErr(problem); return; }
    setBusy(true);
    try { await onSubmit(trimmed); onClose(); }
    catch (e) { setErr(e?.message || String(e)); setBusy(false); }
  };
  const shownError = err || liveError;
  return (
    <Dialog open onOpenChange={busy ? undefined : closeVia(onClose)}>
      <DialogContent size="sm" className="bx-panelkit z-[130]">
        <DialogHeader className="gap-2">
          <Badge tone="outline" className="self-start">
            <Icon name="plus" size={11}/>
            Contract
          </Badge>
          <DialogTitle>Add project under this contract</DialogTitle>
          <DialogDescription>
            Adding another invoice project under <strong className="font-semibold text-[var(--text)]">{projectName || "this contract"}</strong>
            {existingNumber ? <> (already has #{existingNumber})</> : null}. It keeps the same project
            name{invType ? <> and is created as <strong className="font-semibold text-[var(--text)]">{invType}</strong></> : null}. Enter a new
            project number. It must be unique in the Invoice table.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="beacon-contract-projnum"
                   className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-[var(--tracking-caps)] text-[var(--text-soft)]">
              New project number
            </label>
            <input
              id="beacon-contract-projnum"
              className="input mono num" autoFocus value={num}
              aria-invalid={shownError ? "true" : undefined}
              aria-describedby={shownError ? "beacon-contract-projnum-err" : undefined}
              onChange={e => { setNum(e.target.value); setErr(""); }}
              onKeyDown={e => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") onClose();
              }}
              placeholder="e.g. 202609"
            />
            {shownError && (
              <p id="beacon-contract-projnum-err" role="alert"
                 className="m-0 text-[length:var(--fs-xs)] text-[var(--destructive)]">
                {shownError}
              </p>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" size="sm" variant="primary" loading={busy}
                  onClick={submit} disabled={busy || !trimmed || !!liveError}>
            {busy ? "Creating…" : "Create invoice project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
