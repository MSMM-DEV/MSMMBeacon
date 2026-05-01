import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { Sparkline } from "./primitives.jsx";
import {
  PotentialTable, AwaitingTable, AwardedTable, ClosedTable,
  InvoiceTable, EventsTable, HotLeadsTable, DirectoryTable,
} from "./tables.jsx";
// Note: SoqTable was removed — SOQ is no longer surfaced in v2.
// ClientsTable + CompaniesTable were merged into DirectoryTable.
import { QuadSheet } from "./quadsheet.jsx";
import { EventsCalendar } from "./events-calendar.jsx";
import { DetailDrawer, MoveForwardPanel, AlertModal, InvoiceFilesModal, AddSubModal } from "./panels.jsx";
import { TweaksPanel, applyTweaks } from "./tweaks.jsx";
import { CreateModal } from "./forms.jsx";
import { LoginPage } from "./login.jsx";
import { AdminPanel } from "./admin.jsx";
import { exportPDF } from "./utils/pdf.js";
import { getCurrentTableSnapshot } from "./table-state.js";
import {
  loadBeacon, fmtDate, fmtDateTime, fmtMoney, mkId,
  MONTHS, TODAY_MONTH, THIS_YEAR,
  getClientsOnly, getCompaniesOnly, getUsers, companyById, userById,
  routeClientPick, linkedProjectsFor,
  supabase, signOut, getCurrentSession, fetchCurrentBeaconUser,
  getRowAnchors, TAB_TO_SUBJECT_TABLE,
  runOutlookSyncNow, reloadEvents,
  upsertSubInvoiceAmount, reloadInvoiceArtifacts, addProjectSub, updateProjectSub, removeProjectSub,
  ensureSubInvoiceRow, setSubInvoicePaid,
  setProjectRole, setProjectPrimeCompany,
  findOrCreateProjectForInvoice, linkInvoiceToProject,
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

// Display order differs from the move-forward flow: Invoice is shown first
// because it's what leadership looks at most. The actual pipeline (Potential
// → Awaiting Verdict → Awarded / Closed Out) keeps its → arrows; the Invoice
// tab sits in its own "head" group separated by a gap so no arrow implies
// a bogus Invoice → Potential flow.
const TAB_META = [
  { key: "quad",      label: "Quad Sheet",       stage: "stage-quad",      group: "head" },
  { key: "awaiting",  label: "Awaiting Verdict", stage: "stage-awaiting",  group: "pipeline" },
  { key: "awarded",   label: "Awarded",          stage: "stage-awarded",   group: "pipeline" },
  { key: "closed",    label: "Closed Out",       stage: "stage-closed",    group: "pipeline" },
  { key: "potential", label: "Potential",        stage: "stage-potential", group: "pipeline" },
  { key: "invoice",   label: "Invoice",          stage: "stage-invoice",   group: "pipeline" },
  // SOQ was removed entirely in beacon_v2 (no table, no data).
  { key: "hotleads",  label: "Hot Leads",        stage: "stage-events",    group: "side" },
  { key: "events",    label: "Events & Other",   stage: "stage-events",    group: "side" },
  { key: "directory", label: "Directory",        stage: "stage-clients",   group: "side" },
];

const PAGE_META = {
  potential: { title: "Potential Projects", desc: "Opportunities and billing candidates. Add directly or copy from Awarded. Move forward to Invoice when ready to bill." },
  awaiting:  { title: "Awaiting Verdict", desc: "Entry point for submitted proposals. Add here, then mark as Awarded or Closed Out when the verdict lands." },
  awarded:   { title: "Awarded Projects", desc: "Won contracts. Move to Potential to track as a billing candidate, or directly to Invoice when billing starts." },
  closed:    { title: "Closed Out Projects", desc: "Archived. Losses, descopes, and completed engagements." },
  invoice:   { title: "Anticipated Invoice", desc: "Monthly billing — Actual and Projection split by today's date." },
  events:    { title: "Events & Other", desc: "Partner touchpoints, conferences, and meetings. Not linked to projects." },
  hotleads:  { title: "Hot Leads",      desc: "Early-stage opportunities and conversations before they become Potential Projects." },
  directory: { title: "Directory", desc: "Clients and companies on a single roster. Click a row to see every project they're linked to." },
  quad:      { title: "Quad Sheet", desc: "Executive snapshot for board members. Invoices, events, awaiting verdicts, and hot leads at a glance." },
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
const EXPORT_COLUMNS = {
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
    { label: "Status",            wMm: 28,  get: r => r.status || "Awaiting Verdict" },
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
    { label: "Proj #",            wMm: 20,  get: r => r.projectNumber || "" },
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
    { label: "Remaining Jan 1",   wMm: 28, wrap: true, halign: "right", get: r => fmtMoney(r.remainingStart) },
    ...MONTHS.map((m, i) => ({
      label: m, wMm: 20, wrap: true, halign: "right",
      get: r => r.values[i] ? fmtMoney(r.values[i]) : "",
    })),
    { label: "YTD Actual",        wMm: 24, wrap: true, halign: "right", get: r => fmtMoney(r.ytdActualOverride != null ? r.ytdActualOverride : r.values.slice(0, TODAY_MONTH + 1).reduce((a,b) => a+(b||0), 0)) },
    { label: "Rollforward",       wMm: 24, wrap: true, halign: "right", get: r => fmtMoney(r.rollforwardOverride != null ? r.rollforwardOverride : Math.max(0, (r.remainingStart || 0) - r.values.reduce((a,b) => a+(b||0), 0))) },
  ],
  events: [
    { label: "Date",              wMm: 22,  get: r => fmtDate(r.date) },
    { label: "Status",            wMm: 24,  get: r => r.status || "" },
    { label: "Type",              wMm: 22,  get: r => r.type || "" },
    { label: "Title",                       get: r => r.title || "" },
    { label: "Date & Time",       wMm: 36,  get: r => fmtDateTime(r.dateTime) },
    { label: "Attendees",                   get: r => (r.attendees || []).map(uid => userById(uid)?.name).filter(Boolean).join(", ") },
    { label: "Notes",                       get: r => r.notes || "" },
  ],
  hotleads: [
    { label: "Status",            wMm: 24,  get: r => r.status || "" },
    { label: "Title",                       get: r => r.title || "", wrap: true },
    { label: "Client / Firm",               get: r => companyById(r.clientId)?.name || "" },
    { label: "Date & Time",       wMm: 36,  get: r => fmtDateTime(r.dateTime) },
    { label: "Attendees",                   get: r => (r.attendees || []).map(uid => userById(uid)?.name).filter(Boolean).join(", ") },
    { label: "Notes",                       get: r => r.notes || "" },
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
};

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
      status: "Awaiting Verdict",
      dateSubmitted: dbRow.date_submitted || "",
      anticipatedResultDate: dbRow.anticipated_result_date || "",
      clientContract: dbRow.client_contract_number || "",
      msmmContract: dbRow.msmm_contract_number || "",
      msmmUsed: dbRow.msmm_used || 0,
      msmmRemaining: dbRow.msmm_remaining || 0,
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
    };
  }
  if (table === "hotleads") {
    return {
      id: dbRow.id,
      title: dbRow.title,
      status: dbRow.status || "Scheduled",
      dateTime: dbRow.date_time || "",
      clientId: dbRow.client_id || dbRow.prime_company_id || null,
      notes: dbRow.notes || "",
      attendees: extras.attendees || [],
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
            marginTop: 18, textAlign: "left", background: "#FFF", border: "1px solid #E6DFD1",
            borderRadius: 10, padding: 14, fontSize: 12, fontFamily: "var(--font-mono, monospace)",
            color: "#B86B66", maxHeight: 240, overflow: "auto",
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
    const saved = localStorage.getItem("beacon-tab") || "quad";
    // Migrate legacy values: the v2 UI merged clients + companies into
    // "directory" and dropped soq. Anyone whose last-used tab was one of
    // those lands on the new combined tab (or quad for soq).
    if (saved === "clients" || saved === "companies") return "directory";
    if (saved === "soq") return "quad";
    return saved;
  });
  // Deep-link landing: if the URL carries ?tab=X&rowId=Y (from an alert email),
  // record the row id until the target tab's rows are available, then auto-open
  // the detail drawer on it. Cleared after consumption so tab-switches don't
  // re-trigger.
  const [pendingFocusRowId, setPendingFocusRowId] = useState(null);

  useEffect(() => { localStorage.setItem("beacon-tab", tab); }, [tab]);
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
      const tabParam = params.get("tab");
      const rowParam = params.get("rowId");
      if (tabParam && TAB_META.some(t => t.key === tabParam)) setTab(tabParam);
      if (rowParam) setPendingFocusRowId(rowParam);
      if (tabParam || rowParam) {
        window.history.replaceState(null, "", window.location.pathname);
      }
    } catch { /* malformed params — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const [clients,   setClients]   = useState(() => getClientsOnly());
  const [companies, setCompanies] = useState(() => getCompaniesOnly());
  // Workspace-wide settings (singleton). Today: monthlyInvoiceBenchmark drives
  // the Quad Sheet's bar coloring (green when month total ≥ benchmark, red
  // when below). Updated locally + persisted by AdminPanel → Targets tab.
  const [appSettings, setAppSettings] = useState(
    initial.appSettings || { monthlyInvoiceBenchmark: null, updatedAt: null }
  );

  // Filter state (keyed by tab)
  const [filterKey, setFilterKey] = useState({
    potential: "all", awaiting: "all", awarded: "all", closed: "all",
    events: "all", hotleads: "all", directory: "all",
  });

  // Year filter state. null = All years; number = filter to that year. Default
  // is THIS_YEAR for every pipeline table so users see current-year data on
  // first load — clicking "All" in the Year menu clears to null.
  const [yearFilter, setYearFilter] = useState({
    potential: THIS_YEAR, awaiting: THIS_YEAR, awarded: THIS_YEAR,
    closed: THIS_YEAR, invoice: THIS_YEAR, events: THIS_YEAR,
    hotleads: THIS_YEAR,
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
  // NOTE on `clientId`: deliberately NOT in any *_COLS map. The UI's
  // clientId field is unified (adapter: client_id || prime_company_id) and
  // needs routing based on whether the picked UUID is actually a client or
  // a prime firm. Each updater calls routeClientPick(patch.clientId) and
  // merges the result into dbPatch after buildDbPatch runs.
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
  };
  // Hot Leads — like Events but with a client/company picker. `clientId` is
  // intentionally OMITTED from this map for the same reason as the project
  // tables (routed through routeClientPick to client_id or prime_company_id
  // based on which pool the UUID belongs to).
  const HOT_LEADS_COLS = {
    title: "title",
    status: "status",
    dateTime: "date_time",
    notes: "notes",
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

  // UI-field → DB-column whitelist for other editable Invoice cells. Any
  // key not in this map updates local state only (e.g. pmIds is managed
  // via the anticipated_invoice_pms join table, not columns on the row).
  const INVOICE_COL_MAP = {
    ytdActualOverride:   "ytd_actual_override",
    rollforwardOverride: "rollforward_override",
    name:                "project_name",
    projectNumber:       "project_number",
    amount:              "contract_amount",
    type:                "type",
    remainingStart:      "msmm_remaining_to_bill_year_start",
    year:                "year",
  };
  const updateInvoice = (id, patch) => {
    setInvoice(rows => rows.map(r => r.id === id ? { ...r, ...patch } : r));
    const dbPatch = {};
    for (const [uiKey, dbCol] of Object.entries(INVOICE_COL_MAP)) {
      if (uiKey in patch) dbPatch[dbCol] = patch[uiKey];
    }
    if (Object.keys(dbPatch).length === 0) return;
    supabase.from("anticipated_invoice").update(dbPatch).eq("id", id)
      .then(({ error }) => {
        if (error) showToast(`Save failed: ${error.message}`, "x");
      });
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

  // Sub-invoice cell edits + post-write refresh of the invoice artifacts.
  // The invoice rows + sub matrix get re-fetched together so primeFiles/files
  // stay in sync with whatever the user just saved.
  const refreshInvoiceArtifacts = async () => {
    try {
      const allProjects = [...potential, ...awaiting, ...awarded, ...closed];
      const allCompaniesOrClients = [...clients, ...companies];
      const { primeFilesByKey, subInvoicesMatrix } =
        await reloadInvoiceArtifacts(allProjects, allCompaniesOrClients);
      // Re-annotate primeFiles on existing invoice rows.
      setInvoice(rows => rows.map(inv => ({
        ...inv,
        primeFiles: Array.from({ length: 12 }, (_, i) =>
          primeFilesByKey.get(`${inv.id}:${i + 1}`) || []
        ),
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
  const setSubInvoicePaidStatus = async ({ projectId, companyId, monthIdx, paid, kind = "sub" }) => {
    try {
      const row = await ensureSubInvoiceRow({
        projectId, companyId,
        year: THIS_YEAR,
        month: monthIdx + 1,
        kind,
      });
      await setSubInvoicePaid(row.id, paid);
      setSubInvoices(prev => {
        const next = new Map(prev);
        const list = next.get(projectId);
        if (!list) return prev;
        const updated = list.map(s => {
          if (s.companyId !== companyId) return s;
          const newPaid     = [...(s.paid     || Array(12).fill(false))];
          const newPaidAt   = [...(s.paidAt   || Array(12).fill(null))];
          const newSubIds   = [...(s.subInvoiceIds || Array(12).fill(null))];
          newPaid[monthIdx] = paid;
          newPaidAt[monthIdx] = paid ? new Date().toISOString() : null;
          newSubIds[monthIdx] = row.id;
          return { ...s, paid: newPaid, paidAt: newPaidAt, subInvoiceIds: newSubIds };
        });
        next.set(projectId, updated);
        return next;
      });
    } catch (e) {
      showToast(`Mark ${paid ? "paid" : "pending"} failed: ${e?.message || e}`, "x");
    }
  };

  const updateSubInvoiceCell = async (projectId, companyId, monthIdx, value, kind = "sub") => {
    try {
      const cleaned = value === "" || value == null ? null : Number(value);
      await upsertSubInvoiceAmount({
        projectId, companyId,
        year: THIS_YEAR,
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
  const applyInsertedSub = ({ inserted, linkedProjectId, invoiceId, autoLinkedProject, kind }) => {
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
      const updated = { ...r, subs: [...(r.subs || []), newUiSub] };
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
      invoice, events, hotleads: hotLeads,
      directory: [...clients, ...companies],
    };
    const rows = rowsByTab[tab] || [];
    const match = rows.find(r => r.id === pendingFocusRowId);
    if (match) {
      openDrawer(match, tab);
      setPendingFocusRowId(null);
    }
  }, [pendingFocusRowId, tab, potential, awaiting, awarded, closed, invoice, events, hotLeads, clients, companies]);

  // Snapshot all pipeline slices so an Undo toast can restore them in one
  // shot if the user clicks Undo within ~10s of a move. Doesn't capture
  // DB-side state — branches that persist also pass an async DB reverser to
  // undoLastMove below.
  const buildPipelineSnapshot = () => ({
    potential, awaiting, awarded, closed, invoice,
  });
  const restorePipelineSnapshot = (snap) => {
    setPotential(snap.potential);
    setAwaiting(snap.awaiting);
    setAwarded(snap.awarded);
    setClosed(snap.closed);
    setInvoice(snap.invoice);
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

  // Pipeline transitions. New flow (2026-04):
  //   Awaiting Verdict → Awarded (MOVE: row leaves Awaiting, appears in Awarded)
  //   Awaiting Verdict → Closed Out (MOVE)
  //   Awarded → Potential (COPY: Awarded stays as historical log; Potential
  //                        gets a new row representing it as a billing candidate)
  //   Awarded → Invoice  (COPY: Awarded stays; new Invoice row spawned)
  //   Potential → Invoice (COPY: Potential stays as a pipeline tracker;
  //                        new Invoice row spawned)
  //   Invoice → Closed (PERSIST: project status flips to closed_out, invoice deleted)
  //   Closed → Awaiting / Awarded / Invoice (PERSIST: reopens a closed-out
  //                        project; flips status back, optionally re-spawns
  //                        an anticipated_invoice row)
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
      // COPY: Awarded stays; mint an Invoice row with Awarded-carried fields.
      const { _invoiceType, ...rest } = newRow;
      const invRow = {
        id: rest.id, sourceId: row.id,
        projectNumber: rest.projectNumber, name: rest.name,
        pmIds: [...(rest.pmIds || [])], amount: rest.amount || 0,
        type: _invoiceType || "ENG",
        remainingStart: rest.msmmRemaining || 0,
        values: Array(12).fill(0),
      };
      setInvoice(rs => [invRow, ...rs]);
      setFlashId(invRow.id);
      offerUndo("Invoice row created from Awarded project", snap, null);
      setTab("invoice");
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
      // The invoice row is removed from anticipated_invoice. The upstream
      // project (if any) flips status='closed_out' with date_closed and
      // reason_for_closure set; stage-specific fields disallowed on
      // closed_out are nulled to satisfy the projects_*_only_on_* check
      // constraints. If the invoice has no upstream project, a fresh
      // closed_out row is minted. Local state mirrors the DB.
      const sourceId = row.sourceId;
      const sourceRow = sourceId
        ? (awarded.find(r => r.id === sourceId)
           || potential.find(r => r.id === sourceId)
           || awaiting.find(r => r.id === sourceId)
           || closed.find(r => r.id === sourceId))
        : null;
      const prevInvoice = invoice;
      const prevPotential = potential;
      const prevAwaiting = awaiting;
      const prevAwarded = awarded;
      const prevClosed = closed;
      // Optimistic: remove the invoice + drop the source from any upstream
      // slice; landed-closed entry is added below once we know its id.
      setInvoice(rs => rs.filter(r => r.id !== row.id));
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
            .from("anticipated_invoice").delete().eq("id", row.id);
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
          // Undo: restore the previous project status + re-insert the
          // anticipated_invoice row. We capture the source row's status
          // (was 'awarded'/'potential'/'awaiting') so we can flip back to
          // exactly what it was. If the invoice had no upstream project
          // (closedId was minted), undoing deletes the freshly-created
          // closed_out project entirely.
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
              // Recreate the anticipated_invoice row with its original id so
              // the snapshot's invoice list lines up after the restore.
              const { error: invErr2 } = await supabase
                .from("anticipated_invoice").insert({
                  id: row.id,
                  source_project_id: sourceId || null,
                  project_name: row.name,
                  project_number: row.projectNumber || null,
                  year: row.year ?? null,
                  contract_amount: row.amount ?? null,
                  type: row.type || "ENG",
                  msmm_remaining_to_bill_year_start: row.remainingStart ?? null,
                  ytd_actual_override: row.ytdActualOverride ?? null,
                  rollforward_override: row.rollforwardOverride ?? null,
                });
              if (invErr2) throw invErr2;
              if ((row.pmIds || []).length > 0) {
                const { error: pmErr } = await supabase
                  .from("anticipated_invoice_pms")
                  .insert(row.pmIds.map(uid => ({
                    anticipated_invoice_id: row.id, user_id: uid,
                  })));
                if (pmErr) throw pmErr;
              }
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
        status: to === "awaiting" ? "Awaiting Verdict" : "Awarded",
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
              ? "Reopened to Awaiting Verdict"
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
      // Reopen as Active: project status flips back to 'awarded' AND a fresh
      // anticipated_invoice row is spawned with the carried fields. The
      // project re-appears in the Awarded tab too (consistent with how
      // awarded → invoice keeps the source visible).
      const invType  = newData._invoiceType || "ENG";
      const invAmt   = Number(newData._amount) || null;
      const invRem   = Number(newData._remaining) || null;
      // Local invoice row uses a temp id; replaced once we have the DB id.
      const tempInvId = mkId();
      const invRow = {
        id: tempInvId,
        sourceId: row.id,
        projectNumber: row.projectNumber || "",
        name: row.name,
        pmIds: [...(row.pmIds || [])],
        amount: invAmt || 0,
        type: invType,
        remainingStart: invRem || 0,
        values: Array(12).fill(0),
        year: row.year,
        ytdActualOverride: null,
        rollforwardOverride: null,
      };
      const reopenedAwarded = {
        ...row,
        id: row.id,
        status: "Awarded",
        dateClosed: "",
        reason: "",
        stage: "Multi-Use Contract",
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
    const uiRow = adaptInsertedRow(table, dbRow, extras);
    if (table === "potential")  setPotential(rs => [uiRow, ...rs]);
    if (table === "awaiting")   setAwaiting(rs => [uiRow, ...rs]);
    if (table === "events")     setEvents(rs => [uiRow, ...rs]);
    if (table === "hotleads")   setHotLeads(rs => [uiRow, ...rs]);
    if (table === "clients")    setClients(rs => [uiRow, ...rs]);
    if (table === "companies")  setCompanies(rs => [uiRow, ...rs]);
    if (table === "invoice")    setInvoice(rs => [uiRow, ...rs]);
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
        amount: ir.total_contract_amount ?? uiRow.amount ?? 0,
        type: "ENG",
        remainingStart: ir.msmm_amount ?? uiRow.msmm ?? 0,
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
    if (snap && snap.tab === tab && snap.visibleColumns && snap.processedRows) {
      cols = snap.visibleColumns
        .map(uc => defsByLabel.get(uc.label))
        .filter(Boolean);
      rows = snap.processedRows;
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
    const invoiceCellStyle = tab === "invoice"
      ? (row, _colIndex, col) => {
          const isOrangeRow = row?.sourceId && orangeSourceIds.has(row.sourceId);
          const label = col?.label;
          const monthIdx = MONTHS.indexOf(label);
          const isActualMonth = monthIdx >= 0 && monthIdx <= TODAY_MONTH;
          const isProjMonth   = monthIdx >= 0 && monthIdx > TODAY_MONTH;
          const isTotalCol    = label === "YTD Actual" || label === "Rollforward";
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
        format: tab === "invoice" ? "a3" : "a4",
        // Zebra striping fights the Invoice's per-cell fill palette
        // (actual amber, projection cream, orange tint) — turn it off
        // on Invoice so the colors read cleanly.
        alternateRows: tab !== "invoice",
      });
      showToast(`Exported ${rows.length} rows`, "export");
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
    };
  }, [potential, awaiting, awarded, closed, invoice, events, hotLeads]);

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
      invoice:   applyYear("invoice", invoice),
      events:    apply("events",    events),
      hotleads:  apply("hotleads",  hotLeads),
      directory: apply("directory", [...clients, ...companies]),
    };
  }, [filterKey, yearFilter, potential, awaiting, awarded, closed, invoice, events, hotLeads, clients, companies]);

  // Current tab's visible rows (for page-head Export and New button context)
  const currentRows = filtered[tab] || [];

  // Set of Potential project ids currently tagged probability=Orange. Invoice
  // rows whose `sourceId` (= anticipated_invoice.source_project_id) is in
  // this set are highlighted orange and excluded from the "Total — excl. Orange" row.
  const orangeSourceIds = useMemo(
    () => new Set(potential.filter(p => p.probability === "Orange").map(p => p.id)),
    [potential]
  );

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
              directory: [...clients, ...companies],
            })[tabKey] || []).filter(FILTERS[tabKey][chip.key]).length)
      : null,
    active: filterKey[tabKey] === chip.key,
    onClick: () => setFilterKey(f => ({ ...f, [tabKey]: chip.key })),
  }));

  const stats = useMemo(() => {
    const pot = potential.reduce((a,r) => a + (r.msmm || 0), 0);
    const awa = awaiting.reduce((a,r) => a + (r.msmm || 0), 0);
    const awd = awarded.reduce((a,r) => a + (r.msmmRemaining || 0), 0);
    const ytd = invoice.reduce((a,r) => a + r.values.slice(0, TODAY_MONTH + 1).reduce((x,y) => x + (y||0), 0), 0);
    return [
      { label: "Pipeline MSMM",       val: pot, sub: `${potential.length} potential`, spark: [3,4,3,5,4,6,7,8,7,9] },
      { label: "Awaiting verdict",    val: awa, sub: `${awaiting.length} submittals`, spark: [2,3,3,4,4,5,5,6,7,7] },
      { label: "Active backlog",      val: awd, sub: `${awarded.length} awarded`,     spark: [5,5,6,7,6,7,8,9,10,11] },
      { label: "YTD billed (actual)", val: ytd, sub: `Jan–${MONTHS[TODAY_MONTH]} ${THIS_YEAR}`, spark: [1,2,3,3,4,5,6,7,8,9] },
    ];
  }, [potential, awaiting, awarded, invoice]);

  const tabCounts = {
    potential: potential.length, awaiting: awaiting.length,
    awarded: awarded.length, closed: closed.length,
    invoice: invoice.length, events: events.length,
    hotleads: hotLeads.length,
    directory: clients.length + companies.length,
    quad: null,
  };

  const currentMeta = PAGE_META[tab];

  // Does the current tab support "New X"? Awaiting Verdict is a first-class
  // entry point (projects can start here without a prior Potential row).
  // Potential is ALSO an entry (opportunities scoped directly / billing
  // candidates added without going through the proposal stage). Awarded /
  // Closed Out / Invoice are only reached via Move Forward from an earlier
  // stage — no direct "New" button for those.
  // Directory's primary "New X" defaults to client (the more common entry).
  // Companies are typically created via the sub-picker on a project rather
  // than from this tab.
  const newForTab = { awaiting: "awaiting", potential: "potential", events: "events", hotleads: "hotleads", directory: "clients" };
  const newTarget = newForTab[tab];
  const newLabel = tab === "events" ? "New event"
                 : tab === "hotleads" ? "New hot lead"
                 : tab === "directory" ? "New client"
                 : tab === "awaiting" ? "New awaiting verdict"
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
          {TAB_META.filter(t => t.group === "head").map(t => (
            <button key={t.key}
              className={`tab ${t.stage} ${tab === t.key ? "active" : ""}`}
              onClick={() => setTab(t.key)} role="tab">
              <span className="dot"/>
              {t.label}
              <span className="count">{tabCounts[t.key]}</span>
            </button>
          ))}
          {TAB_META.some(t => t.group === "head") && <div style={{ width: 14 }}/>}
          {TAB_META.filter(t => t.group === "pipeline").map((t, i, arr) => (
            <React.Fragment key={t.key}>
              <button
                className={`tab ${t.stage} ${tab === t.key ? "active" : ""}`}
                onClick={() => setTab(t.key)}
                role="tab"
              >
                <span className="dot"/>
                {t.label}
                <span className="count">{tabCounts[t.key]}</span>
              </button>
              {i < arr.length - 1 && <span className="tab-sep">→</span>}
            </React.Fragment>
          ))}
          <div style={{ width: 14 }}/>
          {TAB_META.filter(t => t.group === "side").map(t => (
            <button key={t.key}
              className={`tab ${t.stage} ${tab === t.key ? "active" : ""}`}
              onClick={() => setTab(t.key)} role="tab">
              <span className="dot"/>
              {t.label}
              <span className="count">{tabCounts[t.key]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="page">
        <div className="page-head">
          <div>
            <h1 className="page-title">{currentMeta.title}</h1>
            <p className="page-desc">{currentMeta.desc}</p>
          </div>
          <div className="page-actions">
            <button className="btn sm" onClick={handleExport}>
              <Icon name="export" size={13}/>Export PDF
            </button>
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

        {["potential","awaiting","awarded","invoice"].includes(tab) && (
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
            onMoveToPotential={r => triggerForward(r, "awarded", "potential")}
            onAlert={r => setAlertObj({ row: r, tab: "awarded" })}
            flashId={flashId}
            filters={chipsFor("awarded")}
            tab="awarded"
            yearOptions={availableYears.awarded}
            yearValue={yearFilter.awarded}
            onYearChange={(y) => setYear("awarded", y)}/>
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
        {tab === "invoice" && (
          <InvoiceTable rows={filtered.invoice}
            updateInvoice={updateInvoiceCell}
            updateRow={updateInvoice}
            onOpenDrawer={r => openDrawer(r, "invoice")}
            onAlert={r => setAlertObj({ row: r, tab: "invoice" })}
            flashId={flashId}
            tab="invoice"
            orangeSourceIds={orangeSourceIds}
            subInvoices={subInvoices}
            onUpdateSubAmount={updateSubInvoiceCell}
            onTogglePaid={setSubInvoicePaidStatus}
            onOpenFiles={(payload) => setFilesModal(payload)}
            onAddSub={(projectRow, kind = "sub") => setAddSubModal({ projectRow, kind })}
            onUpdateSubMeta={updateSubMeta}
            onRemoveSub={removeSub}
            onChangeRole={setInvoiceRoleHandler}
            onNew={() => setCreateTable("invoice")}
            yearOptions={availableYears.invoice}
            yearValue={yearFilter.invoice}
            onYearChange={(y) => setYear("invoice", y)}/>
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
          <HotLeadsTable rows={filtered.hotleads}
            updateRow={updateHotLeads}
            onOpenDrawer={r => openDrawer(r, "hotleads")}
            onAlert={r => setAlertObj({ row: r, tab: "hotleads" })}
            flashId={flashId}
            filters={chipsFor("hotleads")}
            tab="hotleads"
            yearOptions={availableYears.hotleads}
            yearValue={yearFilter.hotleads}
            onYearChange={(y) => setYear("hotleads", y)}/>
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
            tab="directory"/>
        )}
        {tab === "quad" && (() => {
          // Build a project lookup so the receivables panel can resolve
          // project names + numbers + status from the projectId keys it
          // sees in subInvoices. Built inline (not memoized) — these
          // arrays only re-create when their slices change, and the panel
          // memoizes its pivot internally.
          const projectsById = new Map();
          for (const p of potential) projectsById.set(p.id, { name: p.name, projectNumber: p.projectNumber, year: p.year, statusKey: "potential" });
          for (const p of awaiting)  projectsById.set(p.id, { name: p.name, projectNumber: p.projectNumber, year: p.year, statusKey: "awaiting"  });
          for (const p of awarded)   projectsById.set(p.id, { name: p.name, projectNumber: p.projectNumber, year: p.year, statusKey: "awarded"   });
          for (const p of closed)    projectsById.set(p.id, { name: p.name, projectNumber: p.projectNumber, year: p.year, statusKey: "closed"    });
          return (
            <QuadSheet
              invoice={invoice}
              events={events}
              awaiting={awaiting}
              hotLeads={hotLeads}
              orangeSourceIds={orangeSourceIds}
              monthlyBenchmark={appSettings.monthlyInvoiceBenchmark}
              subInvoices={subInvoices}
              projectsById={projectsById}
              onOpen={(t, r) => openDrawer(r, t)}
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
          );
        })()}
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
            null
          }
          onAlert={() => { setAlertObj({ row: liveRow, tab: drawer.table }); setDrawer(null); }}
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
          onDemoteFromOrange={
            drawer.table === "invoice"
            && liveRow.sourceId
            && orangeSourceIds.has(liveRow.sourceId)
              ? () => {
                  if (!window.confirm(
                    `Demote "${liveRow.name || ""}" from Orange?\n\n`
                    + `The Invoice row will be removed and the project will `
                    + `reappear in Potential as "High" probability. You can `
                    + `change the probability afterward in the Potential drawer.`
                  )) return;
                  updatePotential(liveRow.sourceId, { probability: "High" });
                  setDrawer(null);
                  setTab("potential");
                }
              : null
          }
          onDelete={
            drawer.table === "invoice"
              ? () => {
                  if (!window.confirm(`Delete invoice row "${liveRow.name || ""}"? This cannot be undone.`)) return;
                  deleteInvoice(liveRow.id);
                  setDrawer(null);
                }
              : null
          }
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
          />
        );
      })()}

      {filesModal && (() => {
        const { kind, projectRow, monthIdx, sub } = filesModal;
        const isSub = kind === "sub";
        // Resolve the sub fresh from the live matrix on every render so any
        // uploads / deletes / paid toggles surface immediately. Falls back
        // to the captured object if the matrix hasn't been refreshed yet.
        const liveSub = isSub
          ? (subInvoices.get(projectRow.sourceId) || []).find(s => s.companyId === sub.companyId) || sub
          : null;
        // Likewise for the prime row — re-read from the invoice slice so
        // primeFiles annotations are current.
        const liveProjectRow = isSub
          ? projectRow
          : (invoice.find(r => r.id === projectRow.id) || projectRow);
        const filesForCell = isSub
          ? (liveSub?.files?.[monthIdx] || [])
          : (liveProjectRow?.primeFiles?.[monthIdx] || []);
        const cellAmount = isSub
          ? (liveSub?.amounts?.[monthIdx] ?? null)
          : (liveProjectRow?.values?.[monthIdx] ?? null);
        const cellPaid   = isSub ? !!(liveSub?.paid?.[monthIdx])    : false;
        const cellPaidAt = isSub ? (liveSub?.paidAt?.[monthIdx] || null) : null;
        return (
          <InvoiceFilesModal
            kind={kind}
            projectId={liveProjectRow.sourceId}
            projectName={liveProjectRow.name}
            year={liveProjectRow.year || THIS_YEAR}
            monthIdx={monthIdx}
            files={filesForCell}
            amount={cellAmount}
            paid={cellPaid}
            paidAt={cellPaidAt}
            primeInvoiceId={!isSub ? liveProjectRow.id : undefined}
            subInvoiceId={isSub ? liveSub?.subInvoiceIds?.[monthIdx] : undefined}
            companyId={isSub ? liveSub?.companyId : undefined}
            companyName={isSub ? liveSub?.companyName : undefined}
            onClose={() => setFilesModal(null)}
            onChanged={refreshInvoiceArtifacts}
          />
        );
      })()}

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
