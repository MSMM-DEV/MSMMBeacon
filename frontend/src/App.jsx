import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { Sparkline } from "./primitives.jsx";
import {
  PotentialTable, AwaitingTable, AwardedTable, ClosedTable,
  InvoiceTable, EventsTable, HotLeadsTable, ClientsTable, CompaniesTable,
} from "./tables.jsx";
import { QuadSheet } from "./quadsheet.jsx";
import { DetailDrawer, MoveForwardPanel, AlertModal } from "./panels.jsx";
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
  routeClientPick,
  supabase, signOut, getCurrentSession, fetchCurrentBeaconUser,
  getRowAnchors, TAB_TO_SUBJECT_TABLE,
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

// Display order differs from the move-forward flow: Invoice is shown first
// because it's what leadership looks at most. The actual pipeline (Potential
// → Awaiting Verdict → Awarded / Closed Out) keeps its → arrows; the Invoice
// tab sits in its own "head" group separated by a gap so no arrow implies
// a bogus Invoice → Potential flow.
const TAB_META = [
  { key: "invoice",   label: "Invoice",          stage: "stage-invoice",   group: "head" },
  { key: "potential", label: "Potential",        stage: "stage-potential", group: "pipeline" },
  { key: "awaiting",  label: "Awaiting Verdict", stage: "stage-awaiting",  group: "pipeline" },
  { key: "awarded",   label: "Awarded",          stage: "stage-awarded",   group: "pipeline" },
  { key: "closed",    label: "Closed Out",       stage: "stage-closed",    group: "pipeline" },
  // SOQ tab hidden from navigation per product direction — the `soq` table
  // and its data still exist in Supabase; we just don't surface them. To
  // bring the tab back, restore this entry + the {tab === "soq" && ...}
  // render block below, and re-add the SoqTable import.
  { key: "events",    label: "Events & Other",   stage: "stage-events",    group: "side" },
  { key: "hotleads",  label: "Hot Leads",        stage: "stage-events",    group: "side" },
  { key: "clients",   label: "Clients",          stage: "stage-clients",   group: "side" },
  { key: "companies", label: "Companies",        stage: "stage-clients",   group: "side" },
  { key: "quad",      label: "Quad Sheet",       stage: "stage-quad",      group: "side" },
];

const PAGE_META = {
  potential: { title: "Potential Projects", desc: "Opportunities and billing candidates. Add directly or copy from Awarded. Move forward to Invoice when ready to bill." },
  awaiting:  { title: "Awaiting Verdict", desc: "Entry point for submitted proposals. Add here, then mark as Awarded or Closed Out when the verdict lands." },
  awarded:   { title: "Awarded Projects", desc: "Won contracts. Move to Potential to track as a billing candidate, or directly to Invoice when billing starts." },
  soq:       { title: "SOQ", desc: "Statements of Qualifications — parallel to the pipeline. Grouped by org type." },
  closed:    { title: "Closed Out Projects", desc: "Archived. Losses, descopes, and completed engagements." },
  invoice:   { title: "Anticipated Invoice", desc: "Monthly billing — Actual and Projection split by today's date." },
  events:    { title: "Events & Other", desc: "Partner touchpoints, conferences, and meetings. Not linked to projects." },
  hotleads:  { title: "Hot Leads",      desc: "Early-stage opportunities and conversations before they become Potential Projects." },
  clients:   { title: "Clients", desc: "Organizations that hire us. Referenced by every project row's Client field." },
  companies: { title: "Companies", desc: "Firms we team with as Primes or Subs. Referenced by project Prime and Subs fields." },
  quad:      { title: "Quad Sheet", desc: "Executive snapshot for board members. Invoices, events, awaiting verdicts, and SOQs at a glance." },
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
  soq: {
    all:       () => true,
    recurring: r => r.recurring === "Yes" || r.recurring === "In Talks",
    expiring:  r => {
      if (!r.contractExpiry) return false;
      const days = (new Date(r.contractExpiry).getTime() - Date.now()) / 86400000;
      return days > 0 && days < 180;
    },
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
  clients: {
    all: () => true,
    federal: r => r.orgType === "Federal",
    state:   r => r.orgType === "State",
    city:    r => r.orgType === "City",
    parish:  r => r.orgType === "Parish",
    other:   r => !["Federal","State","City","Parish"].includes(r.orgType),
  },
  companies: {
    all: () => true,
    prime:    r => r.type === "Prime",
    sub:      r => r.type === "Sub",
    multiple: r => r.type === "Multiple",
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
  soq: [
    { key: "all",       label: "All" },
    { key: "recurring", label: "Recurring", icon: "clock" },
    { key: "expiring",  label: "Expiring soon", icon: "clock" },
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
  clients: [
    { key: "all",     label: "All" },
    { key: "federal", label: "Federal" },
    { key: "state",   label: "State" },
    { key: "city",    label: "City" },
    { key: "parish",  label: "Parish" },
    { key: "other",   label: "Other" },
  ],
  companies: [
    { key: "all",      label: "All" },
    { key: "prime",    label: "Primes" },
    { key: "sub",      label: "Subs" },
    { key: "multiple", label: "Multiple" },
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
  soq: [
    { label: "Year",              wMm: 14,  get: r => r.year },
    { label: "Project",                     get: r => r.name },
    { label: "Client",                      get: r => companyById(r.clientId)?.name || "" },
    { label: "Start Date",        wMm: 22,  get: r => fmtDate(r.startDate) },
    { label: "Expiry",            wMm: 22,  get: r => fmtDate(r.contractExpiry) },
    { label: "Recurring",         wMm: 22,  get: r => r.recurring || "" },
    { label: "Stage",                       get: r => r.stage || "" },
    { label: "Pool",                        get: r => r.pools || "" },
    { label: "Contract",          wMm: 26,  get: r => fmtMoney((r.msmmUsed || 0) + (r.msmmRemaining || 0)) },
    { label: "PM",                wMm: 22,  get: r => (r.pmIds || []).map(id => userById(id)?.name).filter(Boolean).join(", ") },
    { label: "Proj #",            wMm: 20,  get: r => r.projectNumber || "" },
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
  invoice: [
    { label: "Project",                     get: r => r.name },
    { label: "Type",              wMm: 14,  get: r => r.type || "" },
    { label: "PM",                wMm: 22,  get: r => (r.pmIds || []).map(id => userById(id)?.name).filter(Boolean).join(", ") },
    { label: "Contract",          wMm: 24,  get: r => fmtMoney(r.amount) },
    { label: "Remaining Jan 1",   wMm: 26,  get: r => fmtMoney(r.remainingStart) },
    ...MONTHS.map((m, i) => ({ label: m, wMm: 16, get: r => r.values[i] ? fmtMoney(r.values[i]) : "" })),
    { label: "YTD Actual",        wMm: 22,  get: r => fmtMoney(r.ytdActualOverride != null ? r.ytdActualOverride : r.values.slice(0, TODAY_MONTH + 1).reduce((a,b) => a+(b||0), 0)) },
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
    { label: "Title",                       get: r => r.title || "", wrap: true },
    { label: "Client / Firm",               get: r => companyById(r.clientId)?.name || "" },
    { label: "Date & Time",       wMm: 36,  get: r => fmtDateTime(r.dateTime) },
    { label: "Attendees",                   get: r => (r.attendees || []).map(uid => userById(uid)?.name).filter(Boolean).join(", ") },
    { label: "Notes",                       get: r => r.notes || "" },
  ],
  clients: [
    { label: "Name",                        get: r => r.baseName || r.name },
    { label: "District",                    get: r => r.district || "" },
    { label: "Org Type",          wMm: 22,  get: r => r.orgType || "" },
    { label: "Contact",                     get: r => r.contact || "" },
    { label: "Email",                       get: r => r.email || "" },
    { label: "Phone",             wMm: 28,  get: r => r.phone || "" },
    { label: "Location",                    get: r => r.address || "" },
    { label: "Notes",                       get: r => r.notes || "" },
    { label: "Projects",          wMm: 20,  get: r => countRefs(r.id) },
  ],
  companies: [
    { label: "Company",                     get: r => r.name },
    { label: "Type",              wMm: 22,  get: r => r.type || "" },
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
  if (table === "soq") {
    return {
      id: dbRow.id,
      year: dbRow.year,
      name: dbRow.project_name,
      role: dbRow.prime_company_id ? "Sub" : "Prime",
      clientId: dbRow.client_id || null,
      amount: null,
      msmm: (dbRow.msmm_used || 0) + (dbRow.msmm_remaining || 0),
      subs: extras.subs || [],
      pmIds: extras.pmIds || [],
      notes: dbRow.notes || "",
      dates: "",
      projectNumber: dbRow.project_number || "",
      status: "SOQ",
      dateSubmitted: dbRow.date_submitted || "",
      clientContract: dbRow.client_contract_number || "",
      msmmContract: dbRow.msmm_contract_number || "",
      msmmUsed: dbRow.msmm_used || 0,
      msmmRemaining: dbRow.msmm_remaining || 0,
      stage: "",
      details: dbRow.details || "",
      pools: dbRow.pool || "",
      startDate: dbRow.start_date || "",
      contractExpiry: dbRow.contract_expiry_date || "",
      recurring: dbRow.recurring || "",
    };
  }
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
      dateTime: dbRow.date_time || "",
      clientId: dbRow.client_id || dbRow.prime_company_id || null,
      notes: dbRow.notes || "",
      attendees: extras.attendees || [],
    };
  }
  if (table === "clients") {
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
  if (table === "companies") {
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
          {error ? "Couldn't load project data" : "Loading from beacon.*…"}
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
  const [tab, setTab] = useState(() => localStorage.getItem("beacon-tab") || "potential");
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
  const [soq,       setSoq]       = useState(initial.soq || []);
  const [closed,    setClosed]    = useState(initial.closed);
  const [invoice,   setInvoice]   = useState(initial.invoices);
  const [events,    setEvents]    = useState(initial.events);
  const [hotLeads,  setHotLeads]  = useState(initial.hotLeads || []);
  const [clients,   setClients]   = useState(() => getClientsOnly());
  const [companies, setCompanies] = useState(() => getCompaniesOnly());

  // Filter state (keyed by tab)
  const [filterKey, setFilterKey] = useState({
    potential: "all", awaiting: "all", awarded: "all", soq: "all", closed: "all",
    events: "all", hotleads: "all", clients: "all", companies: "all",
  });

  // Year filter state. null = All years; number = filter to that year. Default
  // is THIS_YEAR for every pipeline table so users see current-year data on
  // first load — clicking "All" in the Year menu clears to null.
  const [yearFilter, setYearFilter] = useState({
    potential: THIS_YEAR, awaiting: THIS_YEAR, awarded: THIS_YEAR, soq: THIS_YEAR,
    closed: THIS_YEAR, invoice: THIS_YEAR, events: THIS_YEAR,
    hotleads: THIS_YEAR,
  });
  const setYear = (t, y) => setYearFilter(f => ({ ...f, [t]: y }));

  // Overlays
  const [drawer, setDrawer] = useState(null);
  const [moving, setMoving] = useState(null);
  const [alert, setAlertObj] = useState(null);
  const [createTable, setCreateTable] = useState(null); // 'potential' | 'events' | 'clients' | 'companies' | null
  const [toast, setToast] = useState(null);
  const [flashId, setFlashId] = useState(null);

  const setTweak = (k, v) => setTweaks(t => ({ ...t, [k]: v }));

  const showToast = (msg, icon = "check") => {
    setToast({ msg, icon });
    setTimeout(() => setToast(null), 3200);
  };

  // =====================================================================
  // PERSISTENCE LAYER — every inline/drawer edit flows through these maps
  // and the patchTable / syncJoinUsers helpers, so changes survive a reload.
  // Fields not listed in a *_COLS map update local React state only; typical
  // exceptions are derived values (row.role on awaiting/awarded/closed/soq,
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
  const SOQ_COLS = {
    year: "year", name: "project_name",
    notes: "notes", projectNumber: "project_number",
    dateSubmitted: "date_submitted",
    clientContract: "client_contract_number", msmmContract: "msmm_contract_number",
    msmmUsed: "msmm_used", msmmRemaining: "msmm_remaining",
    details: "details", pools: "pool",
    startDate: "start_date", contractExpiry: "contract_expiry_date",
    recurring: "recurring",
    // stage skipped (same reason as AWARDED).
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
    "date_closed", "start_date", "contract_expiry_date",
    "event_date", "event_datetime", "date_time",
    "year", "total_contract_amount", "msmm_amount",
    "anticipated_invoice_start_month", "msmm_used", "msmm_remaining",
    "client_id",
    "role", "probability", "org_type", "status", "type", "recurring",
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
    patchTable("potential_projects", id, dbPatch);

    if ("pmIds" in patch) {
      syncJoinUsers(id, existing.pmIds, patch.pmIds,
        "potential_project_pms", "potential_project_id");
    }

    // Orange invariant: if probability transitions into Orange and no Invoice
    // row is linked yet, spawn one. Unique index on (source_potential_id,
    // year) guards against concurrent duplicates.
    if ("probability" in patch && patch.probability !== existing.probability) {
      const wasOrange = existing.probability === "Orange";
      const isNowOrange = patch.probability === "Orange";
      if (isNowOrange && !wasOrange) {
        const alreadyLinked = invoice.some(r => r.sourcePotentialId === id);
        if (!alreadyLinked) {
          (async () => {
            try {
              const invPayload = {
                source_potential_id: id,
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
                sourceId: null,
                sourcePotentialId: invRow.source_potential_id,
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
      }
    }
  };

  const updateAwaiting = (id, patch) => {
    const existing = awaiting.find(r => r.id === id);
    if (!existing) return;
    setAwaiting(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    const dbPatch = buildDbPatch(patch, AWAITING_COLS);
    if ("clientId" in patch) Object.assign(dbPatch, routeClientPick(patch.clientId));
    patchTable("awaiting_verdict", id, dbPatch);
    if ("pmIds" in patch) {
      syncJoinUsers(id, existing.pmIds, patch.pmIds,
        "awaiting_verdict_pms", "awaiting_verdict_id");
    }
  };

  const updateAwarded = (id, patch) => {
    const existing = awarded.find(r => r.id === id);
    if (!existing) return;
    setAwarded(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    const dbPatch = buildDbPatch(patch, AWARDED_COLS);
    if ("clientId" in patch) Object.assign(dbPatch, routeClientPick(patch.clientId));
    patchTable("awarded_projects", id, dbPatch);
    if ("pmIds" in patch) {
      syncJoinUsers(id, existing.pmIds, patch.pmIds,
        "awarded_project_pms", "awarded_project_id");
    }
  };

  const updateClosed = (id, patch) => {
    const existing = closed.find(r => r.id === id);
    if (!existing) return;
    setClosed(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    const dbPatch = buildDbPatch(patch, CLOSED_COLS);
    if ("clientId" in patch) Object.assign(dbPatch, routeClientPick(patch.clientId));
    patchTable("closed_out_projects", id, dbPatch);
    if ("pmIds" in patch) {
      syncJoinUsers(id, existing.pmIds, patch.pmIds,
        "closed_out_project_pms", "closed_out_project_id");
    }
  };

  const updateSoq = (id, patch) => {
    const existing = soq.find(r => r.id === id);
    if (!existing) return;
    setSoq(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    const dbPatch = buildDbPatch(patch, SOQ_COLS);
    if ("clientId" in patch) Object.assign(dbPatch, routeClientPick(patch.clientId));
    patchTable("soq", id, dbPatch);
    if ("pmIds" in patch) {
      syncJoinUsers(id, existing.pmIds, patch.pmIds, "soq_pms", "soq_id");
    }
  };

  const updateEvents = (id, patch) => {
    const existing = events.find(r => r.id === id);
    if (!existing) return;
    setEvents(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    patchTable("events", id, buildDbPatch(patch, EVENTS_COLS));
    if ("attendees" in patch) {
      syncJoinUsers(id, existing.attendees, patch.attendees,
        "event_attendees", "event_id");
    }
  };

  const updateHotLeads = (id, patch) => {
    const existing = hotLeads.find(r => r.id === id);
    if (!existing) return;
    setHotLeads(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
    const dbPatch = buildDbPatch(patch, HOT_LEADS_COLS);
    // Client-or-Firm picker: route the unified clientId to the right column.
    if ("clientId" in patch) Object.assign(dbPatch, routeClientPick(patch.clientId));
    patchTable("hot_leads", id, dbPatch);
    if ("attendees" in patch) {
      syncJoinUsers(id, existing.attendees, patch.attendees,
        "hot_lead_attendees", "hot_lead_id");
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

  const openDrawer = (row, table) => setDrawer({ row, table });
  const triggerForward = (row, fromTable, toTable) => setMoving({ row, from: fromTable, to: toTable });

  // When a deep-link pending row id is set, look it up in the current tab's
  // rows and open the drawer once found. Re-runs when rows update (covers the
  // slim chance that the row isn't in state yet at mount).
  useEffect(() => {
    if (!pendingFocusRowId) return;
    const rowsByTab = {
      potential, awaiting, awarded, soq, closed,
      invoice, events, clients, companies,
    };
    const rows = rowsByTab[tab] || [];
    const match = rows.find(r => r.id === pendingFocusRowId);
    if (match) {
      openDrawer(match, tab);
      setPendingFocusRowId(null);
    }
  }, [pendingFocusRowId, tab, potential, awaiting, awarded, soq, closed, invoice, events, clients, companies]);

  // Pipeline transitions. New flow (2026-04):
  //   Awaiting Verdict → Awarded (MOVE: row leaves Awaiting, appears in Awarded)
  //   Awaiting Verdict → Closed Out (MOVE)
  //   Awarded → Potential (COPY: Awarded stays as historical log; Potential
  //                        gets a new row representing it as a billing candidate)
  //   Awarded → Invoice  (COPY: Awarded stays; new Invoice row spawned)
  //   Potential → Invoice (COPY: Potential stays as a pipeline tracker;
  //                        new Invoice row spawned)
  // Orange-probability Potentials still auto-spawn an Invoice row at create
  // time (special-case shortcut — see handleCreated() below).
  const confirmMove = (newData) => {
    const { row, from, to } = moving;
    const newRow = { ...row, ...newData, id: mkId(), sourceId: row.id };

    if (from === "awaiting" && to === "awarded") {
      // MOVE: Awaiting row leaves; Awarded row lands. No auto-Invoice — user
      // explicitly moves from Awarded → Invoice when ready to bill.
      setAwarded(rs => [newRow, ...rs]);
      setAwaiting(rs => rs.filter(r => r.id !== row.id));
      setFlashId(newRow.id);
      showToast("Awarded · carried to Awarded Projects");
      setTab("awarded");
    } else if (from === "awaiting" && to === "closed") {
      setClosed(rs => [newRow, ...rs]);
      setAwaiting(rs => rs.filter(r => r.id !== row.id));
      setFlashId(newRow.id);
      showToast("Closed out · carried to Closed Out Projects");
      setTab("closed");
    } else if (from === "awarded" && to === "potential") {
      // COPY: Potential row gets its own id; sourceId points back to Awarded.
      setPotential(rs => [newRow, ...rs]);
      setFlashId(newRow.id);
      showToast("Tracked as Potential billing candidate");
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
      showToast("Invoice row created from Awarded project");
      setTab("invoice");
    } else if (from === "potential" && to === "invoice") {
      // COPY: Potential stays as a pipeline tracker; Invoice row spawned.
      const { _invoiceType, ...rest } = newRow;
      const invRow = {
        id: rest.id, sourceId: row.id, sourcePotentialId: row.id,
        projectNumber: rest.projectNumber, name: rest.name,
        pmIds: [...(rest.pmIds || [])], amount: rest.amount || 0,
        type: _invoiceType || "ENG",
        remainingStart: rest.msmm || 0,
        values: Array(12).fill(0),
      };
      setInvoice(rs => [invRow, ...rs]);
      setFlashId(invRow.id);
      showToast("Invoice row created from Potential");
      setTab("invoice");
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
    if (table === "soq")        setSoq(rs => [uiRow, ...rs]);
    if (table === "events")     setEvents(rs => [uiRow, ...rs]);
    if (table === "hotleads")   setHotLeads(rs => [uiRow, ...rs]);
    if (table === "clients")    setClients(rs => [uiRow, ...rs]);
    if (table === "companies")  setCompanies(rs => [uiRow, ...rs]);
    // Orange potential auto-creates an Anticipated Invoice row tagged with
    // source_potential_id so the Invoice tab picks up the stripe.
    if (table === "potential" && extras.invoiceRow) {
      const ir = extras.invoiceRow;
      const invUiRow = {
        id: ir.id,
        sourceId: null,
        sourcePotentialId: ir.source_potential_id || uiRow.id,
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
      soq:       uniq(soq),
      closed:    uniq(closed),
      invoice:   uniq(invoice),
      events:    uniqFromDate(events, "date"),
      hotleads:  uniqFromDate(hotLeads, "dateTime"),
    };
  }, [potential, awaiting, awarded, soq, closed, invoice, events, hotLeads]);

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
    return {
      potential: apply("potential", potential),
      awaiting:  apply("awaiting",  awaiting),
      awarded:   apply("awarded",   awarded),
      soq:       apply("soq",       soq),
      closed:    apply("closed",    closed),
      invoice:   applyYear("invoice", invoice),
      events:    apply("events",    events),
      hotleads:  apply("hotleads",  hotLeads),
      clients:   apply("clients",   clients),
      companies: apply("companies", companies),
    };
  }, [filterKey, yearFilter, potential, awaiting, awarded, soq, closed, invoice, events, hotLeads, clients, companies]);

  // Current tab's visible rows (for page-head Export and New button context)
  const currentRows = filtered[tab] || [];

  // Set of potential_project ids currently tagged probability=Orange. Invoice
  // rows whose sourcePotentialId is in this set are highlighted orange and
  // excluded from the "Total — excl. Orange" row.
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
          : (({potential,awaiting,awarded,closed,events,hotleads:hotLeads,clients,companies})[tabKey] || []).filter(FILTERS[tabKey][chip.key]).length)
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
    awarded: awarded.length, soq: soq.length, closed: closed.length,
    invoice: invoice.length, events: events.length,
    hotleads: hotLeads.length,
    clients: clients.length, companies: companies.length,
    quad: null,
  };

  const currentMeta = PAGE_META[tab];

  // Does the current tab support "New X"? Awaiting Verdict is a first-class
  // entry point (projects can start here without a prior Potential row).
  // Potential is ALSO an entry (opportunities scoped directly / billing
  // candidates added without going through the proposal stage). Awarded /
  // Closed Out / Invoice are only reached via Move Forward from an earlier
  // stage — no direct "New" button for those.
  const newForTab = { awaiting: "awaiting", potential: "potential", events: "events", hotleads: "hotleads", clients: "clients", companies: "companies" };
  const newTarget = newForTab[tab];
  const newLabel = tab === "events" ? "New event"
                 : tab === "hotleads" ? "New hot lead"
                 : tab === "clients" ? "New client"
                 : tab === "companies" ? "New company"
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
          {TAB_META.some(t => t.group === "head") && <div style={{ width: 24 }}/>}
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
          <div style={{ width: 24 }}/>
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
            {newTarget && (
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
                <div className="stat-val">{fmtMoney(s.val)}</div>
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
        {/* SOQ tab render removed from UI (see TAB_META comment above). */}
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
            yearOptions={availableYears.invoice}
            yearValue={yearFilter.invoice}
            onYearChange={(y) => setYear("invoice", y)}/>
        )}
        {tab === "events" && (
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
        )}
        {tab === "hotleads" && (
          <HotLeadsTable rows={filtered.hotleads}
            updateRow={updateHotLeads}
            onOpenDrawer={r => openDrawer(r, "hotleads")}
            flashId={flashId}
            filters={chipsFor("hotleads")}
            tab="hotleads"
            yearOptions={availableYears.hotleads}
            yearValue={yearFilter.hotleads}
            onYearChange={(y) => setYear("hotleads", y)}/>
        )}
        {tab === "clients" && (
          <ClientsTable rows={filtered.clients}
            updateRow={updateClients}
            onOpenDrawer={r => openDrawer(r, "clients")}
            projectsByType={{ potential, awaiting, awarded, closed }}
            flashId={flashId}
            filters={chipsFor("clients")}
            tab="clients"/>
        )}
        {tab === "companies" && (
          <CompaniesTable rows={filtered.companies}
            updateRow={updateCompanies}
            onOpenDrawer={r => openDrawer(r, "companies")}
            projectsByType={{ potential, awaiting, awarded, closed }}
            flashId={flashId}
            filters={chipsFor("companies")}
            tab="companies"/>
        )}
        {tab === "quad" && (
          <QuadSheet
            invoice={invoice}
            events={events}
            awaiting={awaiting}
            hotLeads={hotLeads}
            onOpen={(t, r) => openDrawer(r, t)}
          />
        )}
      </div>

      {drawer && (() => {
        // Look up the LATEST row from state so in-drawer edits (e.g. adding
        // a sub) re-render the drawer with the updated data. drawer.row is
        // captured at open-time and would otherwise go stale after onUpdate.
        const pool = (
          drawer.table === "potential" ? potential :
          drawer.table === "awaiting"  ? awaiting  :
          drawer.table === "awarded"   ? awarded   :
          drawer.table === "soq"       ? soq       :
          drawer.table === "closed"    ? closed    :
          drawer.table === "invoice"   ? invoice   :
          drawer.table === "events"    ? events    :
          drawer.table === "hotleads"  ? hotLeads  :
          drawer.table === "clients"   ? clients   :
          drawer.table === "companies" ? companies :
          []
        );
        const liveRow = pool.find(r => r.id === drawer.row.id) || drawer.row;
        return (
        <DetailDrawer
          row={liveRow}
          table={drawer.table}
          onClose={() => setDrawer(null)}
          onUpdate={
            drawer.table === "potential" ? updatePotential :
            drawer.table === "awaiting"  ? updateAwaiting  :
            drawer.table === "awarded"   ? updateAwarded   :
            drawer.table === "soq"       ? updateSoq       :
            drawer.table === "closed"    ? updateClosed    :
            drawer.table === "invoice"   ? updateInvoice   :
            drawer.table === "events"    ? updateEvents    :
            drawer.table === "hotleads"  ? updateHotLeads  :
            drawer.table === "clients"   ? updateClients   :
            drawer.table === "companies" ? updateCompanies :
            () => {}
          }
          onForward={
            drawer.table === "awaiting"  ? () => { triggerForward(liveRow, "awaiting", "awarded"); setDrawer(null); } :
            drawer.table === "awarded"   ? () => { triggerForward(liveRow, "awarded", "invoice"); setDrawer(null); } :
            drawer.table === "potential" ? () => { triggerForward(liveRow, "potential", "invoice"); setDrawer(null); } :
            null
          }
          onAlert={() => { setAlertObj({ row: liveRow, tab: drawer.table }); setDrawer(null); }}
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
          clients={clients}
          companies={companies}
          users={getUsers()}
          onClose={() => setCreateTable(null)}
          onCreated={(dbRow, extras) => handleCreated(createTable, dbRow, extras)}/>
      )}

      {toast && (
        <div className="toast">
          <span className="toast-icon"><Icon name={toast.icon} size={11} stroke={2.2}/></span>
          {toast.msg}
        </div>
      )}

      {adminOpen && isAdmin && (
        <AdminPanel
          tweaks={tweaks}
          setTweak={setTweak}
          currentUser={currentUser}
          onClose={() => setAdminOpen(false)}
          onRosterChange={async () => {
            setRosterTick(t => t + 1);
            // If the admin edited themselves (role change, ban) we want the
            // topbar / isAdmin gate to reflect the new state right away.
            onRefreshCurrentUser?.();
          }}
          // Keyed by beacon.alert_subject_enum value; AlertsAdmin looks up
          // each alert's subject row to render its name/number.
          alertSubjectLookup={{
            potential:  Object.fromEntries((potential || []).map(r => [r.id, r])),
            awaiting:   Object.fromEntries((awaiting  || []).map(r => [r.id, r])),
            awarded:    Object.fromEntries((awarded   || []).map(r => [r.id, r])),
            soq:        Object.fromEntries((soq       || []).map(r => [r.id, r])),
            closed_out: Object.fromEntries((closed    || []).map(r => [r.id, r])),
            invoice:    Object.fromEntries((invoice   || []).map(r => [r.id, r])),
            event:      Object.fromEntries((events    || []).map(r => [r.id, r])),
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
