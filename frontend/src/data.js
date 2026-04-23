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
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "beacon.auth",
    detectSessionInUrl: false,
  },
});

// ----------------------------------------------------------------------
// Auth helpers
// ----------------------------------------------------------------------
// The auth flow:
//   1. User submits email + password on the login page.
//   2. signIn() resolves a Supabase session (or an error).
//   3. fetchCurrentBeaconUser() looks up the matching beacon.users row by
//      email so we know the app-level role (Admin / User) for this session.
//
// The beacon.users row is cached at module level (_currentBeaconUser) so any
// component can check the current user's role without re-querying.

let _currentBeaconUser = null;
export const getCurrentBeaconUser = () => _currentBeaconUser;
export const isAdmin = () => _currentBeaconUser?.role === "Admin";

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: String(email || "").trim().toLowerCase(),
    password: password || "",
  });
  if (error) return { ok: false, error };
  return { ok: true, session: data.session };
}

export async function signOut() {
  _currentBeaconUser = null;
  const { error } = await supabase.auth.signOut();
  return { ok: !error, error };
}

export async function getCurrentSession() {
  const { data } = await supabase.auth.getSession();
  return data?.session || null;
}

// ----------------------------------------------------------------------
// Admin panel helpers
// ----------------------------------------------------------------------
// Refresh the full beacon.users list and rebuild the module-level _users
// cache so PM pickers, attendee pickers, and lookups everywhere see changes
// after an admin action (add / rename / delete / role change).
export async function listAllUsersFull() {
  const { data, error } = await supabase
    .from("users")
    .select("id, email, first_name, last_name, display_name, short_name, login_name, role, is_enabled, auth_user_id, created_at, updated_at")
    .order("display_name");
  if (error) throw error;
  // Rebuild module cache so getUsers()/userById() reflect the new roster.
  _users = (data || []).map(adaptUser);
  return data || [];
}

// Thin wrapper around the admin-users Edge Function. Produces friendlier
// errors when the function isn't deployed or the caller isn't an Admin.
export async function adminAction(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke("admin-users", {
    body: { action, payload },
  });
  if (error) {
    // supabase-js v2 surfaces the function response body here when the
    // function returns a non-2xx. Unwrap it if present.
    let detail = error.message || "admin action failed";
    try {
      const ctx = error.context;
      const text = ctx && typeof ctx.text === "function" ? await ctx.text() : null;
      if (text) {
        try { detail = JSON.parse(text).error || text; }
        catch { detail = text; }
      }
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  if (data && data.ok === false) throw new Error(data.error || "admin action failed");
  return data;
}

// Resolve the beacon.users row for the currently-signed-in auth user.
// Matches first by auth_user_id (set by the backfill trigger / admin API),
// then falls back to a case-insensitive email match.
export async function fetchCurrentBeaconUser() {
  const { data: sess } = await supabase.auth.getSession();
  const authUser = sess?.session?.user;
  if (!authUser) { _currentBeaconUser = null; return null; }

  let row = null;
  // Try auth_user_id first — unique, and the trigger links on insert.
  {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("auth_user_id", authUser.id)
      .maybeSingle();
    if (!error && data) row = data;
  }
  // Fallback: email match (citext is case-insensitive but we lowercase anyway).
  if (!row && authUser.email) {
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .ilike("email", authUser.email)
      .maybeSingle();
    if (!error && data) row = data;
  }

  _currentBeaconUser = row;
  return row;
}

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

export const fmtMoney = (n, showCents = true) => {
  if (n == null || n === "") return "—";
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
// Alerts — anchor metadata per tab + tab → DB enum mapping
// ----------------------------------------------------------------------
// Each anchor entry has:
//   field    — beacon.<table> DB column name (snake_case); stored in
//              beacon.alerts.anchor_field.
//   uiField  — the camelCase key on the adapted UI row (see adapt* fns).
//   label    — friendly text shown in the modal anchor chip.
//   hasTime  — true when the source column is timestamptz so we can keep
//              the user's time; false for `date` columns (the modal fills
//              09:00 as the default wall-clock time).
const TAB_ANCHORS = {
  potential: [
    { field: "next_action_date",        uiField: "nextActionDate",        label: "Next action" },
  ],
  awaiting: [
    { field: "anticipated_result_date", uiField: "anticipatedResultDate", label: "Anticipated result" },
    { field: "date_submitted",          uiField: "dateSubmitted",         label: "Submitted" },
  ],
  awarded: [
    { field: "contract_expiry_date",    uiField: "contractExpiry",        label: "Contract expiry" },
    { field: "date_submitted",          uiField: "dateSubmitted",         label: "Submitted" },
  ],
  soq: [
    { field: "contract_expiry_date",    uiField: "contractExpiry",        label: "Contract expiry" },
    { field: "start_date",              uiField: "startDate",             label: "Start date" },
    { field: "date_submitted",          uiField: "dateSubmitted",         label: "Submitted" },
  ],
  closed: [
    { field: "date_closed",             uiField: "dateClosed",            label: "Closed" },
    { field: "date_submitted",          uiField: "dateSubmitted",         label: "Submitted" },
  ],
  events: [
    { field: "event_datetime",          uiField: "dateTime",              label: "Event time", hasTime: true },
    { field: "event_date",              uiField: "date",                  label: "Event date" },
  ],
  invoice: [],
};

// Returns [{field, uiField, label, hasTime, value}] for each anchor on this
// tab that actually has a value on the given row. Order matches TAB_ANCHORS
// (first entry = the "primary" anchor).
export function getRowAnchors(tab, row) {
  const anchors = TAB_ANCHORS[tab] || [];
  return anchors
    .map(a => ({ ...a, value: row?.[a.uiField] || "" }))
    .filter(a => a.value);
}

// UI tab key → beacon.alert_subject_enum value.
export const TAB_TO_SUBJECT_TABLE = {
  potential: "potential",
  awaiting:  "awaiting",
  awarded:   "awarded",
  soq:       "soq",
  closed:    "closed_out",
  invoice:   "invoice",
  events:    "event",
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

// Multi-PM — every join table can carry any number of PMs per project. Preserve
// join-row order as returned by PostgREST (stable across fetches for the same
// dataset; the DB doesn't record a per-row ord).
const allPms = (pms) => (pms || []).map(p => p.user_id).filter(Boolean);

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
    pmIds: allPms(r.pms),
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
    pmIds: allPms(r.pms),
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
    pmIds: allPms(r.pms),
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
    pmIds: allPms(r.pms),
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
    pmIds: allPms(r.pms),
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
    pmIds: allPms(r.pms),
    amount: r.contract_amount || 0,
    type: r.type || "ENG",
    remainingStart: r.msmm_remaining_to_bill_year_start || 0,
    values: [
      r.jan_amount, r.feb_amount, r.mar_amount, r.apr_amount,
      r.may_amount, r.jun_amount, r.jul_amount, r.aug_amount,
      r.sep_amount, r.oct_amount, r.nov_amount, r.dec_amount,
    ].map(v => v || 0),
    year: r.year,
    // NULL = use auto-calc; numeric = user has frozen the value.
    ytdActualOverride:   r.ytd_actual_override   ?? null,
    rollforwardOverride: r.rollforward_override  ?? null,
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

  // Reconcile the invariant: every probability=Orange Potential must have a
  // linked anticipated_invoice row for the current year. Seed data and
  // pre-fix edits can leave Orange potentials without a corresponding
  // Invoice row; this pass back-fills them silently on load so the Invoice
  // tab's orange-tinted entries are always in sync with the Potential tab.
  // Uniqueness on (source_potential_id, year) means concurrent loads can't
  // race into duplicates — a second insert would fail with a 409 and we
  // swallow that case without surfacing it.
  let reconciledInvoices = invoice;
  const linkedPotentialIds = new Set(
    invoice.map(r => r.source_potential_id).filter(Boolean)
  );
  const orphanOranges = potential.filter(p =>
    p.probability === "Orange" &&
    p.year === THIS_YEAR &&
    !linkedPotentialIds.has(p.id)
  );
  if (orphanOranges.length > 0) {
    const payloads = orphanOranges.map(p => ({
      source_potential_id: p.id,
      project_name: p.project_name,
      year: p.year,
      project_number: p.project_number || null,
      contract_amount: p.total_contract_amount ?? null,
    }));
    const { data: inserted, error } = await supabase
      .from("anticipated_invoice")
      .insert(payloads)
      .select("*, pms:anticipated_invoice_pms(user_id)");
    if (!error && inserted) {
      reconciledInvoices = [...invoice, ...inserted];
    } else if (error) {
      // Partial failures (e.g. a duplicate key race) still let the app boot;
      // the user will just see the pre-existing invoice list until next load.
      console.warn("[beacon] Orange Invoice reconciliation skipped:", error.message);
    }
  }

  return {
    potential: potential.map(adaptPotential),
    awaiting:  awaiting.map(adaptAwaiting),
    awarded:   awarded.map(adaptAwarded),
    closed:    closed.map(adaptClosed),
    invoices:  reconciledInvoices.map(adaptInvoice),
    events:    events.map(adaptEvent),
    soq:       soq.map(adaptSoq),
    clients:   _companies,
    users:     _users,
  };
}

// ----------------------------------------------------------------------
// Admin · Alerts — everything the AlertsAdmin panel needs.
// ----------------------------------------------------------------------
// beacon.alerts / alert_recipients / alert_fires are writable by authenticated
// users today (prototype RLS). The Edge Function (service role) is the only
// mover that dispatches email; all other mutations are plain PostgREST calls.

// One row per alert, newest first. Recipients + creator embedded.
export async function loadAdminAlerts() {
  const { data, error } = await supabase
    .from("alerts")
    .select(`
      id, subject_table, subject_row_id, first_fire_at, recurrence, recurrence_rule,
      message, is_active, anchor_field, anchor_offset_minutes, timezone, created_at,
      created_by,
      recipients:alert_recipients(user_id, users(id, display_name, first_name, email, is_enabled)),
      creator:created_by(id, display_name, first_name)
    `)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(a => ({
    ...a,
    creatorName: a.creator?.display_name || a.creator?.first_name || "",
    recipients: (a.recipients || []).map(r => r.users).filter(Boolean),
  }));
}

// Last N fires for one alert, newest first. Used by the expand-for-history UI.
export async function loadAlertFires(alertId, limit = 10) {
  const { data, error } = await supabase
    .from("alert_fires")
    .select("id, alert_id, scheduled_at, fired_at, status, error_message, attempts, created_at")
    .eq("alert_id", alertId)
    .order("scheduled_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// Summary counts for the Dispatch header strip. `lastTick` is the most recent
// fired_at across all fires — used as the LIVE indicator's "last tick" stamp.
export async function load24hVitals() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const head = { count: "exact", head: true };
  const [active, sent, failed, skipped, pending, lastTick] = await Promise.all([
    supabase.from("alerts").select("id", head).eq("is_active", true),
    supabase.from("alert_fires").select("id", head).eq("status", "sent").gte("fired_at", since),
    supabase.from("alert_fires").select("id", head).eq("status", "failed").gte("fired_at", since),
    supabase.from("alert_fires").select("id", head).eq("status", "skipped").gte("fired_at", since),
    supabase.from("alert_fires").select("id", head).eq("status", "pending"),
    supabase.from("alert_fires").select("fired_at").not("fired_at", "is", null)
      .order("fired_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return {
    active:   active.count   ?? 0,
    sent:     sent.count     ?? 0,
    failed:   failed.count   ?? 0,
    skipped:  skipped.count  ?? 0,
    pending:  pending.count  ?? 0,
    lastTick: lastTick.data?.fired_at || null,
  };
}

export async function setAlertActive(alertId, isActive) {
  const { error } = await supabase.from("alerts").update({ is_active: isActive }).eq("id", alertId);
  if (error) throw error;
}

export async function deleteAlert(alertId) {
  // FK cascade removes alert_recipients + alert_fires rows.
  const { error } = await supabase.from("alerts").delete().eq("id", alertId);
  if (error) throw error;
}

// Re-enqueue: insert a fresh pending alert_fires row at now(). The dispatcher
// picks it up on the next tick and retries with attempt-count = 1 (on fresh row).
export async function retryAlertFire(alertId) {
  const { error } = await supabase.from("alert_fires").insert({
    alert_id: alertId,
    scheduled_at: new Date().toISOString(),
    status: "pending",
  });
  if (error) throw error;
}

// Replace-entire-list semantics. Simpler than diffing and keeps the UI code
// trivial — the picker just hands us the full final list of user_ids.
export async function setAlertRecipients(alertId, userIds) {
  const { error: delErr } = await supabase.from("alert_recipients").delete().eq("alert_id", alertId);
  if (delErr) throw delErr;
  if (!userIds || userIds.length === 0) return;
  const rows = userIds.map(uid => ({ alert_id: alertId, user_id: uid }));
  const { error: insErr } = await supabase.from("alert_recipients").insert(rows);
  if (insErr) throw insErr;
}

// Admin-triggered manual tick. send-alert accepts either the service-role key
// (GitHub Actions) or an authenticated Admin session JWT (this code path).
// supabase.functions.invoke uses the caller's session by default.
export async function runAlertTickNow() {
  const { data, error } = await supabase.functions.invoke("send-alert", { body: {} });
  if (error) {
    // supabase-js puts the function's response body on error.context when non-2xx.
    let detail = error.message || "tick failed";
    try {
      const ctx = error.context;
      const text = ctx && typeof ctx.text === "function" ? await ctx.text() : null;
      if (text) { try { detail = JSON.parse(text).error || text; } catch { detail = text; } }
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return data; // { ok, processed, sent, failed, skipped, disabled? }
}
