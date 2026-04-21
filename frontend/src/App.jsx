import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "./icons.jsx";
import { Sparkline } from "./primitives.jsx";
import {
  PotentialTable, AwaitingTable, AwardedTable, ClosedTable,
  InvoiceTable, EventsTable, ClientsTable, CompaniesTable,
} from "./tables.jsx";
import { DetailDrawer, MoveForwardPanel, AlertModal } from "./panels.jsx";
import { TweaksPanel, applyTweaks } from "./tweaks.jsx";
import { CreateModal } from "./forms.jsx";
import { exportPDF } from "./utils/pdf.js";
import { getCurrentTableSnapshot } from "./table-state.js";
import {
  loadBeacon, fmtDate, fmtDateTime, fmtMoney, mkId,
  MONTHS, TODAY_MONTH, THIS_YEAR,
  getClientsOnly, getCompaniesOnly, getUsers, companyById, userById,
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

const TAB_META = [
  { key: "potential", label: "Potential",        stage: "stage-potential", group: "pipeline" },
  { key: "awaiting",  label: "Awaiting Verdict", stage: "stage-awaiting",  group: "pipeline" },
  { key: "awarded",   label: "Awarded",          stage: "stage-awarded",   group: "pipeline" },
  { key: "closed",    label: "Closed Out",       stage: "stage-closed",    group: "pipeline" },
  { key: "invoice",   label: "Invoice",          stage: "stage-invoice",   group: "pipeline" },
  { key: "events",    label: "Events & Other",   stage: "stage-events",    group: "side" },
  { key: "clients",   label: "Clients",          stage: "stage-clients",   group: "side" },
  { key: "companies", label: "Companies",        stage: "stage-clients",   group: "side" },
];

const PAGE_META = {
  potential: { title: "Potential Projects", desc: "Opportunities being scoped and proposed. Move forward to submit." },
  awaiting:  { title: "Awaiting Verdict", desc: "Submitted proposals pending client decision. Mark as Awarded or Closed Out." },
  awarded:   { title: "Awarded Projects", desc: "Active engagements. Each has a matching row in the Anticipated Invoice." },
  closed:    { title: "Closed Out Projects", desc: "Archived. Losses, descopes, and completed engagements." },
  invoice:   { title: "Anticipated Invoice", desc: "Monthly billing — Actual and Projection split by today's date." },
  events:    { title: "Events & Other", desc: "Partner touchpoints, conferences, and meetings. Not linked to projects." },
  clients:   { title: "Clients", desc: "Organizations that hire us. Referenced by every project row's Client field." },
  companies: { title: "Companies", desc: "Firms we team with as Primes or Subs. Referenced by project Prime and Subs fields." },
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
    { label: "PM",                wMm: 22,  get: r => r._total ? "" : (userById(r.pmId)?.name || "") },
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
    { label: "Client Contract",   wMm: 28,  get: r => r.clientContract || "" },
    { label: "MSMM Contract",     wMm: 28,  get: r => r.msmmContract || "" },
    { label: "MSMM Remaining",    wMm: 26,  get: r => fmtMoney(r.msmmRemaining) },
    { label: "PM",                wMm: 22,  get: r => userById(r.pmId)?.name || "" },
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
    { label: "PM",                wMm: 22,  get: r => userById(r.pmId)?.name || "" },
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
    { label: "PM",                wMm: 22,  get: r => userById(r.pmId)?.name || "" },
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
    { label: "PM",                wMm: 22,  get: r => userById(r.pmId)?.name || "" },
    { label: "Contract",          wMm: 24,  get: r => fmtMoney(r.amount) },
    { label: "Remaining Jan 1",   wMm: 26,  get: r => fmtMoney(r.remainingStart) },
    ...MONTHS.map((m, i) => ({ label: m, wMm: 16, get: r => r.values[i] ? fmtMoney(r.values[i]) : "" })),
    { label: "YTD Actual",        wMm: 22,  get: r => fmtMoney(r.values.slice(0, TODAY_MONTH + 1).reduce((a,b) => a+(b||0), 0)) },
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
function adaptInsertedRow(table, dbRow) {
  if (table === "potential") {
    return {
      id: dbRow.id,
      year: dbRow.year,
      name: dbRow.project_name,
      role: dbRow.role || null,
      clientId: dbRow.client_id || null,
      amount: dbRow.total_contract_amount,
      msmm: dbRow.msmm_amount,
      subs: [],
      pmId: null,
      notes: dbRow.notes || "",
      dates: dbRow.next_action_note || "",
      projectNumber: dbRow.project_number || "",
      probability: dbRow.probability,
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
      attendees: [],
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
function BeaconApp({ initial }) {
  const [tweaks, setTweaks] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("beacon-tweaks") || "null");
      return saved || { ...DEFAULT_TWEAKS };
    } catch { return { ...DEFAULT_TWEAKS }; }
  });
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [tab, setTab] = useState(() => localStorage.getItem("beacon-tab") || "potential");

  useEffect(() => { localStorage.setItem("beacon-tab", tab); }, [tab]);
  useEffect(() => { localStorage.setItem("beacon-tweaks", JSON.stringify(tweaks)); }, [tweaks]);
  useEffect(() => { applyTweaks(tweaks); }, [tweaks]);

  // Data state
  const [potential, setPotential] = useState(initial.potential);
  const [awaiting,  setAwaiting]  = useState(initial.awaiting);
  const [awarded,   setAwarded]   = useState(initial.awarded);
  const [closed,    setClosed]    = useState(initial.closed);
  const [invoice,   setInvoice]   = useState(initial.invoices);
  const [events,    setEvents]    = useState(initial.events);
  const [clients,   setClients]   = useState(() => getClientsOnly());
  const [companies, setCompanies] = useState(() => getCompaniesOnly());

  // Filter state (keyed by tab)
  const [filterKey, setFilterKey] = useState({
    potential: "all", awaiting: "all", awarded: "all", closed: "all",
    events: "all", clients: "all", companies: "all",
  });

  // Year filter state. null = All years; number = filter to that year.
  const [yearFilter, setYearFilter] = useState({
    potential: null, awaiting: null, awarded: null, closed: null, invoice: null,
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

  // Local mutations — Supabase writes deferred for a later pass.
  const makeUpdate = (setter) => (id, patch) =>
    setter(rows => rows.map(r => r.id === id ? { ...r, ...patch } : r));
  const updatePotential = makeUpdate(setPotential);
  const updateAwaiting  = makeUpdate(setAwaiting);
  const updateAwarded   = makeUpdate(setAwarded);
  const updateClosed    = makeUpdate(setClosed);
  const updateEvents    = makeUpdate(setEvents);
  const updateClients   = makeUpdate(setClients);
  const updateCompanies = makeUpdate(setCompanies);

  const updateInvoiceCell = (id, monthIdx, v) => {
    setInvoice(rows => rows.map(r => {
      if (r.id !== id) return r;
      const nv = [...r.values];
      nv[monthIdx] = v || 0;
      return { ...r, values: nv };
    }));
  };

  const openDrawer = (row, table) => setDrawer({ row, table });
  const triggerForward = (row, fromTable, toTable) => setMoving({ row, from: fromTable, to: toTable });

  const confirmMove = (newData) => {
    const { row, from, to } = moving;
    const newRow = { ...row, ...newData, id: mkId(), sourceId: row.id };

    if (from === "potential" && to === "awaiting") {
      setAwaiting(rs => [newRow, ...rs]);
      setPotential(rs => rs.filter(r => r.id !== row.id));
      setFlashId(newRow.id);
      showToast("Submitted · carried to Awaiting Verdict");
      setTab("awaiting");
    } else if (from === "awaiting" && to === "awarded") {
      const { _invoiceType, ...rest } = newRow;
      setAwarded(rs => [rest, ...rs]);
      setAwaiting(rs => rs.filter(r => r.id !== row.id));
      const invRow = {
        id: mkId(), sourceId: rest.id,
        projectNumber: rest.projectNumber, name: rest.name,
        pmId: rest.pmId, amount: rest.amount || 0,
        type: _invoiceType || "ENG",
        remainingStart: rest.msmmRemaining || 0,
        values: Array(12).fill(0),
      };
      setInvoice(rs => [invRow, ...rs]);
      setFlashId(rest.id);
      showToast("Awarded · Invoice row auto-created");
      setTab("awarded");
    } else if (from === "awaiting" && to === "closed") {
      setClosed(rs => [newRow, ...rs]);
      setAwaiting(rs => rs.filter(r => r.id !== row.id));
      setFlashId(newRow.id);
      showToast("Closed out · carried to Closed Out Projects");
      setTab("closed");
    }
    setMoving(null);
    setTimeout(() => setFlashId(null), 1500);
  };

  const confirmAlert = (data) => {
    showToast(`Alert scheduled for ${data.recipients.length} user${data.recipients.length !== 1 ? "s" : ""} on ${fmtDate(data.date)}`, "bell");
    setAlertObj(null);
  };

  const handleCreated = (table, dbRow) => {
    const uiRow = adaptInsertedRow(table, dbRow);
    if (table === "potential")  setPotential(rs => [uiRow, ...rs]);
    if (table === "events")     setEvents(rs => [uiRow, ...rs]);
    if (table === "clients")    setClients(rs => [uiRow, ...rs]);
    if (table === "companies")  setCompanies(rs => [uiRow, ...rs]);
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
    return {
      potential: uniq(potential),
      awaiting:  uniq(awaiting),
      awarded:   uniq(awarded),
      closed:    uniq(closed),
      invoice:   uniq(invoice),
    };
  }, [potential, awaiting, awarded, closed, invoice]);

  // Apply year filter, then category filter.
  const filtered = useMemo(() => {
    const applyYear = (key, rows) => {
      const y = yearFilter[key];
      return y == null ? rows : rows.filter(r => r.year === y);
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
      closed:    apply("closed",    closed),
      invoice:   applyYear("invoice", invoice),
      events:    apply("events",    events),
      clients:   apply("clients",   clients),
      companies: apply("companies", companies),
    };
  }, [filterKey, yearFilter, potential, awaiting, awarded, closed, invoice, events, clients, companies]);

  // Current tab's visible rows (for page-head Export and New button context)
  const currentRows = filtered[tab] || [];

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
          : (({potential,awaiting,awarded,closed,events,clients,companies})[tabKey] || []).filter(FILTERS[tabKey][chip.key]).length)
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
    clients: clients.length, companies: companies.length,
  };

  const currentMeta = PAGE_META[tab];

  // Does the current tab support "New X"? (awaiting/awarded/closed come from move-forward; invoice is auto-created)
  const newForTab = { potential: "potential", events: "events", clients: "clients", companies: "companies" };
  const newTarget = newForTab[tab];
  const newLabel = tab === "events" ? "New event" : tab === "clients" ? "New client" : tab === "companies" ? "New company" : "New project";

  return (
    <div className="app">
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
          <button className="iconbtn" title="Tweaks" onClick={() => setTweaksOpen(v => !v)}>
            <Icon name="settings" size={16}/>
          </button>
          <div className="avatar" title="Signed-in user">RM</div>
        </div>
      </div>

      <div className="tabwrap">
        <div className="pipeline" role="tablist">
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
            onForward={r => triggerForward(r, "potential", "awaiting")}
            onAlert={r => setAlertObj({ row: r })}
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
            onAlert={r => setAlertObj({ row: r })}
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
            onAlert={r => setAlertObj({ row: r })}
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
            onAlert={r => setAlertObj({ row: r })}
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
            onAlert={r => setAlertObj({ row: r })}
            flashId={flashId}
            tab="invoice"
            yearOptions={availableYears.invoice}
            yearValue={yearFilter.invoice}
            onYearChange={(y) => setYear("invoice", y)}/>
        )}
        {tab === "events" && (
          <EventsTable rows={filtered.events}
            updateRow={updateEvents}
            onOpenDrawer={r => openDrawer(r, "events")}
            onAlert={r => setAlertObj({ row: r })}
            flashId={flashId}
            filters={chipsFor("events")}
            tab="events"/>
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
          drawer.table === "events"    ? events    :
          drawer.table === "clients"   ? clients   :
          drawer.table === "companies" ? companies :
          []
        );
        const liveRow = pool.find(r => r.id === drawer.row.id) || drawer.row;
        return (
        <DetailDrawer
          row={liveRow}
          table={drawer.table === "companies" ? "clients" : drawer.table}
          onClose={() => setDrawer(null)}
          onUpdate={
            drawer.table === "potential" ? updatePotential :
            drawer.table === "awaiting"  ? updateAwaiting  :
            drawer.table === "awarded"   ? updateAwarded   :
            drawer.table === "closed"    ? updateClosed    :
            drawer.table === "events"    ? updateEvents    :
            drawer.table === "clients"   ? updateClients   :
            drawer.table === "companies" ? updateCompanies :
            () => {}
          }
          onForward={
            drawer.table === "potential" ? () => { triggerForward(liveRow, "potential", "awaiting"); setDrawer(null); } :
            drawer.table === "awaiting"  ? () => { triggerForward(liveRow, "awaiting", "awarded"); setDrawer(null); } :
            null
          }
          onAlert={() => { setAlertObj({ row: liveRow }); setDrawer(null); }}
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
          onCreated={(dbRow) => handleCreated(createTable, dbRow)}/>
      )}

      {toast && (
        <div className="toast">
          <span className="toast-icon"><Icon name={toast.icon} size={11} stroke={2.2}/></span>
          {toast.msg}
        </div>
      )}

      {tweaksOpen && (
        <TweaksPanel tweaks={tweaks} setTweak={setTweak} onClose={() => setTweaksOpen(false)}/>
      )}
    </div>
  );
}

// ======================================================================
// Root
// ======================================================================
export default function App() {
  const [state, setState] = useState({ ready: false, error: null, data: null });

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("beacon-tweaks") || "null");
      applyTweaks(saved || DEFAULT_TWEAKS);
    } catch { applyTweaks(DEFAULT_TWEAKS); }

    loadBeacon()
      .then(data => setState({ ready: true, error: null, data }))
      .catch(err => setState({ ready: false, error: err, data: null }));
  }, []);

  if (state.error) return <LoadingScreen error={state.error}/>;
  if (!state.ready) return <LoadingScreen/>;
  return <BeaconApp initial={state.data}/>;
}
