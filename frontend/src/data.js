// Supabase client + data adapters + formatting helpers.
// All Supabase config comes from Vite env vars (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY).
// Copy `.env.example` → `.env.local` and fill in your own values.

import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!URL || !KEY) {
  throw new Error(
    "Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in frontend/.env.local"
  );
}

export const supabase = createClient(URL, KEY, {
  db: { schema: "beacon" },
  auth: { persistSession: false, autoRefreshToken: false },
});

// ----------------------------------------------------------------------
// Module-level caches — populated by loadBeacon(). Static for the session.
// Consumers read via companyById() / userById() / getCompanies() / getUsers().
// ----------------------------------------------------------------------
let _users = [];
let _companies = [];

export const getUsers     = () => _users;
export const getCompanies = () => _companies;                                         // merged (clients + companies) for generic lookups
export const getClientsOnly   = () => _companies.filter(c => c.type === "Client");     // beacon.clients rows
export const getCompaniesOnly = () => _companies.filter(c => c.type !== "Client");     // beacon.companies rows
export const userById     = (id) => _users.find(u => u.id === id);
export const companyById  = (id) => _companies.find(c => c.id === id);

// ----------------------------------------------------------------------
// Formatting
// ----------------------------------------------------------------------
export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const TODAY_MONTH = new Date().getMonth();
export const THIS_YEAR   = new Date().getFullYear();

export const mkId = () => "r_" + Math.random().toString(36).slice(2, 10);

export const fmtMoney = (n, showCents = false) => {
  if (n == null || n === "") return "—";
  if (n === 0) return "$0";
  return "$" + Number(n).toLocaleString("en-US", {
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
};

export const fmtDate = (iso) => {
  if (!iso) return "—";
  const s = String(iso).substr(0, 10);
  const [y, m, d] = s.split("-").map(Number);
  if (!y) return "—";
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

export const fmtDateTime = (iso) => {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (isNaN(dt)) return "—";
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " +
    dt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};

// ----------------------------------------------------------------------
// Adapters — DB row → UI row shape (matches the original prototype)
// ----------------------------------------------------------------------
const PM_COLORS = ["", "sage", "blue", "rose", "amber"];

function initialsFromName(name) {
  if (!name) return "??";
  return name.replace(/[^A-Za-z\s]/g, "").trim().split(/\s+/)
    .map(w => w[0]).slice(0, 2).join("").toUpperCase() || "??";
}

function adaptUser(u, i) {
  const display = u.display_name || [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.login_name || u.email;
  const short = u.short_name || display;
  return {
    id: u.id,
    name: display,
    shortName: short,
    initials: initialsFromName(short),
    color: PM_COLORS[i % PM_COLORS.length],
  };
}

function adaptClient(c) {
  return {
    id: c.id,
    // `name` keeps the merged form so existing consumers (project rows' Client column,
    // dropdowns, sub references) continue to show the full USACE — District label.
    name: c.district ? `${c.name} — ${c.district}` : c.name,
    baseName: c.name,
    district: c.district || "",
    type: "Client",
    contact: c.contact_person || "",
    email: c.email || "",
    phone: c.phone || "",
    address: c.address || "",
    notes: c.notes || "",
    orgType: c.org_type || "",
  };
}

function adaptCompany(c, typeMap) {
  return {
    id: c.id,
    name: c.name,
    type: c.is_msmm ? "Multiple" : (typeMap.get(c.id) || "Prime"),
    contact: c.contact_person || "",
    email: c.email || "",
    phone: c.phone || "",
    address: c.address || "",
    notes: c.notes || "",
  };
}

const adaptSubsCosted = (arr) =>
  (arr || [])
    .slice()
    .sort((a, b) => (a.ord || 0) - (b.ord || 0))
    .map(s => ({ cId: s.company_id, desc: s.discipline || "", amt: s.amount || 0 }));

const firstPm = (pms) => (pms && pms[0] ? pms[0].user_id : null);

function adaptPotential(r) {
  return {
    id: r.id,
    year: r.year,
    name: r.project_name,
    role: r.role,
    clientId: r.client_id || r.prime_company_id || null,
    amount: r.total_contract_amount,
    msmm: r.msmm_amount,
    subs: adaptSubsCosted(r.subs),
    pmId: firstPm(r.pms),
    notes: r.notes || "",
    dates: r.next_action_note || "",
    nextActionDate: r.next_action_date || "",
    projectNumber: r.project_number || "",
    probability: r.probability,
    anticipatedInvoiceStartMonth: r.anticipated_invoice_start_month ?? null,
  };
}

function adaptAwaiting(r) {
  return {
    id: r.id,
    year: r.year,
    name: r.project_name,
    role: r.prime_company_id ? "Sub" : "Prime",
    clientId: r.client_id,
    amount: null,
    msmm: r.msmm_remaining || 0,
    subs: (r.subs || []).map(s => ({ cId: s.company_id, desc: "", amt: 0 })),
    pmId: firstPm(r.pms),
    notes: r.notes || "",
    dates: "",
    projectNumber: r.project_number || "",
    status: "Awaiting Verdict",
    dateSubmitted: r.date_submitted || "",
    anticipatedResultDate: r.anticipated_result_date || "",
    clientContract: r.client_contract_number || "",
    msmmContract: r.msmm_contract_number || "",
    msmmUsed: r.msmm_used || 0,
    msmmRemaining: r.msmm_remaining || 0,
  };
}

function adaptSoq(r) {
  return {
    id: r.id,
    year: r.year,
    name: r.project_name,
    role: r.prime_company_id ? "Sub" : "Prime",
    clientId: r.client_id,
    amount: null,
    msmm: (r.msmm_used || 0) + (r.msmm_remaining || 0),
    subs: (r.subs || []).map(s => ({ cId: s.company_id, desc: "", amt: 0 })),
    pmId: firstPm(r.pms),
    notes: r.notes || "",
    dates: "",
    projectNumber: r.project_number || "",
    status: "SOQ",
    dateSubmitted: r.date_submitted || "",
    clientContract: r.client_contract_number || "",
    msmmContract: r.msmm_contract_number || "",
    msmmUsed: r.msmm_used || 0,
    msmmRemaining: r.msmm_remaining || 0,
    stage: r.stage?.name || "",
    details: r.details || "",
    pools: r.pool || "",
    startDate: r.start_date || "",
    contractExpiry: r.contract_expiry_date || "",
    recurring: r.recurring || "",
  };
}

function adaptAwarded(r) {
  return {
    id: r.id,
    year: r.year,
    name: r.project_name,
    role: r.prime_company_id ? "Sub" : "Prime",
    clientId: r.client_id,
    amount: null,
    msmm: (r.msmm_used || 0) + (r.msmm_remaining || 0),
    subs: (r.subs || []).map(s => ({ cId: s.company_id, desc: "", amt: 0 })),
    pmId: firstPm(r.pms),
    notes: "",
    dates: "",
    projectNumber: r.project_number || "",
    status: "Awarded",
    dateSubmitted: r.date_submitted || "",
    clientContract: r.client_contract_number || "",
    msmmContract: r.msmm_contract_number || "",
    msmmUsed: r.msmm_used || 0,
    msmmRemaining: r.msmm_remaining || 0,
    stage: r.stage?.name || "",
    details: r.details || "",
    pools: r.pool || "",
    contractExpiry: r.contract_expiry_date || "",
  };
}

function adaptClosed(r) {
  return {
    id: r.id,
    year: r.year,
    name: r.project_name,
    role: r.prime_company_id ? "Sub" : "Prime",
    clientId: r.client_id,
    amount: null,
    msmm: 0,
    subs: [],
    pmId: firstPm(r.pms),
    notes: r.notes || "",
    dates: "",
    projectNumber: r.project_number || "",
    status: "Closed Out",
    dateSubmitted: r.date_submitted || "",
    clientContract: r.client_contract_number || "",
    msmmContract: r.msmm_contract_number || "",
    dateClosed: r.date_closed || "",
    reason: r.reason_for_closure || "",
  };
}

function adaptInvoice(r) {
  return {
    id: r.id,
    sourceId: r.source_awarded_id,
    sourcePotentialId: r.source_potential_id || null,
    projectNumber: r.project_number || "",
    name: r.project_name,
    pmId: firstPm(r.pms),
    amount: r.contract_amount || 0,
    type: r.type || "ENG",
    remainingStart: r.msmm_remaining_to_bill_year_start || 0,
    values: [
      r.jan_amount, r.feb_amount, r.mar_amount, r.apr_amount,
      r.may_amount, r.jun_amount, r.jul_amount, r.aug_amount,
      r.sep_amount, r.oct_amount, r.nov_amount, r.dec_amount,
    ].map(v => v || 0),
    year: r.year,
  };
}

function adaptEvent(r) {
  return {
    id: r.id,
    date: r.event_date || "",
    status: r.status || "",
    type: r.type || "",
    title: r.title,
    dateTime: r.event_datetime || "",
    attendees: (r.attendees || []).map(a => a.user_id),
  };
}

// ----------------------------------------------------------------------
// loadBeacon — fetches everything in parallel, shapes into UI rows.
// ----------------------------------------------------------------------
async function pget(builder, label) {
  const { data, error } = await builder;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data || [];
}

export async function loadBeacon() {
  const [users, clients, companies, potential, awaiting, awarded, closed, invoice, events, soq] = await Promise.all([
    pget(supabase.from("users").select("*").order("display_name"), "users"),
    pget(supabase.from("clients").select("*").order("name"), "clients"),
    pget(supabase.from("companies").select("*").order("name"), "companies"),
    pget(
      supabase.from("potential_projects")
        .select("*, subs:potential_project_subs(ord,company_id,discipline,amount), pms:potential_project_pms(user_id)")
        .order("year", { ascending: false })
        .order("project_name"),
      "potential_projects"
    ),
    pget(
      supabase.from("awaiting_verdict")
        .select("*, subs:awaiting_verdict_subs(company_id), pms:awaiting_verdict_pms(user_id)")
        .order("date_submitted", { ascending: false, nullsFirst: false }),
      "awaiting_verdict"
    ),
    pget(
      supabase.from("awarded_projects")
        .select("*, stage:stage_id(name), subs:awarded_project_subs(company_id), pms:awarded_project_pms(user_id)")
        .order("year", { ascending: false })
        .order("project_name"),
      "awarded_projects"
    ),
    pget(
      supabase.from("closed_out_projects")
        .select("*, pms:closed_out_project_pms(user_id)")
        .order("date_closed", { ascending: false, nullsFirst: false }),
      "closed_out_projects"
    ),
    pget(
      supabase.from("anticipated_invoice")
        .select("*, pms:anticipated_invoice_pms(user_id)")
        .eq("year", THIS_YEAR)
        .order("project_name"),
      "anticipated_invoice"
    ),
    pget(
      supabase.from("events")
        .select("*, attendees:event_attendees(user_id)")
        .order("event_date", { ascending: false, nullsFirst: false }),
      "events"
    ),
    pget(
      supabase.from("soq")
        .select("*, stage:stage_id(name), subs:soq_subs(company_id), pms:soq_pms(user_id)")
        .order("year", { ascending: false })
        .order("project_name"),
      "soq"
    ),
  ]);

  _users = users.map(adaptUser);

  // Infer company role (Prime / Sub / Multiple) from observed usage across stages.
  const primeIds = new Set();
  const subIds = new Set();
  [...awarded, ...awaiting].forEach(r => {
    if (r.prime_company_id) primeIds.add(r.prime_company_id);
    (r.subs || []).forEach(s => subIds.add(s.company_id));
  });
  potential.forEach(r => {
    if (r.prime_company_id) primeIds.add(r.prime_company_id);
    (r.subs || []).forEach(s => { if (s.company_id) subIds.add(s.company_id); });
  });
  const typeMap = new Map();
  companies.forEach(c => {
    const isP = primeIds.has(c.id), isS = subIds.has(c.id);
    typeMap.set(c.id, (isP && isS) ? "Multiple" : isP ? "Prime" : isS ? "Sub" : "Prime");
  });

  _companies = [
    ...clients.map(adaptClient),
    ...companies.map(c => adaptCompany(c, typeMap)),
  ];

  return {
    potential: potential.map(adaptPotential),
    awaiting:  awaiting.map(adaptAwaiting),
    awarded:   awarded.map(adaptAwarded),
    closed:    closed.map(adaptClosed),
    invoices:  invoice.map(adaptInvoice),
    events:    events.map(adaptEvent),
    soq:       soq.map(adaptSoq),
    clients:   _companies,
    users:     _users,
  };
}
