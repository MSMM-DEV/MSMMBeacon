import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { Sparkline } from "./primitives.jsx";
import {
  PotentialTable, AwaitingTable, AwardedTable, ClosedTable,
  InvoiceTable, EventsTable, HotLeadsTable, HotLeadsQuickView, DirectoryTable, OpenBidsTable,
  ProjectsTable,
} from "./tables.jsx";
// Note: SoqTable was removed — SOQ is no longer surfaced in v2.
// ClientsTable + CompaniesTable were merged into DirectoryTable.
import { InvoiceCharts } from "./invoice-charts.jsx";
import { SubsReceivablesPanel } from "./quadsheet-receivables.jsx";
import { EventsCalendar } from "./events-calendar.jsx";
import { DetailDrawer, MoveForwardPanel, AlertModal, InvoiceFilesModal, AddSubModal, MergeModal, ConfirmDialog } from "./panels.jsx";
import { TweaksPanel, applyTweaks } from "./tweaks.jsx";
import { CreateModal } from "./forms.jsx";
import { LoginPage } from "./login.jsx";
import { AdminPanel } from "./admin.jsx";
import { TimesheetTab } from "./timekeeping/TimesheetTab.jsx";
import { TimeAdminTab } from "./timekeeping/TimeAdminTab.jsx";
import { LicensesTab } from "./licenses.jsx";
import { TeamCalendarTab } from "./team-calendar.jsx";
import { ProjectDetailPage } from "./project-detail.jsx";
import { exportPDF } from "./utils/pdf.js";
import { exportManishWorkbook } from "./utils/manish-xlsx.js";
import { getCurrentTableSnapshot } from "./table-state.js";
import { PwaInstallChip, PwaOfflineChip, PwaUpdateToast } from "./pwa-ui.jsx";
import { isMobileNow } from "./use-mobile.js";
import { invoiceIsOrange } from "./invoice-orange.js";
import {
  loadBeacon, fmtDate, fmtDateTime, fmtMoney, mkId,
  MONTHS, TODAY_MONTH, THIS_YEAR, BID_SERVICE_OPTIONS, isActualInvoiceMonth, ATTACH_ONLY_ON_ACTUAL, actualThruMonth,
  mergeInvoiceYears, adaptInvoiceRow, monthDescsForWindow, defaultWindowStartAbs, WINDOW_SIZE,
  getClientsOnly, getCompaniesOnly, getUsers, companyById, userById, mergeEntities,
  routeClientPick, routePrimePick, linkedProjectsFor,
  supabase, signOut, getCurrentSession, fetchCurrentBeaconUser, changeOwnPassword,
  getRowAnchors, TAB_TO_SUBJECT_TABLE,
  runOutlookSyncNow, reloadEvents,
  upsertSubInvoiceAmount, reloadInvoiceArtifacts, reloadInvoicePartyFiles, addProjectSub, updateProjectSub, removeProjectSub,
  ensureSubInvoiceRow, setSubInvoicePaid,
  setProjectRole, setProjectPrimeCompany,
  findOrCreateProjectForInvoice, linkInvoiceToProject,
  createOpenBid, updateOpenBid as updateOpenBidDb, deleteOpenBid as deleteOpenBidDb,
  setOpenBidApproval, markOpenBidMovedForward,
  uploadOpenBidPdf, deleteOpenBidPdf, getOpenBidPdfSignedUrl,
  normInvoiceNumber, addProjectInvoiceLink, removeProjectInvoiceLink,
  saveProjectEgnyteFolder,
  createProjectItem, updateProjectItem, deleteProjectItem,
  addProjectItemSub, updateProjectItemSub, removeProjectItemSub,
  validateProjectItemContract, projectItemDescendantIds,
  contractTypeLabel, projectItemTypeLabel, projectItemStatusLabel,
} from "./data.js";

// A ref-count helper shared by both Clients and Companies export columns.
// Declared at module scope because EXPORT_COLUMNS entries reference it.
let _projectsByTypeRef = null;
const setProjectsByTypeRef = (v) => { _projectsByTypeRef = v; };
const countRefs = (id) => {
  const all = _projectsByTypeRef || {};
  const list = [...(all.potential || []), ...(all.awaiting || []), ...(all.awarded || []), ...(all.closed || [])];
  return list.filter(p => p.clientId === id || (p.subs || []).some(s => s.cId === id)).length;
};

// linkedProjectsFor moved to data.js so both the Directory drawer (panels.jsx)
// and the inline expand row (DirectoryTable in tables.jsx) can use it.

// 2026-06 IA: the rail shows GROUPED pages; several tab keys live inside one
// navbar entry and switch via an in-page sub-tab strip. The underlying tab
// keys are unchanged (deep links like ?tab=awaiting / ?tab=closed from old
// alert emails keep working) — only the navigation chrome is grouped:
//   Leads & Bids        = hotleads · openbids
//   Proposals & Awarded = awaiting (renamed "Proposals") · awarded
//   Invoice             = invoice (active billing) · between (paused) · closed
// TAB_META stays the registry of every valid tab key (deep-link validation).
const TAB_META = [
  { key: "hotleads",  label: "Hot Leads",     stage: "stage-events"    },
  { key: "openbids",  label: "Open Bids",     stage: "stage-openbids"  },
  { key: "awaiting",  label: "Proposals",     stage: "stage-awaiting"  },
  { key: "awarded",   label: "Awarded",       stage: "stage-awarded"   },
  { key: "potential", label: "Potential",     stage: "stage-potential" },
  { key: "invoice",   label: "Invoices",      stage: "stage-invoice"   },
  { key: "between",   label: "In-Between",    stage: "stage-invoice"   },
  { key: "closed",    label: "Closed Out",    stage: "stage-closed"    },
  { key: "projects",  label: "Projects",      stage: "stage-awarded"   },
  { key: "events",    label: "Events & Other",stage: "stage-events"    },
  { key: "directory", label: "Directory",     stage: "stage-clients"   },
  { key: "licenses",  label: "Licenses",      stage: "stage-events"    },
  { key: "timesheet", label: "Timesheet",     stage: "stage-events"    },
  { key: "time-admin",label: "Time Admin",    stage: "stage-events", adminOnly: true },
  { key: "team-cal",  label: "Team Calendar", stage: "stage-events"    },
];

// One entry per navbar pill. `tabs` lists the member tab keys in sub-tab
// order; a single-tab group renders with no sub-tab strip. Pipeline groups
// keep the → arrows between them.
const NAV_GROUPS = [
  // Potential was removed from the navbar (2026-06 follow-up) — the flow is
  // Leads & Bids → Proposals → Awarded → Invoice ⇄ In-Between → Closed Out.
  // The "potential" TAB KEY stays valid (deep links + Directory project
  // jumps still render the hidden page); it's just not navigable from here.
  { key: "leads",     label: "Leads & Bids",        stage: "stage-openbids",  group: "pipeline", tabs: ["hotleads", "openbids"] },
  { key: "proposals", label: "Proposals & Awarded", stage: "stage-awaiting",  group: "pipeline", tabs: ["awaiting", "awarded"] },
  { key: "invoice",   label: "Invoice",             stage: "stage-invoice",   group: "pipeline", tabs: ["invoice", "between", "closed"] },
  { key: "projects",  label: "Projects",            stage: "stage-awarded",   group: "side", tabs: ["projects"] },
  { key: "events",    label: "Events & Other",      stage: "stage-events",    group: "side", tabs: ["events"] },
  { key: "directory", label: "Directory",           stage: "stage-clients",   group: "side", tabs: ["directory"] },
  { key: "licenses",  label: "Licenses",            stage: "stage-events",    group: "side", tabs: ["licenses"] },
  { key: "timesheet", label: "Timesheet",           stage: "stage-events",    group: "side", tabs: ["timesheet"] },
  { key: "time-admin",label: "Time Admin",          stage: "stage-events",    group: "side", tabs: ["time-admin"], adminOnly: true },
  { key: "team-cal",  label: "Team Calendar",       stage: "stage-events",    group: "side", tabs: ["team-cal"] },
];
const navGroupOf = (tabKey) => NAV_GROUPS.find(g => g.tabs.includes(tabKey));

// Sub-tab strip definitions for the multi-tab groups.
const SUB_TABS = {
  leads: [
    { key: "hotleads", label: "Hot Leads", icon: "trend" },
    { key: "openbids", label: "Open Bids", icon: "flag"  },
  ],
  proposals: [
    { key: "awaiting", label: "Proposals", icon: "clock" },
    { key: "awarded",  label: "Awarded",   icon: "check" },
  ],
  invoice: [
    { key: "invoice", label: "Invoices",   icon: "trend" },
    { key: "between", label: "In-Between", icon: "pause" },
    { key: "closed",  label: "Closed Out", icon: "x"     },
  ],
};

const PAGE_META = {
  openbids:  { title: "Open Bids", desc: "RFQ/RFPs under evaluation. Admins approve a bid before it can be moved forward to Proposals." },
  potential: { title: "Potential Projects", desc: "Opportunities and billing candidates. Add directly or copy from Awarded. Move forward to Invoice when ready to bill." },
  awaiting:  { title: "Proposals", desc: "Submitted proposals awaiting a verdict. Add here, then mark as Awarded or Closed Out when the verdict lands." },
  awarded:   { title: "Awarded Projects", desc: "Won contracts. Attach invoice projects by number, track capacity, or move forward when billing starts." },
  closed:    { title: "Closed Out Projects", desc: "Archived. Losses, descopes, and completed engagements — billing history is kept." },
  invoice:   { title: "Anticipated Invoice", desc: "Monthly billing — Actual and Projection split by today's date. Cash-flow charts up top, outstanding receivables at the bottom." },
  between:   { title: "In-Between", desc: "Paused projects. Every dollar, sub, attachment, and note stays intact — resume to Invoices or close out." },
  projects:  { title: "Projects", desc: "Tree-structured work breakdown — projects, phases, and subphases. Main items are containers; Standard items are where time & expenses get logged. Child contract totals can't exceed the parent." },
  events:    { title: "Events & Other", desc: "Partner touchpoints, conferences, and meetings. Not linked to projects." },
  hotleads:  { title: "Hot Leads",      desc: "Early-stage opportunities and conversations before they become Potential Projects." },
  directory: { title: "Directory", desc: "Clients and companies on a single roster. Click a row to see every project they're linked to." },
  licenses:  { title: "Licenses & Certifications", desc: "Every company and individual license with its expiration. Color-coded by days until due; reminder emails go out at 60 / 30 / 14 / 7 / 1 days before expiry." },
  timesheet: { title: "Timesheet", desc: "Your daily punches, this week's hours, leave balances, and time-off requests. Punch in or out with the big button or tap your fob on the front-door reader." },
  "time-admin": { title: "Time Admin", desc: "Team-wide view, leave requests + balances, NFC enrollment, and timekeeping settings." },
  "team-cal":  { title: "Team Calendar", desc: "Everyone's Outlook calendars in one view, color-coded per person. Read-only — pick the colleagues you want to see and overlay their schedules." },
};

const DEFAULT_TWEAKS = {
  accent: "#C8823B",
  theme: "light",
  density: "comfortable",
  fontPair: "geist_jetbrains",
};

// ======================================================================
// Filter predicates — one per tab. Keys are arbitrary strings.
// The 'all' key means no filter; returns the row unchanged.
// ======================================================================
const FILTERS = {
  openbids: {
    all:      () => true,
    pending:  r => r.approvalStatus === "pending",
    approved: r => r.approvalStatus === "approved",
    rejected: r => r.approvalStatus === "rejected",
    dueSoon:  r => {
      if (!r.dueAt) return false;
      const days = (new Date(r.dueAt).getTime() - Date.now()) / 86400000;
      return days > 0 && days <= 7;
    },
  },
  potential: {
    all:   () => true,
    prime: r => r.role === "Prime",
    sub:   r => r.role === "Sub",
  },
  awaiting: {
    all: () => true,
    over30: r => {
      if (!r.dateSubmitted) return false;
      const days = (Date.now() - new Date(r.dateSubmitted).getTime()) / 86400000;
      return days > 30;
    },
  },
  awarded: {
    all: () => true,
    expiring: r => {
      if (!r.contractExpiry) return false;
      const days = (new Date(r.contractExpiry).getTime() - Date.now()) / 86400000;
      return days > 0 && days < 180;
    },
    low: r => (r.msmmUsed + r.msmmRemaining) > 0 && (r.msmmRemaining / (r.msmmUsed + r.msmmRemaining)) < 0.2,
  },
  closed: {
    all: () => true,
    thisYear: r => r.dateClosed && new Date(r.dateClosed).getFullYear() === THIS_YEAR,
    losses: r => /lost|cancel|descope|withdraw/i.test(r.reason || ""),
  },
  events: {
    all: () => true,
    upcoming: r => r.status === "Booked",
    happened: r => r.status === "Happened",
  },
  hotleads: {
    all: () => true,
    upcoming: r => r.dateTime && new Date(r.dateTime) >= new Date(),
    past:     r => r.dateTime && new Date(r.dateTime) <  new Date(),
  },
  // Projects is a tree — filtering is applied inside ProjectsTable (which keeps
  // a matching node's ancestors visible so the branch doesn't orphan). These
  // predicates exist so chipsFor()/the toolbar don't choke; the table reads the
  // active chip key directly and does the ancestor-aware filtering itself.
  projects: {
    all:      () => true,
    main:     r => r.itemType === "main",
    standard: r => r.itemType === "standard",
    active:   r => r.status === "active",
    between:  r => r.status === "between",
    closed:   r => r.status === "closed_out",
  },
  // The Directory merges Clients + Companies. Filter chips cover both
  // the kind axis (clients vs companies) and the sub-attribute axis
  // (Federal/State for clients; Prime/Sub/Multiple for companies).
  directory: {
    all:       () => true,
    clients:   r => r.type === "Client",
    companies: r => r.type !== "Client",
    federal:   r => r.type === "Client" && r.orgType === "Federal",
    state:     r => r.type === "Client" && r.orgType === "State",
    prime:     r => r.type === "Prime",
    sub:       r => r.type === "Sub",
    multiple:  r => r.type === "Multiple",
  },
};

const FILTER_CHIPS = {
  openbids: [
    { key: "all",      label: "All" },
    { key: "pending",  label: "Pending",  icon: "clock" },
    { key: "approved", label: "Approved", icon: "check" },
    { key: "rejected", label: "Rejected", icon: "x" },
    { key: "dueSoon",  label: "Due ≤ 7 days", icon: "clock" },
  ],
  potential: [
    { key: "all",   label: "All" },
    { key: "prime", label: "Prime", icon: "flag" },
    { key: "sub",   label: "Sub",   icon: "link" },
  ],
  awaiting: [
    { key: "all",    label: "All" },
    { key: "over30", label: "Over 30 days", icon: "clock" },
  ],
  awarded: [
    { key: "all",      label: "All" },
    { key: "expiring", label: "Expiring soon", icon: "clock" },
    { key: "low",      label: "Low remaining", icon: "trend" },
  ],
  closed: [
    { key: "all",      label: "All" },
    { key: "thisYear", label: "This year" },
    { key: "losses",   label: "Losses only" },
  ],
  events: [
    { key: "all",      label: "All" },
    { key: "upcoming", label: "Upcoming", icon: "calendar" },
    { key: "happened", label: "Happened" },
  ],
  hotleads: [
    { key: "all",      label: "All" },
    { key: "upcoming", label: "Upcoming", icon: "clock" },
    { key: "past",     label: "Past" },
  ],
  projects: [
    { key: "all",      label: "All" },
    { key: "main",     label: "Main",     icon: "briefcase" },
    { key: "standard", label: "Standard", icon: "flag" },
    { key: "active",   label: "Active" },
    { key: "between",  label: "In Between", icon: "pause" },
    { key: "closed",   label: "Closed Out", icon: "x" },
  ],
  // Two visual groupings on the Directory: kind (clients vs companies)
  // then sub-attribute (org-type for clients; company-type for companies).
  directory: [
    { key: "all",       label: "All" },
    { key: "clients",   label: "Clients",   icon: "users" },
    { key: "companies", label: "Companies", icon: "briefcase" },
    { key: "federal",   label: "Federal" },
    { key: "state",     label: "State" },
    { key: "prime",     label: "Primes" },
    { key: "sub",       label: "Subs" },
    { key: "multiple",  label: "Multiple" },
  ],
};

// ======================================================================
// Export column sets per tab (used for both PDF and any future CSV export).
// `wMm` on a column pins its PDF width in mm; columns without it share
// remaining landscape page width evenly.
// ======================================================================
// Labels MUST match the table column labels in tables.jsx so the export can
// map the user's visible/ordered columns onto these export defs by label.
// (The Awarded single/multi/others view buckets were removed in the 2026-06
// IA restructure — the Awarded sub-tab shows one table.)

// Approval-state pretty-print for the Open Bids export.
const _approvalLabel = (r) => {
  const u = r.approvedBy ? userById(r.approvedBy)?.name : null;
  if (r.approvalStatus === "approved") return `Approved${u ? ` · ${u}` : ""}${r.approvedAt ? ` · ${fmtDate(r.approvedAt)}` : ""}`;
  if (r.approvalStatus === "rejected") return `Rejected${u ? ` · ${u}` : ""}${r.approvedAt ? ` · ${fmtDate(r.approvedAt)}` : ""}`;
  return "Pending";
};

const EXPORT_COLUMNS = {
  openbids: [
    { label: "RFQ/RFP #",       wMm: 26,  get: r => r.rfqNumber || "" },
    { label: "Client / Parish",           get: r => companyById(r.clientId)?.name || "" },
    { label: "Service",                   get: r => r.serviceDescription || "" },
    { label: "Due Date",        wMm: 32,  get: r => fmtDateTime(r.dueAt) },
    { label: "Web Link",                  get: r => r.webLink || "" },
    { label: "PDF",             wMm: 30,  get: r => r.pdfName || (r.pdfPath ? "(uploaded)" : "") },
    { label: "Approval",        wMm: 60,  get: r => _approvalLabel(r), wrap: true },
    { label: "Notes",                     get: r => r.notes || "" },
  ],
  potential: [
    { label: "Year",              wMm: 14,  get: r => r._total ? "" : r.year },
    { label: "Project",                     get: r => r._total
        ? (r._total === "All" ? `Grand total · ${r._count} ${r._count === 1 ? "project" : "projects"}` : `${r._total} · ${r._count} ${r._count === 1 ? "project" : "projects"}`)
        : r.name },
    { label: "Role",              wMm: 18,  get: r => r._total ? "" : (r.role || "") },
    { label: "Client",                      get: r => r._total ? "" : (companyById(r.clientId)?.name || "") },
    { label: "Contract",          wMm: 26,  get: r => r._total ? fmtMoney(r.amount) : (r.amount != null ? fmtMoney(r.amount) : "") },
    { label: "MSMM",              wMm: 24,  get: r => r._total ? fmtMoney(r.msmm) : (r.msmm != null ? fmtMoney(r.msmm) : "") },
    { label: "Subs",                        get: r => r._total
        ? fmtMoney(r.subsTotal)
        : (r.subs || []).map(s => `${companyById(s.cId)?.name || s.desc || "Sub"}${s.amt ? " " + fmtMoney(s.amt) : ""}`.trim()).join("; ") },
    { label: "PM",                wMm: 22,  get: r => r._total ? "" : ((r.pmIds || []).map(id => userById(id)?.name).filter(Boolean).join(", ")) },
    { label: "Proj #",            wMm: 20,  get: r => r._total ? "" : (r.projectNumber || "") },
    { label: "Probability",       wMm: 22,  get: r => r._total ? "" : (r.probability || "") },
    { label: "Notes",                       get: r => r._total ? "" : (r.notes || "") },
    { label: "Dates & Comments",            get: r => r._total ? "" : [r.nextActionDate ? fmtDate(r.nextActionDate) : "", r.dates || ""].filter(Boolean).join(" · ") },
  ],
  awaiting: [
    { label: "Year",              wMm: 14,  get: r => r.year },
    { label: "Project",                     get: r => r.name },
    { label: "Client",                      get: r => companyById(r.clientId)?.name || "" },
    { label: "Role",              wMm: 18,  get: r => r.role || "" },
    { label: "Submitted",         wMm: 22,  get: r => fmtDate(r.dateSubmitted) },
    { label: "Anticipated Result", wMm: 26, get: r => fmtDate(r.anticipatedResultDate) },
    { label: "Client Contract",   wMm: 28,  get: r => r.clientContract || "" },
    { label: "MSMM Contract",     wMm: 28,  get: r => r.msmmContract || "" },
    { label: "MSMM Remaining",    wMm: 26,  get: r => fmtMoney(r.msmmRemaining) },
    { label: "PM",                wMm: 22,  get: r => (r.pmIds || []).map(id => userById(id)?.name).filter(Boolean).join(", ") },
    { label: "Proj #",            wMm: 20,  get: r => r.projectNumber || "" },
    { label: "Subs",                        get: r => (r.subs || []).map(s => companyById(s.cId)?.name || "").filter(Boolean).join("; ") },
    { label: "Status",            wMm: 28,  get: r => r.status || "Proposal" },
    { label: "MSMM Used",         wMm: 24,  get: r => fmtMoney(r.msmmUsed) },
    { label: "Notes",                       get: r => r.notes || "" },
  ],
  awarded: [
    { label: "Year",              wMm: 14,  get: r => r.year },
    { label: "Project",                     get: r => r.name },
    { label: "Client",                      get: r => companyById(r.clientId)?.name || "" },
    { label: "Stage",                       get: r => r.stage || "" },
    { label: "Pool",                        get: r => r.pools || "" },
    { label: "Contract",          wMm: 26,  get: r => fmtMoney((r.msmmUsed || 0) + (r.msmmRemaining || 0)) },
    { label: "MSMM Used",         wMm: 24,  get: r => fmtMoney(r.msmmUsed) },
    { label: "Remaining",         wMm: 24,  get: r => fmtMoney(r.msmmRemaining) },
    { label: "Expiry",            wMm: 22,  get: r => fmtDate(r.contractExpiry) },
    { label: "PM",                wMm: 22,  get: r => (r.pmIds || []).map(id => userById(id)?.name).filter(Boolean).join(", ") },
    { label: "Proj #",            wMm: 26,  get: r => (r.invoiceLinks && r.invoiceLinks.length) ? r.invoiceLinks.join(", ") : (r.projectNumber || "") },
    { label: "Role",              wMm: 18,  get: r => r.role || "" },
    { label: "Subs",                        get: r => (r.subs || []).map(s => companyById(s.cId)?.name || "").filter(Boolean).join("; ") },
    { label: "Submitted",         wMm: 22,  get: r => fmtDate(r.dateSubmitted) },
    { label: "Client Contract",             get: r => r.clientContract || "" },
    { label: "MSMM Contract",               get: r => r.msmmContract || "" },
    { label: "Status",            wMm: 26,  get: r => r.status || "Awarded" },
    { label: "Details",                     get: r => r.details || "" },
  ],
  closed: [
    { label: "Year",              wMm: 14,  get: r => r.year },
    { label: "Project",                     get: r => r.name },
    { label: "Client",                      get: r => companyById(r.clientId)?.name || "" },
    { label: "Submitted",         wMm: 22,  get: r => fmtDate(r.dateSubmitted) },
    { label: "Closed",            wMm: 22,  get: r => fmtDate(r.dateClosed) },
    { label: "Contract",          wMm: 24,  get: r => fmtMoney(r.amount) },
    { label: "Reason",                      get: r => r.reason || "" },
    { label: "PM",                wMm: 22,  get: r => (r.pmIds || []).map(id => userById(id)?.name).filter(Boolean).join(", ") },
    { label: "Proj #",            wMm: 20,  get: r => r.projectNumber || "" },
    { label: "Role",              wMm: 18,  get: r => r.role || "" },
    { label: "Subs",                        get: r => (r.subs || []).map(s => companyById(s.cId)?.name || "").filter(Boolean).join("; ") },
    { label: "Client Contract",             get: r => r.clientContract || "" },
    { label: "MSMM Contract",               get: r => r.msmmContract || "" },
    { label: "Notes",                       get: r => r.notes || "" },
    { label: "Status",            wMm: 26,  get: r => r.status || "Closed Out" },
  ],
  // Invoice exports on A3 landscape (see handleExport) because 17 columns +
  // full dollar amounts don't fit on A4 without crushing the money cells to
  // an ellipsized "$1,234,5…". Every money column sets `wrap: true` + right
  // halign: `wrap` guarantees the full value prints even if the cell is
  // narrower than expected (falls back to a 2-line linebreak instead of a
  // truncated "…"), and the right halign mirrors the Invoice table's
  // tabular-numeric alignment in the app.
  // Every column declares a `wMm` so the planner uses its "no flex
  // columns" branch and scales all widths proportionally against the A3
  // landscape page (400 mm usable) — instead of reserving 25% of the page
  // for a single flex Project column, which would starve the money cells
  // back to an ellipsized state. Project sets `wrap: true` so long
  // project names still wrap (instead of truncating "…"); money columns
  // set `wrap: true` + `halign: right` so full `$1,234,567.89` values
  // render in full (possibly on 2 lines for multi-million amounts) and
  // align tabular-numeric like the UI.
  invoice: [
    { label: "Project",           wMm: 52, wrap: true,                 get: r => r.name },
    { label: "Type",              wMm: 14,                             get: r => r.type || "" },
    { label: "PM",                wMm: 24, wrap: true,                 get: r => (r.pmIds || []).map(id => userById(id)?.name).filter(Boolean).join(", ") },
    { label: "Contract",          wMm: 26, wrap: true, halign: "right", get: r => fmtMoney(r.amount) },
    { label: "Rollforward",       wMm: 28, wrap: true, halign: "right", get: r => fmtMoney(r.remainingStart) },
    ...MONTHS.map((m, i) => ({
      label: m, wMm: 20, wrap: true, halign: "right",
      get: r => r.values[i] ? fmtMoney(r.values[i]) : "",
    })),
    // YTD Actual = ALL the actuals for the project, summed across EVERY year
    // (not just the current one) — the rolling-window definition. Merged rows
    // carry a byYear map; fall back to the row's own months if absent.
    { label: "Total Billed",      wMm: 24, wrap: true, halign: "right",
      get: r => {
        const sumYr = (yr) => (yr?.values || []).reduce((a,b) => a+(b||0), 0);
        const total = r.byYear
          ? Object.values(r.byYear).reduce((a, yr) => a + sumYr(yr), 0)
          : (r.values || []).reduce((a,b) => a+(b||0), 0);
        return fmtMoney(total);
      } },
    // Total Remaining = Contract (Total CV) − Total Billed, mirroring the
    // project-total scope used by the Contract + Total Billed export columns.
    { label: "Total Remaining",   wMm: 24, wrap: true, halign: "right",
      get: r => {
        const sumYr = (yr) => (yr?.values || []).reduce((a,b) => a+(b||0), 0);
        const billed = r.byYear
          ? Object.values(r.byYear).reduce((a, yr) => a + sumYr(yr), 0)
          : (r.values || []).reduce((a,b) => a+(b||0), 0);
        return fmtMoney((r.amount || 0) - billed);
      } },
  ],
  events: [
    { label: "Date",              wMm: 22,  get: r => fmtDate(r.date) },
    { label: "Status",            wMm: 24,  get: r => r._starsHeader ? "" : (r.status || "") },
    { label: "Type",              wMm: 22,  get: r => r._starsHeader ? "" : (r.type || "") },
    { label: "Title",                       get: r => r._starsHeader
        ? (r._starsHeader === "Unrated" ? `Unrated · ${r._count} ${r._count === 1 ? "event" : "events"}`
                                        : `${"★".repeat(r._starsHeader)} · ${r._count} ${r._count === 1 ? "event" : "events"}`)
        : (r.title || "") },
    { label: "Date & Time",       wMm: 36,  get: r => r._starsHeader ? "" : fmtDateTime(r.dateTime) },
    { label: "Attendees",                   get: r => r._starsHeader ? "" : ((r.attendees || []).map(uid => userById(uid)?.name).filter(Boolean).join(", ")) },
    { label: "Notes",                       get: r => r._starsHeader ? "" : (r.notes || "") },
    { label: "Rating",            wMm: 22,  get: r => r._starsHeader ? "" : (r.stars ? "★".repeat(r.stars) : "") },
  ],
  hotleads: [
    { label: "Status",            wMm: 24,  get: r => r._starsHeader ? "" : (r.status || "") },
    { label: "Type",              wMm: 22,  get: r => r._starsHeader ? "" : (r.type || "") },
    { label: "Title",                       get: r => r._starsHeader
        ? (r._starsHeader === "Unrated" ? `Unrated · ${r._count} ${r._count === 1 ? "lead" : "leads"}`
                                        : `${"★".repeat(r._starsHeader)} · ${r._count} ${r._count === 1 ? "lead" : "leads"}`)
        : (r.title || ""), wrap: true },
    { label: "Client / Firm",               get: r => r._starsHeader ? "" : (companyById(r.clientId)?.name || "") },
    { label: "Date & Time",       wMm: 36,  get: r => r._starsHeader ? "" : fmtDateTime(r.dateTime) },
    { label: "Attendees",                   get: r => r._starsHeader ? "" : ((r.attendees || []).map(uid => userById(uid)?.name).filter(Boolean).join(", ")) },
    { label: "Notes",                       get: r => r._starsHeader ? "" : (r.notes || "") },
    { label: "Rating",            wMm: 22,  get: r => r._starsHeader ? "" : (r.stars ? "★".repeat(r.stars) : "") },
  ],
  directory: [
    { label: "Name",                        get: r => r.type === "Client" ? (r.baseName || r.name) : r.name },
    { label: "Kind",              wMm: 22,  get: r => r.type === "Client" ? "Client" : "Company" },
    { label: "District",                    get: r => r.district || "" },
    { label: "Org Type",          wMm: 22,  get: r => r.orgType || "" },
    { label: "Type",              wMm: 22,  get: r => r.type === "Client" ? "" : (r.type || "") },
    { label: "Contact",                     get: r => r.contact || "" },
    { label: "Email",                       get: r => r.email || "" },
    { label: "Phone",             wMm: 28,  get: r => r.phone || "" },
    { label: "Location",                    get: r => r.address || "" },
    { label: "Notes",                       get: r => r.notes || "" },
    { label: "Projects",          wMm: 20,  get: r => countRefs(r.id) },
  ],
  // Projects export: the rows are the flattened tree (depth carried on
  // r._depth, prefixed onto the name so the hierarchy reads on paper).
  projects: [
    { label: "Project ID",        wMm: 28,  get: r => r.localId || "" },
    { label: "Name",              wrap: true, get: r => `${"  ".repeat(r._depth || 0)}${r.name || ""}` },
    { label: "Type",              wMm: 18,  get: r => projectItemTypeLabel(r.itemType) },
    { label: "Client / Prime",              get: r => companyById(r.clientId)?.name || "" },
    { label: "Subs",                        get: r => (r.subs || []).map(s => companyById(s.cId)?.name || "").filter(Boolean).join("; ") },
    { label: "Contract Type",     wMm: 30,  get: r => contractTypeLabel(r.contractType) },
    { label: "Contract",          wMm: 26, halign: "right", get: r => r.contractAmount != null ? fmtMoney(r.contractAmount) : "" },
    { label: "Start",             wMm: 22,  get: r => fmtDate(r.startDate) },
    { label: "Due",               wMm: 22,  get: r => fmtDate(r.dueDate) },
    { label: "% Complete",        wMm: 18, halign: "right", get: r => r.percentComplete != null ? `${r.percentComplete}%` : "" },
    { label: "Manager",           wMm: 24,  get: r => userById(r.managerId)?.name || "" },
    { label: "Additional PMs",              get: r => (r.pmIds || []).map(id => userById(id)?.name).filter(Boolean).join(", ") },
    { label: "Status",            wMm: 22,  get: r => projectItemStatusLabel(r.status) },
    { label: "Address",                     get: r => [r.addressLine1, r.addressLine2, r.city, r.state, r.pinCode].filter(Boolean).join(", ") },
    { label: "Notes",                       get: r => r.notes || "" },
  ],
};
// The In-Between tab is the same table shape as Invoices — share its defs.
EXPORT_COLUMNS.between = EXPORT_COLUMNS.invoice;

// DB row → UI row adapter for newly-inserted rows from CreateModal
function adaptInsertedRow(table, dbRow, extras = {}) {
  if (table === "potential") {
    return {
      id: dbRow.id,
      year: dbRow.year,
      name: dbRow.project_name,
      role: dbRow.role || null,
      clientId: dbRow.client_id || null,
      amount: dbRow.total_contract_amount,
      msmm: dbRow.msmm_amount,
      // Keep the user's chosen subs shape; sort by ord if we built it from DB rows later.
      subs: extras.subs || [],
      pmIds: extras.pmIds || [],
      notes: dbRow.notes || "",
      dates: dbRow.next_action_note || "",
      nextActionDate: dbRow.next_action_date || "",
      projectNumber: dbRow.project_number || "",
      probability: dbRow.probability,
      anticipatedInvoiceStartMonth: dbRow.anticipated_invoice_start_month ?? null,
    };
  }
  if (table === "awaiting") {
    return {
      id: dbRow.id,
      year: dbRow.year,
      name: dbRow.project_name,
      role: dbRow.prime_company_id ? "Sub" : (dbRow.role || "Prime"),
      clientId: dbRow.client_id || null,
      amount: null,
      msmm: dbRow.msmm_remaining || 0,
      subs: extras.subs || [],
      pmIds: extras.pmIds || [],
      notes: dbRow.notes || "",
      dates: "",
      projectNumber: dbRow.project_number || "",
      status: "Proposal",
      dateSubmitted: dbRow.date_submitted || "",
      anticipatedResultDate: dbRow.anticipated_result_date || "",
      clientContract: dbRow.client_contract_number || "",
      msmmContract: dbRow.msmm_contract_number || "",
      msmmUsed: dbRow.msmm_used || 0,
      msmmRemaining: dbRow.msmm_remaining || 0,
    };
  }
  if (table === "awarded") {
    // Direct-create awarded row. Stage is captured server-side as stage_id;
    // the form's `stage` name string isn't returned in dbRow, so fall back
    // to extras.stageName when available. If neither is set, the cell
    // renders blank and the user fills it in via the drawer.
    return {
      id: dbRow.id,
      year: dbRow.year,
      name: dbRow.project_name,
      role: dbRow.role || (dbRow.prime_company_id || dbRow.prime_client_id ? "Sub" : "Prime"),
      clientId: dbRow.client_id || null,
      primeId: dbRow.prime_client_id || dbRow.prime_company_id || null,
      amount: null,
      msmm: (dbRow.msmm_used || 0) + (dbRow.msmm_remaining || 0),
      subs: extras.subs || [],
      pmIds: extras.pmIds || [],
      notes: dbRow.notes || "",
      dates: "",
      projectNumber: dbRow.project_number || "",
      status: "Awarded",
      dateSubmitted: dbRow.date_submitted || "",
      clientContract: dbRow.client_contract_number || "",
      msmmContract: dbRow.msmm_contract_number || "",
      msmmUsed: dbRow.msmm_used || 0,
      msmmRemaining: dbRow.msmm_remaining || 0,
      stage: extras.stageName || "",
      details: dbRow.details || "",
      pools: dbRow.pool || "",
      contractExpiry: dbRow.contract_expiry_date || "",
    };
  }
  if (table === "events") {
    return {
      id: dbRow.id,
      date: dbRow.event_date || "",
      status: dbRow.status || "",
      type: dbRow.type || "",
      title: dbRow.title,
      dateTime: dbRow.event_datetime || "",
      attendees: extras.attendees || [],
      notes: dbRow.notes || "",
      stars: dbRow.stars == null ? null : Number(dbRow.stars),
    };
  }
  if (table === "hotleads") {
    return {
      id: dbRow.id,
      title: dbRow.title,
      status: dbRow.status || "Scheduled",
      type: dbRow.type || null,
      dateTime: dbRow.date_time || "",
      clientId: dbRow.client_id || dbRow.prime_company_id || null,
      notes: dbRow.notes || "",
      attendees: extras.attendees || [],
      stars: dbRow.stars == null ? null : Number(dbRow.stars),
      anticipatedAmount: dbRow.anticipated_amount == null ? null : Number(dbRow.anticipated_amount),
    };
  }
  if (table === "clients" || table === "directory-client") {
    return {
      id: dbRow.id,
      name: dbRow.district ? `${dbRow.name} — ${dbRow.district}` : dbRow.name,
      baseName: dbRow.name,
      district: dbRow.district || "",
      type: "Client",
      contact: dbRow.contact_person || "",
      email: dbRow.email || "",
      phone: dbRow.phone || "",
      address: dbRow.address || "",
      notes: dbRow.notes || "",
      orgType: dbRow.org_type || "",
    };
  }
  if (table === "companies" || table === "directory-company") {
    return {
      id: dbRow.id,
      name: dbRow.name,
      type: "Prime",
      contact: dbRow.contact_person || "",
      email: dbRow.email || "",
      phone: dbRow.phone || "",
      address: dbRow.address || "",
      notes: dbRow.notes || "",
    };
  }
  if (table === "invoice") {
    return {
      id: dbRow.id,
      sourceId: dbRow.source_project_id || null,
      projectNumber: dbRow.project_number || "",
      name: dbRow.project_name,
      pmIds: extras.pmIds || [],
      amount: dbRow.contract_amount || 0,
      msmmAmount: dbRow.msmm_amount ?? null,
      msmmValues: [
        dbRow.msmm_jan_amount, dbRow.msmm_feb_amount, dbRow.msmm_mar_amount, dbRow.msmm_apr_amount,
        dbRow.msmm_may_amount, dbRow.msmm_jun_amount, dbRow.msmm_jul_amount, dbRow.msmm_aug_amount,
        dbRow.msmm_sep_amount, dbRow.msmm_oct_amount, dbRow.msmm_nov_amount, dbRow.msmm_dec_amount,
      ].map(v => v ?? null),
      type: dbRow.type || "ENG",
      remainingStart: dbRow.msmm_remaining_to_bill_year_start || 0,
      values: Array(12).fill(0),
      year: dbRow.year,
      ytdActualOverride: null,
      rollforwardOverride: null,
      // Default role + empty file lists so the table render path doesn't
      // need to special-case freshly-inserted rows.
      role: "Prime",
      primeFiles: Array.from({ length: 12 }, () => []),
    };
  }
  if (table === "openbids") {
    return {
      id: dbRow.id,
      rfqNumber:          dbRow.rfq_rfp_number || "",
      clientId:           dbRow.client_id || null,
      serviceDescription: dbRow.service_description || "",
      dueAt:              dbRow.due_at || "",
      pdfPath:            dbRow.pdf_file_path || "",
      pdfName:            dbRow.pdf_file_name || "",
      webLink:            dbRow.web_link || "",
      notes:              dbRow.notes || "",
      approvalStatus:     dbRow.approval_status || "pending",
      approvedBy:         dbRow.approved_by || null,
      approvedAt:         dbRow.approved_at || null,
      movedToProjectId:   dbRow.moved_to_project_id || null,
      createdBy:          dbRow.created_by || null,
      createdAt:          dbRow.created_at || null,
      anticipatedAmount:  dbRow.anticipated_amount == null ? null : Number(dbRow.anticipated_amount),
    };
  }
  return dbRow;
}

// ======================================================================
// Loading screen
// ======================================================================
function LoadingScreen({ error }) {
  return (
    <div style={{
      minHeight: "100vh", display: "grid", placeItems: "center",
      background: "var(--bg, #F7F3EC)", color: "var(--text, #22201C)",
      fontFamily: "var(--font-body, system-ui)",
    }}>
      <div style={{ textAlign: "center", maxWidth: 520, padding: 32 }}>
        <div style={{
          width: 48, height: 48, borderRadius: 14, margin: "0 auto 18px",
          background: "radial-gradient(circle at 50% 35%, #C8823B, #6B3F10)",
          boxShadow: "0 0 0 2px #F8ECD6, 0 10px 24px -6px rgba(200,130,59,.45)",
          animation: error ? "none" : "beaconPulse 1.4s ease-in-out infinite",
          position: "relative",
        }}>
          <div style={{
            position: "absolute", inset: 10, borderRadius: "50%",
            background: "radial-gradient(circle at 50% 40%, rgba(255,255,255,.9), transparent 60%)",
          }}/>
        </div>
        <div style={{ fontFamily: "var(--font-display, system-ui)", fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>
          Beacon
        </div>
        <div style={{ color: "var(--text-muted, #6E6659)", fontSize: 13, marginTop: 6 }}>
          {error ? "Couldn't load project data" : "Loading from beacon_v2.*…"}
        </div>
        {error && (
          <pre style={{
            marginTop: 18, textAlign: "left",
            background: "var(--surface, #FFF)",
            border: "1px solid var(--border, #E6DFD1)",
            borderRadius: 10, padding: 14, fontSize: 12, fontFamily: "var(--font-mono, monospace)",
            color: "var(--rose, #B86B66)", maxHeight: 240, overflow: "auto",
          }}>{String(error.message || error)}</pre>
        )}
      </div>
      <style>{`
        @keyframes beaconPulse {
          0%,100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.08); opacity: .85; }
        }
      `}</style>
    </div>
  );
}

const OwnPasswordModal = ({ user, onClose, onSubmit }) => {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const valid =
    currentPassword.length > 0 &&
    newPassword.length >= 6 &&
    newPassword === confirmPassword &&
    newPassword !== currentPassword;

  const submit = async (e) => {
    e.preventDefault();
    if (pending) return;
    if (!currentPassword) {
      setError("Enter your current password.");
      return;
    }
    if (newPassword.length < 6) {
      setError("New password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setError("Choose a password that is different from your current one.");
      return;
    }

    setPending(true);
    setError("");
    try {
      await onSubmit(currentPassword, newPassword);
      onClose();
    } catch (err) {
      setError(err?.message || "Password change failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="overlay" onClick={pending ? undefined : onClose}/>
      <form className="modal password-modal" onSubmit={submit}>
        <div className="modal-head">
          <div className="icon-badge"><Icon name="lock" size={16}/></div>
          <div style={{ flex: 1 }}>
            <div className="drawer-eyebrow">Account</div>
            <h3 className="drawer-title" style={{ fontSize: 16 }}>Change password</h3>
            <div style={{ fontSize: 12, color: "var(--text-soft)", marginTop: 3 }}>
              <span className="mono">{user?.email}</span>
            </div>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} disabled={pending}>
            <Icon name="x" size={16}/>
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <div className="field-label">Current password *</div>
            <div className="field-value">
              <input
                className="input"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                value={currentPassword}
                autoFocus
                onChange={e => setCurrentPassword(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <div className="field-label">New password *</div>
            <div className="field-value">
              <input
                className="input"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <div className="field-label">Confirm password *</div>
            <div className="field-value">
              <input
                className="input"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
              />
            </div>
          </div>
          <label className="password-show-toggle">
            <input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)}/>
            <span>Show passwords</span>
          </label>
          {error && (
            <div className="admin-error" role="alert">
              <Icon name="x" size={12}/>
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <div style={{ fontSize: 12, color: "var(--text-soft)" }}>
            You will stay signed in on this device.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn sm" onClick={onClose} disabled={pending}>Cancel</button>
            <button className="btn primary sm" disabled={!valid || pending}>
              <Icon name="check" size={13}/>
              {pending ? "Updating…" : "Update password"}
            </button>
          </div>
        </div>
      </form>
    </>
  );
};

// ======================================================================
// Main App
// ======================================================================
function BeaconApp({ initial, currentUser, onSignOut, onRefreshCurrentUser }) {
  const isAdmin = currentUser?.role === "Admin";
  const userDisplayName =
    currentUser?.display_name
    || [currentUser?.first_name, currentUser?.last_name].filter(Boolean).join(" ").trim()
    || currentUser?.email
    || "Signed in";
  const userInitials =
    (currentUser?.first_name?.[0] || "") +
    (currentUser?.last_name?.[0]  || "")
    || userDisplayName.slice(0, 2);
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [tweaks, setTweaks] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("beacon-tweaks") || "null");
      return saved || { ...DEFAULT_TWEAKS };
    } catch { return { ...DEFAULT_TWEAKS }; }
  });
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [adminOpen, setAdminOpen]   = useState(false);
  // Bump to force PM pickers / Quad Sheet / exports to re-read the users cache
  // after the admin panel mutates the roster. The value is read via a data
  // attribute below so unused-var lint stays happy; re-render is the goal.
  const [rosterTick, setRosterTick] = useState(0);
  const [tab, setTab] = useState(() => {
    // Mobile-first: when a user opens Beacon on a phone, the most common
    // intent is "punch in / out" — so we override the persisted desktop
    // tab and land them on Timesheet. URL ?tab=X deep links (handled in
    // the effect below) still win; this only kicks in for a fresh open
    // with no explicit destination.
    if (isMobileNow()) {
      const urlTab = new URLSearchParams(window.location.search).get("tab");
      if (!urlTab) return "timesheet";
    }
    const saved = localStorage.getItem("beacon-tab") || "invoice";
    // Migrate legacy values: the v2 UI merged clients + companies into
    // "directory" and dropped soq. The Quad Sheet was retired (2026-05) —
    // its charts moved to the top of the Invoice tab and the Outstanding
    // Invoices panel moved to the bottom, so legacy "quad" / "soq" both
    // remap to "invoice".
    if (saved === "clients" || saved === "companies") return "directory";
    if (saved === "soq" || saved === "quad") return "invoice";
    return saved;
  });
  // Deep-link landing: if the URL carries ?tab=X&rowId=Y (from an alert email),
  // record the row id until the target tab's rows are available, then auto-open
  // the detail drawer on it. Cleared after consumption so tab-switches don't
  // re-trigger.
  const [pendingFocusRowId, setPendingFocusRowId] = useState(null);

  useEffect(() => { localStorage.setItem("beacon-tab", tab); }, [tab]);
  // Leaving the Projects section closes any open project detail page.
  useEffect(() => { setDetailProject(null); }, [tab]);
  useEffect(() => { localStorage.setItem("beacon-tweaks", JSON.stringify(tweaks)); }, [tweaks]);
  useEffect(() => { applyTweaks(tweaks); }, [tweaks]);

  // Keep the active tab visible. On narrow viewports the pipeline scrolls
  // horizontally (overflow-x: auto), so the active tab can sit off-screen
  // if the user touch-scrolled the rail or switched tabs programmatically.
  // Scroll the active button into view every time the tab changes.
  const pipelineRef = useRef(null);
  useEffect(() => {
    const rail = pipelineRef.current;
    if (!rail) return;
    const active = rail.querySelector(".tab.active");
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
  }, [tab]);

  // Consume URL params once on BeaconApp mount. BeaconApp only renders after
  // `phase === "ready"`, so we know the session + data are loaded — no race
  // with the boot machine in the root <App/>.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const tabParam  = params.get("tab");
      const rowParam  = params.get("rowId");
      const dateParam = params.get("date");
      if (tabParam && TAB_META.some(t => t.key === tabParam)) setTab(tabParam);
      if (rowParam)  setPendingFocusRowId(rowParam);
      // Timesheet deep link uses ?tab=timesheet&date=YYYY-MM-DD (the
      // "tag your meeting" alert email goes here).
      if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        setTimesheetFocusDate(dateParam);
      }
      if (tabParam || rowParam || dateParam) {
        window.history.replaceState(null, "", window.location.pathname);
      }
    } catch { /* malformed params — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [timesheetFocusDate, setTimesheetFocusDate] = useState(null);

  // Data state
  const [potential, setPotential] = useState(initial.potential);
  const [awaiting,  setAwaiting]  = useState(initial.awaiting);
  const [awarded,   setAwarded]   = useState(initial.awarded);
  const [closed,    setClosed]    = useState(initial.closed);
  // Sub-invoice matrix per project: Map<project_id, sub_entry[]>. Updated
  // after every subAmount upsert / file upload / file delete via reloadInvoiceArtifacts.
  const [subInvoices, setSubInvoices] = useState(initial.subInvoices || new Map());
  const [invoice,   setInvoice]   = useState(initial.invoices);
  const [events,    setEvents]    = useState(initial.events);
  const [hotLeads,  setHotLeads]  = useState(initial.hotLeads || []);
  const [openBids,  setOpenBids]  = useState(initial.openBids || []);
  // Projects (tree-structured work breakdown — beacon_v2.project_items). One
  // flat array; ProjectsTable builds the parent/child tree from parentId.
  const [projectItems, setProjectItems] = useState(initial.projectItems || []);
  // The root project_item whose dedicated detail page is open (null = the
  // normal Projects tree table). Set by clicking a root on the Projects page.
  const [detailProject, setDetailProject] = useState(null);
  const [clients,   setClients]   = useState(() => getClientsOnly());
  const [companies, setCompanies] = useState(() => getCompaniesOnly());
  // Workspace-wide settings (singleton). Today: monthlyInvoiceBenchmark drives
  // the Quad Sheet's bar coloring (green when month total ≥ benchmark, red
  // when below). Updated locally + persisted by AdminPanel → Targets tab.
  const [appSettings, setAppSettings] = useState(
    initial.appSettings || { monthlyInvoiceBenchmark: null, invoiceActualCutoverDay: 1, invoiceActualCutoverNextMonth: false, updatedAt: null }
  );
  // Invoice Actual/Projection boundary — the last month index considered
  // "Actual". Driven by the configurable cutover day (the current month stays
  // Projection until that day, then flips). Recomputed each render from the
  // live setting; passed to InvoiceTable + InvoiceCharts and used in the
  // export/styling closures + the YTD stat below. The "today column" highlight
  // still keys off the real calendar month (TODAY_MONTH), not this boundary.
  const actualThru = actualThruMonth(appSettings.invoiceActualCutoverDay, appSettings.invoiceActualCutoverNextMonth);

  // Filter state (keyed by tab)
  const [filterKey, setFilterKey] = useState({
    potential: "all", awaiting: "all", awarded: "all", closed: "all",
    events: "all", hotleads: "all", directory: "all", openbids: "all",
    projects: "all",
  });

  // Year filter state. null = All years; number = filter to that year.
  const [yearFilter, setYearFilter] = useState({
    potential: null, awaiting: null, awarded: null,
    closed: null, invoice: null, events: null,
    hotleads: null, openbids: null,
  });
  const setYear = (t, y) => setYearFilter(f => ({ ...f, [t]: y }));

  // Overlays
  const [drawer, setDrawer] = useState(null);
  const [moving, setMoving] = useState(null);
  const [alert, setAlertObj] = useState(null);
  const [createTable, setCreateTable] = useState(null); // 'potential' | 'events' | 'clients' | 'companies' | null
  const [createSeed, setCreateSeed] = useState(null);
  // Invoice file-attachment modal — { kind, projectRow, monthIdx, sub? } or null.
  const [filesModal, setFilesModal] = useState(null);
  // "Add sub" modal — { projectRow } or null. Triggered from the Invoice expand.
  const [addSubModal, setAddSubModal] = useState(null);
  // Directory "Merge" modal — { entities, kind } or null. mergeResetKey bumps
  // after a successful merge so DirectoryTable drops its (now stale) selection.
  const [mergeModal, setMergeModal] = useState(null);
  const [mergeResetKey, setMergeResetKey] = useState(0);
  // Generic confirm prompt — { title, message, confirmLabel, tone, icon, onConfirm } or null.
  // Currently drives the "unmark a paid invoice" gate; reusable for other guards.
  const [confirmState, setConfirmState] = useState(null);
  const [toast, setToast] = useState(null);
  const [flashId, setFlashId] = useState(null);
  const [eventsViewMode, setEventsViewModeState] = useState(() => {
    try { return localStorage.getItem("beacon.eventsViewMode") || "list"; }
    catch { return "list"; }
  });
  const [calendarViewMode, setCalendarViewModeState] = useState(() => {
    try { return localStorage.getItem("beacon.calendarViewMode") || "month"; }
    catch { return "month"; }
  });
  const [outlookSyncing, setOutlookSyncing] = useState(false);
  const setEventsViewMode = (v) => {
    setEventsViewModeState(v);
    try { localStorage.setItem("beacon.eventsViewMode", v); } catch {}
  };
  const setCalendarViewMode = (v) => {
    setCalendarViewModeState(v);
    try { localStorage.setItem("beacon.calendarViewMode", v); } catch {}
  };

  const setTweak = (k, v) => setTweaks(t => ({ ...t, [k]: v }));

  // Toast supports an optional inline action button (e.g. an Undo link after a
  // move-forward). When opts.action is provided the toast lingers ~10s instead
  // of the default 3.2s so the user has time to click; calling the action also
  // dismisses the toast immediately. Each call cancels the prior auto-clear so
  // back-to-back showToast() calls don't cross streams.
  const toastTimerRef = useRef(null);
  const showToast = (msg, icon = "check", opts = {}) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    const action = opts.action || null;
    setToast({ msg, icon, action });
    const ttl = action ? 10000 : 3200;
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, ttl);
  };
  const dismissToast = () => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  };

  // =====================================================================
  // PERSISTENCE LAYER — every inline/drawer edit flows through these maps
  // and the patchTable / syncJoinUsers helpers, so changes survive a reload.
  // Fields not listed in a *_COLS map update local React state only; typical
  // exceptions are derived values (row.role on awaiting/awarded/closed,
  // row.status, row.type on companies) and join-table relationships (subs,
  // pmIds, attendees — handled separately). PMs + event attendees are diffed
  // and mirrored to their join tables. Subs edits are still local-only today.
  // =====================================================================
  // NOTE on `clientId` / `primeId`: deliberately NOT in any *_COLS map.
  // Both are merged-pool UI fields whose picked UUID could belong to either
  // the clients or companies table. Each updater calls the matching router
  // (routeClientPick / routePrimePick) and merges the result into dbPatch
  // after buildDbPatch runs. clientId is unified across every project tab;
  // primeId is awarded-only.
  const POTENTIAL_COLS = {
    year: "year", name: "project_name", role: "role",
    amount: "total_contract_amount", msmm: "msmm_amount",
    notes: "notes", dates: "next_action_note", nextActionDate: "next_action_date",
    projectNumber: "project_number", probability: "probability",
    anticipatedInvoiceStartMonth: "anticipated_invoice_start_month",
  };
  const AWAITING_COLS = {
    year: "year", name: "project_name",
    notes: "notes", projectNumber: "project_number",
    dateSubmitted: "date_submitted", anticipatedResultDate: "anticipated_result_date",
    clientContract: "client_contract_number", msmmContract: "msmm_contract_number",
    msmmUsed: "msmm_used", msmmRemaining: "msmm_remaining",
  };
  const AWARDED_COLS = {
    year: "year", name: "project_name",
    projectNumber: "project_number", dateSubmitted: "date_submitted",
    clientContract: "client_contract_number", msmmContract: "msmm_contract_number",
    msmmUsed: "msmm_used", msmmRemaining: "msmm_remaining",
    details: "details", pools: "pool", contractExpiry: "contract_expiry_date",
    // stage is stored as stage_id (FK to awarded_stages); editing by name
    // would need a lookup. Skipped for now — edit via the drawer triggers no
    // persist; re-create from Move Forward to pick a new stage instead.
  };
  const CLOSED_COLS = {
    year: "year", name: "project_name",
    notes: "notes", projectNumber: "project_number",
    dateSubmitted: "date_submitted",
    clientContract: "client_contract_number", msmmContract: "msmm_contract_number",
    dateClosed: "date_closed", reason: "reason_for_closure",
  };
  const EVENTS_COLS = {
    title: "title", status: "status", type: "type",
    date: "event_date", dateTime: "event_datetime", notes: "notes",
    stars: "stars",
  };
  // Hot Leads — like Events but with a client/company picker. `clientId` is
  // intentionally OMITTED from this map for the same reason as the project
  // tables (routed through routeClientPick to client_id or prime_company_id
  // based on which pool the UUID belongs to).
  const HOT_LEADS_COLS = {
    title: "title",
    type: "type",
    dateTime: "date_time",
    anticipatedAmount: "anticipated_amount",
    notes: "notes",
    stars: "stars",
  };
  const CLIENTS_COLS = {
    baseName: "name", district: "district", orgType: "org_type",
    contact: "contact_person", email: "email", phone: "phone",
    address: "address", notes: "notes",
  };
  const COMPANIES_COLS = {
    name: "name", contact: "contact_person", email: "email",
    phone: "phone", address: "address", notes: "notes",
    // `type` on companies is derived at load time from observed Prime/Sub
    // usage across rows — not a column on `beacon.companies`. Intentionally
    // skipped so drawer edits don't error.
  };

  // Columns that reject empty string at the DB level (dates, numerics, UUIDs,
  // enums). An empty string in a patch for any of these becomes SQL NULL.
  const NULL_IF_EMPTY_COLS = new Set([
    "next_action_date", "date_submitted", "anticipated_result_date",
    "date_closed", "contract_expiry_date",
    "event_date", "event_datetime", "date_time",
    "year", "total_contract_amount", "msmm_amount",
    "anticipated_invoice_start_month", "msmm_used", "msmm_remaining",
    "client_id",
    "role", "probability", "org_type", "status", "type",
    "stars", "anticipated_amount",
  ]);

  const buildDbPatch = (patch, colMap) => {
    const dbPatch = {};
    for (const [uiKey, dbCol] of Object.entries(colMap)) {
      if (!(uiKey in patch)) continue;
      let v = patch[uiKey];
      if ((v === "" || v === undefined) && NULL_IF_EMPTY_COLS.has(dbCol)) v = null;
      dbPatch[dbCol] = v;
    }
    return dbPatch;
  };

  const patchTable = (tableName, id, dbPatch) => {
    if (Object.keys(dbPatch).length === 0) return;
    supabase.from(tableName).update(dbPatch).eq("id", id)
      .then(({ error }) => {
        if (error) showToast(`Save failed: ${error.message}`, "x");
      });
  };

  // Diff old vs new user-id arrays and mirror the delta into a join table.
  // Covers PMs on every project table + attendees on events.
  const syncJoinUsers = async (parentId, oldIds, newIds, joinTable, parentCol) => {
    const oldSet = new Set(oldIds || []);
    const newSet = new Set(newIds || []);
    const toAdd    = [...newSet].filter(x => !oldSet.has(x));
    const toRemove = [...oldSet].filter(x => !newSet.has(x));
    try {
      if (toRemove.length > 0) {
        const { error } = await supabase.from(joinTable).delete()
          .eq(parentCol, parentId).in("user_id", toRemove);
        if (error) throw error;
      }
      if (toAdd.length > 0) {
        const { error } = await supabase.from(joinTable).insert(
          toAdd.map(uid => ({ [parentCol]: parentId, user_id: uid }))
        );
        if (error) throw error;
      }
    } catch (e) {
      showToast(`User tag save failed: ${e.message || e}`, "x");
    }
  };

  // --- Per-table update functions ---------------------------------------
  // Each one: (1) optimistic local state update, (2) scalar column PATCH via
  // buildDbPatch, (3) join-table sync where applicable. Potential layers
  // Orange auto-Invoice-create on top as an additional side-effect.

  const updatePotential = (id, patch) => {
    const existing = potential.find(r => r.id === id);
    if (!existing) return;
    setPotential(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));

    // Scalar writeback. potential_role_prime_consistency check requires that
    // role=Prime implies prime_company_id IS NULL, and role=Sub requires it
    // to be set. Auto-nullify prime_company_id when switching to Prime so
    // the check doesn't fire; Sub requires a prime company set via drawer.
    const dbPatch = buildDbPatch(patch, POTENTIAL_COLS);
    if ("role" in patch && patch.role === "Prime") dbPatch.prime_company_id = null;
    // Route the unified UI clientId to client_id or prime_company_id based
    // on whether the picked UUID is actually a client or a firm. See
    // routeClientPick in data.js.
    if ("clientId" in patch) Object.assign(dbPatch, routeClientPick(patch.clientId));
    patchTable("projects", id, dbPatch);

    if ("pmIds" in patch) {
      syncJoinUsers(id, existing.pmIds, patch.pmIds,
        "project_pms", "project_id");
    }

    // Orange invariant: tagging Orange spawns a linked Invoice row; clearing
    // Orange (transitioning to any other probability) tears that row back
    // down. Orange Potentials are also hidden from the Potential view (see
    // `filtered.potential`), so the row only "lives" in Invoice while Orange.
    // Unique index on (source_potential_id, year) guards against duplicates
    // on the spawn path.
    if ("probability" in patch && patch.probability !== existing.probability) {
      const wasOrange = existing.probability === "Orange";
      const isNowOrange = patch.probability === "Orange";
      if (isNowOrange && !wasOrange) {
        const alreadyLinked = invoice.some(r => r.sourceId === id);
        if (!alreadyLinked) {
          (async () => {
            try {
              const invPayload = {
                source_project_id: id,
                project_name: existing.name,
                year: existing.year,
                project_number: existing.projectNumber || null,
                // Total Contract Value only. MSMM portion stays NULL so the
                // UI shows the derived value (= total − Σ subs); the user
                // can override from the Invoice expand row if needed.
                contract_amount: existing.amount ?? null,
              };
              const { data: invRow, error } = await supabase
                .from("anticipated_invoice").insert(invPayload).select().single();
              if (error) throw error;
              setInvoice(rs => [{
                id: invRow.id,
                sourceId: invRow.source_project_id,
                projectNumber: invRow.project_number || "",
                name: invRow.project_name,
                pmIds: [...(existing.pmIds || [])],
                amount: invRow.contract_amount ?? 0,
                msmmAmount: invRow.msmm_amount ?? null,
                msmmValues: Array(12).fill(null),
                type: invRow.type || "ENG",
                remainingStart: invRow.msmm_remaining_to_bill_year_start || 0,
                values: Array(12).fill(0),
                year: invRow.year,
                ytdActualOverride:   invRow.ytd_actual_override   ?? null,
                rollforwardOverride: invRow.rollforward_override  ?? null,
              }, ...rs]);
              showToast("Orange tagged · Invoice row auto-created", "check");
            } catch (e) {
              showToast(`Orange Invoice creation failed: ${e.message || e}`, "x");
            }
          })();
        }
      } else if (wasOrange && !isNowOrange) {
        // Demote from Orange. The linked invoice row was auto-spawned and
        // has no independent meaning once the project is no longer Orange,
        // so tear it down. The Potential row reappears in the Potential
        // view automatically (it's hidden by `filtered.potential` only
        // while probability='Orange').
        const linked = invoice.find(r => r.sourceId === id);
        if (linked) {
          (async () => {
            const prev = invoice;
            setInvoice(rs => rs.filter(r => r.id !== linked.id));
            const { error } = await supabase
              .from("anticipated_invoice").delete().eq("id", linked.id);
            if (error) {
              setInvoice(prev);
              showToast(`Demote failed: ${error.message}`, "x");
              return;
            }
            showToast("Demoted from Orange · Invoice row removed", "check");
          })();
        }
      }
    }
  };

  const updateAwaiting = (id, patch) => {
    const existing = awaiting.find(r => r.id === id);
    if (!existing) return;
    setAwaiting(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    const dbPatch = buildDbPatch(patch, AWAITING_COLS);
    if ("clientId" in patch) Object.assign(dbPatch, routeClientPick(patch.clientId));
    patchTable("projects", id, dbPatch);
    if ("pmIds" in patch) {
      syncJoinUsers(id, existing.pmIds, patch.pmIds,
        "project_pms", "project_id");
    }
  };

  const updateAwarded = (id, patch) => {
    const existing = awarded.find(r => r.id === id);
    if (!existing) return;
    setAwarded(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    const dbPatch = buildDbPatch(patch, AWARDED_COLS);
    if ("clientId" in patch) Object.assign(dbPatch, routeClientPick(patch.clientId));
    if ("primeId"  in patch) Object.assign(dbPatch, routePrimePick (patch.primeId));
    patchTable("projects", id, dbPatch);
    if ("pmIds" in patch) {
      syncJoinUsers(id, existing.pmIds, patch.pmIds,
        "project_pms", "project_id");
    }
  };

  const updateClosed = (id, patch) => {
    const existing = closed.find(r => r.id === id);
    if (!existing) return;
    setClosed(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    const dbPatch = buildDbPatch(patch, CLOSED_COLS);
    if ("clientId" in patch) Object.assign(dbPatch, routeClientPick(patch.clientId));
    patchTable("projects", id, dbPatch);
    if ("pmIds" in patch) {
      syncJoinUsers(id, existing.pmIds, patch.pmIds,
        "project_pms", "project_id");
    }
  };

  const updateEvents = (id, patch) => {
    const existing = events.find(r => r.id === id);
    if (!existing) return;
    // Outlook-sourced events: synced fields (title, datetime, attendees) are
    // overwritten by Graph on every tick — silently strip them from the patch
    // so a stray inline edit doesn't appear to stick.
    let safe = patch;
    if (existing.source === "outlook") {
      const { title: _t, dateTime: _dt, date: _d, attendees: _a, ...rest } = patch;
      safe = rest;
      if (Object.keys(safe).length === 0) {
        showToast("Synced from Outlook — edit there to change this field.", "lock");
        return;
      }
    }
    setEvents(rs => rs.map(r => r.id === id ? { ...r, ...safe } : r));
    patchTable("events", id, buildDbPatch(safe, EVENTS_COLS));
    if ("attendees" in safe) {
      syncJoinUsers(id, existing.attendees, safe.attendees,
        "event_attendees", "event_id");
    }
  };

  const handleOutlookSync = async () => {
    if (outlookSyncing) return;
    setOutlookSyncing(true);
    try {
      const res = await runOutlookSyncNow();
      if (res?.disabled) {
        showToast("Outlook sync is disabled.", "ban");
      } else {
        const parts = [];
        if (res?.processed != null) parts.push(`${res.processed} processed`);
        if (res?.inserted)  parts.push(`${res.inserted} new`);
        if (res?.updated)   parts.push(`${res.updated} updated`);
        if (res?.cancelled) parts.push(`${res.cancelled} cancelled`);
        showToast(parts.length ? `Outlook · ${parts.join(" · ")}` : "Outlook sync complete", "bolt");
        try {
          const fresh = await reloadEvents();
          setEvents(fresh);
        } catch (e) {
          showToast(`Reload failed: ${e.message || e}`, "x");
        }
      }
    } catch (e) {
      showToast(`Sync failed: ${e.message || e}`, "x");
    } finally {
      setOutlookSyncing(false);
    }
  };

  const updateHotLeads = (id, patch) => {
    const existing = hotLeads.find(r => r.id === id);
    if (!existing) return;
    setHotLeads(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    const dbPatch = buildDbPatch(patch, HOT_LEADS_COLS);
    // Client-or-Firm picker: route the unified clientId to the right column.
    if ("clientId" in patch) Object.assign(dbPatch, routeClientPick(patch.clientId));
    patchTable("leads", id, dbPatch);
    if ("attendees" in patch) {
      syncJoinUsers(id, existing.attendees, patch.attendees,
        "lead_attendees", "lead_id");
    }
  };

  // -------------------- Open Bids handlers --------------------
  // Optimistic local update + scoped PATCH. Mirrors the existing
  // pipeline-tab pattern. The OPEN_BID_COL_MAP in data.js filters out
  // approval-state fields — those flow through approveOpenBid /
  // rejectOpenBid / clearOpenBidApproval below (which the DB trigger
  // gates to Admins).
  const updateOpenBids = (id, patch) => {
    const existing = openBids.find(r => r.id === id);
    if (!existing) return;
    setOpenBids(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    updateOpenBidDb(id, patch).catch(e => {
      showToast(`Save failed: ${e.message || e}`, "x");
    });
  };

  const setBidApproval = async (id, status) => {
    const existing = openBids.find(r => r.id === id);
    if (!existing) return;
    // Optimistic stamp with the current admin's id + now() so the UI
    // reflects the change instantly. The server-side trigger is the
    // authoritative gate.
    const me = currentUser;
    const stampedAt = status === "pending" ? null : new Date().toISOString();
    const stampedBy = status === "pending" ? null : (me?.id || null);
    setOpenBids(rs => rs.map(r => r.id === id
      ? { ...r, approvalStatus: status, approvedBy: stampedBy, approvedAt: stampedAt }
      : r));
    try {
      const fresh = await setOpenBidApproval(id, status);
      // Re-sync from DB (canonical approver/timestamp) in case our optimistic
      // stamp diverged (e.g. clock skew, race).
      setOpenBids(rs => rs.map(r => r.id === id ? { ...r, ...fresh } : r));
      showToast(
        status === "approved" ? "Bid approved" :
        status === "rejected" ? "Bid rejected" :
        "Approval cleared",
        status === "rejected" ? "x" : "check"
      );
    } catch (e) {
      // Roll back the optimistic stamp on error.
      setOpenBids(rs => rs.map(r => r.id === id ? existing : r));
      showToast(`Approval failed: ${e.message || e}`, "x");
    }
  };

  const uploadBidPdf = async (id, file) => {
    if (!file) return;
    try {
      const fresh = await uploadOpenBidPdf({ bidId: id, file });
      setOpenBids(rs => rs.map(r => r.id === id ? { ...r, ...fresh } : r));
      showToast("PDF uploaded", "check");
    } catch (e) {
      showToast(`Upload failed: ${e.message || e}`, "x");
    }
  };

  const removeBidPdf = async (id) => {
    const existing = openBids.find(r => r.id === id);
    if (!existing?.pdfPath) return;
    const prev = existing;
    setOpenBids(rs => rs.map(r => r.id === id ? { ...r, pdfPath: "", pdfName: "" } : r));
    try {
      const fresh = await deleteOpenBidPdf({ bidId: id, filePath: existing.pdfPath });
      setOpenBids(rs => rs.map(r => r.id === id ? { ...r, ...fresh } : r));
      showToast("PDF removed", "check");
    } catch (e) {
      setOpenBids(rs => rs.map(r => r.id === id ? prev : r));
      showToast(`Remove failed: ${e.message || e}`, "x");
    }
  };

  const openBidPdfInNewTab = async (row) => {
    if (!row?.pdfPath) return;
    try {
      const url = await getOpenBidPdfSignedUrl(row.pdfPath, 60);
      if (url) window.open(url, "_blank", "noopener");
    } catch (e) {
      showToast(`Open failed: ${e.message || e}`, "x");
    }
  };

  const deleteOpenBidRow = async (id) => {
    const prev = openBids;
    setOpenBids(rs => rs.filter(r => r.id !== id));
    try {
      await deleteOpenBidDb(id);
      showToast("Open bid deleted", "check");
    } catch (e) {
      setOpenBids(prev);
      showToast(`Delete failed: ${e.message || e}`, "x");
    }
  };

  // -------------------- Projects (tree work breakdown) --------------------
  // Optimistic local update + a guarded scalar PATCH. The contract roll-up
  // rule + the re-parent cycle guard are checked client-side here (instant
  // feedback) AND enforced by the DB trigger (the backstop — a rejected write
  // reverts the optimistic change). Additional PMs sync through the shared
  // join-table differ; the single Manager is a scalar column.
  const updateProjectItemRow = (id, patch) => {
    const existing = projectItems.find(r => r.id === id);
    if (!existing) return;

    // item_type / status are NOT NULL enums. The inline select auto-injects a
    // "—" option that commits null — ignore an attempt to clear them (the DB
    // would reject it anyway). local_id is NOT NULL too — never blank it.
    if ("itemType" in patch && !patch.itemType) return;
    if ("status"   in patch && !patch.status)   return;
    if ("localId"  in patch && !String(patch.localId).trim()) {
      showToast("ID can't be empty.", "x");
      return;
    }

    // Re-parent guard: can't move a node under itself or its own descendant.
    if ("parentId" in patch && patch.parentId) {
      if (patch.parentId === id || projectItemDescendantIds(projectItems, id).includes(patch.parentId)) {
        showToast("Can't move an item under itself or one of its own children.", "x");
        return;
      }
    }
    // Contract roll-up guard (mirror of fn_project_item_validate).
    if ("contractAmount" in patch || "parentId" in patch) {
      const amount   = "contractAmount" in patch ? patch.contractAmount : existing.contractAmount;
      const parentId = "parentId" in patch ? patch.parentId : existing.parentId;
      const v = validateProjectItemContract(projectItems, { itemId: id, parentId, amount });
      if (!v.ok) { showToast(v.message, "x"); return; }
    }

    setProjectItems(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));

    if ("pmIds" in patch) {
      syncJoinUsers(id, existing.pmIds, patch.pmIds, "project_item_pms", "item_id");
    }

    const scalarPatch = { ...patch };
    delete scalarPatch.pmIds;
    delete scalarPatch.subs;
    if (Object.keys(scalarPatch).length > 0) {
      updateProjectItem(id, scalarPatch).catch(e => {
        // Revert the optimistic change (covers a DB-trigger reject, e.g. the
        // roll-up constraint catching something the client check missed).
        setProjectItems(rs => rs.map(r => r.id === id ? existing : r));
        showToast(e.message || String(e), "x");
      });
    }
  };

  const deleteProjectItemRow = (id) => {
    const existing = projectItems.find(r => r.id === id);
    if (!existing) return;
    const descendants = projectItemDescendantIds(projectItems, id);
    const n = descendants.length;
    const doDelete = async () => {
      const removeIds = new Set([id, ...descendants]);
      const prev = projectItems;
      setProjectItems(rs => rs.filter(r => !removeIds.has(r.id)));
      try {
        await deleteProjectItem(id); // parent_id FK is ON DELETE CASCADE
        showToast(n
          ? `Deleted "${existing.name}" + ${n} child item${n === 1 ? "" : "s"}`
          : `Deleted "${existing.name}"`, "check");
      } catch (e) {
        setProjectItems(prev);
        showToast(`Delete failed: ${e.message || e}`, "x");
      }
    };
    setConfirmState({
      title: n > 0 ? "Delete this project and its children?" : "Delete this project?",
      message: n > 0
        ? `"${existing.name}" has ${n} item${n === 1 ? "" : "s"} nested under it. Deleting it removes the whole subtree — this can't be undone.`
        : `"${existing.name}" will be permanently deleted.`,
      confirmLabel: n > 0 ? `Delete ${n + 1} items` : "Delete",
      tone: "danger", icon: "trash",
      onConfirm: doDelete,
    });
  };

  // Subs on a project item (companies). Optimistic; the join key is
  // (item_id, company_id) — itemId is the node's uuid.
  const addProjectItemSubRow = async (itemId, companyId) => {
    const existing = projectItems.find(r => r.id === itemId);
    if (!existing || !companyId) return;
    try {
      const res = await addProjectItemSub({
        itemId, companyId, ord: (existing.subs?.length || 0) + 1,
      });
      if (res.existed) { showToast("Already a sub on this item", "x"); return; }
      setProjectItems(rs => rs.map(r => r.id === itemId
        ? { ...r, subs: [...(r.subs || []), { cId: companyId, desc: "", amt: 0 }] }
        : r));
    } catch (e) { showToast(`Add sub failed: ${e.message || e}`, "x"); }
  };
  const updateProjectItemSubRow = (itemId, companyId, patch) => {
    const prev = projectItems;
    setProjectItems(rs => rs.map(r => r.id === itemId
      ? { ...r, subs: (r.subs || []).map(s => s.cId === companyId ? { ...s, ...patch } : s) }
      : r));
    updateProjectItemSub({
      itemId, companyId,
      amount:     "amt"  in patch ? patch.amt  : undefined,
      discipline: "desc" in patch ? patch.desc : undefined,
    }).catch(e => { setProjectItems(prev); showToast(`Save failed: ${e.message || e}`, "x"); });
  };
  const removeProjectItemSubRow = async (itemId, companyId) => {
    const prev = projectItems;
    setProjectItems(rs => rs.map(r => r.id === itemId
      ? { ...r, subs: (r.subs || []).filter(s => s.cId !== companyId) }
      : r));
    try { await removeProjectItemSub({ itemId, companyId }); }
    catch (e) { setProjectItems(prev); showToast(`Remove failed: ${e.message || e}`, "x"); }
  };

  // Open the New-Project modal. When adding a child, pre-seed the parent (and
  // default the new item to Standard — children are usually work items).
  const openNewProject = (parentId = null) => {
    setCreateSeed(parentId ? { parent_id: parentId } : null);
    setCreateTable("projects");
  };

  const updateClients = (id, patch) => {
    const existing = clients.find(r => r.id === id);
    if (!existing) return;
    // clients.name in the UI is the merged display `${name} — ${district}`.
    // Drawer/table edits target baseName / district individually; keep the
    // merged `name` derived in local state so consumers (project rows'
    // Client cell, dropdowns) stay consistent without a full reload.
    let p = patch;
    if ("baseName" in patch || "district" in patch) {
      const newBase = "baseName" in patch ? patch.baseName : existing.baseName;
      const newDist = "district" in patch ? patch.district : existing.district;
      p = { ...patch, name: newDist ? `${newBase} — ${newDist}` : newBase };
    }
    setClients(rs => rs.map(r => r.id === id ? { ...r, ...p } : r));
    patchTable("clients", id, buildDbPatch(patch, CLIENTS_COLS));
  };

  const updateCompanies = (id, patch) => {
    const existing = companies.find(r => r.id === id);
    if (!existing) return;
    setCompanies(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    // `type` on a company is derived from observed Prime/Sub usage at load
    // time — not a beacon.companies column. Only scalars in COMPANIES_COLS
    // persist; everything else is local state only.
    patchTable("companies", id, buildDbPatch(patch, COMPANIES_COLS));
  };

  // Directory merge — consolidate the selected duplicates into `survivorId`,
  // repointing every reference (server-side, transactional). Because the merge
  // touches projects across all stages plus invoices / sub-invoices / leads /
  // bids, we re-pull those slices from loadBeacon (which also refreshes the
  // clients/companies module caches) rather than surgically patching state.
  const handleMergeConfirm = async (survivorId, loserIds) => {
    const kind = mergeModal?.kind || "Company";
    const survivorName =
      (mergeModal?.entities || []).find(e => e.id === survivorId)?.name || "the kept record";
    const res = await mergeEntities({ kind, survivorId, loserIds });
    const d = await loadBeacon();
    setPotential(d.potential); setAwaiting(d.awaiting);
    setAwarded(d.awarded);     setClosed(d.closed);
    setInvoice(d.invoices);    setHotLeads(d.hotLeads || []);
    setOpenBids(d.openBids || []);
    setSubInvoices(d.subInvoices || new Map());
    setClients(getClientsOnly());
    setCompanies(getCompaniesOnly());
    setMergeModal(null);
    setMergeResetKey(k => k + 1);
    const moved =
      (res?.projects || 0) + (res?.project_subs || 0) + (res?.sub_invoices || 0) +
      (res?.leads || 0) + (res?.prime || 0) + (res?.open_bids || 0);
    const n = res?.merged ?? loserIds.length;
    showToast(
      `Merged ${n} duplicate${n > 1 ? "s" : ""} into ${survivorName} · ${moved} reference${moved === 1 ? "" : "s"} repointed`,
      "merge"
    );
  };

  // Monthly value edits (Jan–Dec cells in the Invoice table) write through
  // to the corresponding per-month column on beacon.anticipated_invoice.
  // Writes are optimistic: local React state updates immediately so the
  // cell reflects the new value, then the PostgREST PATCH fires; if it
  // fails the toast surfaces the error (local state is NOT rolled back —
  // matches the existing override-cell behavior).
  const INVOICE_MONTH_COLS = [
    "jan_amount","feb_amount","mar_amount","apr_amount",
    "may_amount","jun_amount","jul_amount","aug_amount",
    "sep_amount","oct_amount","nov_amount","dec_amount",
  ];
  // Parallel monthly columns holding MSMM-portion overrides. NULL means
  // "auto-calc (= total month − Σ sub.amounts[month])"; numeric is a
  // frozen override. Same semantic as msmm_amount on the contract field.
  const INVOICE_MSMM_MONTH_COLS = [
    "msmm_jan_amount","msmm_feb_amount","msmm_mar_amount","msmm_apr_amount",
    "msmm_may_amount","msmm_jun_amount","msmm_jul_amount","msmm_aug_amount",
    "msmm_sep_amount","msmm_oct_amount","msmm_nov_amount","msmm_dec_amount",
  ];
  // Parallel monthly PAID flags for the prime/total invoice (MSMM as Prime).
  // Boolean per month on anticipated_invoice — drives the green tick on the
  // Project total row, the prime analogue of sub_invoices.paid.
  const INVOICE_PAID_MONTH_COLS = [
    "jan_paid","feb_paid","mar_paid","apr_paid",
    "may_paid","jun_paid","jul_paid","aug_paid",
    "sep_paid","oct_paid","nov_paid","dec_paid",
  ];
  const INVOICE_INVNUM_MONTH_COLS = [
    "jan_invoice_number","feb_invoice_number","mar_invoice_number","apr_invoice_number",
    "may_invoice_number","jun_invoice_number","jul_invoice_number","aug_invoice_number",
    "sep_invoice_number","oct_invoice_number","nov_invoice_number","dec_invoice_number",
  ];
  const updateInvoiceCell = (id, monthIdx, v) => {
    const nv = Number(v || 0);
    setInvoice(rows => rows.map(r => {
      if (r.id !== id) return r;
      const vals = [...r.values];
      vals[monthIdx] = nv;
      return { ...r, values: vals };
    }));
    const col = INVOICE_MONTH_COLS[monthIdx];
    if (!col) return;
    supabase.from("anticipated_invoice").update({ [col]: nv }).eq("id", id)
      .then(({ error }) => {
        if (error) showToast(`Save failed: ${error.message}`, "x");
      });
  };
  // MSMM monthly override write. Empty input → null → resume auto-calc;
  // numeric → freeze that month's MSMM value at the override.
  const updateInvoiceMsmmCell = (id, monthIdx, v) => {
    const nv = (v == null || v === "") ? null : Number(v);
    setInvoice(rows => rows.map(r => {
      if (r.id !== id) return r;
      const next = [...(r.msmmValues || Array(12).fill(null))];
      next[monthIdx] = nv;
      return { ...r, msmmValues: next };
    }));
    const col = INVOICE_MSMM_MONTH_COLS[monthIdx];
    if (!col) return;
    supabase.from("anticipated_invoice").update({ [col]: nv }).eq("id", id)
      .then(({ error }) => {
        if (error) showToast(`Save failed: ${error.message}`, "x");
      });
  };
  // Prime/total invoice per-month paid toggle. Flips one boolean column
  // (jan_paid..dec_paid) on anticipated_invoice — the prime analogue of the
  // sub paid toggle. Optimistic local flip so the Project total cell turns
  // green immediately; reverts the row on a write failure.
  // A paid invoice locks: marking paid (paid=true) is always allowed; unmarking
  // (paid=false) is admin-only and requires a confirmation prompt. Non-admins
  // get a "locked" toast instead. See requestPaidUntick.
  const updateInvoicePrimePaid = (id, monthIdx, paid) => {
    const col = INVOICE_PAID_MONTH_COLS[monthIdx];
    if (!col) return;
    const apply = () => {
      setInvoice(rows => rows.map(r => {
        if (r.id !== id) return r;
        const next = [...(r.primePaid || Array(12).fill(false))];
        next[monthIdx] = paid;
        return { ...r, primePaid: next };
      }));
      supabase.from("anticipated_invoice").update({ [col]: paid }).eq("id", id)
        .then(({ error }) => {
          if (error) {
            setInvoice(rows => rows.map(r => {
              if (r.id !== id) return r;
              const next = [...(r.primePaid || Array(12).fill(false))];
              next[monthIdx] = !paid;
              return { ...r, primePaid: next };
            }));
            showToast(`Mark ${paid ? "paid" : "pending"} failed: ${error.message}`, "x");
          }
        });
    };
    if (!paid) {
      const row = invoice.find(r => r.id === id);
      requestPaidUntick({ label: `${row?.name || "Project total"} · ${MONTHS[monthIdx]}`, onConfirm: apply });
      return;
    }
    apply();
  };

  // Shared gate for un-ticking a paid invoice (prime total, sub line, or the
  // files modal). Locked for non-admins; admins confirm before it applies.
  const requestPaidUntick = ({ label, onConfirm }) => {
    if (!isAdmin) {
      showToast("This invoice is marked paid and locked — only an administrator can unmark it.", "lock");
      return;
    }
    setConfirmState({
      title: "Unmark this invoice as paid?",
      message: label
        ? `“${label}” is marked paid and locked. Are you sure you want to untick it?`
        : "Are you sure you want to untick this?",
      confirmLabel: "Untick",
      tone: "danger",
      icon: "lock",
      onConfirm,
    });
  };

  // Per-month invoice number on the prime/total row. One number per
  // (project, month) — the invoice the month's project total was billed
  // under. Mirrors updateInvoicePrimePaid: optimistic local patch of
  // invoiceNumbers[monthIdx] then a scoped column update; rollback on error.
  // Empty string normalizes to NULL so clearing the field clears the chip.
  const updateInvoiceMonthInvoiceNumber = (id, monthIdx, value) => {
    const col = INVOICE_INVNUM_MONTH_COLS[monthIdx];
    if (!col) return;
    const clean = (value == null || String(value).trim() === "") ? null : String(value).trim();
    const existing = invoice.find(r => r.id === id);
    const prevVal = existing?.invoiceNumbers?.[monthIdx] ?? null;
    if (prevVal === clean) return;
    setInvoice(rows => rows.map(r => {
      if (r.id !== id) return r;
      const next = [...(r.invoiceNumbers || Array(12).fill(null))];
      next[monthIdx] = clean;
      return { ...r, invoiceNumbers: next };
    }));
    supabase.from("anticipated_invoice").update({ [col]: clean }).eq("id", id)
      .then(({ error }) => {
        if (error) {
          setInvoice(rows => rows.map(r => {
            if (r.id !== id) return r;
            const next = [...(r.invoiceNumbers || Array(12).fill(null))];
            next[monthIdx] = prevVal;
            return { ...r, invoiceNumbers: next };
          }));
          showToast(`Save invoice # failed: ${error.message}`, "x");
        }
      });
  };

  // Resolve EVERY anticipated_invoice row id in a project's merged group.
  // Merged rows carry groupIds; raw year-rows (e.g. the DetailDrawer's
  // liveRow, which is looked up in the unmerged invoice slice) don't — for
  // those, re-derive the group by lineage / normalized number + type so a
  // transition never strands a sibling year-row in the old state.
  const invoiceGroupIdsFor = (row) => {
    if (row.groupIds && row.groupIds.length) return row.groupIds;
    const key = normInvoiceNumber(row.projectNumber);
    const t = row.type || "ENG";
    const matches = invoice.filter(r =>
      r.id === row.id ||
      ((r.type || "ENG") === t && (
        (row.sourceId && r.sourceId === row.sourceId) ||
        (key && normInvoiceNumber(r.projectNumber) === key)
      )));
    return matches.length ? matches.map(r => r.id) : [row.id];
  };

  // UI-field → DB-column whitelist for other editable Invoice cells. Any
  // key not in this map updates local state only. PMs are mirrored below
  // through anticipated_invoice_pms, not patched onto anticipated_invoice.
  const INVOICE_COL_MAP = {
    ytdActualOverride:   "ytd_actual_override",
    rollforwardOverride: "rollforward_override",
    name:                "project_name",
    projectNumber:       "project_number",
    amount:              "contract_amount",
    msmmAmount:          "msmm_amount",
    type:                "type",
    remainingStart:      "msmm_remaining_to_bill_year_start",
    totalRemainingStart: "total_remaining_to_bill_year_start",
    year:                "year",
    notes:               "notes",
    description:         "description",
    invoiceOrange:       "invoice_orange",
  };
  const updateInvoice = (id, patch) => {
    const existing = invoice.find(r => r.id === id);
    if (!existing) return;
    const ids = "invoiceOrange" in patch ? invoiceGroupIdsFor(existing) : [id];
    setInvoice(rows => rows.map(r => ids.includes(r.id) ? { ...r, ...patch } : r));
    const dbPatch = {};
    for (const [uiKey, dbCol] of Object.entries(INVOICE_COL_MAP)) {
      if (uiKey in patch) dbPatch[dbCol] = patch[uiKey];
    }
    if (Object.keys(dbPatch).length > 0) {
      const query = supabase.from("anticipated_invoice").update(dbPatch);
      const save = ids.length === 1 && ids[0] === id ? query.eq("id", id) : query.in("id", ids);
      save
        .then(({ error }) => {
          if (error) showToast(`Save failed: ${error.message}`, "x");
        });
    }
    if ("pmIds" in patch) {
      syncJoinUsers(id, existing.pmIds, patch.pmIds,
        "anticipated_invoice_pms", "anticipated_invoice_id");
    }
  };

  const saveInvoiceProjectEgnyteFolder = async (row, egnyteFolderPath) => {
    let projectId = row?.sourceId;
    let autoLinked = null;
    if (!projectId) {
      autoLinked = await findOrCreateProjectForInvoice({
        name: row?.name,
        projectNumber: row?.projectNumber,
        year: row?.year,
      });
      projectId = autoLinked.projectId;
      await linkInvoiceToProject(row.id, projectId);
    }
    const result = await saveProjectEgnyteFolder(projectId, egnyteFolderPath);
    const cleanPath = result.egnyteFolderPath || "";
    if (autoLinked?.matchType === "created" && autoLinked.projectStub) {
      const stub = autoLinked.projectStub;
      const stubUiRow = {
        id: stub.id,
        year: stub.year,
        name: stub.project_name,
        role: null,
        clientId: null,
        amount: null,
        msmm: 0,
        subs: [],
        pmIds: [],
        notes: "",
        dates: "",
        projectNumber: stub.project_number || "",
        status: "Awarded",
        dateSubmitted: "",
        clientContract: "",
        msmmContract: "",
        msmmUsed: 0,
        msmmRemaining: 0,
        stage: "",
        details: "",
        pools: "",
        contractExpiry: "",
        egnyteFolderPath: cleanPath,
      };
      setAwarded(rows => rows.some(r => r.id === projectId)
        ? rows.map(r => r.id === projectId ? { ...r, egnyteFolderPath: cleanPath } : r)
        : [stubUiRow, ...rows]);
    }
    const patchProjectSlice = setter => setter(rows => rows.map(r =>
      r.id === projectId ? { ...r, egnyteFolderPath: cleanPath } : r
    ));
    setInvoice(rows => rows.map(r =>
      r.sourceId === projectId || r.id === row?.id
        ? { ...r, sourceId: projectId, egnyteFolderPath: cleanPath }
        : r
    ));
    patchProjectSlice(setPotential);
    patchProjectSlice(setAwaiting);
    patchProjectSlice(setAwarded);
    patchProjectSlice(setClosed);
    if (autoLinked?.matchType === "matched") {
      showToast(`Linked to ${autoLinked.projectName} · Egnyte folder saved`, "link");
      return cleanPath;
    }
    showToast(cleanPath ? "Egnyte folder linked" : "Egnyte folder link cleared", "link");
    return cleanPath;
  };

  // ---- Rolling-window year-aware month edits ---------------------------------
  // The InvoiceTable shows a sliding 16-month window that crosses calendar
  // years, but each month's data lives in the anticipated_invoice row for that
  // specific year. These wrappers resolve (merged project, year) → the flat
  // year-row id, MINTING the row on the fly when a month is edited in a year
  // that has none yet, then delegate to the existing per-id writers.
  const resolveInvoiceYearId = async (mergedRow, year) => {
    const existing = mergedRow?.byYear?.[year]?.id;
    if (existing) return existing;
    const payload = {
      source_project_id: mergedRow.sourceId || null,
      project_name: mergedRow.name || "",
      project_number: mergedRow.projectNumber || null,
      type: mergedRow.type || "ENG",
      contract_amount: mergedRow.amount ?? null,
      year,
    };
    const { data, error } = await supabase
      .from("anticipated_invoice")
      .insert(payload)
      .select("*, pms:anticipated_invoice_pms(user_id)")
      .single();
    if (error) {
      // 23505 = a concurrent edit in the same new year won the (source_project_id,
      // year) unique race. Fetch the row that landed instead of erroring.
      if (error.code === "23505" && mergedRow.sourceId) {
        const { data: raced } = await supabase
          .from("anticipated_invoice")
          .select("*, pms:anticipated_invoice_pms(user_id)")
          .eq("source_project_id", mergedRow.sourceId)
          .eq("year", year)
          .eq("type", mergedRow.type || "ENG")
          .limit(1)
          .maybeSingle();
        if (raced) {
          setInvoice(rs => rs.some(r => r.id === raced.id)
            ? rs
            : [...rs, adaptInvoiceRow(raced, { role: mergedRow.role || "Prime" })]);
          return raced.id;
        }
      }
      showToast(`Couldn't add the ${year} invoice row: ${error.message}`, "x");
      return null;
    }
    setInvoice(rs => [...rs, adaptInvoiceRow(data, { role: mergedRow.role || "Prime" })]);
    return data.id;
  };
  const editInvoiceTotalMonth = async (mergedRow, year, monthIdx, v) => {
    const id = await resolveInvoiceYearId(mergedRow, year);
    if (id) updateInvoiceCell(id, monthIdx, v);
  };
  const editInvoiceMsmmMonth = async (mergedRow, year, monthIdx, v) => {
    const id = await resolveInvoiceYearId(mergedRow, year);
    if (id) updateInvoiceMsmmCell(id, monthIdx, v);
  };
  const editInvoicePrimePaidMonth = async (mergedRow, year, monthIdx, paid) => {
    const id = await resolveInvoiceYearId(mergedRow, year);
    if (id) updateInvoicePrimePaid(id, monthIdx, paid);
  };

  // Open the files modal for a month cell, year-aware. Prime files attach to an
  // invoice_id, so we ensure the year's invoice row exists first; sub files read
  // the sub entry's byYear[year]. Party (firm-level) files are year-agnostic.
  const openInvoiceFiles = async (payload) => {
    const { kind } = payload;
    if (kind === "party-msmm" || kind === "party-prime" || kind === "party-sub") {
      setFilesModal(payload);
      return;
    }
    const year = payload.year ?? (payload.projectRow?.year || THIS_YEAR);
    if (kind === "prime") {
      const id = await resolveInvoiceYearId(payload.projectRow, year);
      if (!id) return;
      setFilesModal({ ...payload, year, yearRowId: id });
    } else {
      setFilesModal({ ...payload, year });
    }
  };

  // Delete an anticipated_invoice row. The BEFORE DELETE trigger from the
  // alerts wiring migration deactivates any related alerts; the
  // anticipated_invoice_pms join cascades. Optimistic local removal first,
  // restore on DB error.
  const deleteInvoice = async (id) => {
    const prev = invoice;
    setInvoice(rows => rows.filter(r => r.id !== id));
    const { error } = await supabase.from("anticipated_invoice").delete().eq("id", id);
    if (error) {
      setInvoice(prev);
      showToast(`Delete failed: ${error.message}`, "x");
      return;
    }
    showToast("Invoice row deleted", "check");
  };

  // Events delete — `event_attendees` cascades; the generic BEFORE DELETE
  // trigger deactivates any related alerts. Optimistic local removal first,
  // restore on DB error.
  const deleteEvent = async (id) => {
    const prev = events;
    setEvents(rows => rows.filter(r => r.id !== id));
    const { error } = await supabase.from("events").delete().eq("id", id);
    if (error) {
      setEvents(prev);
      showToast(`Delete failed: ${error.message}`, "x");
      return;
    }
    showToast("Event deleted", "check");
  };

  // Hot Leads delete — v2 table is `leads`; `lead_attendees` cascades;
  // generic deactivate-alerts trigger fires. Same optimistic pattern.
  const deleteHotLead = async (id) => {
    const prev = hotLeads;
    setHotLeads(rows => rows.filter(r => r.id !== id));
    const { error } = await supabase.from("leads").delete().eq("id", id);
    if (error) {
      setHotLeads(prev);
      showToast(`Delete failed: ${error.message}`, "x");
      return;
    }
    showToast("Hot lead deleted", "check");
  };

  // Sub-invoice cell edits + post-write refresh of the invoice artifacts.
  // The invoice rows + sub matrix get re-fetched together so primeFiles/files
  // stay in sync with whatever the user just saved.
  const refreshInvoiceArtifacts = async () => {
    try {
      const allProjects = [...potential, ...awaiting, ...awarded, ...closed];
      const allCompaniesOrClients = [...clients, ...companies];
      const [{ primeFilesByKey, subInvoicesMatrix }, partyFilesByInvoice] = await Promise.all([
        reloadInvoiceArtifacts(allProjects, allCompaniesOrClients),
        reloadInvoicePartyFiles(),
      ]);
      // Re-annotate primeFiles + partyFiles on existing invoice rows.
      setInvoice(rows => rows.map(inv => ({
        ...inv,
        primeFiles: Array.from({ length: 12 }, (_, i) =>
          primeFilesByKey.get(`${inv.id}:${i + 1}`) || []
        ),
        partyFiles: partyFilesByInvoice.get(inv.id) || { msmm: [], prime: {}, sub: {} },
      })));
      setSubInvoices(subInvoicesMatrix);
    } catch (e) {
      showToast(`Reload failed: ${e?.message || e}`, "x");
    }
  };

  // Toggle paid status for a single (project, sub, month) cell. Ensures the
  // sub_invoice row exists first (so users can mark a cell paid even before
  // typing an amount), then patches the matrix locally so the cell flips
  // green immediately without a full reload.
  // Same lock as the prime row: un-ticking a paid sub line is admin-only +
  // confirmed; marking paid is open. Routes through requestPaidUntick on untick.
  const setSubInvoicePaidStatus = async (args) => {
    if (!args.paid) {
      const yr = args.year ?? THIS_YEAR;
      const label = `${companyById(args.companyId)?.name || "Sub"} · ${MONTHS[args.monthIdx]} ${yr}`;
      requestPaidUntick({ label, onConfirm: () => doSetSubInvoicePaid(args) });
      return;
    }
    await doSetSubInvoicePaid(args);
  };

  const doSetSubInvoicePaid = async ({ projectId, companyId, monthIdx, paid, kind = "sub", year = THIS_YEAR }) => {
    try {
      const row = await ensureSubInvoiceRow({
        projectId, companyId,
        year,
        month: monthIdx + 1,
        kind,
      });
      await setSubInvoicePaid(row.id, paid);
      // Rebuild the matrix (incl. every year's byYear) so the cell flips in the
      // window regardless of which year it belongs to.
      await refreshInvoiceArtifacts();
    } catch (e) {
      showToast(`Mark ${paid ? "paid" : "pending"} failed: ${e?.message || e}`, "x");
    }
  };

  const updateSubInvoiceCell = async (projectId, companyId, monthIdx, value, kind = "sub", year = THIS_YEAR) => {
    try {
      const cleaned = value === "" || value == null ? null : Number(value);
      await upsertSubInvoiceAmount({
        projectId, companyId,
        year,
        month: monthIdx + 1,
        amount: cleaned,
        kind,
      });
      await refreshInvoiceArtifacts();
    } catch (e) {
      showToast(`Invoice save failed: ${e?.message || e}`, "x");
    }
  };

  // Edit metadata on an existing project_subs row (contract amount or
  // discipline). Identifies the row by the natural composite key
  // (project_id, company_id, kind). Optimistic — patches both the
  // subInvoices matrix AND the per-project subs array on whichever pipeline
  // slice owns the project, so every consumer sees the change immediately.
  const updateSubMeta = async ({ projectId, companyId, kind = "sub", patch }) => {
    if (!patch || Object.keys(patch).length === 0) return;
    try {
      await updateProjectSub({ projectId, companyId, kind, ...patch });

      // 1) Patch the matrix entry (Invoice tab + Receivables read this).
      setSubInvoices(prev => {
        const next = new Map(prev);
        const list = next.get(projectId);
        if (!list) return prev;
        next.set(projectId, list.map(s => {
          if (s.companyId !== companyId || (s.kind || "sub") !== kind) return s;
          const out = { ...s };
          if (patch.amount !== undefined) {
            out.contractAmount = (patch.amount === "" || patch.amount == null) ? 0 : Number(patch.amount);
          }
          if (patch.discipline !== undefined) {
            out.discipline = patch.discipline || "";
          }
          if (patch.sub_agreement !== undefined) out.subAgreement = !!patch.sub_agreement;
          if (patch.w9 !== undefined) out.w9 = !!patch.w9;
          if (patch.coi !== undefined) out.coi = !!patch.coi;
          if (patch.remaining_to_bill_year_start !== undefined) {
            out.remainingStart = (patch.remaining_to_bill_year_start === "" || patch.remaining_to_bill_year_start == null)
              ? null : Number(patch.remaining_to_bill_year_start);
          }
          return out;
        }));
        return next;
      });

      // 2) Patch the project's subs array on whichever slice holds it. The
      //    adapted shape uses {cId, desc, amt, kind}, distinct from the
      //    matrix entry shape — both need to stay in sync.
      const patchSlice = (setter) => setter(prev => prev.map(p => {
        if (p.id !== projectId) return p;
        return {
          ...p,
          subs: (p.subs || []).map(s => {
            if (s.cId !== companyId || (s.kind || "sub") !== kind) return s;
            const out = { ...s };
            if (patch.amount !== undefined) {
              out.amt = (patch.amount === "" || patch.amount == null) ? 0 : Number(patch.amount);
            }
            if (patch.discipline !== undefined) {
              out.desc = patch.discipline || "";
            }
            if (patch.sub_agreement !== undefined) out.subAgreement = !!patch.sub_agreement;
            if (patch.w9 !== undefined) out.w9 = !!patch.w9;
            if (patch.coi !== undefined) out.coi = !!patch.coi;
            if (patch.remaining_to_bill_year_start !== undefined) {
              out.remaining = (patch.remaining_to_bill_year_start === "" || patch.remaining_to_bill_year_start == null)
                ? null : Number(patch.remaining_to_bill_year_start);
            }
            return out;
          }),
        };
      }));
      patchSlice(setPotential);
      patchSlice(setAwaiting);
      patchSlice(setAwarded);
      patchSlice(setClosed);
    } catch (e) {
      showToast(`Update failed: ${e?.message || e}`, "x");
    }
  };

  // Remove a project_subs row entirely. For kind='prime' rows the DB call
  // also clears projects.prime_company_id (see data.js). Local state mirrors
  // both removals — the matrix entry is dropped, the project's subs list
  // is filtered, and for prime removals the project's clientId is recomputed
  // (it's conflated with prime_company_id by the adapter, so leaving it
  // alone leaves a dangling reference to the removed firm).
  const removeSub = async ({ projectId, companyId, kind = "sub", companyName }) => {
    try {
      await removeProjectSub({ projectId, companyId, kind });

      setSubInvoices(prev => {
        const next = new Map(prev);
        const list = next.get(projectId);
        if (!list) return prev;
        const filtered = list.filter(s => !(s.companyId === companyId && (s.kind || "sub") === kind));
        if (filtered.length === 0) next.delete(projectId);
        else next.set(projectId, filtered);
        return next;
      });

      const patchSlice = (setter) => setter(prev => prev.map(p => {
        if (p.id !== projectId) return p;
        const nextSubs = (p.subs || []).filter(s => !(s.cId === companyId && (s.kind || "sub") === kind));
        const out = { ...p, subs: nextSubs };
        // For prime removal, also drop the conflated clientId reference if it
        // was pointing at the prime we just removed (the adapter folds
        // prime_company_id into clientId when client_id is null).
        if (kind === "prime" && p.clientId === companyId) out.clientId = null;
        return out;
      }));
      patchSlice(setPotential);
      patchSlice(setAwaiting);
      patchSlice(setAwarded);
      patchSlice(setClosed);

      showToast(`Removed ${companyName || (kind === "prime" ? "prime" : "sub")}`, "check");
    } catch (e) {
      showToast(`Remove failed: ${e?.message || e}`, "x");
    }
  };

  // Toggle a project's Prime/Sub role from the Invoice tab. Switching to
  // Prime also clears prime_company_id in the DB; switching to Sub leaves
  // prime_company_id alone (the user picks one in the next "+ Add prime"
  // step). After the DB write, we patch the project's role + the linked
  // invoice row's role flag locally so the UI updates without a reload.
  const setInvoiceRoleHandler = async (invoiceRow, newRole) => {
    let projectId = invoiceRow?.sourceId;
    let autoLinked = null;
    try {
      // Invisible auto-link: same pattern as AddSubModal. If the invoice
      // has no upstream project, match by (project_number, year) or mint a
      // stub. The user never sees a project-picker — they just toggled the
      // role chip. Without this, role changes on standalone invoices threw
      // "Link this invoice to a project first" with no path forward.
      if (!projectId) {
        autoLinked = await findOrCreateProjectForInvoice({
          name: invoiceRow.name,
          projectNumber: invoiceRow.projectNumber,
          year: invoiceRow.year,
        });
        projectId = autoLinked.projectId;
        await linkInvoiceToProject(invoiceRow.id, projectId);
        setInvoice(rows => rows.map(inv =>
          inv.id === invoiceRow.id ? { ...inv, sourceId: projectId } : inv
        ));
        // Mirror a brand-new stub project into the awarded slice so the
        // rest of the UI sees it (matches applyInsertedSub's pattern).
        if (autoLinked.matchType === "created" && autoLinked.projectStub) {
          const stub = autoLinked.projectStub;
          const stubUiRow = {
            id: stub.id,
            year: stub.year,
            name: stub.project_name,
            role: null,
            clientId: null,
            amount: null,
            msmm: 0,
            subs: [],
            pmIds: [],
            notes: "",
            dates: "",
            projectNumber: stub.project_number || "",
            status: "Awarded",
            dateSubmitted: "",
            clientContract: "",
            msmmContract: "",
            msmmUsed: 0,
            msmmRemaining: 0,
            stage: "",
            details: "",
            pools: "",
            contractExpiry: "",
          };
          setAwarded(rows => [stubUiRow, ...rows]);
        }
      }

      await setProjectRole(projectId, newRole);
      // Patch invoice slice — every invoice on this project gets the new role.
      setInvoice(rows => rows.map(inv =>
        inv.sourceId === projectId ? { ...inv, role: newRole } : inv
      ));
      // Patch the project slice the project lives in. Switching to Prime
      // also clears prime_company_id locally (matches the DB clear).
      const patch = (rows) => rows.map(p =>
        p.id !== projectId ? p : {
          ...p,
          role: newRole,
          ...(newRole === "Prime" ? { prime_company_id: null } : {}),
        }
      );
      if (potential.some(p => p.id === projectId)) setPotential(patch);
      else if (awaiting.some(p => p.id === projectId)) setAwaiting(patch);
      else if (awarded.some(p => p.id === projectId)) setAwarded(patch);
      else if (closed.some(p => p.id === projectId))   setClosed(patch);

      if (autoLinked?.matchType === "matched") {
        showToast(`Linked to ${autoLinked.projectName} · role: ${newRole}`);
      } else if (autoLinked?.matchType === "created") {
        showToast(`Stub project created · role: ${newRole}`);
      }
    } catch (e) {
      showToast(`Role change failed: ${e?.message || e}`, "x");
    }
  };

  // Patch local project + sub-invoice matrix state to reflect a freshly-
  // inserted project_subs row. The DB INSERT itself is performed inside
  // AddSubModal (so it can surface inline errors) — this just mirrors that
  // change into in-memory state so the Invoice tab updates immediately.
  //
  // When the modal had to link a previously-unlinked invoice to a project,
  // the auto-link can resolve in two ways:
  //   * matched   → an existing project was found by (project_number, year)
  //   * created   → we auto-created a stub project (status='awarded')
  // Both surface here via autoLinkedProject so we can patch the right state
  // slice (and add the stub to the awarded slice if it's brand new).
  //
  // `kind` is 'sub' (default) or 'prime'. For prime entries, the modal also
  // updated projects.prime_company_id; we mirror that locally so role/prime
  // logic in the rest of the UI stays consistent without a reload.
  const applyInsertedSub = ({ inserted, existed, linkedProjectId, invoiceId, autoLinkedProject, kind }) => {
    if (linkedProjectId && invoiceId) {
      setInvoice(rows => rows.map(inv =>
        inv.id === invoiceId ? { ...inv, sourceId: linkedProjectId } : inv
      ));
    }
    // If the modal auto-created a stub project, mirror it into the awarded
    // slice so the rest of the UI sees it (Awarded tab, Linked Projects in
    // the Directory drawer, the project_subs lookup that drives the matrix).
    if (autoLinkedProject?.matchType === "created" && autoLinkedProject.projectStub) {
      const stub = autoLinkedProject.projectStub;
      const stubUiRow = {
        id: stub.id,
        year: stub.year,
        name: stub.project_name,
        role: null,
        clientId: null,
        amount: null,
        msmm: 0,
        subs: [],
        pmIds: [],
        notes: "",
        dates: "",
        projectNumber: stub.project_number || "",
        status: "Awarded",
        dateSubmitted: "",
        clientContract: "",
        msmmContract: "",
        msmmUsed: 0,
        msmmRemaining: 0,
        stage: "",
        details: "",
        pools: "",
        contractExpiry: "",
      };
      setAwarded(rows => [stubUiRow, ...rows]);
    }
    const projectId = inserted.project_id;
    const companyId = inserted.company_id;
    const entryKind = kind || inserted.kind || "sub";
    // UI sub shape used by adapter / Linked-Projects helper / countRefsFor.
    const newUiSub = {
      cId: companyId,
      desc: inserted.discipline || "",
      amt: inserted.amount || 0,
      kind: entryKind,
    };
    const append = (rows) => rows.map(r => {
      if (r.id !== projectId) return r;
      // For a prime entry we also update prime_company_id on the project
      // (the DB UPDATE was already done by the modal). This keeps the
      // role/derivation logic consistent across the UI.
      // Guard against duplicating an existing sub on the project's subs array
      // (e.g. re-adding a company that's already there).
      const subsArr = r.subs || [];
      const dup = subsArr.some(s =>
        (s.cId ?? s.company_id) === companyId && (s.kind || "sub") === entryKind);
      const updated = dup ? { ...r } : { ...r, subs: [...subsArr, newUiSub] };
      if (entryKind === "prime") updated.prime_company_id = companyId;
      return updated;
    });
    if (potential.some(p => p.id === projectId)) setPotential(append);
    else if (awaiting.some(p => p.id === projectId)) setAwaiting(append);
    else if (awarded.some(p => p.id === projectId)) setAwarded(append);
    else if (closed.some(p => p.id === projectId))  setClosed(append);

    // Append a fresh sub_entry to the matrix for this project, so the new
    // row appears beneath the prime row in the Invoice tab.
    const company = [...companies, ...clients].find(c => c.id === companyId);
    setSubInvoices(prev => {
      const next = new Map(prev);
      const existing = next.get(projectId) || [];
      // Don't append a second matrix entry for a company that's already there
      // — the existing row already carries its billing data.
      if (existing.some(e => e.companyId === companyId && (e.kind || "sub") === entryKind)) {
        return prev;
      }
      next.set(projectId, [...existing, {
        kind: entryKind,
        companyId,
        companyName: company?.name || "Unknown company",
        contractAmount: inserted.amount || 0,
        discipline: inserted.discipline || "",
        amounts: Array(12).fill(null),
        files:   Array(12).fill(null).map(() => []),
        subInvoiceIds: Array(12).fill(null),
        paid:    Array(12).fill(false),
        paidAt:  Array(12).fill(null),
      }]);
      return next;
    });
    setAddSubModal(null);
    const noun = entryKind === "prime" ? "Prime" : "Sub";
    // The company was already on the project — nothing new was created.
    if (existed) {
      showToast(`${company?.name || noun} is already a ${noun.toLowerCase()} on this project`, "flag");
      return;
    }
    if (autoLinkedProject?.matchType === "matched") {
      showToast(`${noun} added · linked to ${autoLinkedProject.projectName}`);
    } else if (autoLinkedProject?.matchType === "created") {
      showToast(`${noun} added · created project ${autoLinkedProject.projectName}`);
    } else {
      showToast(`${noun} added`);
    }
  };

  const openDrawer = (row, table) => setDrawer({ row, table });
  const triggerForward = (row, fromTable, toTable) => setMoving({ row, from: fromTable, to: toTable });

  // When a deep-link pending row id is set, look it up in the current tab's
  // rows and open the drawer once found. Re-runs when rows update (covers the
  // slim chance that the row isn't in state yet at mount).
  useEffect(() => {
    if (!pendingFocusRowId) return;
    const rowsByTab = {
      potential, awaiting, awarded, closed,
      invoice, between: invoice, events, hotleads: hotLeads,
      directory: [...clients, ...companies],
    };
    const rows = rowsByTab[tab] || [];
    const match = rows.find(r => r.id === pendingFocusRowId);
    if (match) {
      // Invoice rows live behind two sub-tabs now — land on the one the
      // project is actually visible on (old alert deep links say ?tab=invoice
      // even for a project that has since been paused).
      if ((tab === "invoice" || tab === "between")) {
        const wantTab = match.billingState === "between" ? "between" : "invoice";
        if (wantTab !== tab) setTab(wantTab);
        openDrawer(match, "invoice");
      } else {
        openDrawer(match, tab);
      }
      setPendingFocusRowId(null);
    }
  }, [pendingFocusRowId, tab, potential, awaiting, awarded, closed, invoice, events, hotLeads, clients, companies]);

  // Snapshot all pipeline slices so an Undo toast can restore them in one
  // shot if the user clicks Undo within ~10s of a move. Doesn't capture
  // DB-side state — branches that persist also pass an async DB reverser to
  // undoLastMove below.
  const buildPipelineSnapshot = () => ({
    potential, awaiting, awarded, closed, invoice, hotLeads,
  });
  const restorePipelineSnapshot = (snap) => {
    setPotential(snap.potential);
    setAwaiting(snap.awaiting);
    setAwarded(snap.awarded);
    setClosed(snap.closed);
    setInvoice(snap.invoice);
    if (snap.hotLeads) setHotLeads(snap.hotLeads);
  };

  // Wraps a "show toast with Undo" call. `dbReverse` is optional; when
  // present, clicking Undo runs it after restoring local state. Errors
  // surface as a follow-up toast — the local restore already happened so
  // the user sees the previous view immediately.
  const offerUndo = (msg, snapshot, dbReverse) => {
    showToast(msg, "check", {
      action: {
        label: "Undo",
        icon: "undo",
        onClick: async () => {
          restorePipelineSnapshot(snapshot);
          if (dbReverse) {
            try {
              await dbReverse();
              showToast("Move undone");
            } catch (e) {
              showToast(`Undo failed: ${e?.message || e}`, "x");
            }
          } else {
            showToast("Move undone");
          }
        },
      },
    });
  };

  // ----------------------------------------------------------------------
  // Invoice billing-state transitions (2026-06 IA): a project's invoice rows
  // carry billing_state ∈ active | between | closed. Pause/resume flip the
  // state on EVERY row in the merged group (groupIds — all years + dupes);
  // close-out keeps the rows (state='closed') instead of deleting them.
  // ----------------------------------------------------------------------
  const setInvoiceBillingState = async (row, state, successMsg, successIcon = "check") => {
    const ids = invoiceGroupIdsFor(row);
    const prevState = row.billingState || "active";
    setInvoice(rs => rs.map(r => ids.includes(r.id) ? { ...r, billingState: state } : r));
    const { error } = await supabase
      .from("anticipated_invoice")
      .update({ billing_state: state })
      .in("id", ids);
    if (error) {
      setInvoice(rs => rs.map(r => ids.includes(r.id) ? { ...r, billingState: prevState } : r));
      showToast(`Move failed: ${error.message} — apply migration 20260611120000 if billing_state is missing.`, "x");
      return false;
    }
    if (successMsg) showToast(successMsg, successIcon);
    return true;
  };
  const pauseInvoiceProject = (r) =>
    setInvoiceBillingState(r, "between", `${r.name || "Project"} → In-Between · resume any time`, "pause");
  const resumeInvoiceProject = (r) =>
    setInvoiceBillingState(r, "active", `${r.name || "Project"} resumed → Invoices`, "play");

  // Every invoice row belonging to a project — by lineage (sourceId) or by
  // matching project number — scoped to one invoice type (ENG/PM groups are
  // separate projects in the Invoice table).
  const findInvoiceGroupForProject = (projectRow, invType) =>
    invoice.filter(r =>
      (r.sourceId === projectRow.id ||
        (projectRow.projectNumber &&
         normInvoiceNumber(r.projectNumber) === normInvoiceNumber(projectRow.projectNumber)))
      && (r.type || "ENG") === (invType || "ENG"));

  // ----------------------------------------------------------------------
  // Awarded ↔ Invoice links (project_invoice_links). Optimistic local update
  // on the awarded slice + best-effort persist; 23505 reads as "already".
  // ----------------------------------------------------------------------
  const addInvoiceLink = async (row, number) => {
    const num = String(number || "").trim();
    if (!num) return;
    if ((row.invoiceLinks || []).some(n => normInvoiceNumber(n) === normInvoiceNumber(num))) {
      showToast(`${num} is already linked`, "check");
      return;
    }
    setAwarded(rs => rs.map(r => r.id === row.id
      ? { ...r, invoiceLinks: [...(r.invoiceLinks || []), num] } : r));
    try {
      await addProjectInvoiceLink(row.id, num);
      showToast(`Linked invoice project ${num}`, "link");
    } catch (e) {
      setAwarded(rs => rs.map(r => r.id === row.id
        ? { ...r, invoiceLinks: (r.invoiceLinks || []).filter(n => n !== num) } : r));
      showToast(`Link failed: ${e.message || e} — apply migration 20260611120100 if the links table is missing.`, "x");
    }
  };
  const removeInvoiceLink = async (row, number) => {
    const prev = row.invoiceLinks || [];
    setAwarded(rs => rs.map(r => r.id === row.id
      ? { ...r, invoiceLinks: prev.filter(n => n !== number) } : r));
    try {
      await removeProjectInvoiceLink(row.id, number);
      showToast(`Unlinked ${number}`);
    } catch (e) {
      setAwarded(rs => rs.map(r => r.id === row.id ? { ...r, invoiceLinks: prev } : r));
      showToast(`Unlink failed: ${e.message || e}`, "x");
    }
  };
  // Jump from an awarded row's project card to the invoice project itself —
  // landing on whichever sub-tab the project currently lives on.
  const openInvoiceProject = (inv) => {
    const state = inv.billingState || "active";
    if (state === "closed") {
      const proj = inv.sourceId ? closed.find(p => p.id === inv.sourceId) : null;
      setTab("closed");
      if (proj) setDrawer({ row: proj, table: "closed" });
      else showToast("This project is closed out — its billing rows are archived.", "check");
      return;
    }
    setDrawer(null);
    setTab(state === "between" ? "between" : "invoice");
    setFlashId(inv.id);
    setTimeout(() => setFlashId(null), 1600);
  };

  // Pipeline transitions. Flow (2026-06 IA):
  //   Proposals (awaiting) → Awarded (MOVE: row leaves Proposals, appears in Awarded)
  //   Proposals (awaiting) → Closed Out (MOVE)
  //   Awarded → Potential (COPY: Awarded stays as historical log; Potential
  //                        gets a new row representing it as a billing candidate)
  //   Awarded → Invoice  (COPY: Awarded stays; the project's invoice rows are
  //                        REVIVED if they exist (billing_state → active),
  //                        else a new anticipated_invoice row is inserted —
  //                        and the awarded row auto-links to the number)
  //   Potential → Invoice (COPY: Potential stays as a pipeline tracker;
  //                        new Invoice row spawned)
  //   Invoice / In-Between → Closed (PERSIST: project status flips to
  //                        closed_out; invoice rows KEEP their data with
  //                        billing_state='closed' — nothing is deleted)
  //   Invoice ⇄ In-Between (billing_state flip via pause/resume above)
  //   Closed → Awaiting / Awarded / Invoice (PERSIST: reopens a closed-out
  //                        project; flips status back; closed→invoice revives
  //                        the archived invoice rows when they exist)
  // Orange-probability Potentials still auto-spawn an Invoice row at create
  // time (special-case shortcut — see handleCreated() below).
  const confirmMove = (newData) => {
    const { row, from, to } = moving;
    const newRow = { ...row, ...newData, id: mkId(), sourceId: row.id };

    const snap = buildPipelineSnapshot();

    if (from === "awaiting" && to === "awarded") {
      // MOVE: Awaiting row leaves; Awarded row lands. No auto-Invoice — user
      // explicitly moves from Awarded → Invoice when ready to bill.
      setAwarded(rs => [newRow, ...rs]);
      setAwaiting(rs => rs.filter(r => r.id !== row.id));
      setFlashId(newRow.id);
      offerUndo("Awarded · carried to Awarded Projects", snap, null);
      setTab("awarded");
    } else if (from === "awaiting" && to === "closed") {
      setClosed(rs => [newRow, ...rs]);
      setAwaiting(rs => rs.filter(r => r.id !== row.id));
      setFlashId(newRow.id);
      offerUndo("Closed out · carried to Closed Out Projects", snap, null);
      setTab("closed");
    } else if (from === "awarded" && to === "potential") {
      // COPY: Potential row gets its own id; sourceId points back to Awarded.
      setPotential(rs => [newRow, ...rs]);
      setFlashId(newRow.id);
      offerUndo("Tracked as Potential billing candidate", snap, null);
      setTab("potential");
    } else if (from === "awarded" && to === "invoice") {
      // COPY: Awarded stays. If the project already has invoice rows (e.g.
      // it was paused or closed out earlier), REVIVE them — flipping
      // billing_state back to 'active' — instead of inserting a duplicate
      // (which would also trip the (source_project_id, year) unique index).
      // Otherwise insert + persist a fresh anticipated_invoice row. Either
      // way, auto-link the awarded row to the invoice project number.
      const { _invoiceType, ...rest } = newRow;
      const invType = _invoiceType || "ENG";
      const existingGroup = findInvoiceGroupForProject(row, invType);
      const autoLink = (num) => {
        const n = String(num || "").trim();
        if (!n) return;
        if ((row.invoiceLinks || []).some(x => normInvoiceNumber(x) === normInvoiceNumber(n))) return;
        setAwarded(rs => rs.map(r => r.id === row.id
          ? { ...r, invoiceLinks: [...(r.invoiceLinks || []), n] } : r));
        addProjectInvoiceLink(row.id, n).catch(() => { /* links table optional */ });
      };

      if (existingGroup.length > 0) {
        const anyActive = existingGroup.some(r => (r.billingState || "active") === "active");
        const target = existingGroup[0];
        if (anyActive) {
          showToast("Already in the Invoice table — jumping to it.", "check");
        }
        autoLink(target.projectNumber || rest.projectNumber);
        if (!anyActive) {
          const prevState = target.billingState || "closed";
          const ids = existingGroup.map(r => r.id);
          setInvoice(rs => rs.map(r => ids.includes(r.id) ? { ...r, billingState: "active" } : r));
          (async () => {
            const { error } = await supabase
              .from("anticipated_invoice")
              .update({ billing_state: "active" })
              .in("id", ids);
            if (error) {
              restorePipelineSnapshot(snap);
              showToast(`Move failed: ${error.message}`, "x");
              return;
            }
            offerUndo("Invoice rows revived from Awarded project", snap, async () => {
              const { error: revErr } = await supabase
                .from("anticipated_invoice")
                .update({ billing_state: prevState })
                .in("id", ids);
              if (revErr) throw revErr;
            });
          })();
        }
        setFlashId(target.id);
        setTab("invoice");
      } else {
        const invRow = {
          id: rest.id, sourceId: row.id,
          projectNumber: rest.projectNumber, name: rest.name,
          pmIds: [...(rest.pmIds || [])], amount: rest.amount || 0,
          msmmAmount: null,                       // auto-calc by default
          msmmValues: Array(12).fill(null),       // auto-calc per month
          type: invType,
          remainingStart: rest.msmmRemaining || 0,
          values: Array(12).fill(0),
          year: rest.year,                        // keep shape consistent w/ other paths
          ytdActualOverride: null,
          rollforwardOverride: null,
          billingState: "active",
          primeFiles: Array.from({ length: 12 }, () => []),
          partyFiles: { msmm: [], prime: {}, sub: {} },
          notesLog: [],
        };
        const prevInvoice = invoice;
        setInvoice(rs => [invRow, ...rs]);
        setFlashId(invRow.id);
        setTab("invoice");
        (async () => {
          try {
            const { data: invData, error: invErr } = await supabase
              .from("anticipated_invoice").insert({
                source_project_id: row.id,
                project_name: rest.name,
                project_number: rest.projectNumber || null,
                year: rest.year ?? THIS_YEAR,
                contract_amount: rest.amount ?? null,
                // MSMM portion stays NULL → auto-calc in the expand row.
                type: invType,
                msmm_remaining_to_bill_year_start: rest.msmmRemaining ?? null,
              }).select().single();
            if (invErr) throw invErr;
            if ((rest.pmIds || []).length > 0) {
              const { error: pmErr } = await supabase
                .from("anticipated_invoice_pms")
                .insert(rest.pmIds.map(uid => ({
                  anticipated_invoice_id: invData.id, user_id: uid,
                })));
              if (pmErr) throw pmErr;
            }
            // Replace the temp local id with the DB id so future edits hit it.
            setInvoice(rs => rs.map(r => r.id === invRow.id ? { ...r, id: invData.id } : r));
            autoLink(rest.projectNumber);
            offerUndo("Invoice row created from Awarded project", snap, async () => {
              const { error: delErr } = await supabase
                .from("anticipated_invoice").delete().eq("id", invData.id);
              if (delErr) throw delErr;
            });
          } catch (e) {
            setInvoice(prevInvoice);
            showToast(`Move failed: ${e.message || e}`, "x");
          }
        })();
      }
    } else if (from === "potential" && to === "invoice") {
      // MOVE: Potential row leaves; Invoice row lands. The invoice row
      // persists to anticipated_invoice with source_project_id pointing back
      // at the potential row, then the potential row is deleted from
      // beacon_v2.projects (project_pms cascades). Optimistic local state
      // first; rolled back on error.
      const { _invoiceType, ...rest } = newRow;
      const invRow = {
        id: rest.id, sourceId: row.id,
        projectNumber: rest.projectNumber, name: rest.name,
        pmIds: [...(rest.pmIds || [])], amount: rest.amount || 0,
        type: _invoiceType || "ENG",
        remainingStart: rest.msmm || 0,
        values: Array(12).fill(0),
        year: rest.year,
        ytdActualOverride: null,
        rollforwardOverride: null,
      };
      const prevPotential = potential;
      const prevInvoice = invoice;
      setInvoice(rs => [invRow, ...rs]);
      setPotential(rs => rs.filter(r => r.id !== row.id));
      setFlashId(invRow.id);
      setTab("invoice");
      (async () => {
        try {
          const { data: invData, error: invErr } = await supabase
            .from("anticipated_invoice").insert({
              source_project_id: row.id,
              project_name: rest.name,
              project_number: rest.projectNumber || null,
              year: rest.year,
              contract_amount: rest.amount ?? null,
              // MSMM portion stays NULL → auto-calc in the expand row.
              type: _invoiceType || "ENG",
              msmm_remaining_to_bill_year_start: rest.msmm ?? null,
            }).select().single();
          if (invErr) throw invErr;
          // Sync PMs onto the new anticipated_invoice row.
          if ((rest.pmIds || []).length > 0) {
            const { error: pmErr } = await supabase
              .from("anticipated_invoice_pms")
              .insert(rest.pmIds.map(uid => ({
                anticipated_invoice_id: invData.id, user_id: uid,
              })));
            if (pmErr) throw pmErr;
          }
          // Replace the temp local id with the DB id so future edits hit it.
          setInvoice(rs => rs.map(r => r.id === invRow.id
            ? { ...r, id: invData.id }
            : r));
          // Delete the potential row from the projects table.
          const { error: delErr } = await supabase
            .from("projects").delete().eq("id", row.id);
          if (delErr) throw delErr;
          // Undo for this branch needs to: re-insert the potential project +
          // its PMs, and delete the freshly-created anticipated_invoice + PMs.
          offerUndo(
            "Invoice row created · Potential moved",
            snap,
            async () => {
              // 1. Reinsert the potential project (using its original id so
              //    sourceId references stay intact).
              const dbPatch = {
                id: row.id,
                status: "potential",
                year: row.year ?? null,
                project_name: row.name,
                project_number: row.projectNumber || null,
                role: row.role || null,
                total_contract_amount: row.amount ?? null,
                msmm_amount: row.msmm ?? null,
                probability: row.probability || null,
                next_action_date: row.nextActionDate || null,
                next_action_note: row.dates || null,
                client_id: row.clientId || null,
                notes: row.notes || null,
              };
              const { error: rErr } = await supabase.from("projects").insert(dbPatch);
              if (rErr) throw rErr;
              if ((row.pmIds || []).length > 0) {
                const { error: pmErr } = await supabase.from("project_pms")
                  .insert(row.pmIds.map(uid => ({ project_id: row.id, user_id: uid })));
                if (pmErr) throw pmErr;
              }
              // 2. Delete the anticipated_invoice row (and PMs cascade).
              const { error: delInvErr } = await supabase
                .from("anticipated_invoice").delete().eq("id", invData.id);
              if (delInvErr) throw delInvErr;
            }
          );
        } catch (e) {
          setPotential(prevPotential);
          setInvoice(prevInvoice);
          showToast(`Move failed: ${e.message || e}`, "x");
        }
      })();
    } else if (from === "invoice" && to === "closed") {
      // Close-out KEEPS the billing history: every anticipated_invoice row in
      // the project's merged group flips billing_state='closed' (months,
      // attachments, subs, and notes all survive — they're just hidden from
      // the Invoices / In-Between tabs). The upstream project (if any) flips
      // status='closed_out' with date_closed and reason_for_closure set;
      // stage-specific fields disallowed on closed_out are nulled to satisfy
      // the projects_*_only_on_* check constraints. If the invoice has no
      // upstream project, a fresh closed_out row is minted. Local state
      // mirrors the DB. Reached from BOTH the Invoices and In-Between tabs.
      const sourceId = row.sourceId;
      const sourceRow = sourceId
        ? (awarded.find(r => r.id === sourceId)
           || potential.find(r => r.id === sourceId)
           || awaiting.find(r => r.id === sourceId)
           || closed.find(r => r.id === sourceId))
        : null;
      const groupIds = invoiceGroupIdsFor(row);
      const prevBillingState = row.billingState || "active";
      const prevInvoice = invoice;
      const prevPotential = potential;
      const prevAwaiting = awaiting;
      const prevAwarded = awarded;
      const prevClosed = closed;
      // Optimistic: archive the invoice rows + drop the source from any
      // upstream slice; landed-closed entry is added below once we know its id.
      setInvoice(rs => rs.map(r => groupIds.includes(r.id) ? { ...r, billingState: "closed" } : r));
      if (sourceId) {
        setPotential(rs => rs.filter(r => r.id !== sourceId));
        setAwaiting(rs => rs.filter(r => r.id !== sourceId));
        setAwarded(rs => rs.filter(r => r.id !== sourceId));
      }
      setTab("closed");
      (async () => {
        try {
          let closedId = sourceId;
          if (sourceId) {
            const { error } = await supabase.from("projects").update({
              status: "closed_out",
              date_closed: newData.dateClosed || null,
              reason_for_closure: newData.reason || null,
              role: null, total_contract_amount: null, msmm_amount: null,
              probability: null, next_action_date: null, next_action_note: null,
              anticipated_invoice_start_month: null,
              anticipated_result_date: null,
              stage_id: null, details: null, pool: null, contract_expiry_date: null,
            }).eq("id", sourceId);
            if (error) throw error;
          } else {
            const { data, error } = await supabase.from("projects").insert({
              status: "closed_out",
              year: row.year,
              project_name: row.name,
              project_number: row.projectNumber || null,
              date_closed: newData.dateClosed || null,
              reason_for_closure: newData.reason || null,
            }).select().single();
            if (error) throw error;
            closedId = data.id;
            if ((row.pmIds || []).length > 0) {
              const { error: pmErr } = await supabase.from("project_pms")
                .insert(row.pmIds.map(uid => ({
                  project_id: closedId, user_id: uid,
                })));
              if (pmErr) throw pmErr;
            }
          }
          const { error: invErr } = await supabase
            .from("anticipated_invoice")
            .update({ billing_state: "closed" })
            .in("id", groupIds);
          if (invErr) throw invErr;
          const closedRow = {
            id: closedId,
            year: sourceRow?.year ?? row.year,
            name: sourceRow?.name ?? row.name,
            role: sourceRow?.role ?? "Prime",
            clientId: sourceRow?.clientId ?? null,
            amount: null,
            msmm: 0,
            subs: sourceRow?.subs ?? [],
            pmIds: [...(sourceRow?.pmIds || row.pmIds || [])],
            notes: sourceRow?.notes ?? "",
            dates: "",
            projectNumber: sourceRow?.projectNumber ?? row.projectNumber ?? "",
            status: "Closed Out",
            dateSubmitted: sourceRow?.dateSubmitted ?? "",
            clientContract: sourceRow?.clientContract ?? "",
            msmmContract: sourceRow?.msmmContract ?? "",
            dateClosed: newData.dateClosed || "",
            reason: newData.reason || "",
          };
          setClosed(rs => {
            const filtered = rs.filter(r => r.id !== closedId);
            return [closedRow, ...filtered];
          });
          setFlashId(closedId);
          // Undo: restore the previous project status + flip the invoice
          // rows' billing_state back to what it was (active or between). We
          // capture the source row's status (was 'awarded'/'potential'/
          // 'awaiting') so we can flip back to exactly what it was. If the
          // invoice had no upstream project (closedId was minted), undoing
          // deletes the freshly-created closed_out project entirely.
          const wasMintedClosed = !sourceId;
          const restoreStatus =
            sourceRow ? (
              prevAwarded.find(r => r.id === sourceId)   ? "awarded"   :
              prevPotential.find(r => r.id === sourceId) ? "potential" :
              prevAwaiting.find(r => r.id === sourceId)  ? "awaiting"  :
              "awarded"
            ) : null;
          offerUndo(
            "Closed out · moved from Invoice",
            snap,
            async () => {
              if (wasMintedClosed) {
                // Drop the brand-new closed_out project + its PMs.
                const { error } = await supabase
                  .from("projects").delete().eq("id", closedId);
                if (error) throw error;
              } else {
                // Flip the project's status back; restore stage-specific
                // fields from the snapshot row.
                const sr = sourceRow;
                const { error } = await supabase.from("projects").update({
                  status: restoreStatus,
                  date_closed: null,
                  reason_for_closure: null,
                  role: sr?.role || null,
                  total_contract_amount: sr?.amount ?? null,
                  msmm_amount: sr?.msmm ?? null,
                  probability: sr?.probability || null,
                  next_action_date: sr?.nextActionDate || null,
                  next_action_note: sr?.dates || null,
                  anticipated_result_date: sr?.anticipatedResultDate || null,
                  details: sr?.details || null,
                  pool: sr?.pools || null,
                  contract_expiry_date: sr?.contractExpiry || null,
                }).eq("id", sourceId);
                if (error) throw error;
              }
              // Un-archive the invoice rows — the data never left.
              const { error: invErr2 } = await supabase
                .from("anticipated_invoice")
                .update({ billing_state: prevBillingState })
                .in("id", groupIds);
              if (invErr2) throw invErr2;
            }
          );
        } catch (e) {
          setInvoice(prevInvoice);
          setPotential(prevPotential);
          setAwaiting(prevAwaiting);
          setAwarded(prevAwarded);
          setClosed(prevClosed);
          showToast(`Close out failed: ${e.message || e}`, "x");
        }
      })();
    } else if (from === "closed" && (to === "awaiting" || to === "awarded")) {
      // Reopen a Closed Out project. Same DB row — only `status` flips and
      // stage-specific fields get re-applied. The locally-known carried
      // fields (clientId, role, msmm, etc.) carry forward in local state for
      // the user; on the DB side those fields are still NULL from close-out
      // and the user can edit them in the destination tab as needed.
      const dbStatus = to === "awaiting" ? "awaiting" : "awarded";
      const reopenedRow = {
        ...row,
        ...newData,
        id: row.id,                              // same DB id
        status: to === "awaiting" ? "Proposal" : "Awarded",
        dateClosed: "",
        reason: "",
      };
      setClosed(rs => rs.filter(r => r.id !== row.id));
      if (to === "awaiting") setAwaiting(rs => [reopenedRow, ...rs]);
      else                   setAwarded (rs => [reopenedRow, ...rs]);
      setFlashId(row.id);
      setTab(to);
      (async () => {
        try {
          const dbPatch = {
            status: dbStatus,
            date_closed: null,
            reason_for_closure: null,
          };
          if (to === "awaiting") {
            dbPatch.anticipated_result_date = newData.anticipatedResultDate || null;
            dbPatch.notes = newData.notes || null;
          } else {
            dbPatch.details = newData.details || null;
            dbPatch.pool = newData.pools || null;
            dbPatch.contract_expiry_date = newData.contractExpiry || null;
            // stage_id requires a name→id lookup against beacon.awarded_stages.
            // Skipped for now — local state shows the picked stage label;
            // user can edit via the Awarded drawer afterwards.
          }
          const { error } = await supabase
            .from("projects").update(dbPatch).eq("id", row.id);
          if (error) throw error;
          offerUndo(
            to === "awaiting"
              ? "Reopened to Proposals"
              : "Reopened to Awarded",
            snap,
            async () => {
              // Reverse: flip status back to closed_out and restore
              // close-out fields from the original closed row.
              const { error: revErr } = await supabase.from("projects").update({
                status: "closed_out",
                date_closed: row.dateClosed || null,
                reason_for_closure: row.reason || null,
                anticipated_result_date: null,
                details: null, pool: null, contract_expiry_date: null,
                notes: row.notes || null,
              }).eq("id", row.id);
              if (revErr) throw revErr;
            }
          );
        } catch (e) {
          restorePipelineSnapshot(snap);
          showToast(`Reopen failed: ${e.message || e}`, "x");
        }
      })();
    } else if (from === "closed" && to === "invoice") {
      // Reopen as Active: project status flips back to 'awarded'. If the
      // project's invoice rows still exist (close-out keeps them archived
      // with billing_state='closed'), REVIVE them — every month amount,
      // attachment, and note returns exactly as it was. Only when no rows
      // exist (e.g. closed before the billing_state era and the rows were
      // deleted) is a fresh anticipated_invoice row spawned. The project
      // re-appears in the Awarded tab too (consistent with how awarded →
      // invoice keeps the source visible).
      const invType  = newData._invoiceType || "ENG";
      const invAmt   = Number(newData._amount) || null;
      const invRem   = Number(newData._remaining) || null;
      const reopenedAwarded = {
        ...row,
        id: row.id,
        status: "Awarded",
        dateClosed: "",
        reason: "",
        stage: "Multi-Use Contract",
      };
      const existingGroup = findInvoiceGroupForProject(row, invType);
      if (existingGroup.length > 0) {
        // ---- Revive path: un-archive the project's invoice rows. ----
        const ids = existingGroup.map(r => r.id);
        setClosed(rs => rs.filter(r => r.id !== row.id));
        setAwarded(rs => [reopenedAwarded, ...rs]);
        setInvoice(rs => rs.map(r => ids.includes(r.id) ? { ...r, billingState: "active" } : r));
        setFlashId(existingGroup[0].id);
        setTab("invoice");
        (async () => {
          try {
            const { error: upErr } = await supabase.from("projects").update({
              status: "awarded",
              date_closed: null,
              reason_for_closure: null,
            }).eq("id", row.id);
            if (upErr) throw upErr;
            const { error: invErr } = await supabase
              .from("anticipated_invoice")
              .update({ billing_state: "active" })
              .in("id", ids);
            if (invErr) throw invErr;
            offerUndo(
              "Reopened as Active · billing history revived",
              snap,
              async () => {
                const { error: revInvErr } = await supabase
                  .from("anticipated_invoice")
                  .update({ billing_state: "closed" })
                  .in("id", ids);
                if (revInvErr) throw revInvErr;
                const { error: revErr } = await supabase.from("projects").update({
                  status: "closed_out",
                  date_closed: row.dateClosed || null,
                  reason_for_closure: row.reason || null,
                }).eq("id", row.id);
                if (revErr) throw revErr;
              }
            );
          } catch (e) {
            restorePipelineSnapshot(snap);
            showToast(`Reopen failed: ${e.message || e}`, "x");
          }
        })();
        setMoving(null);
        setTimeout(() => setFlashId(null), 1500);
        return;
      }
      // ---- Spawn path: no archived rows — mint a fresh invoice row. ----
      // Local invoice row uses a temp id; replaced once we have the DB id.
      const tempInvId = mkId();
      const invRow = {
        id: tempInvId,
        sourceId: row.id,
        projectNumber: row.projectNumber || "",
        name: row.name,
        pmIds: [...(row.pmIds || [])],
        amount: invAmt || 0,
        msmmAmount: null,                       // auto-calc by default
        msmmValues: Array(12).fill(null),       // auto-calc per month
        type: invType,
        remainingStart: invRem || 0,
        values: Array(12).fill(0),
        year: row.year,
        ytdActualOverride: null,
        rollforwardOverride: null,
        billingState: "active",
        primeFiles: Array.from({ length: 12 }, () => []),
        partyFiles: { msmm: [], prime: {}, sub: {} },
        notesLog: [],
      };
      setClosed(rs => rs.filter(r => r.id !== row.id));
      setAwarded(rs => [reopenedAwarded, ...rs]);
      setInvoice(rs => [invRow, ...rs]);
      setFlashId(tempInvId);
      setTab("invoice");
      (async () => {
        try {
          // 1. Flip the project status back to 'awarded' and clear close-out fields.
          const { error: upErr } = await supabase.from("projects").update({
            status: "awarded",
            date_closed: null,
            reason_for_closure: null,
          }).eq("id", row.id);
          if (upErr) throw upErr;
          // 2. Spawn the anticipated_invoice row.
          const { data: invData, error: invErr } = await supabase
            .from("anticipated_invoice").insert({
              source_project_id: row.id,
              project_name: row.name,
              project_number: row.projectNumber || null,
              year: row.year ?? null,
              contract_amount: invAmt,
              // MSMM portion stays NULL → auto-calc.
              type: invType,
              msmm_remaining_to_bill_year_start: invRem,
            }).select().single();
          if (invErr) throw invErr;
          // 3. Re-tag PMs onto the new invoice row.
          if ((row.pmIds || []).length > 0) {
            const { error: pmErr } = await supabase
              .from("anticipated_invoice_pms")
              .insert(row.pmIds.map(uid => ({
                anticipated_invoice_id: invData.id, user_id: uid,
              })));
            if (pmErr) throw pmErr;
          }
          // Replace the temp local id with the real one.
          setInvoice(rs => rs.map(r => r.id === tempInvId
            ? { ...r, id: invData.id }
            : r));
          offerUndo(
            "Reopened as Active · Invoice row spawned",
            snap,
            async () => {
              // Reverse: drop the invoice row + flip status back to closed_out.
              const { error: delErr } = await supabase
                .from("anticipated_invoice").delete().eq("id", invData.id);
              if (delErr) throw delErr;
              const { error: revErr } = await supabase.from("projects").update({
                status: "closed_out",
                date_closed: row.dateClosed || null,
                reason_for_closure: row.reason || null,
              }).eq("id", row.id);
              if (revErr) throw revErr;
            }
          );
        } catch (e) {
          restorePipelineSnapshot(snap);
          showToast(`Reopen failed: ${e.message || e}`, "x");
        }
      })();
    } else if (from === "openbids" && to === "awaiting") {
      // Open Bid → Proposals (awaiting): MOVE-like semantics but the open_bids
      // row is preserved as the historical breadcrumb (moved_to_project_id
      // links forward). DB trigger gates approval changes; the UI also
      // disables Move Forward when approval_status !== 'approved', so by
      // the time we get here the bid is already approved.
      if (row.approvalStatus !== "approved") {
        showToast("Bid must be approved before moving forward.", "lock");
        setMoving(null);
        return;
      }
      const bidNoteLine =
        `RFQ #${row.rfqNumber || "—"}` +
        (row.serviceDescription ? ` · ${row.serviceDescription}` : "") +
        (row.dueAt ? ` · due ${fmtDate(row.dueAt)}` : "");
      const userNotes = (newData.notes || "").trim();
      const combinedNotes = userNotes ? `${bidNoteLine}\n${userNotes}` : bidNoteLine;

      const tempProjectId = mkId();
      const awaitingRow = {
        id: tempProjectId,
        year: Number(newData.year) || THIS_YEAR,
        name: newData.projectName || "",
        role: "Prime",
        clientId: row.clientId || null,
        amount: null,
        msmm: Number(newData.msmmRemaining) || 0,
        subs: [],
        pmIds: [],
        notes: combinedNotes,
        dates: "",
        projectNumber: newData.projectNumber || "",
        status: "Proposal",
        dateSubmitted: newData.dateSubmitted || new Date().toISOString().substr(0, 10),
        anticipatedResultDate: newData.anticipatedResultDate || "",
        clientContract: newData.clientContract || "",
        msmmContract: newData.msmmContract || "",
        msmmUsed: Number(newData.msmmUsed) || 0,
        msmmRemaining: Number(newData.msmmRemaining) || 0,
        sourceId: row.id,
      };
      const prevOpenBids = openBids;
      const prevAwaiting = awaiting;
      setAwaiting(rs => [awaitingRow, ...rs]);
      setOpenBids(rs => rs.map(r => r.id === row.id
        ? { ...r, movedToProjectId: tempProjectId }
        : r));
      setFlashId(tempProjectId);
      setTab("awaiting");
      (async () => {
        try {
          const insertPayload = {
            status: "awaiting",
            project_name: awaitingRow.name,
            year: awaitingRow.year,
            client_id: awaitingRow.clientId,
            date_submitted: awaitingRow.dateSubmitted || null,
            anticipated_result_date: awaitingRow.anticipatedResultDate || null,
            client_contract_number: awaitingRow.clientContract || null,
            msmm_contract_number: awaitingRow.msmmContract || null,
            msmm_used: awaitingRow.msmmUsed || null,
            msmm_remaining: awaitingRow.msmmRemaining || null,
            project_number: awaitingRow.projectNumber || null,
            notes: combinedNotes || null,
          };
          const { data: projData, error: projErr } = await supabase
            .from("projects").insert(insertPayload).select().single();
          if (projErr) throw projErr;
          // Forward-link the open_bids row to the new project so the
          // breadcrumb survives a reload.
          await markOpenBidMovedForward(row.id, projData.id);
          // Replace the temp local id with the real one across both slices.
          setAwaiting(rs => rs.map(r => r.id === tempProjectId
            ? { ...r, id: projData.id }
            : r));
          setOpenBids(rs => rs.map(r => r.id === row.id
            ? { ...r, movedToProjectId: projData.id }
            : r));
          setFlashId(projData.id);
          offerUndo(
            "Moved to Proposals",
            snap,
            async () => {
              // Reverse: drop the new project + clear the forward link.
              const { error: dErr } = await supabase
                .from("projects").delete().eq("id", projData.id);
              if (dErr) throw dErr;
              await markOpenBidMovedForward(row.id, null);
            }
          );
        } catch (e) {
          setAwaiting(prevAwaiting);
          setOpenBids(prevOpenBids);
          showToast(`Move failed: ${e.message || e}`, "x");
        }
      })();
    } else if (from === "hotleads" && to === "awaiting") {
      // Hot Lead → Proposals: MOVE semantics — a new projects row is born
      // (status='awaiting') and the lead row is deleted; its purpose is
      // served once a real proposal exists. The BEFORE DELETE trigger on
      // beacon_v2.leads deactivates any future alert fires. Undo re-inserts
      // the lead (same id) + its attendees and drops the new project.
      const tempProjectId = mkId();
      const awaitingRow = {
        id: tempProjectId,
        year: Number(newData.year) || THIS_YEAR,
        name: newData.projectName || row.title || "",
        role: "Prime",
        clientId: row.clientId || null,
        amount: null,
        msmm: Number(newData.msmmRemaining) || 0,
        subs: [],
        pmIds: [],
        notes: newData.notes || "",
        dates: "",
        projectNumber: newData.projectNumber || "",
        status: "Proposal",
        dateSubmitted: newData.dateSubmitted || new Date().toISOString().substr(0, 10),
        anticipatedResultDate: newData.anticipatedResultDate || "",
        // Anticipated Amount carries into the Proposal's Client Contract field
        // (pre-filled in the MoveForwardPanel as formatted money; editable).
        clientContract: newData.clientContract || "",
        msmmContract: "",
        msmmUsed: 0,
        msmmRemaining: Number(newData.msmmRemaining) || 0,
      };
      const prevHotLeads = hotLeads;
      const prevAwaiting = awaiting;
      setAwaiting(rs => [awaitingRow, ...rs]);
      setHotLeads(rs => rs.filter(r => r.id !== row.id));
      setFlashId(tempProjectId);
      setTab("awaiting");
      (async () => {
        try {
          const insertPayload = {
            status: "awaiting",
            project_name: awaitingRow.name,
            year: awaitingRow.year,
            // Leads store the firm on either client_id or prime_company_id;
            // the router picks the right projects column for the value.
            ...routeClientPick(row.clientId || null),
            date_submitted: awaitingRow.dateSubmitted || null,
            anticipated_result_date: awaitingRow.anticipatedResultDate || null,
            client_contract_number: awaitingRow.clientContract || null,
            msmm_remaining: awaitingRow.msmmRemaining || null,
            project_number: awaitingRow.projectNumber || null,
            notes: awaitingRow.notes || null,
          };
          const { data: projData, error: projErr } = await supabase
            .from("projects").insert(insertPayload).select().single();
          if (projErr) throw projErr;
          const { error: delErr } = await supabase
            .from("leads").delete().eq("id", row.id);
          if (delErr) throw delErr;
          setAwaiting(rs => rs.map(r => r.id === tempProjectId
            ? { ...r, id: projData.id }
            : r));
          setFlashId(projData.id);
          offerUndo(
            "Moved to Proposals · lead removed",
            snap,
            async () => {
              // Reverse: drop the new project, resurrect the lead with its
              // original id (links/alert history line back up) + attendees.
              const { error: dErr } = await supabase
                .from("projects").delete().eq("id", projData.id);
              if (dErr) throw dErr;
              const { error: rErr } = await supabase.from("leads").insert({
                id: row.id,
                title: row.title,
                date_time: row.dateTime || null,
                status: row.status || "Scheduled",
                type: row.type || null,
                stars: row.stars ?? null,
                notes: row.notes || null,
                ...routeClientPick(row.clientId || null),
              });
              if (rErr) throw rErr;
              if ((row.attendees || []).length > 0) {
                const { error: aErr } = await supabase.from("lead_attendees")
                  .insert(row.attendees.map(uid => ({ lead_id: row.id, user_id: uid })));
                if (aErr) throw aErr;
              }
            }
          );
        } catch (e) {
          setAwaiting(prevAwaiting);
          setHotLeads(prevHotLeads);
          showToast(`Move failed: ${e.message || e}`, "x");
        }
      })();
    }
    setMoving(null);
    setTimeout(() => setFlashId(null), 1500);
  };

  // Persist the alert end-to-end: parent alerts row → alert_recipients bulk
  // insert → initial pending alert_fires row. The send-alert Edge Function
  // picks up the pending fire on its next tick and ships the email.
  //
  // UI recurrence values use hyphen ("one-time"); the DB enum uses underscore.
  const RECUR_UI_TO_DB = {
    "one-time": "one_time",
    "weekly":   "weekly",
    "biweekly": "biweekly",
    "monthly":  "monthly",
    "custom":   "custom",
  };
  const confirmAlert = async (data) => {
    if (!alert?.row || !alert?.tab) { setAlertObj(null); return; }
    if (!data.recipients?.length) {
      showToast("Pick at least one recipient before scheduling", "x");
      return;
    }
    const subjectTable = TAB_TO_SUBJECT_TABLE[alert.tab];
    if (!subjectTable) {
      showToast(`Can't schedule alerts from the ${alert.tab} tab`, "x");
      return;
    }
    // date + time are in the user's local tz; new Date(`${date}T${time}`) parses
    // as local, .toISOString() emits UTC. The alert's stored timezone lets the
    // server recompute recurrences with DST-correct wall-clock semantics.
    const firstFireAt = new Date(`${data.date}T${data.time || "09:00"}`).toISOString();
    const recurDb = RECUR_UI_TO_DB[data.recur] || "one_time";

    try {
      const { data: row, error: aErr } = await supabase
        .from("alerts")
        .insert({
          subject_table:         subjectTable,
          subject_row_id:        alert.row.id,
          first_fire_at:         firstFireAt,
          recurrence:            recurDb,
          recurrence_rule:       recurDb === "custom" ? (data.recurrenceRule || null) : null,
          message:               data.message || null,
          anchor_field:          data.anchorField || null,
          anchor_offset_minutes: data.anchorOffsetMinutes ?? null,
          timezone:              data.timezone || "America/Chicago",
          created_by:            currentUser?.id || null,
          is_active:             true,
        })
        .select("id")
        .single();
      if (aErr) throw aErr;

      const recipRows = data.recipients.map(uid => ({ alert_id: row.id, user_id: uid }));
      const { error: rErr } = await supabase.from("alert_recipients").insert(recipRows);
      if (rErr) throw rErr;

      const { error: fErr } = await supabase.from("alert_fires").insert({
        alert_id:     row.id,
        scheduled_at: firstFireAt,
        status:       "pending",
      });
      if (fErr) throw fErr;

      showToast(
        `Alert scheduled · ${data.recipients.length} recipient${data.recipients.length === 1 ? "" : "s"} · first send ${fmtDate(data.date)} ${data.time}`,
        "bell"
      );
      setAlertObj(null);
    } catch (err) {
      const msg = err?.message || "Failed to schedule alert";
      showToast(`Schedule failed: ${msg}`, "x");
    }
  };

  const handleCreated = (table, dbRow, extras = {}) => {
    // Projects (tree items) are created entirely in the modal via the data-layer
    // helpers (text PK + routed client + subs/PMs), so `dbRow` is ALREADY the
    // adapted UI row — just prepend it, no adaptInsertedRow pass.
    if (table === "projects" || extras._projectItem) {
      setProjectItems(rs => [dbRow, ...rs]);
      setFlashId(dbRow.id);
      setTimeout(() => setFlashId(null), 1500);
      showToast("Project created");
      return;
    }
    const uiRow = adaptInsertedRow(table, dbRow, extras);
    if (table === "potential")  setPotential(rs => [uiRow, ...rs]);
    if (table === "awaiting")   setAwaiting(rs => [uiRow, ...rs]);
    if (table === "awarded")    setAwarded(rs => [uiRow, ...rs]);
    if (table === "events")     setEvents(rs => [uiRow, ...rs]);
    if (table === "hotleads")   setHotLeads(rs => [uiRow, ...rs]);
    if (table === "clients")    setClients(rs => [uiRow, ...rs]);
    if (table === "companies")  setCompanies(rs => [uiRow, ...rs]);
    if (table === "invoice")    setInvoice(rs => [uiRow, ...rs]);
    if (table === "openbids")   setOpenBids(rs => [uiRow, ...rs]);
    // Orange potential auto-creates an Anticipated Invoice row tagged with
    // source_potential_id so the Invoice tab picks up the stripe.
    if (table === "potential" && extras.invoiceRow) {
      const ir = extras.invoiceRow;
      const invUiRow = {
        id: ir.id,
        sourceId: ir.source_project_id || uiRow.id,
        projectNumber: ir.project_number || uiRow.projectNumber || "",
        name: ir.project_name || uiRow.name,
        pmIds: [...(uiRow.pmIds || [])],
        // Orange invoice INSERT (forms.jsx) writes contract_amount =
        // potential.total_contract_amount and msmm_amount = potential.msmm_amount.
        // Read both columns explicitly here so the local stub mirrors the DB row.
        amount: ir.contract_amount ?? uiRow.amount ?? 0,
        msmmAmount: ir.msmm_amount ?? uiRow.msmm ?? null,
        type: "ENG",
        remainingStart: ir.msmm_remaining_to_bill_year_start ?? uiRow.msmm ?? 0,
        values: Array(12).fill(0),
      };
      setInvoice(rs => [invUiRow, ...rs]);
    }
    setFlashId(uiRow.id);
    setTimeout(() => setFlashId(null), 1500);
    showToast(`${table[0].toUpperCase() + table.slice(1)} created`);
  };

  const handleExport = async () => {
    const meta = PAGE_META[tab] || {};
    const date = new Date().toISOString().slice(0, 10);
    const filename = `msmm-beacon-${tab}-${date}.pdf`;

    const defs = EXPORT_COLUMNS[tab] || [];
    const defsByLabel = new Map(defs.map(d => [d.label, d]));

    // Prefer the table's live snapshot — it has the exact user-visible state:
    //   column order, hidden columns, search query, sort, and (for Potential)
    //   the currently-displayed filter/year combination. Fall back to the
    //   tab's defined columns + filtered rows if the snapshot isn't ready.
    const snap = getCurrentTableSnapshot();
    let cols, rows;
    if (snap && snap.tab === tab && snap.processedRows) {
      rows = snap.processedRows;
      // TableView tabs publish visibleColumns (honoring reorder + hidden
      // cols); the Invoice tab renders its own table with fixed columns and
      // publishes none, so fall back to the full column defs there.
      cols = snap.visibleColumns
        ? snap.visibleColumns.map(uc => defsByLabel.get(uc.label)).filter(Boolean)
        : defs;
    } else {
      cols = defs;
      rows = currentRows;
    }
    if (cols.length === 0) cols = defs;  // safety net

    const rowColor = tab === "potential"
      ? (r) => {
          // Total rows get a darker shade of the group color; grand total is neutral.
          if (r._total === "All")    return [231, 225, 213];
          if (r._total === "High")   return [190, 210, 170];
          if (r._total === "Medium") return [236, 212, 150];
          if (r._total === "Low")    return [220, 185, 180];
          if (r.probability === "High")   return [221, 232, 207];
          if (r.probability === "Medium") return [246, 228, 180];
          if (r.probability === "Low")    return [236, 205, 203];
          return null;
        }
      : undefined;

    // Invoice export needs per-cell colors that track the Invoice UI's
    // class cascade (actual/projection/total override orange-row tint):
    //   • Actual month cells (Jan…current)  → accent-softer bg (amber)
    //   • Projection month cells (next…Dec) → subtle cream with muted text
    //   • YTD Actual / Rollforward cells    → bg-elev (neutral "total") + bold
    //   • Orange rows, non-month/total cells → prob-orange-bg tint
    // Colors are the exact RGB equivalents of the CSS variables composited
    // over white, so the export reads as a printed snapshot of the UI.
    const INVOICE_PALETTE = {
      ORANGE_TINT:   [249, 234, 220], // --prob-orange-bg over white
      AMBER_ACTUAL:  [248, 236, 214], // --accent-softer
      CREAM_PROJ:    [250, 247, 240], // neutralized stripe (PDF can't do diagonal)
      TOTAL_BG:      [251, 248, 242], // --bg-elev
      ACCENT_INK:    [107,  63,  16], // --accent-ink (amber text on actual cells)
      PROJ_INK:      [110, 102,  89], // --text-muted (dim text on projection)
    };
    const invoiceCellStyle = (tab === "invoice" || tab === "between")
      ? (row, _colIndex, col) => {
          const isOrangeRow = invoiceIsOrange(row, orangeSourceIds);
          const label = col?.label;
          const monthIdx = MONTHS.indexOf(label);
          // A projected month with a bill attached is promoted to Actual (same
          // rule as the on-screen cells), so the print matches the UI.
          const billedAhead = monthIdx >= 0 && monthIdx > actualThru
            && !!(row?.primeFiles && row.primeFiles[monthIdx] && row.primeFiles[monthIdx].length);
          const isActualMonth = monthIdx >= 0 && (monthIdx <= actualThru || billedAhead);
          const isProjMonth   = monthIdx >= 0 && !isActualMonth;
          const isTotalCol    = label === "Total Billed";
          if (isActualMonth) return { fillColor: INVOICE_PALETTE.AMBER_ACTUAL, textColor: INVOICE_PALETTE.ACCENT_INK };
          if (isProjMonth)   return { fillColor: INVOICE_PALETTE.CREAM_PROJ,   textColor: INVOICE_PALETTE.PROJ_INK };
          if (isTotalCol)    return { fillColor: INVOICE_PALETTE.TOTAL_BG,     fontStyle: "bold" };
          if (isOrangeRow)   return { fillColor: INVOICE_PALETTE.ORANGE_TINT };
          return null;
        }
      : undefined;

    // Build subtitle describing active filter/year/search so the PDF footer
    // communicates what the user was looking at.
    const annotations = [];
    if (yearFilter[tab] != null) annotations.push(`Year: ${yearFilter[tab]}`);
    if (filterKey[tab] && filterKey[tab] !== "all") annotations.push(`Filter: ${filterKey[tab]}`);
    if (snap?.search) annotations.push(`Search: "${snap.search}"`);
    const subtitle = [meta.desc, annotations.join(" · ")].filter(Boolean).join(" — ");

    try {
      showToast("Preparing PDF…", "export");
      await exportPDF(cols, rows, filename, {
        title: `MSMM Beacon — ${meta.title || tab}`,
        subtitle,
        rowColor,
        cellStyle: invoiceCellStyle,
        // A3 landscape gives Invoice's 17 columns (12 months + totals)
        // enough width to render full dollar amounts without ellipsizing.
        // Other tabs stay on A4 — fewer columns, more text-oriented.
        format: (tab === "invoice" || tab === "between") ? "a3" : "a4",
        // Zebra striping fights the Invoice's per-cell fill palette
        // (actual amber, projection cream, orange tint) — turn it off
        // on Invoice so the colors read cleanly.
        alternateRows: tab !== "invoice" && tab !== "between",
      });
      showToast(`Exported ${rows.length} rows`, "export");
    } catch (err) {
      showToast(`Export failed: ${err.message || err}`, "x");
    }
  };

  // "Print for Mark - Subs" — Invoice-only. Mirrors the UI's expanded-row
  // structure for each project: the parent row carries MSMM's portion
  // (matching what users see in InvoiceTable's parent), then per-sub rows,
  // then per-prime rows (only present on Sub-role projects), then a
  // "Project total" footer row carrying Total CV + monthly totals. Row
  // colors mirror the UI palette exactly so the print reads like a
  // screenshot of the in-app expand view.
  //
  // Glyph note: jsPDF's stock Helvetica uses WinAnsi/Latin-1 encoding which
  // doesn't contain ↳ (U+21B3) or ▲ (U+25B2) — those glyphs render as
  // garbled "¹³" / "¹²" substitutions. We rely on the colored band + bold
  // text + plain ASCII labels ("Sub · ", "Prime · ", "MSMM portion",
  // "Project total") to communicate row identity instead.
  const handleExportInvoiceSubs = async () => {
    if (tab !== "invoice") return;
    const meta = PAGE_META.invoice || {};
    const date = new Date().toISOString().slice(0, 10);
    const filename = `msmm-beacon-invoice-subs-${date}.pdf`;

    // Same snapshot-vs-fallback strategy as handleExport so the export honors
    // the user's current year filter / search / sort.
    const snap = getCurrentTableSnapshot();
    const projectRows = (snap && snap.tab === "invoice" && snap.processedRows)
      ? snap.processedRows
      : currentRows;

    // Helpers — mirror tables.jsx (subListFor / primeListFor /
    // msmmAtMonth / msmmContractShown) so PDF numbers match the UI.
    const allEntriesFor = (r) => subInvoices?.get(r.sourceId) || [];
    const subListFor    = (r) => allEntriesFor(r).filter(s => (s.kind || "sub") === "sub");
    const primeListFor  = (r) => allEntriesFor(r).filter(s => s.kind === "prime");
    const msmmAtMonth = (r, i) => {
      const override = r.msmmValues?.[i];
      if (override != null) return Number(override);
      const total = Number(r.values?.[i] || 0);
      const subSum = subListFor(r).reduce(
        (a, s) => a + Number((s.amounts && s.amounts[i]) || 0), 0);
      return total - subSum;
    };
    const msmmContractAuto = (r) => {
      const total = Number(r.amount || 0);
      const subSum = subListFor(r).reduce(
        (a, s) => a + Number(s.contractAmount || 0), 0);
      return total - subSum;
    };
    const msmmContractShown = (r) =>
      r.msmmAmount != null ? Number(r.msmmAmount) : msmmContractAuto(r);

    // Build the column list. Reuse regular-export columns BUT replace the
    // parent row's monthly accessor — for `_kind === "project"` we render
    // MSMM monthly (mirrors UI parent); breakdown rows already carry their
    // own per-row monthly arrays in `values`.
    const baseDefs = EXPORT_COLUMNS.invoice || [];
    const defs = baseDefs.map((c) => {
      const monthIdx = MONTHS.indexOf(c.label);
      if (monthIdx >= 0) {
        return {
          ...c,
          get: (r) => {
            const v = r._kind === "project"
              ? msmmAtMonth(r, monthIdx)
              : (r.values?.[monthIdx] ?? 0);
            return v ? fmtMoney(v) : "";
          },
        };
      }
      if (c.label === "Contract") {
        return {
          ...c,
          get: (r) => {
            const v = r._kind === "project" ? msmmContractShown(r) : (r.amount ?? 0);
            return v != null ? fmtMoney(v) : "";
          },
        };
      }
      if (c.label === "Total Billed") {
        return {
          ...c,
          get: (r) => {
            if (r._kind === "project") {
              if (r.ytdActualOverride != null) return fmtMoney(r.ytdActualOverride);
              const ytd = Array.from({ length: 12 }, (_, i) => msmmAtMonth(r, i))
                .reduce((a, b) => a + b, 0);
              return fmtMoney(ytd);
            }
            const sum = (r.values || []).reduce((a, b) => a + (b || 0), 0);
            return fmtMoney(sum);
          },
        };
      }
      // (No "Rollforward"-derived override here: the Rollforward column is
      // the carry-in amount from 2025 (remainingStart) and renders verbatim
      // via its base accessor — the old derived remaining−billed column was
      // removed when the UI hid YTD/Rollforward.)
      return c;
    });

    // Expand each project into [project-MSMM, ...subs, ...primes, project-total, spacer].
    // Synthetic breakdown rows fill `values`, `amount`, `remainingStart` to
    // match the column accessors above. For sub/prime rows, `remainingStart`
    // = contractAmount so the Rollforward column shows "what's left to bill"
    // for that firm. The Project Total row carries r.values verbatim so the
    // monthly columns show the reconciled project totals (Σ subs + MSMM).
    // A blank `spacer` row between projects creates a visual gap; the blue
    // bounding-box stroke is drawn separately in onDidDrawCell.
    const emptyValues = Array(12).fill(null);
    const mkSpacer = (i) => ({
      _kind: "spacer",
      id: `spacer::${i}`,
      name: "",
      type: "",
      pmIds: [],
      amount: null,
      remainingStart: null,
      values: emptyValues,
      msmmValues: null,
      ytdActualOverride: null,
      rollforwardOverride: null,
      sourceId: null,
    });
    const expandedRows = [];
    projectRows.forEach((r, idx) => {
      // Parent row = MSMM view
      expandedRows.push({ ...r, _kind: "project" });

      // Sub rows
      for (const sub of subListFor(r)) {
        const amounts = sub.amounts || Array(12).fill(0);
        const discipline = sub.discipline ? ` (${sub.discipline})` : "";
        expandedRows.push({
          _kind: "sub",
          id: `${r.id}::sub::${sub.companyId}`,
          name: `    Sub · ${sub.companyName || "Sub"}${discipline}`,
          type: "Sub",
          pmIds: [],
          amount: Number(sub.contractAmount) || 0,
          remainingStart: Number(sub.contractAmount) || 0,
          values: amounts,
          msmmValues: null,
          ytdActualOverride: null,
          rollforwardOverride: null,
          sourceId: null,
        });
      }

      // Prime rows (Sub-role projects only)
      for (const prime of primeListFor(r)) {
        const amounts = prime.amounts || Array(12).fill(0);
        expandedRows.push({
          _kind: "prime",
          id: `${r.id}::prime::${prime.companyId}`,
          name: `    Prime · ${prime.companyName || "Prime"}`,
          type: "Prime",
          pmIds: [],
          amount: Number(prime.contractAmount) || 0,
          remainingStart: Number(prime.contractAmount) || 0,
          values: amounts,
          msmmValues: null,
          ytdActualOverride: null,
          rollforwardOverride: null,
          sourceId: null,
        });
      }

      // Project total footer row — Total CV + monthly totals (= MSMM + subs)
      expandedRows.push({
        _kind: "total",
        id: `${r.id}::total`,
        name: `    Project total`,
        type: "Total",
        pmIds: [],
        amount: Number(r.amount) || 0,
        remainingStart: Number(r.remainingStart) || 0,
        values: r.values || Array(12).fill(0),
        msmmValues: null,
        ytdActualOverride: null,
        rollforwardOverride: null,
        sourceId: null,
      });

      // Blank spacer between projects (skipped after the last project)
      if (idx < projectRows.length - 1) expandedRows.push(mkSpacer(idx));
    });

    // Palette — exact RGB equivalents of the UI's color-mix() output on the
    // light theme, derived from CSS variables:
    //   --surface-2 #F3EEE5, --accent-softer #F8ECD6, --bg-elev #FBF8F2,
    //   --blue #6A86A6, --accent-ink #6B3F10, --text #22201C
    // Light theme is what 99% of users will print from; dark theme prints
    // poorly regardless. Sub/Prime/Total tints match the styles.css formulas
    // line-by-line so a printed page reads like a screenshot.
    const PAL = {
      // Parent project (white-ish — same palette as regular Export PDF)
      PROJ_ROW:      [255, 255, 255],
      PROJ_ACTUAL:   [248, 236, 214], // --accent-softer
      PROJ_PROJ:     [250, 247, 240], // existing CREAM_PROJ
      PROJ_TOTAL:    [251, 248, 242], // --bg-elev
      PROJ_INK:      [ 34,  32,  28], // --text
      PROJ_ACCENT:   [107,  63,  16], // --accent-ink (actual-month text)
      PROJ_DIM:      [110, 102,  89], // --text-muted (projection text)
      ORANGE_TINT:   [249, 234, 220],

      // Sub row (warm cream — UI: color-mix(--surface-2 70%, --accent-softer))
      SUB_ROW:       [245, 237, 225],
      SUB_ACTUAL:    [246, 237, 219], // color-mix(--accent-softer 65%, --surface-2)
      SUB_PROJ:      [245, 241, 234], // color-mix(--surface-2 80%, --surface)
      SUB_INK:       [ 34,  32,  28], // company name kept readable
      SUB_DIM:       [147, 137, 116], // --text-soft (caret/details)

      // Prime row (cool gray — UI: color-mix(--blue 14%, --surface-2))
      PRIME_ROW:     [224, 223, 220],
      PRIME_ACTUAL:  [231, 224, 208], // color-mix(--blue 12%, --accent-softer)
      PRIME_PROJ:    [232, 230, 224], // color-mix(--blue 8%, --surface-2)
      PRIME_INK:     [106, 134, 166], // --blue (matches "PRIME" tag color)

      // Project total footer (strong blue — UI: color-mix(--blue 20%, --bg-elev))
      TOTAL_ROW:     [222, 225, 227],
      TOTAL_ACTUAL:  [216, 221, 224], // color-mix(--blue 24%, --bg-elev)
      TOTAL_PROJ:    [231, 232, 231], // color-mix(--blue 14%, --bg-elev)
      TOTAL_INK:     [ 34,  32,  28], // --text (bold)
      TOTAL_BORDER:  [106, 134, 166], // --blue accent for top border
    };

    const cellStyle = (row, _colIndex, col) => {
      const label = col?.label;
      const monthIdx = MONTHS.indexOf(label);
      const isActualMonth = monthIdx >= 0 && monthIdx <= actualThru;
      const isProjMonth   = monthIdx >= 0 && monthIdx >  actualThru;
      const isTotalCol    = label === "Total Billed" || label === "Rollforward";
      const kind = row?._kind || "project";

      // Spacer between projects — paint white, suppress the cell border so
      // it reads as pure breathing room (autotable's default 0.1mm border
      // would otherwise leave a hairline strip across the gap).
      if (kind === "spacer") {
        return {
          fillColor: [255, 255, 255],
          textColor: [255, 255, 255],
          lineWidth: 0,
          lineColor: [255, 255, 255],
        };
      }

      if (kind === "sub") {
        if (isActualMonth) return { fillColor: PAL.SUB_ACTUAL, textColor: PAL.SUB_INK };
        if (isProjMonth)   return { fillColor: PAL.SUB_PROJ,   textColor: PAL.SUB_DIM };
        if (isTotalCol)    return { fillColor: PAL.SUB_ROW,    textColor: PAL.SUB_INK };
        return { fillColor: PAL.SUB_ROW, textColor: PAL.SUB_INK };
      }
      if (kind === "prime") {
        if (isActualMonth) return { fillColor: PAL.PRIME_ACTUAL, textColor: PAL.PRIME_INK };
        if (isProjMonth)   return { fillColor: PAL.PRIME_PROJ,   textColor: PAL.PRIME_INK };
        if (isTotalCol)    return { fillColor: PAL.PRIME_ROW,    textColor: PAL.PRIME_INK };
        return { fillColor: PAL.PRIME_ROW, textColor: PAL.PRIME_INK };
      }
      if (kind === "total") {
        if (isActualMonth) return { fillColor: PAL.TOTAL_ACTUAL, textColor: PAL.TOTAL_INK, fontStyle: "bold" };
        if (isProjMonth)   return { fillColor: PAL.TOTAL_PROJ,   textColor: PAL.TOTAL_INK, fontStyle: "bold" };
        if (isTotalCol)    return { fillColor: PAL.TOTAL_ROW,    textColor: PAL.TOTAL_INK, fontStyle: "bold" };
        return { fillColor: PAL.TOTAL_ROW, textColor: PAL.TOTAL_INK, fontStyle: "bold" };
      }
      // Parent project row — same palette as regular Invoice export.
      const isOrangeRow = invoiceIsOrange(row, orangeSourceIds);
      if (isActualMonth) return { fillColor: PAL.PROJ_ACTUAL, textColor: PAL.PROJ_ACCENT };
      if (isProjMonth)   return { fillColor: PAL.PROJ_PROJ,   textColor: PAL.PROJ_DIM };
      if (isTotalCol)    return { fillColor: PAL.PROJ_TOTAL,  fontStyle: "bold" };
      if (isOrangeRow)   return { fillColor: PAL.ORANGE_TINT };
      return null;
    };

    const annotations = [];
    if (yearFilter.invoice != null) annotations.push(`Year: ${yearFilter.invoice}`);
    if (filterKey.invoice && filterKey.invoice !== "all") annotations.push(`Filter: ${filterKey.invoice}`);
    if (snap?.search) annotations.push(`Search: "${snap.search}"`);
    annotations.push(`Parent rows show MSMM portion · Total row reconciles each project`);
    const subtitle = [
      meta.desc,
      annotations.join(" · "),
      `${projectRows.length} ${projectRows.length === 1 ? "project" : "projects"} · ${expandedRows.length} lines`,
    ].filter(Boolean).join(" — ");

    // Bounding-box stroke around each project block. Draws four sides one
    // cell at a time as autotable renders the table — page breaks are
    // handled naturally because each cell's coords are page-local.
    //   • top    → on every cell of `_kind: project` (parent row)
    //   • bottom → on every cell of `_kind: total`   (footer row)
    //   • left   → on the first column of every group row
    //   • right  → on the last column of every group row
    // A 0.35 mm stroke in --blue matches the existing "Project total"
    // row accent so the box reads as part of the same blue motif.
    const STROKE_MM = 0.35;
    const STROKE_RGB = PAL.TOTAL_BORDER;
    const lastColIdx = defs.length - 1;
    const onDidDrawCell = (data, row) => {
      const kind = row?._kind;
      if (!kind || kind === "spacer") return;
      const { x, y, width, height } = data.cell;
      const { doc } = data;
      doc.setDrawColor(STROKE_RGB[0], STROKE_RGB[1], STROKE_RGB[2]);
      doc.setLineWidth(STROKE_MM);
      if (kind === "project") doc.line(x, y, x + width, y);              // top
      if (kind === "total")   doc.line(x, y + height, x + width, y + height); // bottom
      if (data.column.index === 0)            doc.line(x, y, x, y + height);            // left
      if (data.column.index === lastColIdx)   doc.line(x + width, y, x + width, y + height); // right
    };

    try {
      showToast("Preparing PDF…", "export");
      await exportPDF(defs, expandedRows, filename, {
        title: `MSMM Beacon — Invoice with Sub Breakdown — Print for Mark`,
        subtitle,
        cellStyle,
        onDidDrawCell,
        format: "a3",
        alternateRows: false,
      });
      showToast(`Exported ${projectRows.length} projects`, "export");
    } catch (err) {
      showToast(`Export failed: ${err.message || err}`, "x");
    }
  };

  // "Print for Manish" — Invoice-only. One .xlsx sheet per month (JAN–DEC),
  // each listing every Prime-role project that has at least one sub. Row =
  // Project No. | Invoice No. (blank) | Total Invoice (=SUM) | MSMM | Sub N
  // Name/Amount pairs. Per-cell color mirrors the in-app paid/attachment
  // signal: paid tick → green · PDF attached → yellow · amount only → red
  // (MSMM + Total follow the prime invoice status; each sub follows its own).
  // Sub columns extend past 3 when a project carries more subs.
  const handleExportManish = async () => {
    if (tab !== "invoice") return;
    const date = new Date().toISOString().slice(0, 10);
    // One section per month in the current rolling window (spans calendar
    // years). The xlsx stacks the 16 months vertically; each section title
    // carries its own year.
    const MONTH_FULL = [
      "JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE",
      "JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER",
    ];
    const win = invWindowMonths;
    const monthTitles = win.map(d => `${MONTH_FULL[d.monthIdx]} ${d.year}`);
    const filename = `msmm-invoice-manish-${win[0].label.replace(/\s/g, "")}-${win[win.length - 1].label.replace(/\s/g, "")}-${date}.xlsx`;

    // currentRows = filtered.invoice = MERGED rows (one per project, byYear).
    const baseRows = currentRows;

    const subListFor = (r) =>
      (subInvoices?.get(r.sourceId) || []).filter(s => (s.kind || "sub") === "sub");
    // MSMM portion for a (merged row, window-month descriptor): the right
    // year's total minus its subs, honoring a per-month MSMM override.
    const msmmAtDesc = (r, d) => {
      const yr = r.byYear?.[d.year];
      if (!yr) return 0;
      const override = yr.msmmValues?.[d.monthIdx];
      if (override != null) return Number(override);
      const total = Number(yr.values?.[d.monthIdx] || 0);
      const subSum = subListFor(r).reduce(
        (a, s) => a + Number(s.byYear?.[d.year]?.amounts?.[d.monthIdx] || 0), 0);
      return total - subSum;
    };

    const included = baseRows.filter(r =>
      r.role === "Prime" && subListFor(r).length > 0);

    if (included.length === 0) {
      showToast("No Prime projects with subs in this window", "x");
      return;
    }

    // Same column count on every sheet (subs are project-level, not monthly);
    // never fewer than the template's 3 slots.
    const maxSubs = Math.max(3, ...included.map(r => subListFor(r).length));

    const rows = included.map(r => {
      const subs = subListFor(r);
      const subNames = Array.from({ length: maxSubs }, (_, j) => subs[j]?.companyName || "");
      const months = win.map((d) => {
        const yr = r.byYear?.[d.year] || {};
        return {
          msmmAmount: msmmAtDesc(r, d),
          invoiceNumber: (yr.invoiceNumbers && yr.invoiceNumbers[d.monthIdx]) || null,
          primePaid: !!(yr.primePaid && yr.primePaid[d.monthIdx]),
          primeHasFile: ((yr.primeFiles && yr.primeFiles[d.monthIdx]) || []).length > 0,
          subs: Array.from({ length: maxSubs }, (_, j) => {
            const s = subs[j];
            const sy = s?.byYear?.[d.year];
            if (!s) return { amount: null, paid: false, hasFile: false };
            return {
              amount: (sy?.amounts && sy.amounts[d.monthIdx]) ?? null,
              paid: !!(sy?.paid && sy.paid[d.monthIdx]),
              hasFile: ((sy?.files && sy.files[d.monthIdx]) || []).length > 0,
            };
          }),
        };
      });
      return { projectNumber: r.projectNumber, name: r.name, subNames, months };
    });

    try {
      showToast("Preparing Excel…", "export");
      await exportManishWorkbook({ monthTitles, maxSubs, rows }, filename);
      showToast(`Exported ${included.length} project${included.length === 1 ? "" : "s"} → Excel`, "export");
    } catch (err) {
      showToast(`Export failed: ${err.message || err}`, "x");
    }
  };

  // PotentialTable owns its own primary sort: [probability asc, role asc],
  // so App-level pre-sort is no longer needed. Totals are injected inside
  // PotentialTable's postProcess and published via the snapshot, so Export
  // picks them up for free.

  // Available years per tab (derived from data; descending)
  const availableYears = useMemo(() => {
    const uniq = (rows) => [...new Set(rows.map(r => r.year).filter(v => v != null))].sort((a, b) => b - a);
    // Events/Hot Leads don't carry a standalone year column — derive it from
    // the ISO date string (first 4 chars). Empty dates contribute nothing.
    const uniqFromDate = (rows, key) => [...new Set(
      rows.map(r => r[key] ? Number(String(r[key]).slice(0, 4)) : null)
          .filter(v => v != null && !Number.isNaN(v))
    )].sort((a, b) => b - a);
    return {
      potential: uniq(potential),
      awaiting:  uniq(awaiting),
      awarded:   uniq(awarded),
      closed:    uniq(closed),
      invoice:   uniq(invoice),
      events:    uniqFromDate(events, "date"),
      hotleads:  uniqFromDate(hotLeads, "dateTime"),
      openbids:  uniqFromDate(openBids, "dueAt"),
    };
  }, [potential, awaiting, awarded, closed, invoice, events, hotLeads, openBids]);

  // Merged invoice projects (one row per (type, project number), byYear map,
  // groupIds, billingState) — computed once and split across the Invoice
  // page's sub-tabs below. Also feeds the Awarded tab's link cards.
  const invoiceMerged = useMemo(() => mergeInvoiceYears(invoice), [invoice]);

  // Invoice project lookup by normalized project number — powers the Awarded
  // tab's link chips + project cards. On a number collision (ENG + PM rows
  // share a number; an active row coexists with an old closed one) prefer the
  // most-active state, then ENG over PM.
  const invoiceByNumber = useMemo(() => {
    const rank = { active: 0, between: 1, closed: 2 };
    const m = new Map();
    for (const r of invoiceMerged) {
      const k = normInvoiceNumber(r.projectNumber);
      if (!k) continue;
      const prev = m.get(k);
      if (!prev) { m.set(k, r); continue; }
      const better =
        (rank[r.billingState || "active"] - rank[prev.billingState || "active"]) ||
        ((r.type || "ENG") === "ENG" ? -1 : 1);
      if (better < 0) m.set(k, r);
    }
    return m;
  }, [invoiceMerged]);

  // Project Detail page — the LIVE root row (re-read from projectItems so header
  // + structure reflect edits; null if the project was deleted while open) and
  // its invoice rows. Invoices link by project NUMBER (project_items has no FK
  // to anticipated_invoice), so match the root's local_id to invoice
  // projectNumber — the same merge key the Invoice tab uses. All billing states
  // are shown (the detail view is the project's complete billing).
  const detailLive = useMemo(
    () => detailProject ? projectItems.find(p => p.id === detailProject.id) || null : null,
    [detailProject, projectItems]);
  const detailInvoiceRows = useMemo(() => {
    if (!detailLive) return [];
    const key = normInvoiceNumber(detailLive.localId);
    if (!key) return [];
    return invoiceMerged.filter(r => normInvoiceNumber(r.projectNumber) === key);
  }, [detailLive, invoiceMerged]);

  // Apply year filter, then category filter. Events filter against the year
  // component of the ISO event_date, not a dedicated year column.
  const filtered = useMemo(() => {
    const applyYear = (key, rows) => {
      const y = yearFilter[key];
      if (y == null) return rows;
      if (key === "events") {
        return rows.filter(r => r.date && Number(String(r.date).slice(0, 4)) === y);
      }
      if (key === "hotleads") {
        return rows.filter(r => r.dateTime && Number(String(r.dateTime).slice(0, 4)) === y);
      }
      if (key === "openbids") {
        return rows.filter(r => r.dueAt && Number(String(r.dueAt).slice(0, 4)) === y);
      }
      return rows.filter(r => r.year === y);
    };
    const apply = (key, rows) => {
      const yr = applyYear(key, rows);
      const predicate = FILTERS[key]?.[filterKey[key]];
      return predicate ? yr.filter(predicate) : yr;
    };
    // Directory merges clients + companies into one feed; the type
    // discriminator ("Client" vs "Prime"/"Sub"/"Multiple") drives section
    // headers + filter chips inside DirectoryTable.
    // Orange Potentials live in the Invoice tab (auto-spawned) and are
    // intentionally hidden from the Potential view — they're effectively
    // "moved to Invoice" while tagged Orange. Demoting from Orange deletes
    // the invoice row and the Potential row reappears here.
    const potentialVisible = potential.filter(r => r.probability !== "Orange");
    return {
      potential: apply("potential", potentialVisible),
      awaiting:  apply("awaiting",  awaiting),
      awarded:   apply("awarded",   awarded),
      closed:    apply("closed",    closed),
      // Invoice is a rolling multi-year window now — no per-year filter.
      // mergeInvoiceYears folds each project's per-year rows into one merged
      // row carrying a `byYear` map; the window slice happens in InvoiceTable.
      // billing_state splits the merged projects across the Invoice page's
      // sub-tabs: Invoices (active) vs In-Between (paused); closed rows are
      // archived (the Closed Out sub-tab lists projects, not invoice rows).
      invoice:   invoiceMerged.filter(r => (r.billingState || "active") === "active"),
      between:   invoiceMerged.filter(r => r.billingState === "between"),
      events:    apply("events",    events),
      hotleads:  apply("hotleads",  hotLeads),
      openbids:  apply("openbids",  openBids),
      directory: apply("directory", [...clients, ...companies]),
      // Projects is a tree — ProjectsTable does its own ancestor-aware
      // filtering, so pass the full flat list through unfiltered (the export
      // fallback + currentRows still get something sensible).
      projects:  projectItems,
    };
  }, [filterKey, yearFilter, potential, awaiting, awarded, closed, invoiceMerged, events, hotLeads, openBids, clients, companies, projectItems]);

  // Current tab's visible rows (for page-head Export and New button context)
  const currentRows = filtered[tab] || [];

  // Legacy source ids for untoggled rows. Once invoice_orange is explicitly
  // true/false, the Invoice table uses that row-owned value instead.
  const orangeSourceIds = useMemo(
    () => new Set(potential.filter(p => p.probability === "Orange").map(p => p.id)),
    [potential]
  );

  // Invoice rolling-window — absolute-month index (year*12 + monthIdx) of the
  // leftmost visible month. Shared by the InvoiceTable, the cash-flow charts,
  // and the Manish export so all three slide together. Persisted so navigation
  // survives a reload; Back/Forward shift by one month, "Today" resets to the
  // default (prev 3 + current + next 12 = 16 months).
  const [invWindowStart, setInvWindowStart] = useState(() => {
    try {
      const v = localStorage.getItem("beacon.invoiceWindowStart");
      if (v != null && v !== "") return Number(v);
    } catch { /* storage disabled — fine */ }
    return defaultWindowStartAbs();
  });
  useEffect(() => {
    try { localStorage.setItem("beacon.invoiceWindowStart", String(invWindowStart)); }
    catch { /* storage disabled — fine */ }
  }, [invWindowStart]);
  const invWindowMonths = useMemo(() => monthDescsForWindow(invWindowStart), [invWindowStart]);
  const invWindowAtDefault = invWindowStart === defaultWindowStartAbs();

  // Expose the projects-by-type snapshot to EXPORT_COLUMNS' countRefs helper.
  useEffect(() => {
    setProjectsByTypeRef({ potential, awaiting, awarded, closed });
  }, [potential, awaiting, awarded, closed]);

  // Build filter chips with counts and click handlers for the current tab
  const chipsFor = (tabKey) => (FILTER_CHIPS[tabKey] || []).map(chip => ({
    label: chip.label,
    icon: chip.icon,
    count: tabKey === tab
      ? (chip.key === "all"
          ? (filtered[tabKey]?.length ?? 0)
          : (({
              potential, awaiting, awarded, closed,
              events, hotleads: hotLeads,
              openbids: openBids,
              directory: [...clients, ...companies],
            })[tabKey] || []).filter(FILTERS[tabKey][chip.key]).length)
      : null,
    active: filterKey[tabKey] === chip.key,
    onClick: () => setFilterKey(f => ({ ...f, [tabKey]: chip.key })),
  }));

  const stats = useMemo(() => {
    // Proposals card = the INCOMING pipeline: anticipated $ + entry count
    // across Open Bids + Hot Leads (the two pre-Proposal trackers).
    const propAmt = openBids.reduce((a,r) => a + (r.anticipatedAmount || 0), 0)
                  + hotLeads.reduce((a,r) => a + (r.anticipatedAmount || 0), 0);
    const propCount = openBids.length + hotLeads.length;
    const awd = awarded.reduce((a,r) => a + (r.msmmRemaining || 0), 0);
    // In-Between: paused projects (merged) — contract value sitting on hold.
    const paused = invoiceMerged.filter(r => r.billingState === "between");
    const btw = paused.reduce((a,r) => a + (r.amount || 0), 0);
    // Closed-out projects' archived rows don't count toward YTD (parity with
    // the pre-billing_state era, when close-out deleted them). Paused
    // (In-Between) projects DO count — those dollars were really billed.
    const ytd = invoice
      .filter(r => (r.billingState || "active") !== "closed")
      .reduce((a,r) => a + r.values.slice(0, actualThru + 1).reduce((x,y) => x + (y||0), 0), 0);
    return [
      { label: "Proposals",           val: propAmt, sub: `${propCount} submittals`, spark: [2,3,3,4,4,5,5,6,7,7] },
      { label: "Active backlog",      val: awd, sub: `${awarded.length} awarded`,     spark: [5,5,6,7,6,7,8,9,10,11] },
      { label: "In-Between",          val: btw, sub: `${paused.length} paused`,       spark: [4,4,3,4,3,3,4,3,3,4] },
      { label: "YTD billed (actual)", val: ytd, sub: actualThru >= 0 ? `Jan–${MONTHS[actualThru]} ${THIS_YEAR}` : `Pre-cutover · ${THIS_YEAR}`, spark: [1,2,3,3,4,5,6,7,8,9] },
    ];
  }, [awarded, invoice, invoiceMerged, actualThru, openBids, hotLeads]);

  const tabCounts = {
    openbids: openBids.length,
    potential: potential.length, awaiting: awaiting.length,
    awarded: awarded.length, closed: closed.length,
    // Invoice counts are per merged PROJECT (not per year-row), split by
    // billing state to feed the Invoices / In-Between sub-tab badges.
    invoice: invoiceMerged.filter(r => (r.billingState || "active") === "active").length,
    between: invoiceMerged.filter(r => r.billingState === "between").length,
    events: events.length,
    hotleads: hotLeads.length,
    directory: clients.length + companies.length,
    projects: projectItems.length,
    timesheet:  null,  // populated via Realtime in TimesheetTab; not surfaced here
    "time-admin": null,
    "team-cal":   null,
  };

  // Navbar group of the active tab; multi-tab groups render the group label
  // as the H1 (the sub-tab strip below it names the section) and sum member
  // counts on the rail pill.
  const currentGroup = navGroupOf(tab) || null;
  const groupCount = (g) => {
    const vals = g.tabs.map(k => tabCounts[k]).filter(v => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const currentMeta = PAGE_META[tab];
  const pageTitle = currentGroup && currentGroup.tabs.length > 1
    ? currentGroup.label
    : (currentMeta?.title || "");

  // Remember the last sub-tab used inside each group so clicking the group
  // pill returns you where you left off (falls back to the first member).
  const lastSubTabRef = useRef({});
  useEffect(() => {
    const g = navGroupOf(tab);
    if (g) lastSubTabRef.current[g.key] = tab;
  }, [tab]);
  const gotoGroup = (g) => setTab(
    (lastSubTabRef.current[g.key] && g.tabs.includes(lastSubTabRef.current[g.key]))
      ? lastSubTabRef.current[g.key]
      : g.tabs[0]
  );

  // Does the current tab support "New X"? Proposals (awaiting) is a
  // first-class entry point (projects can start here without a prior
  // Potential row).
  // Potential is ALSO an entry (opportunities scoped directly / billing
  // candidates added without going through the proposal stage). Awarded /
  // Closed Out / Invoice are only reached via Move Forward from an earlier
  // stage — no direct "New" button for those.
  // Directory's primary "New X" defaults to client (the more common entry).
  // Companies are typically created via the sub-picker on a project rather
  // than from this tab.
  const newForTab = { openbids: "openbids", awaiting: "awaiting", awarded: "awarded", potential: "potential", events: "events", hotleads: "hotleads", directory: "clients", projects: "projects" };
  const newTarget = newForTab[tab];
  const newLabel = tab === "events" ? "New event"
                 : tab === "hotleads" ? "New hot lead"
                 : tab === "directory" ? "New client"
                 : tab === "awaiting" ? "New proposal"
                 : tab === "awarded" ? "New awarded project"
                 : tab === "openbids" ? "New open bid"
                 : "New project";

  return (
    <div className="app" data-roster-tick={rosterTick}>
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark"/>
          <span>Beacon</span>
          <span className="brand-sub">MSMM · Project Lifecycle</span>
        </div>
        <div className="search">
          <Icon name="search" size={14}/>
          <input placeholder="Search projects, clients, people…"/>
          <span className="kbd">⌘K</span>
        </div>
        <div className="top-actions">
          <PwaOfflineChip/>
          <PwaInstallChip/>
          <button className="iconbtn" title="Notifications"><Icon name="bell" size={16}/></button>
          <button
            className="iconbtn"
            title={isAdmin ? "Admin · Users & tweaks" : "Tweaks"}
            onClick={() => isAdmin ? setAdminOpen(v => !v) : setTweaksOpen(v => !v)}
          >
            <Icon name="settings" size={16}/>
          </button>
          <div style={{ position: "relative" }}>
            <div className="session-chip" onClick={() => setMenuOpen(v => !v)}
                 title={`${userDisplayName} · ${currentUser?.role || "User"}`}>
              <div className="avatar" style={{ width: 26, height: 26, fontSize: 11 }}>
                {userInitials.toUpperCase()}
              </div>
              <span className="session-name">{currentUser?.first_name || userDisplayName}</span>
              <span className={"session-role" + (isAdmin ? " admin" : "")}>
                {currentUser?.role || "User"}
              </span>
            </div>
            {menuOpen && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 40 }}
                  onClick={() => setMenuOpen(false)}
                />
                <div className="menu"
                     style={{ position: "absolute", right: 0, top: "calc(100% + 6px)",
                              zIndex: 41, minWidth: 220 }}>
                  <div style={{ padding: "10px 12px 8px", borderBottom: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{userDisplayName}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-soft)" }}>{currentUser?.email}</div>
                  </div>
                  <button className="menu-item" onClick={() => { setMenuOpen(false); setPasswordModalOpen(true); }}>
                    <Icon name="lock" size={13}/>
                    <span>Change password</span>
                  </button>
                  <div className="menu-sep"/>
                  <button className="menu-item" onClick={() => { setMenuOpen(false); onSignOut?.(); }}>
                    <Icon name="logout" size={13}/>
                    <span>Sign out</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="tabwrap">
        <div className="pipeline" role="tablist" ref={pipelineRef}>
          {NAV_GROUPS.filter(g => g.group === "pipeline").map((g, i, arr) => (
            <React.Fragment key={g.key}>
              <button
                className={`tab ${g.stage} ${g.tabs.includes(tab) ? "active" : ""}`}
                onClick={() => gotoGroup(g)}
                role="tab"
                aria-selected={g.tabs.includes(tab)}
              >
                {g.label}
                {groupCount(g) != null && (
                  <span className="count">{groupCount(g)}</span>
                )}
              </button>
              {i < arr.length - 1 && (
                <span className="tab-sep" aria-hidden="true">
                  <Icon name="chevronRight" size={12} stroke={2}/>
                </span>
              )}
            </React.Fragment>
          ))}
          <span className="tab-rail-divider" aria-hidden="true"/>
          {NAV_GROUPS.filter(g => g.group === "side" && (!g.adminOnly || isAdmin)).map(g => (
            <button key={g.key}
              className={`tab ${g.stage} ${g.tabs.includes(tab) ? "active" : ""}`}
              onClick={() => gotoGroup(g)} role="tab"
              aria-selected={g.tabs.includes(tab)}>
              {g.label}
              {groupCount(g) != null && (
                <span className="count">{groupCount(g)}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="page">
        {detailLive && (
          <ProjectDetailPage
            project={detailLive}
            items={projectItems}
            onClose={() => setDetailProject(null)}
            updateItem={updateProjectItemRow}
            onAddItemSub={addProjectItemSubRow}
            onUpdateItemSub={updateProjectItemSubRow}
            onRemoveItemSub={removeProjectItemSubRow}
            onDeleteItem={deleteProjectItemRow}
            onAddChild={openNewProject}
            invoiceTableProps={{
              rows: detailInvoiceRows,
              windowMonths: invWindowMonths,
              onWindowBack: () => setInvWindowStart(s => s - 1),
              onWindowFwd: () => setInvWindowStart(s => s + 1),
              onWindowToday: () => setInvWindowStart(defaultWindowStartAbs()),
              windowAtDefault: invWindowAtDefault,
              cutoverDay: appSettings.invoiceActualCutoverDay,
              cutoverNextMonth: appSettings.invoiceActualCutoverNextMonth,
              updateInvoice: editInvoiceTotalMonth,
              updateInvoiceMsmm: editInvoiceMsmmMonth,
              updateRow: updateInvoice,
              onOpenDrawer: r => openDrawer(r, "invoice"),
              onAlert: r => setAlertObj({ row: r, tab: "invoice" }),
              flashId,
              orangeSourceIds,
              subInvoices,
              onUpdateSubAmount: updateSubInvoiceCell,
              onTogglePaid: setSubInvoicePaidStatus,
              onTogglePrimePaid: editInvoicePrimePaidMonth,
              canUntickPaid: isAdmin,
              onOpenFiles: openInvoiceFiles,
              onAddSub: (projectRow, kind = "sub") => setAddSubModal({ projectRow, kind }),
              onUpdateSubMeta: updateSubMeta,
              onRemoveSub: removeSub,
              onChangeRole: setInvoiceRoleHandler,
              onSaveEgnyteFolder: saveInvoiceProjectEgnyteFolder,
              onNotesChanged: (id, log) => setInvoice(rows => rows.map(r => r.id === id ? { ...r, notesLog: log } : r)),
              canEditMsmm: isAdmin,
              onBlockedMsmmEdit: () => showToast("MSMM values are auto-calculated — only an admin can edit them. Edit the Total (or a sub) instead.", "lock"),
              onNew: () => setCreateTable("invoice"),
              // No pause/resume/close-out from the detail view — it shows the
              // project's invoice rows across ALL billing states, so a single
              // billingMode can't be right for every row. Transitions stay on
              // the main Invoice page. This keeps the detail tab a pure
              // filtered view (omitting onPause hides the action).
              billingMode: "active",
            }}
          />
        )}
        {!detailLive && (<>
        <div className="page-head">
          <div>
            <h1 className="page-title">{pageTitle}</h1>
            <p className="page-desc">{currentMeta.desc}</p>
          </div>
          <div className="page-actions">
            {tab === "invoice" ? (
              <>
                <button className="btn sm" onClick={handleExport}>
                  <Icon name="export" size={13}/>Print for Mark
                </button>
                <button className="btn sm" onClick={handleExportInvoiceSubs}>
                  <Icon name="export" size={13}/>Print for Mark - Subs
                </button>
                <button className="btn sm" onClick={handleExportManish}>
                  <Icon name="export" size={13}/>Print for Manish
                </button>
              </>
            ) : (
              <button className="btn sm" onClick={handleExport}>
                <Icon name="export" size={13}/>Export PDF
              </button>
            )}
            {tab === "directory" ? (
              <>
                <button className="btn primary" onClick={() => setCreateTable("clients")}>
                  <Icon name="plus" size={13}/>New client
                </button>
                <button className="btn" onClick={() => setCreateTable("companies")}>
                  <Icon name="plus" size={13}/>New company
                </button>
              </>
            ) : newTarget && (
              <button className="btn primary" onClick={() => setCreateTable(newTarget)}>
                <Icon name="plus" size={13}/>{newLabel}
              </button>
            )}
          </div>
        </div>

        {currentGroup && currentGroup.tabs.length > 1 && (
          <div className="subtabs" role="tablist" aria-label={`${currentGroup.label} sections`}>
            {(SUB_TABS[currentGroup.key] || []).map(st => (
              <button key={st.key}
                role="tab"
                aria-selected={tab === st.key}
                className={"subtab" + (tab === st.key ? " active" : "")}
                onClick={() => setTab(st.key)}>
                {st.icon && <Icon name={st.icon} size={13}/>}
                {st.label}
                {tabCounts[st.key] != null && (
                  <span className="subtab-count">{tabCounts[st.key]}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {["awaiting","awarded","invoice","between","closed"].includes(tab) && (
          <div className="stats">
            {stats.map((s, i) => (
              <div key={i} className="stat">
                <div className="stat-label">{s.label}</div>
                <div className="stat-val">{fmtMoney(s.val, false)}</div>
                <div className="stat-delta" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{s.sub}</div>
                <Sparkline values={s.spark}/>
              </div>
            ))}
          </div>
        )}

        {tab === "openbids" && (
          <OpenBidsTable rows={filtered.openbids}
            updateRow={updateOpenBids}
            isAdmin={isAdmin}
            onOpenDrawer={r => openDrawer(r, "openbids")}
            onForward={r => triggerForward(r, "openbids", "awaiting")}
            onApprove={(r) => setBidApproval(r.id, "approved")}
            onReject={(r) => setBidApproval(r.id, "rejected")}
            onClearApproval={(r) => setBidApproval(r.id, "pending")}
            onUploadPdf={uploadBidPdf}
            onRemovePdf={removeBidPdf}
            onOpenPdf={openBidPdfInNewTab}
            onDelete={deleteOpenBidRow}
            flashId={flashId}
            filters={chipsFor("openbids")}
            tab="openbids"
            yearOptions={availableYears.openbids}
            yearValue={yearFilter.openbids}
            onYearChange={(y) => setYear("openbids", y)}/>
        )}
        {tab === "potential" && (
          <PotentialTable rows={filtered.potential} updateRow={updatePotential}
            onOpenDrawer={r => openDrawer(r, "potential")}
            onForward={r => triggerForward(r, "potential", "invoice")}
            onAlert={r => setAlertObj({ row: r, tab: "potential" })}
            flashId={flashId}
            filters={chipsFor("potential")}
            tab="potential"
            yearOptions={availableYears.potential}
            yearValue={yearFilter.potential}
            onYearChange={(y) => setYear("potential", y)}/>
        )}
        {tab === "awaiting" && (
          <AwaitingTable rows={filtered.awaiting} updateRow={updateAwaiting}
            onOpenDrawer={r => openDrawer(r, "awaiting")}
            onForward={r => triggerForward(r, "awaiting", "awarded")}
            onCloseOut={r => triggerForward(r, "awaiting", "closed")}
            onAlert={r => setAlertObj({ row: r, tab: "awaiting" })}
            flashId={flashId}
            filters={chipsFor("awaiting")}
            tab="awaiting"
            yearOptions={availableYears.awaiting}
            yearValue={yearFilter.awaiting}
            onYearChange={(y) => setYear("awaiting", y)}/>
        )}
        {tab === "awarded" && (
          <AwardedTable rows={filtered.awarded} updateRow={updateAwarded}
            onOpenDrawer={r => openDrawer(r, "awarded")}
            onForward={r => triggerForward(r, "awarded", "invoice")}
            onAlert={r => setAlertObj({ row: r, tab: "awarded" })}
            flashId={flashId}
            filters={chipsFor("awarded")}
            tab="awarded"
            yearOptions={availableYears.awarded}
            yearValue={yearFilter.awarded}
            onYearChange={(y) => setYear("awarded", y)}
            invoiceIndex={invoiceByNumber}
            actualThru={actualThru}
            onAddInvoiceLink={addInvoiceLink}
            onRemoveInvoiceLink={removeInvoiceLink}
            onOpenInvoiceProject={openInvoiceProject}/>
        )}
        {tab === "closed" && (
          <ClosedTable rows={filtered.closed}
            updateRow={updateClosed}
            onOpenDrawer={r => openDrawer(r, "closed")}
            onAlert={r => setAlertObj({ row: r, tab: "closed" })}
            flashId={flashId}
            filters={chipsFor("closed")}
            tab="closed"
            yearOptions={availableYears.closed}
            yearValue={yearFilter.closed}
            onYearChange={(y) => setYear("closed", y)}/>
        )}
        {tab === "invoice" && (() => {
          // Build the project lookup once per render — used by the
          // Outstanding Invoices panel to resolve project names + numbers
          // + status from the projectId keys it sees in subInvoices.
          const projectsById = new Map();
          for (const p of potential) projectsById.set(p.id, { name: p.name, projectNumber: p.projectNumber, year: p.year, statusKey: "potential" });
          for (const p of awaiting)  projectsById.set(p.id, { name: p.name, projectNumber: p.projectNumber, year: p.year, statusKey: "awaiting"  });
          for (const p of awarded)   projectsById.set(p.id, { name: p.name, projectNumber: p.projectNumber, year: p.year, statusKey: "awarded"   });
          for (const p of closed)    projectsById.set(p.id, { name: p.name, projectNumber: p.projectNumber, year: p.year, statusKey: "closed"    });
          return (
            <>
              <InvoiceCharts
                rows={filtered.invoice}
                windowMonths={invWindowMonths}
                orangeSourceIds={orangeSourceIds}
                monthlyBenchmark={appSettings.monthlyInvoiceBenchmark}
                subInvoices={subInvoices}
              />
              <InvoiceTable rows={filtered.invoice}
                windowMonths={invWindowMonths}
                onWindowBack={() => setInvWindowStart(s => s - 1)}
                onWindowFwd={() => setInvWindowStart(s => s + 1)}
                onWindowToday={() => setInvWindowStart(defaultWindowStartAbs())}
                windowAtDefault={invWindowAtDefault}
                cutoverDay={appSettings.invoiceActualCutoverDay}
                cutoverNextMonth={appSettings.invoiceActualCutoverNextMonth}
                updateInvoice={editInvoiceTotalMonth}
                updateInvoiceMsmm={editInvoiceMsmmMonth}
                updateRow={updateInvoice}
                onOpenDrawer={r => openDrawer(r, "invoice")}
                onAlert={r => setAlertObj({ row: r, tab: "invoice" })}
                flashId={flashId}
                tab="invoice"
                orangeSourceIds={orangeSourceIds}
                subInvoices={subInvoices}
                onUpdateSubAmount={updateSubInvoiceCell}
                onTogglePaid={setSubInvoicePaidStatus}
                onTogglePrimePaid={editInvoicePrimePaidMonth}
                canUntickPaid={isAdmin}
                onOpenFiles={openInvoiceFiles}
                onAddSub={(projectRow, kind = "sub") => setAddSubModal({ projectRow, kind })}
                onUpdateSubMeta={updateSubMeta}
                onRemoveSub={removeSub}
                onChangeRole={setInvoiceRoleHandler}
                onSaveEgnyteFolder={saveInvoiceProjectEgnyteFolder}
                onNotesChanged={(id, log) =>
                  setInvoice(rows => rows.map(r => r.id === id ? { ...r, notesLog: log } : r))}
                canEditMsmm={isAdmin}
                onBlockedMsmmEdit={() => showToast("MSMM values are auto-calculated — only an admin can edit them. Edit the Total (or a sub) instead.", "lock")}
                onNew={() => setCreateTable("invoice")}
                billingMode="active"
                onPause={pauseInvoiceProject}/>
              <SubsReceivablesPanel
                subInvoices={subInvoices}
                projectsById={projectsById}
                onOpenProject={(statusKey, projectId) => {
                  // Mirror the directory-drawer routing: locate the row in
                  // the right slice, switch to that tab, and open its drawer.
                  const slice =
                    statusKey === "potential" ? potential :
                    statusKey === "awaiting"  ? awaiting  :
                    statusKey === "awarded"   ? awarded   :
                    statusKey === "closed"    ? closed    : [];
                  const target = slice.find(p => p.id === projectId);
                  if (target) openDrawer(target, statusKey);
                }}
              />
            </>
          );
        })()}
        {tab === "between" && (
          // Paused projects — the same InvoiceTable surface (months, files,
          // subs, notes all live), minus the charts/receivables chrome. Rows
          // resume to Invoices or close out from here.
          <InvoiceTable rows={filtered.between}
            windowMonths={invWindowMonths}
            onWindowBack={() => setInvWindowStart(s => s - 1)}
            onWindowFwd={() => setInvWindowStart(s => s + 1)}
            onWindowToday={() => setInvWindowStart(defaultWindowStartAbs())}
            windowAtDefault={invWindowAtDefault}
            cutoverDay={appSettings.invoiceActualCutoverDay}
            cutoverNextMonth={appSettings.invoiceActualCutoverNextMonth}
            updateInvoice={editInvoiceTotalMonth}
            updateInvoiceMsmm={editInvoiceMsmmMonth}
            updateRow={updateInvoice}
            onOpenDrawer={r => openDrawer(r, "invoice")}
            onAlert={r => setAlertObj({ row: r, tab: "invoice" })}
            flashId={flashId}
            tab="between"
            orangeSourceIds={orangeSourceIds}
            subInvoices={subInvoices}
            onUpdateSubAmount={updateSubInvoiceCell}
            onTogglePaid={setSubInvoicePaidStatus}
            onTogglePrimePaid={editInvoicePrimePaidMonth}
            canUntickPaid={isAdmin}
            onOpenFiles={openInvoiceFiles}
            onAddSub={(projectRow, kind = "sub") => setAddSubModal({ projectRow, kind })}
            onUpdateSubMeta={updateSubMeta}
            onRemoveSub={removeSub}
            onChangeRole={setInvoiceRoleHandler}
            onSaveEgnyteFolder={saveInvoiceProjectEgnyteFolder}
            onNotesChanged={(id, log) =>
              setInvoice(rows => rows.map(r => r.id === id ? { ...r, notesLog: log } : r))}
            canEditMsmm={isAdmin}
            onBlockedMsmmEdit={() => showToast("MSMM values are auto-calculated — only an admin can edit them. Edit the Total (or a sub) instead.", "lock")}
            billingMode="between"
            onResume={resumeInvoiceProject}
            onCloseOutRow={r => triggerForward(r, "invoice", "closed")}/>
        )}
        {tab === "projects" && (
          <ProjectsTable
            items={projectItems}
            updateRow={updateProjectItemRow}
            onOpenProject={(row) => setDetailProject(row)}
            onOpenDrawer={r => openDrawer(r, "projects")}
            onAddChild={(parentId) => openNewProject(parentId)}
            onDelete={deleteProjectItemRow}
            companies={companies}
            users={getUsers()}
            activeFilter={filterKey.projects}
            onFilterChange={(k) => setFilterKey(f => ({ ...f, projects: k }))}
            filterChips={FILTER_CHIPS.projects}
            flashId={flashId}
            tab="projects"/>
        )}
        {tab === "events" && (
          <>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
              <div className="events-view-toggle" role="tablist" aria-label="Events view">
                <button
                  className={eventsViewMode === "list" ? "active" : ""}
                  onClick={() => setEventsViewMode("list")}
                  role="tab"
                  aria-selected={eventsViewMode === "list"}
                >
                  <Icon name="columns" size={12}/> List
                </button>
                <button
                  className={eventsViewMode === "calendar" ? "active" : ""}
                  onClick={() => setEventsViewMode("calendar")}
                  role="tab"
                  aria-selected={eventsViewMode === "calendar"}
                >
                  <Icon name="calendar" size={12}/> Calendar
                </button>
              </div>
            </div>
            {eventsViewMode === "list" ? (
              <EventsTable rows={filtered.events}
                updateRow={updateEvents}
                onOpenDrawer={r => openDrawer(r, "events")}
                onAlert={r => setAlertObj({ row: r, tab: "events" })}
                flashId={flashId}
                filters={chipsFor("events")}
                tab="events"
                yearOptions={availableYears.events}
                yearValue={yearFilter.events}
                onYearChange={(y) => setYear("events", y)}/>
            ) : (
              <EventsCalendar
                events={events}
                onOpenDrawer={r => openDrawer(r, "events")}
                onCreateAtSlot={({ start }) => {
                  const pad = (n) => String(n).padStart(2, "0");
                  const iso = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`;
                  setCreateSeed({ event_datetime: iso });
                  setCreateTable("events");
                }}
                viewMode={calendarViewMode}
                setViewMode={setCalendarViewMode}
                isAdmin={isAdmin}
                onSyncNow={handleOutlookSync}
                syncing={outlookSyncing}
              />
            )}
          </>
        )}
        {tab === "hotleads" && (
          <>
            {/* "What's next" dashboard above the data table — splits upcoming
                Scheduled leads by type so Engineering vs AI work-streams are
                instantly visible. Uses the filtered rows so the user's year
                filter / search context still applies. */}
            <HotLeadsQuickView
              rows={filtered.hotleads}
              onOpenDrawer={r => openDrawer(r, "hotleads")}
            />
            <HotLeadsTable rows={filtered.hotleads}
              updateRow={updateHotLeads}
              onOpenDrawer={r => openDrawer(r, "hotleads")}
              onForward={r => triggerForward(r, "hotleads", "awaiting")}
              onAlert={r => setAlertObj({ row: r, tab: "hotleads" })}
              flashId={flashId}
              filters={chipsFor("hotleads")}
              tab="hotleads"
              yearOptions={availableYears.hotleads}
              yearValue={yearFilter.hotleads}
              onYearChange={(y) => setYear("hotleads", y)}/>
          </>
        )}
        {tab === "directory" && (
          <DirectoryTable rows={filtered.directory}
            updateRow={(id, patch) => {
              // Route to the right updater by row.type. Looking up the row
              // in clients vs companies state slices keeps the existing
              // updater contracts unchanged.
              const inClients = clients.some(c => c.id === id);
              if (inClients) updateClients(id, patch);
              else updateCompanies(id, patch);
            }}
            onOpenDrawer={r => openDrawer(r, "directory")}
            projectsByType={{ potential, awaiting, awarded, closed }}
            invoice={invoice}
            onOpenProject={(projectId, statusKey) => {
              const slice =
                statusKey === "potential" ? potential :
                statusKey === "awaiting"  ? awaiting  :
                statusKey === "awarded"   ? awarded   :
                statusKey === "closed"    ? closed    : [];
              const target = slice.find(p => p.id === projectId);
              if (!target) return;
              setTab(statusKey);
              setDrawer({ row: target, table: statusKey });
            }}
            flashId={flashId}
            filters={chipsFor("directory")}
            onMerge={(entities, kind) => setMergeModal({ entities, kind })}
            mergeResetKey={mergeResetKey}
            tab="directory"/>
        )}
        {tab === "licenses" && <LicensesTab/>}

        {tab === "timesheet" && (
          <TimesheetTab focusDate={timesheetFocusDate}/>
        )}

        {tab === "time-admin" && isAdmin && (
          <TimeAdminTab
            // The per-user day drill-down is now handled in-place by TimeAdminTab's
            // <UserDayModal/>. We keep this hook around so external callers (e.g.
            // future deep links) can still seed the focus date if useful.
            onOpenUserDay={({ date }) => setTimesheetFocusDate(date)}
          />
        )}

        {tab === "team-cal" && (
          <TeamCalendarTab />
        )}
        </>)}
      </div>

      {drawer && (() => {
        // Look up the LATEST row from state so in-drawer edits (e.g. adding
        // a sub) re-render the drawer with the updated data. drawer.row is
        // captured at open-time and would otherwise go stale after onUpdate.
        const pool = (
          drawer.table === "potential" ? potential :
          drawer.table === "awaiting"  ? awaiting  :
          drawer.table === "awarded"   ? awarded   :
          drawer.table === "closed"    ? closed    :
          drawer.table === "invoice"   ? invoice   :
          drawer.table === "events"    ? events    :
          drawer.table === "hotleads"  ? hotLeads  :
          drawer.table === "directory" ? [...clients, ...companies] :
          drawer.table === "projects"  ? projectItems :
          []
        );
        const liveRow = pool.find(r => r.id === drawer.row.id) || drawer.row;

        // For Directory rows, compute the linked-projects list once per
        // open and pass it into the drawer. Includes invoice linkage so the
        // drawer can render the small INV badge on rows that have one.
        const linkedProjects = drawer.table === "directory"
          ? linkedProjectsFor(liveRow, { potential, awaiting, awarded, closed }, invoice)
          : null;

        // For Invoice rows, look up the linked project's subs so the
        // drawer can render the LinkedSubsSection. Empty array if the
        // invoice isn't linked.
        const linkedSubs = drawer.table === "invoice" && liveRow.sourceId
          ? (() => {
              const proj = potential.find(p => p.id === liveRow.sourceId)
                        || awaiting.find(p => p.id === liveRow.sourceId)
                        || awarded.find(p => p.id === liveRow.sourceId)
                        || closed.find(p => p.id === liveRow.sourceId);
              return proj?.subs || [];
            })()
          : [];

        return (
        <DetailDrawer
          row={liveRow}
          table={drawer.table}
          onClose={() => setDrawer(null)}
          onUpdate={
            drawer.table === "potential" ? updatePotential :
            drawer.table === "awaiting"  ? updateAwaiting  :
            drawer.table === "awarded"   ? updateAwarded   :
            drawer.table === "closed"    ? updateClosed    :
            drawer.table === "invoice"   ? updateInvoice   :
            drawer.table === "events"    ? updateEvents    :
            drawer.table === "hotleads"  ? updateHotLeads  :
            drawer.table === "openbids"  ? updateOpenBids  :
            drawer.table === "projects"  ? updateProjectItemRow :
            drawer.table === "directory"
              ? (id, patch) => {
                  const inClients = clients.some(c => c.id === id);
                  if (inClients) updateClients(id, patch);
                  else updateCompanies(id, patch);
                }
              : () => {}
          }
          onForward={
            drawer.table === "awaiting"  ? () => { triggerForward(liveRow, "awaiting", "awarded"); setDrawer(null); } :
            drawer.table === "awarded"   ? () => { triggerForward(liveRow, "awarded", "invoice"); setDrawer(null); } :
            drawer.table === "potential" ? () => { triggerForward(liveRow, "potential", "invoice"); setDrawer(null); } :
            drawer.table === "hotleads"  ? () => { triggerForward(liveRow, "hotleads", "awaiting"); setDrawer(null); } :
            drawer.table === "openbids" && liveRow.approvalStatus === "approved"
              ? () => { triggerForward(liveRow, "openbids", "awaiting"); setDrawer(null); } :
            null
          }
          onAlert={(drawer.table === "openbids" || drawer.table === "projects") ? null : () => { setAlertObj({ row: liveRow, tab: drawer.table }); setDrawer(null); }}
          isAdmin={isAdmin}
          onApproveBid={
            drawer.table === "openbids" && isAdmin
              ? () => setBidApproval(liveRow.id, "approved")
              : null
          }
          onRejectBid={
            drawer.table === "openbids" && isAdmin
              ? () => setBidApproval(liveRow.id, "rejected")
              : null
          }
          onClearBidApproval={
            drawer.table === "openbids" && isAdmin
              && (liveRow.approvalStatus === "approved" || liveRow.approvalStatus === "rejected")
              ? () => setBidApproval(liveRow.id, "pending")
              : null
          }
          onUploadBidPdf={
            drawer.table === "openbids"
              ? (file) => uploadBidPdf(liveRow.id, file)
              : null
          }
          onRemoveBidPdf={
            drawer.table === "openbids" && liveRow.pdfPath
              ? () => removeBidPdf(liveRow.id)
              : null
          }
          onOpenBidPdf={
            drawer.table === "openbids" && liveRow.pdfPath
              ? () => openBidPdfInNewTab(liveRow)
              : null
          }
          onCloseOut={
            drawer.table === "invoice"
              ? () => { triggerForward(liveRow, "invoice", "closed"); setDrawer(null); }
              : null
          }
          onMoveBack={
            drawer.table === "closed"
              ? (destination) => { triggerForward(liveRow, "closed", destination); setDrawer(null); }
              : null
          }
          onDemoteFromOrange={null}
          onDelete={
            drawer.table === "invoice"
              ? () => {
                  if (!window.confirm(`Delete invoice row "${liveRow.name || ""}"? This cannot be undone.`)) return;
                  deleteInvoice(liveRow.id);
                  setDrawer(null);
                }
              : drawer.table === "events"
              ? () => {
                  const label = liveRow.title || liveRow.name || "this event";
                  if (!window.confirm(`Delete event "${label}"? This removes it from the calendar and the event list. This cannot be undone.`)) return;
                  deleteEvent(liveRow.id);
                  setDrawer(null);
                }
              : drawer.table === "hotleads"
              ? () => {
                  const label = liveRow.title || liveRow.name || "this lead";
                  if (!window.confirm(`Delete hot lead "${label}"? This cannot be undone.`)) return;
                  deleteHotLead(liveRow.id);
                  setDrawer(null);
                }
              : drawer.table === "openbids"
              ? () => {
                  const label = liveRow.rfqNumber || "this open bid";
                  if (!window.confirm(`Delete open bid "${label}"? This cannot be undone.`)) return;
                  deleteOpenBidRow(liveRow.id);
                  setDrawer(null);
                }
              : drawer.table === "projects"
              ? () => { deleteProjectItemRow(liveRow.id); setDrawer(null); }
              : null
          }
          projectItems={drawer.table === "projects" ? projectItems : undefined}
          onAddProjectSub={drawer.table === "projects"
            ? (companyId) => addProjectItemSubRow(liveRow.id, companyId) : undefined}
          onUpdateProjectSub={drawer.table === "projects"
            ? (companyId, patch) => updateProjectItemSubRow(liveRow.id, companyId, patch) : undefined}
          onRemoveProjectSub={drawer.table === "projects"
            ? (companyId) => removeProjectItemSubRow(liveRow.id, companyId) : undefined}
          onAddChild={drawer.table === "projects"
            ? () => { openNewProject(liveRow.id); setDrawer(null); } : undefined}
          linkedSubs={linkedSubs}
          onAddSub={drawer.table === "invoice"
            ? () => { setAddSubModal({ projectRow: liveRow }); }
            : undefined}
          linkedProjects={linkedProjects}
          onOpenProject={(projectId, statusKey) => {
            // Resolve which slice the project lives in, then swap the
            // drawer to that project + its tab. Switching `tab` keeps the
            // pipeline rail in sync with what's open.
            const slice =
              statusKey === "potential" ? potential :
              statusKey === "awaiting"  ? awaiting  :
              statusKey === "awarded"   ? awarded   :
              statusKey === "closed"    ? closed    : [];
            const target = slice.find(p => p.id === projectId);
            if (!target) return;
            setTab(statusKey);
            setDrawer({ row: target, table: statusKey });
          }}
        />
        );
      })()}

      {moving && (
        <MoveForwardPanel
          row={moving.row}
          from={moving.from}
          to={moving.to}
          onClose={() => setMoving(null)}
          onConfirm={confirmMove}/>
      )}

      {alert && (
        <AlertModal
          row={alert.row}
          anchors={getRowAnchors(alert.tab, alert.row)}
          onClose={() => setAlertObj(null)}
          onConfirm={confirmAlert}/>
      )}

      {createTable && (
        <CreateModal
          table={createTable}
          seed={createSeed}
          clients={clients}
          companies={companies}
          users={getUsers()}
          projectItems={projectItems}
          onClose={() => { setCreateTable(null); setCreateSeed(null); }}
          onCreated={(dbRow, extras) => handleCreated(createTable, dbRow, extras)}/>
      )}

      {addSubModal && (() => {
        const pr = addSubModal.projectRow;
        const modalKind = addSubModal.kind || "sub";
        // Find the project in any pipeline slice to count existing subs.
        // pr.sourceId may be null for unlinked invoices — that's expected;
        // the modal will auto-link on submit.
        const project = pr.sourceId && (
          potential.find(p => p.id === pr.sourceId)
          || awaiting.find(p => p.id === pr.sourceId)
          || awarded.find(p => p.id === pr.sourceId)
          || closed.find(p => p.id === pr.sourceId)
        );
        const existingSubsCount = project?.subs?.length || 0;

        return (
          <AddSubModal
            projectId={pr.sourceId}
            projectName={pr.name}
            existingSubsCount={existingSubsCount}
            companies={[...clients, ...companies]}
            invoiceId={pr.id}
            invoiceRow={pr}
            kind={modalKind}
            onClose={() => setAddSubModal(null)}
            onAdded={applyInsertedSub}
            onCompanyCreated={(uiRow) =>
              setCompanies(rs => rs.some(c => c.id === uiRow.id) ? rs : [uiRow, ...rs])}
          />
        );
      })()}

      {mergeModal && (
        <MergeModal
          entities={mergeModal.entities}
          kind={mergeModal.kind}
          projectsByType={{ potential, awaiting, awarded, closed }}
          invoice={invoice}
          hotLeads={hotLeads}
          openBids={openBids}
          onClose={() => setMergeModal(null)}
          onConfirm={handleMergeConfirm}
        />
      )}

      {filesModal && (() => {
        const { kind, projectRow, monthIdx, sub, companyId, companyName, yearRowId } = filesModal;
        const isParty = kind === "party-msmm" || kind === "party-prime" || kind === "party-sub";
        const isSub   = kind === "sub";
        // The window crosses calendar years — resolve which flat year-row this
        // cell belongs to. Prime: the resolved yearRowId. Sub: read byYear[year]
        // off the live sub entry. Party: the merged row's primary year row.
        const cellYear = filesModal.year ?? (projectRow?.year || THIS_YEAR);
        // Always re-read the invoice row from live state so file counts /
        // partyFiles annotations reflect the latest refresh. For prime month
        // files that's the resolved year-row; otherwise the merged primary row.
        const liveProjectRow =
          (yearRowId && invoice.find(r => r.id === yearRowId))
          || invoice.find(r => r.id === projectRow.id)
          || projectRow;
        if (isParty) {
          // Party mode: resolve the right bucket from partyFiles.
          const partyKind = kind === "party-msmm" ? "msmm" : kind === "party-prime" ? "prime" : "sub";
          const partyFilesForBucket = partyKind === "msmm"
            ? (liveProjectRow?.partyFiles?.msmm || [])
            : (liveProjectRow?.partyFiles?.[partyKind]?.[companyId] || []);
          return (
            <InvoiceFilesModal
              partyKind={partyKind}
              partyCompanyId={partyKind === "msmm" ? null : companyId}
              partyInvoiceId={liveProjectRow.id}
              projectId={liveProjectRow.sourceId}
              projectName={liveProjectRow.name}
              companyName={companyName}
              files={partyFilesForBucket}
              onClose={() => setFilesModal(null)}
              onChanged={refreshInvoiceArtifacts}
            />
          );
        }
        // Month-cell mode: resolve sub fresh from the live matrix, scoped to
        // the cell's year via byYear. Prime data comes off the resolved
        // year-row (liveProjectRow).
        const liveSub = isSub
          ? (subInvoices.get(projectRow.sourceId) || []).find(s => s.companyId === sub.companyId) || sub
          : null;
        const ysub = (isSub && liveSub?.byYear?.[cellYear]) || {};
        const filesForCell = isSub
          ? (ysub.files?.[monthIdx] || [])
          : (liveProjectRow?.primeFiles?.[monthIdx] || []);
        const cellAmount = isSub
          ? (ysub.amounts?.[monthIdx] ?? null)
          : (liveProjectRow?.values?.[monthIdx] ?? null);
        const cellPaid   = isSub ? !!(ysub.paid?.[monthIdx])    : false;
        const cellPaidAt = isSub ? (ysub.paidAt?.[monthIdx] || null) : null;
        return (
          <InvoiceFilesModal
            kind={kind}
            projectId={projectRow.sourceId}
            projectName={projectRow.name}
            year={cellYear}
            monthIdx={monthIdx}
            files={filesForCell}
            amount={cellAmount}
            paid={cellPaid}
            paidAt={cellPaidAt}
            primeInvoiceId={!isSub ? liveProjectRow.id : undefined}
            subInvoiceId={isSub ? ysub.subInvoiceIds?.[monthIdx] : undefined}
            companyId={isSub ? liveSub?.companyId : undefined}
            companyName={isSub ? liveSub?.companyName : undefined}
            invoiceNumber={!isSub ? (liveProjectRow?.invoiceNumbers?.[monthIdx] || "") : undefined}
            onSaveInvoiceNumber={!isSub
              ? (val) => updateInvoiceMonthInvoiceNumber(liveProjectRow.id, monthIdx, val)
              : undefined}
            canUntickPaid={isAdmin}
            onRequestUntick={requestPaidUntick}
            canAttach={!ATTACH_ONLY_ON_ACTUAL || isActualInvoiceMonth(cellYear, monthIdx)}
            onClose={() => setFilesModal(null)}
            onChanged={refreshInvoiceArtifacts}
          />
        );
      })()}

      {confirmState && (
        <ConfirmDialog
          {...confirmState}
          onConfirm={confirmState.onConfirm}
          onClose={() => setConfirmState(null)}
        />
      )}

      {toast && (
        <div className="toast">
          <span className="toast-icon"><Icon name={toast.icon} size={11} stroke={2.2}/></span>
          <span className="toast-msg">{toast.msg}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                const fn = toast.action.onClick;
                dismissToast();
                fn?.();
              }}
            >
              <Icon name={toast.action.icon || "undo"} size={11} stroke={2.2}/>
              {toast.action.label}
            </button>
          )}
        </div>
      )}

      {passwordModalOpen && (
        <OwnPasswordModal
          user={currentUser}
          onClose={() => setPasswordModalOpen(false)}
          onSubmit={async (currentPassword, newPassword) => {
            await changeOwnPassword(currentUser?.email, currentPassword, newPassword);
            showToast("Password updated", "check");
          }}
        />
      )}

      {adminOpen && isAdmin && (
        <AdminPanel
          tweaks={tweaks}
          setTweak={setTweak}
          currentUser={currentUser}
          onClose={() => setAdminOpen(false)}
          appSettings={appSettings}
          onAppSettingsChange={setAppSettings}
          onRosterChange={async () => {
            setRosterTick(t => t + 1);
            // If the admin edited themselves (role change, ban) we want the
            // topbar / isAdmin gate to reflect the new state right away.
            onRefreshCurrentUser?.();
          }}
          // Keyed by beacon_v2.alert_subject_enum value (4 values: project,
          // invoice, event, lead). AlertsAdmin looks up each alert's subject
          // row to render its name/number; for `project` alerts it also reads
          // the project's `status` to deep-link to the right pipeline tab.
          alertSubjectLookup={{
            project:    Object.fromEntries(
              [...(potential || []), ...(awaiting || []), ...(awarded || []), ...(closed || [])]
                .map(r => [r.id, r])
            ),
            invoice:    Object.fromEntries((invoice  || []).map(r => [r.id, r])),
            event:      Object.fromEntries((events   || []).map(r => [r.id, r])),
            lead:       Object.fromEntries((hotLeads || []).map(r => [r.id, r])),
          }}
        />
      )}
      {tweaksOpen && (
        <TweaksPanel tweaks={tweaks} setTweak={setTweak} onClose={() => setTweaksOpen(false)}/>
      )}

      {/* PWA update prompt — bottom-right floating toast when a new SW is waiting. */}
      <PwaUpdateToast/>
    </div>
  );
}

// ======================================================================
// Root — auth gate + data bootstrap
// ======================================================================
// Boot sequence:
//   1. Apply saved tweaks (theme/density) so the login page matches the app.
//   2. Read the current Supabase session. If absent → LoginPage.
//   3. If present, resolve the beacon.users row (for role), then loadBeacon().
//   4. Subscribe to onAuthStateChange so SIGNED_OUT / SIGNED_IN events from
//      other tabs or the sign-out button flush state cleanly.
//
// The LoginPage calls onSignedIn(beaconUser); we reuse the same "hydrate"
// function so the post-login and cold-boot code paths stay identical.
// ======================================================================
export default function App() {
  const [phase, setPhase] = useState("booting");   // "booting" | "anon" | "loading" | "ready" | "error"
  const [error, setError] = useState(null);
  const [data, setData]   = useState(null);
  const [beaconUser, setBeaconUser] = useState(null);

  // Load the beacon workspace once we have a confirmed session + user row.
  const hydrate = async (bu) => {
    setBeaconUser(bu);
    setPhase("loading");
    try {
      const d = await loadBeacon();
      setData(d);
      setPhase("ready");
    } catch (err) {
      setError(err);
      setPhase("error");
    }
  };

  useEffect(() => {
    // Restore persisted tweaks so the login page itself matches the theme.
    try {
      const saved = JSON.parse(localStorage.getItem("beacon-tweaks") || "null");
      applyTweaks(saved || DEFAULT_TWEAKS);
    } catch { applyTweaks(DEFAULT_TWEAKS); }

    let cancelled = false;

    (async () => {
      const session = await getCurrentSession();
      if (cancelled) return;
      if (!session) { setPhase("anon"); return; }
      const bu = await fetchCurrentBeaconUser();
      if (cancelled) return;
      if (!bu) { setPhase("anon"); return; }
      hydrate(bu);
    })();

    // Cross-tab / background sign-out → kick user back to login.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setBeaconUser(null);
        setData(null);
        setPhase("anon");
      }
    });
    return () => { cancelled = true; sub?.subscription?.unsubscribe?.(); };
    // hydrate is stable (component-scope closure that only reads setters).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSignOut = async () => {
    await signOut();
    setBeaconUser(null);
    setData(null);
    setPhase("anon");
  };

  // Re-fetch the current beacon.users row — called after admin actions that
  // might touch the signed-in user (self-demote, self-ban, etc) so the topbar
  // + admin gate reflect reality without forcing a full reload.
  const refreshCurrentUser = async () => {
    const fresh = await fetchCurrentBeaconUser();
    if (fresh) setBeaconUser(fresh);
  };

  if (phase === "error") return <LoadingScreen error={error}/>;
  if (phase === "anon")  return <LoginPage onSignedIn={hydrate}/>;
  if (phase !== "ready" || !data) return <LoadingScreen/>;
  return (
    <BeaconApp
      initial={data}
      currentUser={beaconUser}
      onSignOut={handleSignOut}
      onRefreshCurrentUser={refreshCurrentUser}
    />
  );
}
