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
  db: { schema: "beacon_v2" },
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
// Workspace-wide settings (singleton row from beacon_v2.app_settings). Refreshed
// on every loadBeacon and on every successful updateMonthlyBenchmark write so
// the in-memory copy never drifts from the DB. Defaults shape used when the
// table is empty / migration not yet applied:
let _appSettings = { monthlyInvoiceBenchmark: null, updatedAt: null };

export const getUsers     = () => _users;
export const getAppSettings = () => _appSettings;
export const getCompanies = () => _companies;                                         // merged (clients + companies) for generic lookups
export const getClientsOnly   = () => _companies.filter(c => c.type === "Client");     // beacon.clients rows
export const getCompaniesOnly = () => _companies.filter(c => c.type !== "Client");     // beacon.companies rows

// Combined Client-or-Prime-Firm picker options. Used ONLY for Sub-role
// rows, where the "Client" column in the UI can represent either the end
// client (client_id) or the external prime firm (prime_company_id). A
// " · Firm" suffix on company entries lets the user tell the two kinds
// apart in the dropdown. Prime-role rows keep the clients-only list.
export const buildClientOrCompanyOptions = () => [
  ...getClientsOnly().map(c => ({ value: c.id, label: c.name })),
  ...getCompaniesOnly().map(c => ({ value: c.id, label: `${c.name} · Firm` })),
];

// Decide which DB column a picked "Client" UUID maps to. For Prime-role
// rows the dropdown is clients-only so picks always yield client_id. For
// Sub-role rows the dropdown is merged and the user can pick either kind —
// this helper inspects which pool the UUID belongs to and returns the
// partial payload ({ client_id: v } OR { prime_company_id: v, client_id:
// null }) that routes the write correctly without tripping the
// client_id_fkey FK on beacon.clients.
//
// Clearing the cell always nulls client_id (not prime_company_id) — the
// role='Sub' constraint requires prime_company_id to stay set, so the
// user must change role to Prime first to drop the prime firm.
export const routeClientPick = (v) => {
  if (v === "" || v == null) return { client_id: null };
  const clients = getClientsOnly();
  if (clients.some(c => c.id === v)) return { client_id: v };
  return { prime_company_id: v, client_id: null };
};
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
  closed: [
    { field: "date_closed",             uiField: "dateClosed",            label: "Closed" },
    { field: "date_submitted",          uiField: "dateSubmitted",         label: "Submitted" },
  ],
  events: [
    { field: "event_datetime",          uiField: "dateTime",              label: "Event time", hasTime: true },
    { field: "event_date",              uiField: "date",                  label: "Event date" },
  ],
  hotleads: [
    { field: "date_time",               uiField: "dateTime",              label: "Lead time",  hasTime: true },
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

// ----------------------------------------------------------------------
// Storage path helpers — file binaries live in the `invoices` bucket under
// human-readable folders matching the user's mental model:
//   invoices/<project_id>/prime/<Month YYYY>/<file>
//   invoices/<project_id>/sub/<sub-name-slug>/<Month YYYY>/<file>
// ----------------------------------------------------------------------
export const slugCompanyName = (name) =>
  String(name || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    || "unknown";

export const monthFolder = (year, monthIdx) => {
  const idx = Math.max(0, Math.min(11, monthIdx | 0));
  return `${MONTH_FULL_NAMES[idx]} ${year}`;
};

const MONTH_FULL_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

// Pre-pad the upload filename with a sortable timestamp so two PDFs uploaded
// for the same cell don't collide.
const uploadFilename = (originalName) => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  // Replace any path separators or unsafe chars in the original name.
  const safe = String(originalName || "file").replace(/[/\\?%*:|"<>]+/g, "-");
  return `${stamp}-${safe}`;
};

export function buildInvoiceStoragePath({ kind, projectId, companyName, year, monthIdx, originalName }) {
  const monthDir = monthFolder(year, monthIdx);
  const fileName = uploadFilename(originalName);
  if (kind === "prime") {
    return `${projectId}/prime/${monthDir}/${fileName}`;
  }
  return `${projectId}/sub/${slugCompanyName(companyName)}/${monthDir}/${fileName}`;
}

// UI tab key → beacon_v2.alert_subject_enum value. v2 collapsed the 8-value
// v1 enum to 4: every project status maps to 'project'; hot-leads maps to
// 'lead'; invoice/event keep their values; SOQ is dropped.
export const TAB_TO_SUBJECT_TABLE = {
  potential: "project",
  awaiting:  "project",
  awarded:   "project",
  closed:    "project",
  invoice:   "invoice",
  events:    "event",
  hotleads:  "lead",
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
    .map(s => ({
      cId: s.company_id,
      desc: s.discipline || "",
      amt: s.amount || 0,
      kind: s.kind || "sub",
    }));

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
    // Sub rows without a client_id fall back to the prime firm, matching
    // adaptPotential. The "Client" cell then shows the prime when no
    // actual client is set — consistent with how Potential already behaves.
    clientId: r.client_id || r.prime_company_id || null,
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

function adaptAwarded(r) {
  return {
    id: r.id,
    year: r.year,
    name: r.project_name,
    role: r.prime_company_id ? "Sub" : "Prime",
    clientId: r.client_id || r.prime_company_id || null,
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
    clientId: r.client_id || r.prime_company_id || null,
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
    // v2 collapsed source_awarded_id + source_potential_id into a single
    // source_project_id. The UI keeps a `sourceId` field that points at any
    // upstream project (potential or awarded — both live in beacon_v2.projects).
    sourceId: r.source_project_id || null,
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
    notes: r.notes || "",
    attendees: (r.attendees || []).map(a => a.user_id),
    source:                    r.source || "manual",
    outlookEventId:            r.outlook_event_id || "",
    outlookEndDateTime:        r.outlook_end_datetime || "",
    outlookExternalAttendees:  r.outlook_external_attendees || [],
    outlookOrganizer:          r.outlook_organizer || null,
    outlookWebLink:            r.outlook_web_link || "",
    outlookIsCancelled:        !!r.outlook_is_cancelled,
    outlookLastSyncedAt:       r.outlook_last_synced_at || "",
  };
}

function adaptHotLead(r) {
  return {
    id: r.id,
    title: r.title,
    status: r.status || "Scheduled",
    dateTime: r.date_time || "",
    // Unified "Client or Firm" picker on Hot Leads: the adapter prefers the
    // real client_id when set, else falls back to prime_company_id so the
    // Client column always shows something the UI can resolve. Writes go
    // through routeClientPick (see App.jsx) which targets the right column.
    clientId: r.client_id || r.prime_company_id || null,
    notes: r.notes || "",
    attendees: (r.attendees || []).map(a => a.user_id),
  };
}

// app_settings is a singleton row. Null benchmark = "no target set" (chart
// renders bars in a neutral color and hides the benchmark line).
function adaptAppSettings(row) {
  if (!row) return { monthlyInvoiceBenchmark: null, updatedAt: null };
  const v = row.monthly_invoice_benchmark;
  return {
    monthlyInvoiceBenchmark: v == null || v === "" ? null : Number(v),
    updatedAt: row.updated_at || null,
  };
}

// Admin-only writer for the monthly invoice benchmark. Pass null to clear.
// Updates the singleton row keyed on singleton=true; refreshes the in-memory
// _appSettings cache on success so subsequent getAppSettings() calls see the
// new value without a full loadBeacon().
export async function updateMonthlyBenchmark(value) {
  const numeric = value == null || value === "" ? null : Number(value);
  if (numeric != null && !Number.isFinite(numeric)) {
    throw new Error("Benchmark must be a number");
  }
  const me = getCurrentBeaconUser();
  const { data, error } = await supabase
    .from("app_settings")
    .update({
      monthly_invoice_benchmark: numeric,
      updated_at: new Date().toISOString(),
      updated_by: me?.id || null,
    })
    .eq("singleton", true)
    .select()
    .single();
  if (error) throw error;
  _appSettings = adaptAppSettings(data);
  return _appSettings;
}

// ----------------------------------------------------------------------
// Linked-projects resolver — used by both the Directory drawer (panels.jsx)
// and the inline expand row in DirectoryTable (tables.jsx). Walks every
// pipeline state slice, tags each match with the entity's role on that
// project (Client / Prime / Sub), and flags rows that have a linked
// anticipated_invoice.
//
// Role resolution: adapters fold prime_company_id into clientId, so
// `p.clientId === entity.id` covers both "this client is the project's
// client" and "this company is the project's prime". We disambiguate by
// entity.type: Client-typed entity → "Client"; otherwise → "Prime".
// Sub matches always come second.
// ----------------------------------------------------------------------
export function linkedProjectsFor(entity, projectsByType, invoice) {
  if (!entity) return [];
  const isClient = entity.type === "Client";
  const STATUS_KEYS = ["awaiting", "awarded", "potential", "closed"];
  const invoiceBySource = new Map();
  for (const inv of (invoice || [])) {
    if (inv.sourceId) invoiceBySource.set(inv.sourceId, inv);
  }
  const out = [];
  for (const statusKey of STATUS_KEYS) {
    const list = projectsByType?.[statusKey] || [];
    for (const p of list) {
      const isPrimaryMatch = p.clientId === entity.id;
      const subMatch = (p.subs || []).some(s => s.cId === entity.id);
      if (!isPrimaryMatch && !subMatch) continue;
      const role = isPrimaryMatch ? (isClient ? "Client" : "Prime") : "Sub";
      const inv  = invoiceBySource.get(p.id);
      out.push({
        id: p.id,
        statusKey,
        name: p.name || "",
        projectNumber: p.projectNumber || "",
        year: p.year || null,
        role,
        hasInvoice: !!inv,
        invoiceTooltip: inv
          ? `Invoice · ${inv.year} · ${inv.type || ""}`.trim()
          : null,
      });
    }
  }
  return out;
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
  // v2 collapsed the 5 v1 pipeline tables (potential_projects, awaiting_verdict,
  // awarded_projects, closed_out_projects, soq) into a single beacon_v2.projects
  // table keyed on a `status` column. We pull all projects in one query and
  // split into the same 4 React state slices the UI already expects (SOQ is
  // dropped). PMs and subs use the consolidated project_pms / project_subs
  // join tables.
  const [
    users, clients, companies, projects, invoice, events, hotLeads,
    subInvRows, subInvFileRows, primeInvFileRows, appSettingsRows,
  ] = await Promise.all([
    pget(supabase.from("users").select("*").order("display_name"), "users"),
    pget(supabase.from("clients").select("*").order("name"), "clients"),
    pget(supabase.from("companies").select("*").order("name"), "companies"),
    pget(
      supabase.from("projects")
        .select("*, subs:project_subs(ord,company_id,discipline,amount,kind), pms:project_pms(user_id), stage:stage_id(name)")
        .order("year", { ascending: false })
        .order("project_name"),
      "projects"
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
    // `leads` (renamed from v1 `hot_leads`) + `lead_attendees`. If the
    // schema migration hasn't been applied yet (e.g. frontend deployed
    // ahead of the SQL), swallow the error so the rest of the app boots.
    supabase.from("leads")
      .select("*, attendees:lead_attendees(user_id)")
      .order("date_time", { ascending: false, nullsFirst: false })
      .then(({ data, error }) => {
        if (error) {
          console.warn("[beacon_v2] leads fetch skipped:", error.message);
          return [];
        }
        return data || [];
      }),
    // Sub invoices + their attached files; if the migration isn't applied
    // yet, gracefully degrade to empty arrays so the rest of the app boots.
    supabase.from("sub_invoices").select("*").eq("year", THIS_YEAR)
      .then(({ data, error }) => {
        if (error) { console.warn("[beacon_v2] sub_invoices fetch skipped:", error.message); return []; }
        return data || [];
      }),
    supabase.from("sub_invoice_files").select("*")
      .then(({ data, error }) => {
        if (error) { console.warn("[beacon_v2] sub_invoice_files fetch skipped:", error.message); return []; }
        return data || [];
      }),
    supabase.from("prime_invoice_files").select("*")
      .then(({ data, error }) => {
        if (error) { console.warn("[beacon_v2] prime_invoice_files fetch skipped:", error.message); return []; }
        return data || [];
      }),
    // Workspace-wide settings singleton. If the migration hasn't been applied
    // yet (frontend deployed ahead of SQL), swallow the error so the rest of
    // the app boots — the chart just falls back to no-benchmark mode.
    supabase.from("app_settings").select("*").limit(1)
      .then(({ data, error }) => {
        if (error) { console.warn("[beacon_v2] app_settings fetch skipped:", error.message); return []; }
        return data || [];
      }),
  ]);

  _appSettings = adaptAppSettings(appSettingsRows?.[0] || null);

  // Split the consolidated projects array into status-keyed slices so the
  // rest of the app sees the same shape it always has.
  const potential = projects.filter(r => r.status === "potential");
  const awaiting  = projects.filter(r => r.status === "awaiting");
  const awarded   = projects.filter(r => r.status === "awarded");
  const closed    = projects.filter(r => r.status === "closed_out");

  _users = users.map(adaptUser);

  // Infer company role (Prime / Sub / Multiple) from observed usage across
  // every project, regardless of status. v2's single projects table makes
  // this a single iteration instead of 3 separate ones.
  const primeIds = new Set();
  const subIds = new Set();
  projects.forEach(r => {
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

  // DISABLED: the automatic Orange-Invoice reconciliation previously ran
  // on every load to back-fill invoices for Orange potentials missing a
  // linked anticipated_invoice row. In the new "spreadsheet is the source
  // of truth" model (see scripts/sync_2026_invoice.py) this is actively
  // harmful: the xlsx may tag only a subset of Orange potentials as
  // billable for the current year, and the reconciliation kept spawning
  // invoice rows for every other Orange potential in the Potential tab,
  // drifting the invoice list away from the sheet. If you need a
  // one-shot back-fill, run the sync script (it's idempotent and aware
  // of what the sheet considers current).
  let reconciledInvoices = invoice;
  if (false) {
  const linkedPotentialIds = new Set(
    invoice.map(r => r.source_project_id).filter(Boolean)
  );
  const orphanOranges = potential.filter(p =>
    p.probability === "Orange" &&
    p.year === THIS_YEAR &&
    !linkedPotentialIds.has(p.id)
  );
  if (orphanOranges.length > 0) {
    const payloads = orphanOranges.map(p => ({
      source_project_id: p.id,
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
  } // end DISABLED reconciliation gate

  // Build the prime file lookup keyed on (anticipated_invoice.id, month).
  // Each invoice row gets a `primeFiles[12]` annotation — index = month-1.
  const primeFilesByKey = new Map();
  for (const f of (primeInvFileRows || [])) {
    const key = `${f.invoice_id}:${f.month}`;
    const arr = primeFilesByKey.get(key) || [];
    arr.push(f);
    primeFilesByKey.set(key, arr);
  }
  // Resolve role per project so each invoice row knows whether MSMM is
  // Prime or Sub on the linked project. role can be explicit (potential
  // rows have it) or derived from prime_company_id (non-Prime if set).
  const projectRoleById = new Map();
  for (const p of projects) {
    let role = p.role;
    if (!role) role = p.prime_company_id ? "Sub" : "Prime";
    projectRoleById.set(p.id, role);
  }
  const adaptedInvoices = reconciledInvoices.map(adaptInvoice).map(inv => ({
    ...inv,
    role: inv.sourceId ? (projectRoleById.get(inv.sourceId) || "Prime") : "Prime",
    primeFiles: Array.from({ length: 12 }, (_, i) =>
      primeFilesByKey.get(`${inv.id}:${i + 1}`) || []
    ),
  }));

  // Build the per-project sub matrix. For each project that has subs in
  // project_subs, list every sub with their 12-month amounts (from
  // sub_invoices) + 12-month file lists (from sub_invoice_files). Subs
  // with no sub_invoice rows still appear — empty cells.
  // Key includes kind so the same company can theoretically appear once
  // per kind per month. Today we only ever look up by (project, company,
  // month, kind) but the matrix builder respects the kind discriminator.
  const subInvoicesByProjectCompany = new Map(); // "projectId:kind:companyId:month" → sub_invoice row
  const subInvoiceById = new Map();              // sub_invoice.id → row (for files lookup)
  for (const r of (subInvRows || [])) {
    const k = r.kind || "sub";
    subInvoicesByProjectCompany.set(`${r.project_id}:${k}:${r.company_id}:${r.month}`, r);
    subInvoiceById.set(r.id, r);
  }
  const subFilesBySubInvoice = new Map();
  for (const f of (subInvFileRows || [])) {
    const arr = subFilesBySubInvoice.get(f.sub_invoice_id) || [];
    arr.push(f);
    subFilesBySubInvoice.set(f.sub_invoice_id, arr);
  }
  const subInvoicesMatrix = new Map();   // project_id → [{ companyId, companyName, contractAmount, discipline, amounts[12], files[12], subInvoiceIds[12] }]
  for (const p of projects) {
    const subs = (p.subs || [])
      .slice()
      .sort((a, b) => (a.ord || 0) - (b.ord || 0));
    if (subs.length === 0) continue;
    const entries = subs.map(s => {
      const company = companies.find(c => c.id === s.company_id);
      const kind = s.kind || "sub";
      const amounts = Array(12).fill(null);
      const files   = Array(12).fill(null).map(() => []);
      const subInvoiceIds = Array(12).fill(null);
      const paid    = Array(12).fill(false);
      const paidAt  = Array(12).fill(null);
      for (let m = 1; m <= 12; m++) {
        const key = `${p.id}:${kind}:${s.company_id}:${m}`;
        const row = subInvoicesByProjectCompany.get(key);
        if (row) {
          amounts[m - 1] = row.amount != null ? Number(row.amount) : null;
          subInvoiceIds[m - 1] = row.id;
          files[m - 1] = subFilesBySubInvoice.get(row.id) || [];
          paid[m - 1] = !!row.paid;
          paidAt[m - 1] = row.paid_at || null;
        }
      }
      return {
        kind,
        companyId: s.company_id,
        companyName: company?.name || "Unknown company",
        contractAmount: s.amount || 0,
        discipline: s.discipline || "",
        amounts, files, subInvoiceIds, paid, paidAt,
      };
    });
    subInvoicesMatrix.set(p.id, entries);
  }

  return {
    potential: potential.map(adaptPotential),
    awaiting:  awaiting.map(adaptAwaiting),
    awarded:   awarded.map(adaptAwarded),
    closed:    closed.map(adaptClosed),
    invoices:  adaptedInvoices,
    events:    events.map(adaptEvent),
    hotLeads:  hotLeads.map(adaptHotLead),
    clients:   _companies,
    users:     _users,
    subInvoices: subInvoicesMatrix,
    appSettings: _appSettings,
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

export async function runOutlookSyncNow() {
  const { data, error } = await supabase.functions.invoke("outlook-sync", { body: {} });
  if (error) {
    let detail = error.message || "sync failed";
    try {
      const ctx = error.context;
      const text = ctx && typeof ctx.text === "function" ? await ctx.text() : null;
      if (text) { try { detail = JSON.parse(text).error || text; } catch { detail = text; } }
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return data; // { ok, processed, inserted, updated, cancelled, skipped, disabled? }
}

// Refetch the events list after an Outlook sync (or any external change) so
// the UI reflects new/updated/cancelled rows without a full loadBeacon().
export async function reloadEvents() {
  const { data, error } = await supabase.from("events")
    .select("*, attendees:event_attendees(user_id)")
    .order("event_date", { ascending: false, nullsFirst: false });
  if (error) throw new Error(`events reload: ${error.message}`);
  return (data || []).map(adaptEvent);
}

// ----------------------------------------------------------------------
// Sub invoices + invoice file attachments
// ----------------------------------------------------------------------
// The amount cell on a sub row is editable inline. This upserts the row
// keyed on (project_id, company_id, year, month). Returns the row id so
// callers can attach file rows to it.
export async function upsertSubInvoiceAmount({ projectId, companyId, year, month, amount, kind = "sub" }) {
  // ON CONFLICT update — uses the kind-aware unique (project_id, kind, company_id, year, month).
  const payload = {
    project_id: projectId,
    company_id: companyId,
    year,
    month,
    amount: amount === "" || amount == null ? null : Number(amount),
    kind,
  };
  const { data, error } = await supabase
    .from("sub_invoices")
    .upsert(payload, { onConflict: "project_id,kind,company_id,year,month" })
    .select("id, amount")
    .single();
  if (error) throw new Error(`sub invoice upsert: ${error.message}`);
  return data;
}

// Resolve the project a given invoice should be linked to. If the invoice
// already has a sourceId, we shouldn't be calling this. Otherwise: search
// for an existing project whose project_number + year matches; if found,
// return its id with matchType='matched'. If not, create a stub project
// (status='awarded') from the invoice's own metadata and return its id
// with matchType='created'.
//
// This drives the "invisible auto-link" UX on the AddSubModal: the user
// never sees a project picker for unlinked invoices — we either match by
// project_number or auto-create a stub on their behalf.
export async function findOrCreateProjectForInvoice(invoiceRow) {
  const { name, projectNumber, year } = invoiceRow || {};

  // Match by (project_number, year) — strongest identity signal we have.
  if (projectNumber && year) {
    const { data, error } = await supabase
      .from("projects")
      .select("id, project_name, status, year")
      .eq("project_number", projectNumber)
      .eq("year", year)
      .limit(1);
    if (error) throw new Error(`project lookup: ${error.message}`);
    if (data && data.length > 0) {
      return {
        projectId: data[0].id,
        projectName: data[0].project_name,
        matchType: "matched",
        projectStub: null,
      };
    }
  }

  // No match → mint a stub project. status='awarded' is the safe default
  // (the row's been invoiced, so it had to have been awarded). The user
  // can refine via the project's drawer later.
  const insertPayload = {
    status: "awarded",
    year: year || new Date().getFullYear(),
    project_name: name || "Untitled invoice",
    project_number: projectNumber || null,
  };
  const { data, error } = await supabase
    .from("projects")
    .insert(insertPayload)
    .select("id, project_name, year, project_number, status")
    .single();
  if (error) throw new Error(`auto-create project: ${error.message}`);
  return {
    projectId: data.id,
    projectName: data.project_name,
    matchType: "created",
    projectStub: data,
  };
}

// Wire an anticipated_invoice row to a project after the fact. Used by the
// AddSubModal when the user wants to add subs to an invoice that was
// created without an upstream project link.
export async function linkInvoiceToProject(invoiceId, projectId) {
  const { error } = await supabase
    .from("anticipated_invoice")
    .update({ source_project_id: projectId })
    .eq("id", invoiceId);
  if (error) throw new Error(`link invoice to project: ${error.message}`);
}

// Add a new entry to project_subs. Many existing invoices were created
// without their sub data tracked (subs were a Potential-stage concept),
// so the Invoice tab provides an inline "+ Add sub" affordance that calls
// this. The `kind` discriminator lets the same table also hold the upstream
// prime firm on a Sub-role project ('prime', max one per project).
export async function addProjectSub({ projectId, companyId, discipline, amount, ord, kind = "sub" }) {
  const payload = {
    project_id: projectId,
    company_id: companyId,
    discipline: discipline || null,
    amount: amount === "" || amount == null ? null : Number(amount),
    ord: ord ?? null,
    kind,
  };
  const { data, error } = await supabase
    .from("project_subs")
    .insert(payload)
    .select("*")
    .single();
  if (error) throw new Error(`add ${kind}: ${error.message}`);
  return data;
}

// Update a project's role explicitly. Switching to Prime also clears
// prime_company_id (the consistency check requires Prime → no prime firm).
export async function setProjectRole(projectId, role) {
  const update = role === "Prime"
    ? { role: "Prime", prime_company_id: null }
    : { role: role || null };
  const { error } = await supabase
    .from("projects")
    .update(update)
    .eq("id", projectId);
  if (error) throw new Error(`set project role: ${error.message}`);
}

// Update a project's prime company. Used in the "Add prime" flow so the
// project's projects.prime_company_id mirrors the project_subs(kind='prime')
// row's company_id — keeping the schema consistency check happy.
export async function setProjectPrimeCompany(projectId, primeCompanyId) {
  const { error } = await supabase
    .from("projects")
    .update({ prime_company_id: primeCompanyId })
    .eq("id", projectId);
  if (error) throw new Error(`set prime company: ${error.message}`);
}

// Mark a sub_invoice paid (or back to pending). Sets paid_at to now() on the
// way to true; clears it on the way back. Returns the updated paid_at so
// callers can patch local state without a refetch.
export async function setSubInvoicePaid(subInvoiceId, paid) {
  const update = paid
    ? { paid: true,  paid_at: new Date().toISOString() }
    : { paid: false, paid_at: null };
  const { error } = await supabase
    .from("sub_invoices")
    .update(update)
    .eq("id", subInvoiceId);
  if (error) throw new Error(`sub invoice paid toggle: ${error.message}`);
  return update.paid_at;
}

// Find or create the sub_invoice row for the given coordinates. Used by the
// upload modal: we may need to create a 0-amount row before attaching files.
export async function ensureSubInvoiceRow({ projectId, companyId, year, month, kind = "sub" }) {
  const existing = await supabase.from("sub_invoices")
    .select("id, amount")
    .eq("project_id", projectId)
    .eq("company_id", companyId)
    .eq("year", year)
    .eq("month", month)
    .eq("kind", kind)
    .maybeSingle();
  if (existing.data) return existing.data;
  const { data, error } = await supabase.from("sub_invoices")
    .insert({ project_id: projectId, company_id: companyId, year, month, kind })
    .select("id, amount")
    .single();
  if (error) throw new Error(`sub invoice ensure: ${error.message}`);
  return data;
}

// Upload a file to the `invoices` bucket and write a metadata row in the
// matching files table. `kind` is 'prime' or 'sub'; the parent reference
// differs accordingly.
//   prime: { kind, projectId, year, monthIdx, file, primeInvoiceId }
//   sub:   { kind, projectId, companyId, companyName, year, monthIdx, file, subInvoiceId }
export async function uploadInvoiceFile(opts) {
  const { kind, projectId, companyName, year, monthIdx, file, notes } = opts;
  const path = buildInvoiceStoragePath({
    kind, projectId, companyName, year, monthIdx,
    originalName: file?.name || "file",
  });
  const up = await supabase.storage.from("invoices").upload(path, file, {
    upsert: false,
    cacheControl: "3600",
  });
  if (up.error) throw new Error(`storage upload: ${up.error.message}`);
  const session = await supabase.auth.getSession();
  const uploadedBy = session.data?.session?.user?.id || null;
  // Resolve uploaded_by to a beacon_v2.users.id by auth_user_id (best effort).
  let beaconUserId = null;
  if (uploadedBy) {
    const u = _users.find(x => x.id === uploadedBy) || null;
    // _users holds adapted UI users — the .id field is the beacon_v2.users.id
    // already, since adaptUser preserves the DB id. If the auth user isn't in
    // _users (e.g. service-role or unrostered), beaconUserId stays null.
    beaconUserId = u?.id || null;
  }

  if (kind === "prime") {
    const { data, error } = await supabase.from("prime_invoice_files")
      .insert({
        invoice_id: opts.primeInvoiceId,
        month: monthIdx + 1,
        file_path: path,
        file_name: file.name,
        notes: notes || null,
        uploaded_by: beaconUserId,
      })
      .select("*")
      .single();
    if (error) throw new Error(`prime file insert: ${error.message}`);
    return data;
  } else {
    const { data, error } = await supabase.from("sub_invoice_files")
      .insert({
        sub_invoice_id: opts.subInvoiceId,
        file_path: path,
        file_name: file.name,
        notes: notes || null,
        uploaded_by: beaconUserId,
      })
      .select("*")
      .single();
    if (error) throw new Error(`sub file insert: ${error.message}`);
    return data;
  }
}

export async function deleteInvoiceFile({ kind, fileId, filePath }) {
  // Delete the binary first so a successful DB delete + failed storage
  // delete doesn't leave orphan rows pointing at a missing path. If the
  // storage delete fails, the DB row stays (safer than the inverse).
  const rm = await supabase.storage.from("invoices").remove([filePath]);
  if (rm.error) throw new Error(`storage remove: ${rm.error.message}`);
  const table = kind === "prime" ? "prime_invoice_files" : "sub_invoice_files";
  const { error } = await supabase.from(table).delete().eq("id", fileId);
  if (error) throw new Error(`${table} delete: ${error.message}`);
}

export async function getInvoiceFileSignedUrl(filePath, expiresInSeconds = 60) {
  const { data, error } = await supabase.storage.from("invoices")
    .createSignedUrl(filePath, expiresInSeconds);
  if (error) throw new Error(`signed url: ${error.message}`);
  return data?.signedUrl;
}

// Refetch sub_invoices + sub_invoice_files + prime_invoice_files after an
// upload/delete. Returns the same shape loadBeacon assembles for these
// pieces so App.jsx can replace its slices in one call.
export async function reloadInvoiceArtifacts(projects, companies) {
  const [subInvRows, subInvFileRows, primeInvFileRows] = await Promise.all([
    supabase.from("sub_invoices").select("*").eq("year", THIS_YEAR)
      .then(({ data, error }) => { if (error) return []; return data || []; }),
    supabase.from("sub_invoice_files").select("*")
      .then(({ data, error }) => { if (error) return []; return data || []; }),
    supabase.from("prime_invoice_files").select("*")
      .then(({ data, error }) => { if (error) return []; return data || []; }),
  ]);
  // Re-build same maps as loadBeacon.
  const primeFilesByKey = new Map();
  for (const f of primeInvFileRows) {
    const k = `${f.invoice_id}:${f.month}`;
    const arr = primeFilesByKey.get(k) || [];
    arr.push(f); primeFilesByKey.set(k, arr);
  }
  const subInvoicesByProjectCompany = new Map();
  for (const r of subInvRows) {
    const k = r.kind || "sub";
    subInvoicesByProjectCompany.set(`${r.project_id}:${k}:${r.company_id}:${r.month}`, r);
  }
  const subFilesBySubInvoice = new Map();
  for (const f of subInvFileRows) {
    const arr = subFilesBySubInvoice.get(f.sub_invoice_id) || [];
    arr.push(f); subFilesBySubInvoice.set(f.sub_invoice_id, arr);
  }
  const subInvoicesMatrix = new Map();
  for (const p of projects) {
    const subs = (p.subs || []).slice().sort((a,b) => (a.ord||0)-(b.ord||0));
    if (subs.length === 0) continue;
    const entries = subs.map(s => {
      const company = companies.find(c => c.id === s.cId || c.id === s.company_id);
      const kind = s.kind || "sub";
      const amounts = Array(12).fill(null);
      const files = Array(12).fill(null).map(() => []);
      const subInvoiceIds = Array(12).fill(null);
      const paid    = Array(12).fill(false);
      const paidAt  = Array(12).fill(null);
      const cId = s.cId || s.company_id;
      for (let m = 1; m <= 12; m++) {
        const row = subInvoicesByProjectCompany.get(`${p.id}:${kind}:${cId}:${m}`);
        if (row) {
          amounts[m-1] = row.amount != null ? Number(row.amount) : null;
          subInvoiceIds[m-1] = row.id;
          files[m-1] = subFilesBySubInvoice.get(row.id) || [];
          paid[m-1] = !!row.paid;
          paidAt[m-1] = row.paid_at || null;
        }
      }
      return {
        kind,
        companyId: cId,
        companyName: company?.name || "Unknown company",
        contractAmount: s.amt || s.amount || 0,
        discipline: s.desc || s.discipline || "",
        amounts, files, subInvoiceIds, paid, paidAt,
      };
    });
    subInvoicesMatrix.set(p.id, entries);
  }
  return { primeFilesByKey, subInvoicesMatrix };
}
