// Supabase client + data adapters + formatting helpers.
// All Supabase config comes from Vite env vars (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY).
// Copy `.env.example` → `.env.local` and fill in your own values.

import { createClient } from "@supabase/supabase-js";
import { patchForIntervalCategory } from "./timekeepingPolicy";

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

export async function changeOwnPassword(email, currentPassword, newPassword) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) throw new Error("No email is available for this session.");
  if (!currentPassword) throw new Error("Enter your current password.");
  if (!newPassword || newPassword.length < 6) {
    throw new Error("New password must be at least 6 characters.");
  }

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password: currentPassword,
  });
  if (signInError) {
    throw new Error("Current password is incorrect.");
  }

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
  return { ok: true };
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
    .select("id, email, first_name, last_name, display_name, short_name, login_name, role, is_enabled, auth_user_id, department, location, employee_type, created_at, updated_at")
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
let _appSettings = { monthlyInvoiceBenchmark: null, invoiceActualCutoverDay: 1, invoiceActualCutoverNextMonth: false, updatedAt: null, tkHolidays: [], tkWorkdayHours: 8 };

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

// Same idea for the dedicated Prime column on Awarded. The picker uses the
// merged client+company list, so writes need to land on `prime_client_id`
// (clients) or `prime_company_id` (companies). Clearing nulls both.
export const routePrimePick = (v) => {
  if (v === "" || v == null) return { prime_company_id: null, prime_client_id: null };
  const clients = getClientsOnly();
  if (clients.some(c => c.id === v)) return { prime_client_id: v, prime_company_id: null };
  return { prime_company_id: v, prime_client_id: null };
};
export const userById     = (id) => _users.find(u => u.id === id);
export const companyById  = (id) => _companies.find(c => c.id === id);

// ----------------------------------------------------------------------
// Formatting
// ----------------------------------------------------------------------
export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const TODAY_MONTH = new Date().getMonth();
export const THIS_YEAR   = new Date().getFullYear();

// The "actual through" month index (0–11) for the Invoice tab's Actual vs
// Projection split. A month becomes Actual on the configurable cutover day,
// which can land in the SAME month or the NEXT month:
//   • nextMonth=false (default): the CURRENT month flips to Actual on
//     `cutoverDay` of the same month. day=1 = the legacy "flips on the 1st".
//   • nextMonth=true: a month flips to Actual on `cutoverDay` of the FOLLOWING
//     month — e.g. day=1 means June stays Projection through June and becomes
//     Actual on July 1 ("close the month once it ends").
// Returns -1 when no month this year has closed yet (clamped, never < -1, so
// downstream `slice(0, n+1)` stays empty rather than tripping negative-index
// behavior). The day is clamped to the current month's length so 31 acts as
// "last day of month" in short months.
export function actualThruMonth(cutoverDay = 1, nextMonth = false, date = new Date()) {
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const eff = Math.min(Math.max(1, Math.round(Number(cutoverDay)) || 1), daysInMonth);
  const base = date.getDate() >= eff ? date.getMonth() : date.getMonth() - 1;
  return Math.max(-1, nextMonth ? base - 1 : base);
}

// Is an invoice month "actual" (already happened) vs a future "projection"?
// Year-aware so historical rows behave correctly: a whole past year is actual,
// a whole future year is projection, and the current year splits at the
// configurable cutover (see actualThruMonth — reads the live cutover day + the
// same/next-month flag from the in-memory app_settings cache). Drives the rule
// that invoice attachments can only be added to actual months.
export function isActualInvoiceMonth(year, monthIdx) {
  const y = Number(year) || THIS_YEAR;
  if (y < THIS_YEAR) return true;
  if (y > THIS_YEAR) return false;
  return monthIdx <= actualThruMonth(
    _appSettings?.invoiceActualCutoverDay,
    _appSettings?.invoiceActualCutoverNextMonth,
  );
}

// Feature flag: when true, invoice attachments (the per-cell paperclip + the
// files modal's upload UI) are restricted to ACTUAL months only — projected
// months can't take new uploads. When false (current policy, set by the
// client), attachments are allowed on EVERY month, projected or actual.
// The actual/projection coloring + cutover are unaffected by this flag; it
// only gates uploads. Flip to true (and `isActualInvoiceMonth` does the rest)
// to bring the lock back without touching the call sites.
export const ATTACH_ONLY_ON_ACTUAL = false;

// ----------------------------------------------------------------------
// Invoice rolling-window
// ----------------------------------------------------------------------
// The Invoice tab shows a SLIDING window of months instead of a fixed
// Jan–Dec calendar year. The default window = the previous WINDOW_PREV
// months, the current month, and the next WINDOW_NEXT months (16 total).
// The window crosses calendar years, so months are addressed by an
// ABSOLUTE index (year*12 + monthIdx); the table / charts / Manish export
// stitch the per-(project, year) anticipated_invoice rows together for
// display via mergeInvoiceYears (each merged row carries a `byYear` map).
// Bump WINDOW_NEXT to 13 if the window should end at Jul 2027 (17 months)
// for a June-2026 "today" instead of Jun 2027 (16 months).
export const WINDOW_PREV = 3;
export const WINDOW_NEXT = 12;
export const WINDOW_SIZE = WINDOW_PREV + 1 + WINDOW_NEXT; // 16
export const ymToAbs = (year, monthIdx) => year * 12 + monthIdx;
export const absToYM = (abs) => ({
  year: Math.floor(abs / 12),
  monthIdx: ((abs % 12) + 12) % 12,
});
// Absolute index of the leftmost month for today's default window.
export function defaultWindowStartAbs(date = new Date()) {
  return ymToAbs(date.getFullYear(), date.getMonth()) - WINDOW_PREV;
}
// Descriptor list for a window beginning at startAbs:
//   { abs, year, monthIdx, mon: "Mar", yy: "26", label: "Mar 2026" }
export function monthDescsForWindow(startAbs, size = WINDOW_SIZE) {
  return Array.from({ length: size }, (_, k) => {
    const abs = startAbs + k;
    const { year, monthIdx } = absToYM(abs);
    return {
      abs, year, monthIdx,
      mon: MONTHS[monthIdx],
      yy: String(year).slice(2),
      label: `${MONTHS[monthIdx]} ${year}`,
    };
  });
}

// Open Bids → Service Description dropdown options. Mirrors the
// beacon_v2.bid_service_enum values defined in 20260527120000_open_bids.sql.
// Keep these two in sync — adding a new service requires both an ALTER TYPE
// in a follow-up migration AND a new entry here.
export const BID_SERVICE_OPTIONS = [
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
];

// ----------------------------------------------------------------------
// Projects (tree-structured work breakdown — beacon_v2.project_items).
// Distinct from the pipeline `projects` table. See 20260624130000.
// ----------------------------------------------------------------------
// Contract structure dropdown. value = the stable enum key stored in the DB
// (beacon_v2.project_item_contract_type_enum); label = the human form.
export const CONTRACT_TYPE_OPTIONS = [
  { value: "hourly",                label: "Hourly" },
  { value: "fixed",                 label: "Fixed" },
  { value: "hourly_nte",            label: "Hourly Not to Exceed" },
  { value: "overhead",              label: "Overhead" },
  { value: "percentage",            label: "Percentage" },
  { value: "recurring",             label: "Recurring" },
  { value: "cost_plus_percentage",  label: "Cost + Percentage" },
  { value: "cost_plus_recurring",   label: "Cost + Recurring" },
  { value: "recurring_plus_hourly", label: "Recurring + Hourly" },
];
export const contractTypeLabel = (v) =>
  CONTRACT_TYPE_OPTIONS.find(o => o.value === v)?.label || "";

// Main = parent-level container (no time/expense logging); Standard = active
// work item (time/expense can be logged). The Main/Standard distinction is
// stored as a property — actual time/expense entry is a future feature.
export const PROJECT_ITEM_TYPE_OPTIONS = [
  { value: "main",     label: "Main" },
  { value: "standard", label: "Standard" },
];
export const projectItemTypeLabel = (v) =>
  PROJECT_ITEM_TYPE_OPTIONS.find(o => o.value === v)?.label || "Standard";

export const PROJECT_ITEM_STATUS_OPTIONS = [
  { value: "active",     label: "Active" },
  { value: "between",    label: "In Between" },
  { value: "closed_out", label: "Closed Out" },
];
export const projectItemStatusLabel = (v) =>
  PROJECT_ITEM_STATUS_OPTIONS.find(o => o.value === v)?.label || "Active";

// Only Standard items can take time + expenses (Main is a container). The DB
// doesn't block time/expense yet (no such feature), so this is the single
// source of truth for any caller that needs to know.
export const canLogTimeExpense = (item) => (item?.itemType || "standard") === "standard";

// Direct children of a node (parentId === null → roots).
export const projectItemChildren = (items, parentId) =>
  (items || []).filter(it => (it.parentId || null) === (parentId || null));

// All descendant UUIDs of a node (depth-first), excluding the node itself.
// Used to size the delete confirm + to block re-parenting under a descendant
// client-side. Keys on the surrogate `id` (uuid), NOT the display local_id.
export function projectItemDescendantIds(items, id) {
  const out = [];
  const stack = [id];
  while (stack.length) {
    const pid = stack.pop();
    for (const it of (items || [])) {
      if (it.parentId === pid) { out.push(it.id); stack.push(it.id); }
    }
  }
  return out;
}

// Client-side mirror of the DB roll-up trigger (fn_project_item_validate) for
// instant feedback. `items` is the current in-memory slice; the row being
// edited is excluded by its uuid `itemId` so its own old amount doesn't
// double-count. Returns { ok:true } or { ok:false, message }.
export function validateProjectItemContract(items, { itemId, parentId, amount }) {
  const amt = amount == null || amount === "" ? null : Number(amount);
  const EPS = 0.005;
  // Floor: a node can't drop below the total already allocated to its children.
  if (amt != null && itemId) {
    const childSum = (items || [])
      .filter(it => it.parentId === itemId)
      .reduce((a, it) => a + (Number(it.contractAmount) || 0), 0);
    if (childSum > amt + EPS) {
      return { ok: false, message: `Contract ${fmtMoney(amt, false)} is below the ${fmtMoney(childSum, false)} already allocated to child items.` };
    }
  }
  // Cap: siblings + this node must fit inside the parent's contract amount.
  if (parentId && amt != null) {
    const parent = (items || []).find(it => it.id === parentId);
    const parentAmt = parent && parent.contractAmount != null ? Number(parent.contractAmount) : null;
    if (parentAmt != null) {
      const sibSum = (items || [])
        .filter(it => it.parentId === parentId && it.id !== itemId)
        .reduce((a, it) => a + (Number(it.contractAmount) || 0), 0);
      if (sibSum + amt > parentAmt + EPS) {
        return { ok: false, message: `Children would total ${fmtMoney(sibSum + amt, false)}, over the parent's ${fmtMoney(parentAmt, false)} contract.` };
      }
    }
  }
  return { ok: true };
}

// ── Project Detail — To-Do + Note option lists ────────────────────────────
// Priority on a project to-do. Rank drives the default sort (most urgent first).
export const TODO_PRIORITY_OPTIONS = [
  { value: "urgent", label: "Urgent" },
  { value: "high",   label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low",    label: "Low" },
];
export const todoPriorityLabel = (v) =>
  TODO_PRIORITY_OPTIONS.find(o => o.value === v)?.label || "Medium";
export const todoPriorityRank = (v) =>
  ({ urgent: 0, high: 1, medium: 2, low: 3 })[v] ?? 2;

// Categories for a project note (fixed list per product spec).
export const NOTE_CATEGORY_OPTIONS = [
  { value: "billing",            label: "Billing" },
  { value: "project_management", label: "Project Management" },
  { value: "invoice",            label: "Invoice" },
  { value: "client",             label: "Client" },
  { value: "management",         label: "Management" },
  { value: "contract",           label: "Contract" },
  { value: "expense",            label: "Expense" },
  { value: "general",            label: "General" },
  { value: "purchase_order",     label: "Purchase Order" },
  { value: "time_entry",         label: "Time Entry" },
  { value: "vendor_bill",        label: "Vendor Bill" },
  { value: "vendor_contract",    label: "Vendor Contract" },
];
export const noteCategoryLabel = (v) =>
  NOTE_CATEGORY_OPTIONS.find(o => o.value === v)?.label || "General";

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
  // Always two letters: first letter of first_name + first letter of last_name.
  // Falls through to initialsFromName(display) when both are missing so we
  // still produce something readable for legacy rows without a split name.
  const fl = (u.first_name || "").trim()[0] || "";
  const ll = (u.last_name  || "").trim()[0] || "";
  const initials = (fl || ll)
    ? (fl + ll).toUpperCase()
    : initialsFromName(display);
  return {
    id: u.id,
    name: display,
    shortName: short,
    initials,
    color: PM_COLORS[i % PM_COLORS.length],
    // Additional roster metadata — surfaced for the Team Calendar people
    // selector and the read-only event popover. Other callers can ignore.
    department: u.department || "",
    location:   u.location   || "",
    email:      u.email      || "",
    role:       u.role       || "User",
    isEnabled:  u.is_enabled !== false,
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
    isMsmm: !!c.is_msmm,
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
      // Per-sub compliance docs + Remaining-Jan-1 override — carried through so
      // they survive the adapted-slice → reloadInvoiceArtifacts rebuild (not
      // just first load).
      subAgreement: !!s.sub_agreement,
      w9: !!s.w9,
      coi: !!s.coi,
      remaining: s.remaining_to_bill_year_start ?? null,
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
    status: "Proposal",
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
    // Awarded keeps Prime as its own column (Client and Prime no longer share
    // a slot), so role comes straight from the stored column. Older rows
    // without a stored role fall back to the prime_company_id heuristic.
    role: r.role || (r.prime_company_id ? "Sub" : "Prime"),
    clientId: r.client_id || null,
    primeId: r.prime_client_id || r.prime_company_id || null,
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
    // `amount` continues to map to anticipated_invoice.contract_amount but
    // now represents the *total* contract value (MSMM + every sub). The UI
    // renames the cell to "Total Contract Value" — the underlying field is
    // unchanged so the drawer / forms / PDF export stay wired identically.
    amount: r.contract_amount || 0,
    // MSMM override fields — NULL means "show derived value (= total − Σ subs)";
    // numeric means "this is a frozen override". Same semantic as
    // ytd_actual_override / rollforward_override.
    msmmAmount: r.msmm_amount ?? null,
    msmmValues: [
      r.msmm_jan_amount, r.msmm_feb_amount, r.msmm_mar_amount, r.msmm_apr_amount,
      r.msmm_may_amount, r.msmm_jun_amount, r.msmm_jul_amount, r.msmm_aug_amount,
      r.msmm_sep_amount, r.msmm_oct_amount, r.msmm_nov_amount, r.msmm_dec_amount,
    ].map(v => v ?? null),
    type: r.type || "ENG",
    remainingStart: r.msmm_remaining_to_bill_year_start || 0,
    // Project-total "Remaining Jan 1" override (NULL = fall back to Total CV).
    totalRemainingStart: r.total_remaining_to_bill_year_start ?? null,
    values: [
      r.jan_amount, r.feb_amount, r.mar_amount, r.apr_amount,
      r.may_amount, r.jun_amount, r.jul_amount, r.aug_amount,
      r.sep_amount, r.oct_amount, r.nov_amount, r.dec_amount,
    ].map(v => v || 0),
    // Per-month PAID flags for the prime/total invoice (MSMM as Prime).
    // Mirrors sub_invoices.paid but lives as 12 columns on this row since
    // the prime invoice has no per-month child table. Drives the green
    // "paid" tick on the Project total row (jan_paid..dec_paid).
    primePaid: [
      r.jan_paid, r.feb_paid, r.mar_paid, r.apr_paid,
      r.may_paid, r.jun_paid, r.jul_paid, r.aug_paid,
      r.sep_paid, r.oct_paid, r.nov_paid, r.dec_paid,
    ].map(v => !!v),
    // Per-month invoice numbers for the prime/total "Project total" row.
    // One number per (project, month) — the invoice the month's total was
    // billed under (jan_invoice_number..dec_invoice_number). NULL = none yet.
    // Surfaced as a chip on each total cell; edited from the prime files modal.
    invoiceNumbers: [
      r.jan_invoice_number, r.feb_invoice_number, r.mar_invoice_number, r.apr_invoice_number,
      r.may_invoice_number, r.jun_invoice_number, r.jul_invoice_number, r.aug_invoice_number,
      r.sep_invoice_number, r.oct_invoice_number, r.nov_invoice_number, r.dec_invoice_number,
    ].map(v => (v == null || v === "") ? null : String(v)),
    year: r.year,
    // NULL = use auto-calc; numeric = user has frozen the value.
    ytdActualOverride:   r.ytd_actual_override   ?? null,
    rollforwardOverride: r.rollforward_override  ?? null,
    // Free-text billing context, surfaced as the two chips under the project
    // name in InvoiceTable. "" = empty (chip renders ghost). Persisted via the
    // INVOICE_COL_MAP whitelist in App.jsx's updateInvoice.
    notes:       r.notes || "",
    description: r.description || "",
    // 'active' | 'between' | 'closed' (20260611120000). Drives which Invoice
    // sub-tab the project appears on. Missing column (un-migrated DB) reads
    // as undefined → 'active', so everything stays on the Invoices tab.
    billingState: r.billing_state || "active",
    // NULL = legacy fallback may still infer Orange from the linked project;
    // true/false = user explicitly moved this invoice row Orange/Normal.
    invoiceOrange: r.invoice_orange ?? null,
  };
}

// Adapt a freshly-INSERTED anticipated_invoice row into the App's flat
// invoice-state shape (= adaptInvoice + the load-time annotations). Used by
// the rolling-window UI when a month is edited in a year that has no row yet
// and we mint one on the fly. A brand-new year row has no attachments, so
// primeFiles / partyFiles start empty; role is inherited from the merged row.
export function adaptInvoiceRow(dbRow, { role = "Prime" } = {}) {
  return {
    ...adaptInvoice(dbRow),
    role,
    primeFiles: Array.from({ length: 12 }, () => []),
    partyFiles: { msmm: [], prime: {}, sub: {} },
    notesLog: [],
  };
}

// A single threaded invoice note (beacon_v2.invoice_notes row). authorId may be
// NULL (author removed, or a legacy/backfilled note) — the UI resolves the name
// via userById() and falls back to "Unknown" when unresolvable.
export function adaptNote(r) {
  return {
    id:        r.id,
    invoiceId: r.invoice_id,
    authorId:  r.author_user_id || null,
    body:      r.body || "",
    createdAt: r.created_at || null,
    editedAt:  r.edited_at  || null,
  };
}

// ── Threaded invoice notes — CRUD ──────────────────────────────────────────
// All four resolve to adapted note objects (or throw). Authorship is stamped
// server-side-safe from the cached current user; the RLS insert policy also
// enforces author_user_id = the caller, so a forged author is rejected.

// Post a new note. Returns the adapted, persisted row (with real id + server
// created_at) so the caller can swap out any optimistic placeholder.
export async function addInvoiceNote(invoiceId, body) {
  const text = (body || "").trim();
  if (!text) throw new Error("Note can't be empty");
  const me = getCurrentBeaconUser();
  const { data, error } = await supabase
    .from("invoice_notes")
    .insert({ invoice_id: invoiceId, author_user_id: me?.id || null, body: text })
    .select("*")
    .single();
  if (error) throw error;
  return adaptNote(data);
}

// Edit a note in place. Stamps edited_at so the UI can show "· edited". RLS
// restricts this to the author or an Admin.
export async function editInvoiceNote(noteId, body) {
  const text = (body || "").trim();
  if (!text) throw new Error("Note can't be empty");
  const { data, error } = await supabase
    .from("invoice_notes")
    .update({ body: text, edited_at: new Date().toISOString() })
    .eq("id", noteId)
    .select("*")
    .single();
  if (error) throw error;
  return adaptNote(data);
}

// Delete a note. RLS restricts this to the author or an Admin.
export async function deleteInvoiceNote(noteId) {
  const { error } = await supabase.from("invoice_notes").delete().eq("id", noteId);
  if (error) throw error;
}

// Re-fetch one invoice's thread (newest-first). Called when the thread modal
// opens so a user sees colleagues' posts made since the last full load, without
// needing a Realtime subscription.
export async function reloadInvoiceNotes(invoiceId) {
  const { data, error } = await supabase
    .from("invoice_notes")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(adaptNote);
}

// ── Project Detail — To-Dos + Notes (CRUD) ────────────────────────────────
// Both hang off a project_items NODE (root project OR any phase/subphase), so
// the detail page loads everything for a project by passing the tree's node
// ids. All loaders graceful-degrade to [] before the migration is applied.

export function adaptTodo(r) {
  return {
    id:          r.id,
    itemId:      r.item_id,
    description: r.description || "",
    startDate:   r.start_date || "",
    endDate:     r.end_date || "",
    priority:    r.priority || "medium",
    done:        !!r.done,
    assignedTo:  r.assigned_to || null,
    assignedBy:  r.assigned_by || null,
    createdAt:   r.created_at || null,
  };
}

export function adaptProjectNoteFile(r) {
  return {
    id:         r.id,
    noteId:     r.note_id,
    path:       r.file_path,
    name:       r.file_name || "file",
    uploadedBy: r.uploaded_by || null,
    uploadedAt: r.uploaded_at || null,
  };
}

export function adaptProjectNote(r) {
  return {
    id:        r.id,
    itemId:    r.item_id,
    authorId:  r.author_user_id || null,
    category:  r.category || "general",
    body:      r.body || "",
    createdAt: r.created_at || null,
    editedAt:  r.edited_at  || null,
    files:     (r.files || []).map(adaptProjectNoteFile),
  };
}

// Load every to-do across a set of node ids (a project's whole tree),
// newest-first. Empty input or an un-migrated DB → [].
export async function loadProjectTodos(itemIds) {
  const ids = (itemIds || []).filter(Boolean);
  if (!ids.length) return [];
  try {
    const { data, error } = await supabase
      .from("project_todos").select("*")
      .in("item_id", ids)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(adaptTodo);
  } catch (e) { console.warn("loadProjectTodos failed (un-migrated?)", e?.message); return []; }
}

export async function createTodo(payload) {
  const me = getCurrentBeaconUser();
  const text = (payload.description || "").trim();
  if (!text) throw new Error("Description can't be empty");
  const db = {
    item_id:     payload.itemId,
    description: text,
    start_date:  payload.startDate || null,
    end_date:    payload.endDate || null,
    priority:    payload.priority || "medium",
    done:        !!payload.done,
    assigned_to: payload.assignedTo || null,
    assigned_by: me?.id || null,
  };
  const { data, error } = await supabase.from("project_todos").insert(db).select("*").single();
  if (error) throw error;
  return adaptTodo(data);
}

export async function updateTodo(id, patch) {
  const map = {
    itemId: "item_id", description: "description", startDate: "start_date",
    endDate: "end_date", priority: "priority", done: "done", assignedTo: "assigned_to",
  };
  const nullable = new Set(["start_date", "end_date", "assigned_to"]);
  const db = {};
  for (const [k, v] of Object.entries(patch)) {
    const col = map[k]; if (!col) continue;
    db[col] = (nullable.has(col) && (v === "" || v == null)) ? null : v;
  }
  if (!Object.keys(db).length) return null;
  const { data, error } = await supabase.from("project_todos").update(db).eq("id", id).select("*").single();
  if (error) throw error;
  return adaptTodo(data);
}

export async function deleteTodo(id) {
  const { error } = await supabase.from("project_todos").delete().eq("id", id);
  if (error) throw error;
}

// Load every note (with attachments) across a set of node ids, newest-first.
export async function loadProjectNotes(itemIds) {
  const ids = (itemIds || []).filter(Boolean);
  if (!ids.length) return [];
  try {
    const { data, error } = await supabase
      .from("project_notes").select("*, files:project_note_files(*)")
      .in("item_id", ids)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(adaptProjectNote);
  } catch (e) { console.warn("loadProjectNotes failed (un-migrated?)", e?.message); return []; }
}

export async function createProjectNote({ itemId, category, body }) {
  const me = getCurrentBeaconUser();
  const text = (body || "").trim();
  if (!text) throw new Error("Note can't be empty");
  const { data, error } = await supabase.from("project_notes")
    .insert({ item_id: itemId, author_user_id: me?.id || null, category: category || "general", body: text })
    .select("*, files:project_note_files(*)").single();
  if (error) throw error;
  return adaptProjectNote(data);
}

export async function editProjectNote(id, { category, body }) {
  const db = { edited_at: new Date().toISOString() };
  if (category != null) db.category = category;
  if (body != null) {
    const text = body.trim();
    if (!text) throw new Error("Note can't be empty");
    db.body = text;
  }
  const { data, error } = await supabase.from("project_notes")
    .update(db).eq("id", id).select("*, files:project_note_files(*)").single();
  if (error) throw error;
  return adaptProjectNote(data);
}

export async function deleteProjectNote(id) {
  // Remove attached binaries first so nothing is orphaned (the row cascade
  // wipes project_note_files metadata, but not the bucket objects).
  const { data: files } = await supabase.from("project_note_files").select("file_path").eq("note_id", id);
  const paths = (files || []).map(f => f.file_path).filter(Boolean);
  if (paths.length) await supabase.storage.from("project-files").remove(paths);
  const { error } = await supabase.from("project_notes").delete().eq("id", id);
  if (error) throw error;
}

// Upload one attachment to a note → { adapted file row }. Binary lands first
// (path `{itemId}/notes/{noteId}/{stamp-name}`), then the metadata row.
export async function uploadProjectNoteFile(itemId, noteId, file) {
  const me = getCurrentBeaconUser();
  const path = `${itemId}/notes/${noteId}/${uploadFilename(file?.name)}`;
  const { error: upErr } = await supabase.storage.from("project-files").upload(path, file, { upsert: false });
  if (upErr) throw upErr;
  const { data, error } = await supabase.from("project_note_files")
    .insert({ note_id: noteId, file_path: path, file_name: file?.name || "file", uploaded_by: me?.id || null })
    .select("*").single();
  if (error) throw error;
  return adaptProjectNoteFile(data);
}

export async function deleteProjectNoteFile(fileRow) {
  if (fileRow?.path) await supabase.storage.from("project-files").remove([fileRow.path]);
  const { error } = await supabase.from("project_note_files").delete().eq("id", fileRow.id);
  if (error) throw error;
}

export async function projectFileUrl(path) {
  const { data, error } = await supabase.storage.from("project-files").createSignedUrl(path, 3600);
  if (error) throw error;
  return data?.signedUrl || null;
}

// Count of months that carry a billed amount on a flat invoice row — used to
// pick the "richer" row when two rows collide on the same (project, year).
function invoiceMonthsFilled(r) {
  return (r?.values || []).reduce((n, v) => n + (v ? 1 : 0), 0);
}

// Fold the flat per-(project, year) invoice rows into ONE merged row per
// project so the rolling-window table can show months that span calendar
// years.
//
// ROBUSTNESS (fixes the "duplicate / stale historical entry that a refresh
// cleared" bug): a project must collapse to a single row even when its year
// rows carry INCONSISTENT identity — e.g. the 2026 row has a source_project_id
// link but the 2025 row (older import, or a not-yet-persisted optimistic row)
// does not. The old key `source_id ELSE project_number ELSE id` split such a
// project into two displayed rows. Now:
//   • Pass 1 — rows WITH source_project_id define the canonical per-project
//     groups (keyed by source+type) and index their (type, project number).
//   • Pass 2 — source-less rows ATTACH to the matching source group by
//     (type, number) when one exists, so mixed-identity years reunite; else
//     they group by number, else stand alone by id.
// Also tolerant of: year-less optimistic rows (skipped from byYear, never a
// phantom row), duplicate ids, and two rows sharing a (project, year) — the
// row with more billed months wins so a stale duplicate can't shadow real
// data. Pure + idempotent. Each merged row carries:
//   • the PRIMARY year-row's scalar fields (name, amount, type, pmIds, role,
//     remainingStart, notes, primeFiles, …) — preferring the current year,
//     else the nearest — so the drawer, project edits, and alerts keep working
//     by the merged row's `id`; `sourceId` is back-filled from any year row
//     that has it so sub lookups / edit routing stay correct.
//   • byYear: { [year]: <that year's flat row> } — the per-month data source.
//   • years: sorted number[] of the years present.
export function mergeInvoiceYears(rows) {
  const list = rows || [];
  const typeOf  = (r) => r.type || "ENG";
  const normNum = (n) =>
    (n != null && String(n).trim() !== "") ? String(n).trim().toLowerCase() : "";

  const groups  = new Map();   // group key -> rows[]
  const numToKey = new Map();  // `${type}::${number}` -> source-group key
  const ensure = (key) => {
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    return g;
  };

  // Pass 1 — source-linked rows define the canonical groups.
  for (const r of list) {
    if (!r.sourceId) continue;
    const key = `src:${r.sourceId}::${typeOf(r)}`;
    ensure(key).push(r);
    const nn = normNum(r.projectNumber);
    const nk = `${typeOf(r)}::${nn}`;
    if (nn && !numToKey.has(nk)) numToKey.set(nk, key);
  }
  // Pass 2 — source-less rows join their project by number, else group alone.
  for (const r of list) {
    if (r.sourceId) continue;
    const nn = normNum(r.projectNumber);
    const key = (nn && numToKey.get(`${typeOf(r)}::${nn}`))
      || (nn ? `num:${nn}::${typeOf(r)}` : `id:${r.id}::${typeOf(r)}`);
    ensure(key).push(r);
  }

  // Billing-state priority — a project group surfaces its most-ACTIVE state.
  // Transitions write the same state to every row in the group, so this is
  // normally unanimous; the priority rule keeps partial/legacy data visible
  // (one stray 'active' year-row keeps the project on the Invoices tab
  // rather than silently hiding it).
  const STATE_RANK = { active: 0, between: 1, closed: 2 };
  const groupState = (g) => g.reduce((best, r) => {
    const s = r.billingState || "active";
    return STATE_RANK[s] < STATE_RANK[best] ? s : best;
  }, "closed");

  const merged = [];
  for (const g of groups.values()) {
    const byYear = {};
    for (const r of g) {
      const y = Number(r.year);
      if (!Number.isFinite(y)) continue;          // year-less optimistic row
      const prev = byYear[y];
      byYear[y] = (!prev || invoiceMonthsFilled(r) > invoiceMonthsFilled(prev)) ? r : prev;
    }
    const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
    const srcId = g.find(r => r.sourceId)?.sourceId || null;   // project's true id
    // Every underlying anticipated_invoice row id in this group — byYear keeps
    // only the best row per year, but billing-state transitions must touch ALL
    // rows (incl. same-year duplicates) or a stray row drags the group back.
    const groupIds = g.map(r => r.id);
    if (!years.length) {
      // Group had only year-less rows — surface one so nothing silently drops.
      merged.push({
        ...g[0], sourceId: g[0].sourceId || srcId, byYear: {}, years: [],
        groupIds, billingState: groupState(g),
      });
      continue;
    }
    const primaryYear = years.includes(THIS_YEAR)
      ? THIS_YEAR
      : years.reduce((best, y) =>
          Math.abs(y - THIS_YEAR) < Math.abs(best - THIS_YEAR) ? y : best, years[0]);
    const primary = byYear[primaryYear];
    merged.push({
      ...primary, sourceId: primary.sourceId || srcId, byYear, years,
      groupIds, billingState: groupState(g),
    });
  }
  return merged;
}

// Canonical MATCH KEY for an invoice project number (trimmed + lowercased) —
// mirrors mergeInvoiceYears' normNum so the Awarded link chips and the
// Invoice table agree on what "the same project" means. Display/storage keep
// the user's original (trimmed) casing; only lookups go through this.
export const normInvoiceNumber = (n) =>
  (n != null && String(n).trim() !== "") ? String(n).trim().toLowerCase() : "";

function adaptEvent(r) {
  return {
    id: r.id,
    date: r.event_date || "",
    status: r.status || "",
    type: r.type || "",
    title: r.title,
    dateTime: r.event_datetime || "",
    notes: r.notes || "",
    stars: r.stars == null ? null : Number(r.stars),
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
    type: r.type || null,
    dateTime: r.date_time || "",
    createdAt: r.created_at || null,
    // Unified "Client or Firm" picker on Hot Leads: the adapter prefers the
    // real client_id when set, else falls back to prime_company_id so the
    // Client column always shows something the UI can resolve. Writes go
    // through routeClientPick (see App.jsx) which targets the right column.
    clientId: r.client_id || r.prime_company_id || null,
    notes: r.notes || "",
    stars: r.stars == null ? null : Number(r.stars),
    anticipatedAmount: r.anticipated_amount == null ? null : Number(r.anticipated_amount),
    attendees: (r.attendees || []).map(a => a.user_id),
  };
}

function adaptOpenBid(r) {
  return {
    id: r.id,
    rfqNumber:          r.rfq_rfp_number || "",
    clientId:           r.client_id || null,
    serviceDescription: r.service_description || "",
    dueAt:              r.due_at || "",
    pdfPath:            r.pdf_file_path || "",
    pdfName:            r.pdf_file_name || "",
    webLink:            r.web_link || "",
    notes:              r.notes || "",
    approvalStatus:     r.approval_status || "pending",
    approvedBy:         r.approved_by || null,
    approvedAt:         r.approved_at || null,
    movedToProjectId:   r.moved_to_project_id || null,
    createdBy:          r.created_by || null,
    createdAt:          r.created_at || null,
    anticipatedAmount:  r.anticipated_amount == null ? null : Number(r.anticipated_amount),
  };
}

// project_item_subs → UI sub chips. Same { cId, desc, amt } shape the pipeline
// SubsCell already renders, so the existing primitive works unchanged.
const adaptItemSubs = (arr) =>
  (arr || [])
    .slice()
    .sort((a, b) => (a.ord || 0) - (b.ord || 0))
    .map(s => ({ cId: s.company_id, desc: s.discipline || "", amt: s.amount || 0 }));

const num = (v) => (v == null ? null : Number(v));

// A tree node (Project / Phase / Subphase / …). `id` is the surrogate uuid PK
// (keys, parent refs, updates all use it); `localId` is the human-entered
// SCOPED id shown in the UI (unique among siblings — globally for roots).
// `parentId` is the PARENT'S uuid (null = root). `clientId` is the merged
// Client/Prime value (a client OR a company), exactly like adaptPotential;
// routeClientPick splits it back into client_id / prime_company_id on write.
function adaptProjectItem(r) {
  return {
    id:              r.id,
    localId:         r.local_id || "",
    parentId:        r.parent_id || null,
    name:            r.name || "",
    clientId:        r.client_id || r.prime_company_id || null,
    itemType:        r.item_type || "standard",
    addressLine1:    r.address_line1 || "",
    addressLine2:    r.address_line2 || "",
    city:            r.city || "",
    state:           r.state || "",
    pinCode:         r.pin_code || "",
    contractType:    r.contract_type || "",
    contractAmount:  num(r.contract_amount),
    laborCost:       num(r.total_labor_cost),
    expenseCost:     num(r.total_expense_cost),
    billedServices:  num(r.billed_services),
    billedExpenses:  num(r.billed_expenses),
    billedTaxes:     num(r.billed_taxes),
    totalBilled:     num(r.total_billed_paid),
    startDate:       r.start_date || "",
    dueDate:         r.due_date || "",
    percentComplete: num(r.percent_complete),
    managerId:       r.manager_user_id || null,
    pmIds:           allPms(r.pms),
    subs:            adaptItemSubs(r.subs),
    status:          r.status || "active",
    notes:           r.notes || "",
    sortOrd:         r.sort_ord ?? null,
    createdAt:       r.created_at || null,
  };
}

// app_settings is a singleton row. Null benchmark = "no target set" (chart
// renders bars in a neutral color and hides the benchmark line).
const LEAVE_SETTING_DEFAULTS = {
  leavePayAnchor: "2026-06-03",        // a known pay date (every other Wednesday)
  leavePayIntervalDays: 14,
  leaveVacationAccrual: 3.076923077,   // hrs per pay period (= 80 hrs/yr over 26)
  leaveSickAccrual: 1.538461538,       // hrs per pay period (= 40 hrs/yr over 26)
};
function adaptAppSettings(row) {
  if (!row) return { monthlyInvoiceBenchmark: null, invoiceActualCutoverDay: 1, invoiceActualCutoverNextMonth: false, updatedAt: null, tkHolidays: [], tkWorkdayHours: 8, ...LEAVE_SETTING_DEFAULTS };
  const v = row.monthly_invoice_benchmark;
  const dayRaw = row.invoice_actual_cutover_day;
  const day = dayRaw == null ? 1 : Math.min(31, Math.max(1, Math.round(Number(dayRaw)) || 1));
  return {
    monthlyInvoiceBenchmark: v == null || v === "" ? null : Number(v),
    invoiceActualCutoverDay: day,
    invoiceActualCutoverNextMonth: !!row.invoice_actual_cutover_next_month,
    updatedAt: row.updated_at || null,
    // Company holidays (jsonb array of 'YYYY-MM-DD') + nominal workday length —
    // surfaced app-wide so the leave day-counter (weekdays minus holidays) and
    // the request preview can read them without a separate settings fetch.
    tkHolidays:     Array.isArray(row.tk_holidays) ? row.tk_holidays : [],
    tkWorkdayHours: row.tk_workday_hours != null ? Number(row.tk_workday_hours) : 8,
    leavePayAnchor:       row.leave_pay_anchor || LEAVE_SETTING_DEFAULTS.leavePayAnchor,
    leavePayIntervalDays: row.leave_pay_interval_days ? Number(row.leave_pay_interval_days) : LEAVE_SETTING_DEFAULTS.leavePayIntervalDays,
    leaveVacationAccrual: row.leave_vacation_accrual != null ? Number(row.leave_vacation_accrual) : LEAVE_SETTING_DEFAULTS.leaveVacationAccrual,
    leaveSickAccrual:     row.leave_sick_accrual     != null ? Number(row.leave_sick_accrual)     : LEAVE_SETTING_DEFAULTS.leaveSickAccrual,
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

// Admin-only writer for the Invoice Actual/Projection cutover (day 1–31 +
// whether it lands in the same month or the following month). Mirrors
// updateMonthlyBenchmark: updates the singleton, refreshes the in-memory
// _appSettings cache, returns the full adapted settings object.
export async function updateInvoiceActualCutover(day, nextMonth = false) {
  const n = Math.round(Number(day));
  if (!Number.isFinite(n) || n < 1 || n > 31) {
    throw new Error("Cutover day must be between 1 and 31");
  }
  const me = getCurrentBeaconUser();
  const { data, error } = await supabase
    .from("app_settings")
    .update({
      invoice_actual_cutover_day: n,
      invoice_actual_cutover_next_month: !!nextMonth,
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
// Leave (vacation / sick) tracker — bi-weekly accrual.
//
// Stored figures are the NET-available balance "as of" as_of_date; the live
// available balance accrues forward one pay period at a time. The pay schedule
// is deterministic (anchor pay date + interval), so the accrued amount is a
// pure function of the calendar — mirrors beacon_v2.v_leave_balances.
// ----------------------------------------------------------------------
const _epochDay      = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const _isoFromEpochDay = (d) => new Date(d * 86400000).toISOString().slice(0, 10);

// Count of pay dates in (asOf, today] given the anchor/interval schedule.
export function leaveAccrualPeriods(asOfISO, anchorISO, intervalDays, todayISO = todayInCT()) {
  if (!asOfISO || !anchorISO || !intervalDays) return 0;
  const a = _epochDay(anchorISO);
  const idx = (iso) => Math.floor((_epochDay(iso) - a) / intervalDays);
  return Math.max(0, idx(todayISO) - idx(asOfISO));
}

// First scheduled pay date strictly AFTER fromISO (the next accrual).
export function leaveNextPayDate(settings, fromISO = todayInCT()) {
  const a = _epochDay(settings.leavePayAnchor), i = settings.leavePayIntervalDays;
  const k = Math.floor((_epochDay(fromISO) - a) / i) + 1;
  return _isoFromEpochDay(a + k * i);
}

// Live available balances for one leave row (= stored balance + accrued).
export function computeLeaveAvailable(lb, settings = getAppSettings(), todayISO = todayInCT()) {
  const periods = lb.accrues
    ? leaveAccrualPeriods(lb.asOfDate, settings.leavePayAnchor, settings.leavePayIntervalDays, todayISO)
    : 0;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    periods,
    vacationAvailable: r2((lb.vacationBalance || 0) + periods * (settings.leaveVacationAccrual || 0)),
    sickAvailable:     r2((lb.sickBalance     || 0) + periods * (settings.leaveSickAccrual     || 0)),
  };
}

// Count eligible LEAVE days in an inclusive [startISO, endISO] range: weekdays
// (Mon–Fri) only, excluding company holidays. Weekends and holidays never count
// against a leave balance. `holidays` is an array of 'YYYY-MM-DD' strings.
export function leaveBusinessDays(startISO, endISO, holidays = getAppSettings().tkHolidays) {
  if (!startISO || !endISO) return 0;
  const hol = new Set(holidays || []);
  let s = _epochDay(startISO), e = _epochDay(endISO);
  if (e < s) return 0;
  let n = 0;
  for (let d = s; d <= e; d++) {
    const iso = _isoFromEpochDay(d);
    // getUTCDay on a midnight-UTC epoch day: 0 = Sun, 6 = Sat.
    const dow = new Date(d * 86400000).getUTCDay();
    if (dow === 0 || dow === 6) continue;     // weekend
    if (hol.has(iso)) continue;               // company holiday
    n++;
  }
  return n;
}

// Total leave hours for a range = eligible weekdays × hours-per-day.
export function leaveHoursFor(startISO, endISO, hoursPerDay, holidays = getAppSettings().tkHolidays) {
  const days = leaveBusinessDays(startISO, endISO, holidays);
  return Math.round(days * (Number(hoursPerDay) || 0) * 100) / 100;
}

export function adaptLeaveBalance(r) {
  return {
    userId:          r.user_id,
    vacationBalance: Number(r.vacation_balance) || 0,
    vacationUsed:    Number(r.vacation_used)    || 0,
    sickBalance:     Number(r.sick_balance)     || 0,
    sickUsed:        Number(r.sick_used)        || 0,
    asOfDate:        r.as_of_date,
    accrues:         r.accrues !== false,
  };
}

// Load leave rows. RLS scopes the result: an admin gets everyone, a regular
// user gets only their own. Degrades to [] if the migration isn't applied yet.
export async function loadLeaveBalances() {
  const { data, error } = await supabase.from("leave_balances").select("*");
  if (error) { console.warn("[beacon_v2] leave_balances fetch skipped:", error.message); return []; }
  return (data || []).map(adaptLeaveBalance);
}

// Admin-only writer for one person's leave row. Patch keys are the camelCase
// fields from adaptLeaveBalance.
export async function updateLeaveBalance(userId, patch) {
  const MAP = {
    vacationBalance: "vacation_balance", vacationUsed: "vacation_used",
    sickBalance: "sick_balance", sickUsed: "sick_used",
    asOfDate: "as_of_date", accrues: "accrues",
  };
  const db = {};
  for (const [k, col] of Object.entries(MAP)) if (k in patch) db[col] = patch[k];
  const { data, error } = await supabase
    .from("leave_balances").update(db).eq("user_id", userId).select("*").single();
  if (error) throw error;
  return adaptLeaveBalance(data);
}

// ----------------------------------------------------------------------
// Leave REQUESTS — submit · approve · deduct · revert.
//
// A request is a date range + hours-per-day + type + reason. It lands
// 'pending'; an admin approves (deducts balance via approve_leave_request RPC),
// rejects (no balance change), or reverts an approved one (adds hours back).
// Day counting (weekdays minus holidays) is snapshotted into business_days /
// total_hours at submit so a later holiday edit can't re-price an open request.
// ----------------------------------------------------------------------
export function adaptLeaveRequest(r) {
  return {
    id:           r.id,
    userId:       r.user_id,
    leaveType:    r.leave_type,
    dateStart:    r.date_start,
    dateEnd:      r.date_end,
    hoursPerDay:  Number(r.hours_per_day) || 0,
    businessDays: Number(r.business_days) || 0,
    totalHours:   Number(r.total_hours)   || 0,
    reason:       r.reason || "",
    status:       r.status,
    requestedAt:  r.requested_at,
    reviewedBy:   r.reviewed_by || null,
    reviewedAt:   r.reviewed_at || null,
    reviewNote:   r.review_note || "",
  };
}

// RLS scopes the result: a regular user sees only their own requests.
export async function loadMyLeaveRequests() {
  const u = getCurrentBeaconUser();
  if (!u) return [];
  const { data, error } = await supabase
    .from("leave_requests").select("*")
    .eq("user_id", u.id)
    .order("date_start", { ascending: false });
  if (error) { console.warn("[beacon_v2] leave_requests (mine) skipped:", error.message); return []; }
  return (data || []).map(adaptLeaveRequest);
}

// Admin gets everyone (RLS admin-select); a non-admin only their own rows.
export async function loadAllLeaveRequests() {
  const { data, error } = await supabase
    .from("leave_requests").select("*")
    .order("requested_at", { ascending: false });
  if (error) { console.warn("[beacon_v2] leave_requests (all) skipped:", error.message); return []; }
  return (data || []).map(adaptLeaveRequest);
}

// Email-body helpers (shared by submit + decision notifications).
const _hrsTxt = (n) => `${Math.round((Number(n) || 0) * 100) / 100}h`;
const _leaveKind = (t) => (t === "sick" ? "sick leave" : "vacation");
const _leaveRangeLabel = (s, e) => (e && e !== s) ? `${fmtDate(s)} – ${fmtDate(e)}` : fmtDate(s);

// Current available balance for one user + leave type (null if untracked).
// loadLeaveBalances() is RLS-scoped: the submitter gets their own row, an
// admin gets everyone — so callers filter by user id.
async function _leaveAvailableFor(userId, leaveType) {
  try {
    const bals = await loadLeaveBalances();
    const lb = bals.find(b => b.userId === userId);
    if (!lb) return null;
    const c = computeLeaveAvailable(lb);
    return leaveType === "sick" ? c.sickAvailable : c.vacationAvailable;
  } catch { return null; }
}

// Submit a new leave request for the signed-in user. Computes the eligible-day
// snapshot, then best-effort emails (a) the requester a confirmation with the
// before/after balance and (b) every admin a review request. Email failures
// never block the insert — each send is wrapped independently.
export async function submitLeaveRequest({ leaveType, dateStart, dateEnd, hoursPerDay, reason }) {
  const u = getCurrentBeaconUser();
  if (!u) throw new Error("not signed in");
  const holidays = getAppSettings().tkHolidays;
  const businessDays = leaveBusinessDays(dateStart, dateEnd, holidays);
  const hpd = Number(hoursPerDay) || 0;
  const totalHours = Math.round(businessDays * hpd * 100) / 100;
  const { data, error } = await supabase
    .from("leave_requests")
    .insert({
      user_id: u.id, leave_type: leaveType,
      date_start: dateStart, date_end: dateEnd,
      hours_per_day: hpd, business_days: businessDays, total_hours: totalHours,
      reason: reason || null, status: "pending",
    })
    .select("*").single();
  if (error) throw error;
  const req = adaptLeaveRequest(data);

  // Shared body pieces.
  const who     = userById(u.id)?.name || u.name || "A teammate";
  const kind    = _leaveKind(leaveType);
  const range   = _leaveRangeLabel(dateStart, dateEnd);
  const dayWord = businessDays === 1 ? "weekday" : "weekdays";
  const before  = await _leaveAvailableFor(u.id, leaveType);
  const after   = before == null ? null : Math.round((before - totalHours) * 100) / 100;

  // (a) Confirmation to the requester.
  try {
    const lines = [
      `Your ${kind} request has been submitted for review.`,
      ``,
      `• Dates: ${range} (${businessDays} ${dayWord})`,
      `• Each day: ${_hrsTxt(hpd)} · ${_hrsTxt(totalHours)} total`,
      before == null ? null : `• Balance: ${_hrsTxt(before)} now → ${_hrsTxt(after)} after approval`,
      reason ? `• Reason: ${reason}` : null,
      ``,
      `You'll get another email once an admin approves or declines it.`,
    ].filter(v => v !== null);
    await createOneShotAlert({ subjectRowId: u.id, message: lines.join("\n"), recipientUserIds: [u.id] });
  } catch (e) { console.warn("[leave] requester submit-confirm skipped:", e.message); }

  // (b) Review request to every admin.
  try {
    // All admins except the submitter (a self-submitting admin already got the
    // personal confirmation above — no need to also ask them to review it).
    const admins  = getUsers().filter(x => x.role === "Admin" && x.id !== u.id).map(x => x.id);
    const overTxt = (before != null && totalHours > before) ? " (over balance — would go negative)" : "";
    const lines = [
      `${who} submitted a ${kind} request and it's awaiting your review.`,
      ``,
      `• Dates: ${range} (${businessDays} ${dayWord})`,
      `• Each day: ${_hrsTxt(hpd)} · ${_hrsTxt(totalHours)} total`,
      before == null ? null : `• Their balance: ${_hrsTxt(before)} now → ${_hrsTxt(after)} if approved${overTxt}`,
      reason ? `• Reason: ${reason}` : null,
      ``,
      `Open Beacon → Time Admin → Leaves to approve or decline.`,
    ].filter(v => v !== null);
    await createOneShotAlert({ subjectRowId: u.id, message: lines.join("\n"), recipientUserIds: admins });
  } catch (e) { console.warn("[leave] admin notify skipped:", e.message); }

  return req;
}

// A user cancels their own still-pending request (RLS pending→cancelled).
export async function cancelLeaveRequest(id) {
  const { data, error } = await supabase
    .from("leave_requests").update({ status: "cancelled" })
    .eq("id", id).select("*").single();
  if (error) throw error;
  return adaptLeaveRequest(data);
}

async function _decideLeaveRequest(rpc, args, outcomeWord) {
  const { data, error } = await supabase.rpc(rpc, args);
  if (error) throw error;
  const req = adaptLeaveRequest(Array.isArray(data) ? data[0] : data);
  if (outcomeWord) {
    try { await _notifyLeaveDecision(req, outcomeWord); }
    catch (e) { console.warn("[leave] requester notify skipped:", e.message); }
  }
  return req;
}

// Build + send the approve/reject email to the requester. The approving admin
// is the caller, so loadLeaveBalances() (admin → everyone) lets us read the
// requester's POST-decision balance for the body.
async function _notifyLeaveDecision(req, outcomeWord) {
  const kind     = _leaveKind(req.leaveType);
  const range    = _leaveRangeLabel(req.dateStart, req.dateEnd);
  const dayWord  = req.businessDays === 1 ? "weekday" : "weekdays";
  const approver = userById(req.reviewedBy)?.name || getCurrentBeaconUser()?.name || "An administrator";

  let lines;
  if (outcomeWord === "approved") {
    const remain = await _leaveAvailableFor(req.userId, req.leaveType);
    lines = [
      `Good news — ${approver} approved your ${kind} request.`,
      ``,
      `• Dates: ${range} (${req.businessDays} ${dayWord})`,
      `• Each day: ${_hrsTxt(req.hoursPerDay)} · ${_hrsTxt(req.totalHours)} total`,
      remain == null ? null : `• Remaining ${kind} balance: ${_hrsTxt(remain)}`,
      req.reviewNote ? `• Note from ${approver}: ${req.reviewNote}` : null,
      ``,
      `It now shows on your Timesheet in Beacon, marked until ${fmtDate(req.dateEnd)}.`,
    ].filter(v => v !== null);
  } else {
    lines = [
      `${approver} declined your ${kind} request for ${range}.`,
      ``,
      `• Requested: ${_hrsTxt(req.totalHours)} (${req.businessDays} ${dayWord})`,
      req.reviewNote ? `• Note from ${approver}: ${req.reviewNote}` : null,
      ``,
      `Your balance was not changed. Reach out to your manager if you have questions.`,
    ].filter(v => v !== null);
  }
  await createOneShotAlert({ subjectRowId: req.userId, message: lines.join("\n"), recipientUserIds: [req.userId] });
}

export function approveLeaveRequest(id, note = null) {
  return _decideLeaveRequest("approve_leave_request", { p_id: id, p_note: note }, "approved");
}
export function rejectLeaveRequest(id, note = null) {
  return _decideLeaveRequest("reject_leave_request", { p_id: id, p_note: note }, "rejected");
}
// Revert restores the balance; no requester email (admin housekeeping action).
export function revertLeaveRequest(id) {
  return _decideLeaveRequest("revert_leave_request", { p_id: id }, null);
}

// One-shot alert (alerts + recipients + a pending fire) reusing the existing
// alerts→send-alert→Resend pipeline. subject_table='timesheet' renders the
// message verbatim, so no Edge Function change is needed. Best-effort: callers
// wrap this in try/catch so a notify failure never blocks the core action.
export async function createOneShotAlert({ subjectTable = "timesheet", subjectRowId, message, recipientUserIds }) {
  const ids = [...new Set((recipientUserIds || []).filter(Boolean))];
  if (!ids.length || !subjectRowId) return null;
  const me = getCurrentBeaconUser();
  const firstFireAt = new Date().toISOString();
  const { data: row, error: aErr } = await supabase
    .from("alerts")
    .insert({
      subject_table: subjectTable,
      subject_row_id: subjectRowId,
      first_fire_at: firstFireAt,
      recurrence: "one_time",
      message: message || null,
      timezone: "America/Chicago",
      created_by: me?.id || null,
      is_active: true,
    })
    .select("id").single();
  if (aErr) throw aErr;
  const { error: rErr } = await supabase.from("alert_recipients")
    .insert(ids.map(uid => ({ alert_id: row.id, user_id: uid })));
  if (rErr) throw rErr;
  const { error: fErr } = await supabase.from("alert_fires")
    .insert({ alert_id: row.id, scheduled_at: firstFireAt, status: "pending" });
  if (fErr) throw fErr;
  return row.id;
}

// ----------------------------------------------------------------------
// Licenses & Certifications.
//
// "Days until due" is derived, never stored: expiration_date − today (CT).
// Color bands: ≤30 days incl. expired = red, 31–60 = amber, ≥61 = green,
// no expiration = neutral. Reminder emails (milestone-based) are sent by the
// license-reminders Edge Function, not here.
// ----------------------------------------------------------------------

// Days until expiry. null expiration → null (no due date).
export function licenseDaysUntil(expirationISO, todayISO = todayInCT()) {
  if (!expirationISO) return null;
  return _epochDay(expirationISO) - _epochDay(todayISO);
}

// Urgency band for a days-until value. tone keys map to the license CSS palette.
export function licenseBand(days) {
  if (days == null) return { key: "none",     tone: "grey",  label: "No expiry" };
  if (days < 0)     return { key: "expired",  tone: "red",   label: "Expired" };
  if (days <= 30)   return { key: "critical", tone: "red",   label: "Due ≤ 30 days" };
  if (days <= 60)   return { key: "soon",     tone: "amber", label: "Due 31–60 days" };
  return              { key: "healthy",  tone: "green", label: "61+ days" };
}

export function adaptLicenseFile(r) {
  return {
    id:         r.id,
    licenseId:  r.license_id,
    path:       r.file_path,
    name:       r.file_name,
    uploadedAt: r.uploaded_at,
  };
}

export function adaptLicense(r) {
  return {
    id:               r.id,
    legacyId:         r.legacy_id ?? null,
    entity:           r.entity || "",
    state:            r.state || "",
    type:             r.lic_type || "",
    licenseNo:        r.license_no || "",
    asceMNo:          r.asce_m_no || "",
    firstIssueDate:   r.first_issue_date || null,
    expirationDate:   r.expiration_date || null,
    notifyEmails:     Array.isArray(r.notify_emails) ? r.notify_emails : [],
    emailEnabled:     r.email_enabled !== false,
    notes:            r.notes || "",
    lastNotifiedBand: r.last_notified_band ?? null,
    lastNotifiedAt:   r.last_notified_at || null,
    files:            (r.files || []).map(adaptLicenseFile),
    createdAt:        r.created_at,
    updatedAt:        r.updated_at,
  };
}

// camelCase patch key → DB column (the editable surface).
const LICENSE_COLS = {
  entity: "entity", state: "state", type: "lic_type",
  licenseNo: "license_no", asceMNo: "asce_m_no",
  firstIssueDate: "first_issue_date", expirationDate: "expiration_date",
  notifyEmails: "notify_emails", emailEnabled: "email_enabled", notes: "notes",
};

function licensePatchToDb(patch) {
  const db = {};
  for (const [k, col] of Object.entries(LICENSE_COLS)) if (k in patch) db[col] = patch[k];
  // Empty date strings must persist as NULL, not "".
  if ("first_issue_date" in db && !db.first_issue_date) db.first_issue_date = null;
  if ("expiration_date"  in db && !db.expiration_date)  db.expiration_date  = null;
  // Trim blank free-text to NULL so filters/sorts stay clean.
  for (const c of ["state", "lic_type", "license_no", "asce_m_no", "notes"]) {
    if (c in db && typeof db[c] === "string" && db[c].trim() === "") db[c] = null;
  }
  if ("notify_emails" in db && !Array.isArray(db.notify_emails)) db.notify_emails = [];
  return db;
}

// RLS-scoped read (every signed-in user sees all licenses). Degrades to [] if
// the migration hasn't been applied yet.
export async function loadLicenses() {
  const { data, error } = await supabase
    .from("licenses")
    .select("*, files:license_files(*)")
    .order("expiration_date", { ascending: true, nullsFirst: false });
  if (error) { console.warn("[beacon_v2] licenses fetch skipped:", error.message); return []; }
  return (data || []).map(adaptLicense);
}

export async function createLicense(patch) {
  const db = licensePatchToDb(patch);
  if (!db.entity || !String(db.entity).trim()) db.entity = "(unnamed)";
  const { data, error } = await supabase
    .from("licenses").insert(db).select("*, files:license_files(*)").single();
  if (error) throw error;
  return adaptLicense(data);
}

export async function updateLicense(id, patch) {
  const db = licensePatchToDb(patch);
  const { data, error } = await supabase
    .from("licenses").update(db).eq("id", id).select("*, files:license_files(*)").single();
  if (error) throw error;
  return adaptLicense(data);
}

export async function deleteLicense(id) {
  // Remove attached Storage binaries first so nothing is orphaned (the row
  // cascade-deletes license_files, but not the bucket objects).
  const { data: files } = await supabase.from("license_files").select("file_path").eq("license_id", id);
  const paths = (files || []).map(f => f.file_path).filter(Boolean);
  if (paths.length) await supabase.storage.from("license-files").remove(paths);
  const { error } = await supabase.from("licenses").delete().eq("id", id);
  if (error) throw error;
}

// ---- license attachments ----
export async function uploadLicenseFile(licenseId, file) {
  const me = getCurrentBeaconUser();
  const safe = (file.name || "file").replace(/[^\w.\-]+/g, "_");
  const path = `${licenseId}/${Date.now()}-${safe}`;
  const { error: upErr } = await supabase.storage.from("license-files").upload(path, file, { upsert: false });
  if (upErr) throw upErr;
  const { data, error } = await supabase.from("license_files")
    .insert({ license_id: licenseId, file_path: path, file_name: file.name, uploaded_by: me?.id || null })
    .select("*").single();
  if (error) throw error;
  return adaptLicenseFile(data);
}

export async function deleteLicenseFile(fileRow) {
  if (fileRow?.path) await supabase.storage.from("license-files").remove([fileRow.path]);
  const { error } = await supabase.from("license_files").delete().eq("id", fileRow.id);
  if (error) throw error;
}

export async function licenseFileUrl(path) {
  const { data, error } = await supabase.storage.from("license-files").createSignedUrl(path, 3600);
  if (error) throw error;
  return data?.signedUrl || null;
}

// Manual "send reminders now" — invokes the license-reminders Edge Function
// with the caller's session (admin). No-op-safe before the function is deployed
// (the caller surfaces the error).
export const licenseRunReminders = () =>
  supabase.functions.invoke("license-reminders", { body: {} });

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

// Empty per-year slot for the sub matrix — 12 months of amount/file/paid.
function emptyMonthSlot() {
  return {
    amounts: Array(12).fill(null),
    files: Array(12).fill(null).map(() => []),
    subInvoiceIds: Array(12).fill(null),
    paid: Array(12).fill(false),
    paidAt: Array(12).fill(null),
  };
}
// Aggregate sub_invoices rows (ALL years) into
//   "projectId:kind:companyId" → { [year]: <month slot> }
// so the rolling-window Invoice table can read any year's sub billing.
function buildSubAggregate(subInvRows, subFilesBySubInvoice) {
  const agg = new Map();
  for (const r of (subInvRows || [])) {
    const m = (r.month || 0) - 1;
    if (m < 0 || m > 11) continue;
    const kind = r.kind || "sub";
    const tk = `${r.project_id}:${kind}:${r.company_id}`;
    let byYear = agg.get(tk);
    if (!byYear) { byYear = {}; agg.set(tk, byYear); }
    const slot = byYear[r.year] || (byYear[r.year] = emptyMonthSlot());
    slot.amounts[m] = r.amount != null ? Number(r.amount) : null;
    slot.subInvoiceIds[m] = r.id;
    slot.files[m] = (subFilesBySubInvoice.get(r.id) || []);
    slot.paid[m] = !!r.paid;
    slot.paidAt[m] = r.paid_at || null;
  }
  return agg;
}
// One sub-matrix entry's data: the flat THIS_YEAR arrays (kept for the
// Receivables panel, which is still single-year) PLUS the full byYear map
// (consumed by the rolling-window InvoiceTable). `touched` = any year present.
function subEntryArrays(agg, projectId, kind, companyId) {
  const byYear = agg.get(`${projectId}:${kind}:${companyId}`) || {};
  const flat = byYear[THIS_YEAR] || emptyMonthSlot();
  return {
    amounts: flat.amounts,
    files: flat.files,
    subInvoiceIds: flat.subInvoiceIds,
    paid: flat.paid,
    paidAt: flat.paidAt,
    byYear,
    touched: Object.keys(byYear).length > 0,
  };
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
    subInvRows, subInvFileRows, primeInvFileRows, partyInvFileRows, appSettingsRows,
    openBidRows, invoiceNoteRows, invoiceLinkRows, projectItemRows,
  ] = await Promise.all([
    pget(supabase.from("users").select("*").order("display_name"), "users"),
    pget(supabase.from("clients").select("*").order("name"), "clients"),
    pget(supabase.from("companies").select("*").order("name"), "companies"),
    pget(
      supabase.from("projects")
        .select("*, subs:project_subs(*), pms:project_pms(user_id), stage:stage_id(name)")
        .order("year", { ascending: false })
        .order("project_name"),
      "projects"
    ),
    pget(
      // All years — the Invoice tab is a rolling multi-year window now, so we
      // can't scope to THIS_YEAR. mergeInvoiceYears folds a project's per-year
      // rows together for display; the volume is small (one row per project
      // per year), so a full pull is fine.
      supabase.from("anticipated_invoice")
        .select("*, pms:anticipated_invoice_pms(user_id)")
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
    // All years — sub billing also feeds the rolling multi-year window.
    supabase.from("sub_invoices").select("*")
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
    // Project-level (party) file attachments. New in 20260514120000; degrade
    // gracefully if the migration hasn't been applied yet.
    supabase.from("invoice_party_files").select("*")
      .then(({ data, error }) => {
        if (error) { console.warn("[beacon_v2] invoice_party_files fetch skipped:", error.message); return []; }
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
    // Open Bids — pre-Awaiting pipeline stage. Newest due first; rows without
    // a due date sort last. Gracefully degrade if the migration hasn't landed.
    supabase.from("open_bids")
      .select("*")
      .order("due_at", { ascending: true, nullsFirst: false })
      .then(({ data, error }) => {
        if (error) { console.warn("[beacon_v2] open_bids fetch skipped:", error.message); return []; }
        return data || [];
      }),
    // Threaded Invoice notes (20260608130000). Fetched as its own query —
    // rather than embedded on the anticipated_invoice select — so that a DB
    // without the migration applied degrades to an empty thread instead of
    // failing the whole invoice load. Newest-first; annotated onto each
    // invoice row as `notesLog` below.
    supabase.from("invoice_notes")
      .select("*")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) { console.warn("[beacon_v2] invoice_notes fetch skipped:", error.message); return []; }
        return data || [];
      }),
    // Awarded ↔ Invoice project links (20260611120100). Keyed on the invoice
    // PROJECT NUMBER (the merge key of the Invoice table), not an invoice row
    // id. Own graceful-degrade query so an un-migrated DB just shows no links.
    supabase.from("project_invoice_links")
      .select("*")
      .then(({ data, error }) => {
        if (error) { console.warn("[beacon_v2] project_invoice_links fetch skipped:", error.message); return []; }
        return data || [];
      }),
    // Projects (tree-structured work breakdown — beacon_v2.project_items).
    // Own graceful-degrade query so an un-migrated DB just shows an empty
    // Projects tab. Subs + additional PMs ride along via the join embeds.
    supabase.from("project_items")
      .select("*, subs:project_item_subs(*), pms:project_item_pms(user_id)")
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (error) { console.warn("[beacon_v2] project_items fetch skipped:", error.message); return []; }
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
  // Project-level (party) file lookup. Three buckets per invoice row:
  //   partyFiles.msmm: File[]                       — files on the MSMM line
  //   partyFiles.prime: { [companyId]: File[] }     — files on each prime firm
  //   partyFiles.sub:   { [companyId]: File[] }     — files on each sub firm
  // Built once here and attached to every adapted invoice row so the UI can
  // render counts on the firm-name paperclips without an extra query.
  const partyFilesByInvoice = new Map();
  for (const f of (partyInvFileRows || [])) {
    let bucket = partyFilesByInvoice.get(f.invoice_id);
    if (!bucket) {
      bucket = { msmm: [], prime: {}, sub: {} };
      partyFilesByInvoice.set(f.invoice_id, bucket);
    }
    if (f.party_kind === "msmm") {
      bucket.msmm.push(f);
    } else if (f.party_company_id) {
      const sub = bucket[f.party_kind];
      (sub[f.party_company_id] = sub[f.party_company_id] || []).push(f);
    }
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
  // Group the threaded invoice notes by invoice_id, newest-first (the query
  // already orders by created_at desc, so push order is preserved).
  const notesByInvoice = new Map();
  for (const n of (invoiceNoteRows || [])) {
    const arr = notesByInvoice.get(n.invoice_id) || [];
    arr.push(adaptNote(n));
    notesByInvoice.set(n.invoice_id, arr);
  }
  const adaptedInvoices = reconciledInvoices.map(adaptInvoice).map(inv => ({
    ...inv,
    role: inv.sourceId ? (projectRoleById.get(inv.sourceId) || "Prime") : "Prime",
    primeFiles: Array.from({ length: 12 }, (_, i) =>
      primeFilesByKey.get(`${inv.id}:${i + 1}`) || []
    ),
    partyFiles: partyFilesByInvoice.get(inv.id) || { msmm: [], prime: {}, sub: {} },
    // Threaded notes for this (project, year) row, newest-first. mergeInvoiceYears
    // spreads the primary year-row, so the merged row inherits this list — the
    // same row whose id the Notes chip keys on.
    notesLog: notesByInvoice.get(inv.id) || [],
  }));

  // Build the per-project sub matrix. For each project that has subs in
  // project_subs, list every sub with their 12-month amounts (from
  // sub_invoices) + 12-month file lists (from sub_invoice_files). Subs
  // with no sub_invoice rows still appear — empty cells.
  // Key includes kind so the same company can theoretically appear once
  // per kind per month. Today we only ever look up by (project, company,
  // month, kind) but the matrix builder respects the kind discriminator.
  const subFilesBySubInvoice = new Map();
  for (const f of (subInvFileRows || [])) {
    const arr = subFilesBySubInvoice.get(f.sub_invoice_id) || [];
    arr.push(f);
    subFilesBySubInvoice.set(f.sub_invoice_id, arr);
  }
  // Aggregate ALL years of sub billing → "projectId:kind:companyId" → byYear.
  // subEntryArrays then yields each entry's flat THIS_YEAR arrays (Receivables)
  // + the byYear map (rolling-window InvoiceTable).
  const subAgg = buildSubAggregate(subInvRows, subFilesBySubInvoice);
  const buildMonthlyArrays = (projectId, kind, companyId) =>
    subEntryArrays(subAgg, projectId, kind, companyId);

  const subInvoicesMatrix = new Map();   // project_id → [{ companyId, companyName, contractAmount, discipline, amounts[12], files[12], subInvoiceIds[12] }]
  for (const p of projects) {
    const subs = dedupeSubsByCompanyKind(
      (p.subs || [])
        .slice()
        .sort((a, b) => (a.ord || 0) - (b.ord || 0))
    );
    const entries = subs.map(s => {
      const company = companies.find(c => c.id === s.company_id);
      const kind = s.kind || "sub";
      const arrays = buildMonthlyArrays(p.id, kind, s.company_id);
      return {
        kind,
        companyId: s.company_id,
        companyName: company?.name || "Unknown company",
        contractAmount: s.amount || 0,
        // Per-sub "Remaining Jan 1" override (NULL = fall back to contract).
        remainingStart: s.remaining_to_bill_year_start ?? null,
        discipline: s.discipline || "",
        subAgreement: !!s.sub_agreement,
        w9: !!s.w9,
        coi: !!s.coi,
        amounts: arrays.amounts,
        files: arrays.files,
        subInvoiceIds: arrays.subInvoiceIds,
        paid: arrays.paid,
        paidAt: arrays.paidAt,
        byYear: arrays.byYear,
      };
    });

    // Synthetic prime fallback — when MSMM is sub on a project (the project
    // row has prime_company_id set), but no project_subs(kind='prime') row
    // exists, we still need to surface this relationship for the
    // receivables view and for the InvoiceTable's prime row. The synthetic
    // entry pulls any sub_invoices(kind='prime') data that may have been
    // entered without a corresponding project_subs row, so manually-added
    // billing data isn't lost.
    const hasPrimeEntry = entries.some(e => e.kind === "prime");
    if (!hasPrimeEntry && p.prime_company_id) {
      const primeCompany = companies.find(c => c.id === p.prime_company_id);
      const arrays = buildMonthlyArrays(p.id, "prime", p.prime_company_id);
      // Only synthesize when there's actually billing data — otherwise we'd
      // emit empty entries for every Sub-role project regardless of activity.
      if (arrays.touched) {
        entries.push({
          kind: "prime",
          companyId: p.prime_company_id,
          companyName: primeCompany?.name || "Unknown prime",
          contractAmount: 0, // unknown — no project_subs row to read amount from
          remainingStart: null,
          discipline: "",
          amounts: arrays.amounts,
          files: arrays.files,
          subInvoiceIds: arrays.subInvoiceIds,
          paid: arrays.paid,
          paidAt: arrays.paidAt,
          byYear: arrays.byYear,
          synthetic: true,
        });
      }
    }

    if (entries.length > 0) subInvoicesMatrix.set(p.id, entries);
  }

  // Group the awarded↔invoice links per project. Annotated onto each awarded
  // row as `invoiceLinks: string[]` (invoice project numbers, insertion order).
  const linksByProject = new Map();
  for (const l of (invoiceLinkRows || [])) {
    const arr = linksByProject.get(l.project_id) || [];
    arr.push(l.project_number);
    linksByProject.set(l.project_id, arr);
  }

  return {
    potential: potential.map(adaptPotential),
    awaiting:  awaiting.map(adaptAwaiting),
    awarded:   awarded.map(adaptAwarded).map(r => ({
      ...r,
      invoiceLinks: linksByProject.get(r.id) || [],
    })),
    closed:    closed.map(adaptClosed),
    invoices:  adaptedInvoices,
    events:    events.map(adaptEvent),
    hotLeads:  hotLeads.map(adaptHotLead),
    openBids:  (openBidRows || []).map(adaptOpenBid),
    projectItems: (projectItemRows || []).map(adaptProjectItem),
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

// Read a File as raw base64 (no `data:<mime>;base64,` prefix) for relaying to
// the generate-description Edge Function. The function re-adds the data-URI
// prefix when it builds the OpenAI `input_file` content part.
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

// AI project-description generation. Posts ephemeral sources (base64 files +
// inline text) and options to the generate-description Edge Function, which
// calls the OpenAI Responses API and returns the draft text. The caller's
// session JWT is auto-attached by supabase.functions.invoke.
export async function generateInvoiceDescription(payload) {
  const { data, error } = await supabase.functions.invoke("generate-description", { body: payload });
  if (error) {
    // supabase-js puts the function's response body on error.context when non-2xx.
    let detail = error.message || "generation failed";
    try {
      const ctx = error.context;
      const text = ctx && typeof ctx.text === "function" ? await ctx.text() : null;
      if (text) { try { detail = JSON.parse(text).error || text; } catch { detail = text; } }
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  if (!data?.ok) throw new Error(data?.error || "generation failed");
  return data.text;
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
// Collapse duplicate subs down to one per (company, kind). Handles both
// DB-shape ({company_id, kind}) and UI-shape ({cId, kind}) sub objects.
// Null-company drafts are kept as-is. Keeps the FIRST occurrence (callers
// sort by `ord` first). Display-side defense so a DB that still has dupes
// (before migration 20260606120600 is applied) renders one row per sub.
export function dedupeSubsByCompanyKind(subs) {
  const seen = new Set();
  const out = [];
  for (const s of (subs || [])) {
    const cId = s.company_id ?? s.cId ?? null;
    if (cId == null) { out.push(s); continue; }
    const key = `${cId}:${s.kind || "sub"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Returns { row, existed }: `existed` is true when the company was already a
// sub/prime on this project (no new row created) so the caller can avoid
// appending a duplicate and tell the user instead. Idempotent + race-safe:
// (project_id, company_id, kind) is the natural key (enforced by the unique
// index from 20260606120600), so a re-add — or a double-submit that slips the
// busy guard — returns the existing row rather than spawning a duplicate.
export async function addProjectSub({ projectId, companyId, discipline, amount, ord, kind = "sub" }) {
  const payload = {
    project_id: projectId,
    company_id: companyId,
    discipline: discipline || null,
    amount: amount === "" || amount == null ? null : Number(amount),
    ord: ord ?? null,
    kind,
  };
  // Pre-check: if this company is already on the project under this kind,
  // don't insert again — return the existing row.
  if (companyId) {
    const { data: existing } = await supabase
      .from("project_subs")
      .select("*")
      .eq("project_id", projectId)
      .eq("company_id", companyId)
      .eq("kind", kind)
      .limit(1)
      .maybeSingle();
    if (existing) return { row: existing, existed: true };
  }
  const { data, error } = await supabase
    .from("project_subs")
    .insert(payload)
    .select("*")
    .single();
  if (error) {
    // 23505 = unique_violation: a concurrent add won the race after our
    // pre-check. Fetch and return the row that landed so this resolves to a
    // no-op duplicate rather than an error.
    if (error.code === "23505" && companyId) {
      const { data: raced } = await supabase
        .from("project_subs")
        .select("*")
        .eq("project_id", projectId)
        .eq("company_id", companyId)
        .eq("kind", kind)
        .limit(1)
        .maybeSingle();
      if (raced) return { row: raced, existed: true };
    }
    throw new Error(`add ${kind}: ${error.message}`);
  }
  return { row: data, existed: false };
}

// Create a brand-new company (firm) in the Directory and return it in the
// adapted UI shape. Backs the inline "create firm" affordance in AddSubModal:
// when a sub firm isn't in the Directory yet, the user can add it without
// leaving the modal. The row lands in beacon_v2.companies, so it immediately
// surfaces on the Directory tab and in every company picker app-wide once the
// caller mirrors the returned row into App state.
export async function addCompany({ name, contact, email, phone, address, notes } = {}) {
  const clean = (name || "").trim();
  if (!clean) throw new Error("Company name is required");
  const payload = {
    name: clean,
    contact_person: (contact || "").trim() || null,
    email: (email || "").trim() || null,
    phone: (phone || "").trim() || null,
    address: (address || "").trim() || null,
    notes: (notes || "").trim() || null,
  };
  const { data, error } = await supabase
    .from("companies").insert(payload).select("*").single();
  if (error) {
    // 23505 = unique_violation on companies.name — surface a friendly message
    // rather than the raw constraint error.
    if (error.code === "23505") {
      throw new Error(`A firm named "${clean}" already exists in the Directory`);
    }
    throw new Error(`add company: ${error.message}`);
  }
  // A fresh company has no observed project usage yet, so adaptCompany's
  // empty-typeMap fallback ("Prime", i.e. non-Client) is exactly right — it
  // passes the sub-picker's `type !== "Client"` filter immediately.
  return adaptCompany(data, new Map());
}

// Update an existing project_subs row. Identifies the row by the natural
// composite key (project_id, company_id, kind). Patch is whitelisted to the
// metadata fields users can edit inline — amount and discipline. Other
// columns (project_id / company_id / kind / ord) are immutable; to swap the
// linked company on a row, remove + re-add.
export async function updateProjectSub({ projectId, companyId, kind = "sub", amount, discipline, sub_agreement, w9, coi, remaining_to_bill_year_start }) {
  const patch = {};
  if (amount !== undefined) {
    patch.amount = (amount === "" || amount == null) ? null : Number(amount);
  }
  if (discipline !== undefined) {
    patch.discipline = (discipline === "" || discipline == null) ? null : String(discipline);
  }
  // Per-sub compliance-document flags (sub_agreement / w9 / coi).
  if (sub_agreement !== undefined) patch.sub_agreement = !!sub_agreement;
  if (w9 !== undefined) patch.w9 = !!w9;
  if (coi !== undefined) patch.coi = !!coi;
  // Per-sub "Remaining to bill at year start" (Invoice expand · Remaining Jan 1).
  if (remaining_to_bill_year_start !== undefined) {
    patch.remaining_to_bill_year_start =
      (remaining_to_bill_year_start === "" || remaining_to_bill_year_start == null)
        ? null : Number(remaining_to_bill_year_start);
  }
  if (Object.keys(patch).length === 0) return null;
  const { error } = await supabase
    .from("project_subs")
    .update(patch)
    .eq("project_id", projectId)
    .eq("company_id", companyId)
    .eq("kind", kind);
  if (error) throw new Error(`update ${kind}: ${error.message}`);
  return patch;
}

// Remove a project_subs row. For kind='prime' rows we also clear
// projects.prime_company_id so the role/consistency invariant holds.
// Note: this does NOT delete linked sub_invoices rows — those are kept as
// history. If you re-add the same company afterwards, the existing billing
// data resurfaces automatically (the matrix builder keys on company_id).
export async function removeProjectSub({ projectId, companyId, kind = "sub" }) {
  if (!projectId) {
    throw new Error(`remove ${kind}: this invoice isn't linked to a project yet`);
  }
  let del = supabase
    .from("project_subs")
    .delete()
    .eq("project_id", projectId)
    .eq("kind", kind);
  // A draft sub (added before a company was picked) has a NULL company_id.
  // supabase-js .eq("company_id", null) serializes to `company_id=eq.null`,
  // which Postgres reads as the literal text "null" and fails to cast to uuid
  // ("invalid input syntax for type uuid: \"null\""). Match NULLs with .is()
  // instead. (Removes any company-less draft row(s) of this kind — they carry
  // no sub_invoices, which key on company_id, so nothing is orphaned.)
  if (companyId == null || companyId === "" || companyId === "null") {
    del = del.is("company_id", null);
  } else {
    del = del.eq("company_id", companyId);
  }
  const { error } = await del;
  if (error) throw new Error(`remove ${kind}: ${error.message}`);
  if (kind === "prime") {
    const { error: e2 } = await supabase
      .from("projects")
      .update({ prime_company_id: null })
      .eq("id", projectId);
    if (e2) throw new Error(`clear prime_company_id: ${e2.message}`);
  }
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

// Storage path for project-level (party) attachments. Independent of month —
// these files describe the firm relationship, not a specific billing cycle.
//   msmm:  ${projectId}/party/msmm/${stamp-name}
//   prime: ${projectId}/party/prime/${slug}/${stamp-name}
//   sub:   ${projectId}/party/sub/${slug}/${stamp-name}
export function buildInvoicePartyStoragePath({ projectId, partyKind, companyName, originalName }) {
  const fileName = uploadFilename(originalName);
  if (partyKind === "msmm") return `${projectId}/party/msmm/${fileName}`;
  const slug = slugCompanyName(companyName || partyKind);
  return `${projectId}/party/${partyKind}/${slug}/${fileName}`;
}

// Upload one file to the bucket + write a metadata row in invoice_party_files.
// Caller may invoke this in a loop for multi-file uploads (the modal stages
// every picked file and submits them sequentially so we get per-file error
// surfaces). Falls back to projectId=invoiceId when the invoice has no
// linked project — keeps the binary discoverable in Storage either way.
export async function uploadInvoicePartyFile(opts) {
  const { invoiceId, projectId, partyKind, partyCompanyId, companyName, file, notes } = opts;
  const path = buildInvoicePartyStoragePath({
    projectId: projectId || invoiceId,
    partyKind,
    companyName,
    originalName: file?.name || "file",
  });
  const up = await supabase.storage.from("invoices").upload(path, file, {
    upsert: false,
    cacheControl: "3600",
  });
  if (up.error) throw new Error(`storage upload: ${up.error.message}`);
  const session = await supabase.auth.getSession();
  const authUid = session.data?.session?.user?.id || null;
  const beaconUserId = authUid ? (_users.find(x => x.id === authUid)?.id || null) : null;
  const { data, error } = await supabase.from("invoice_party_files")
    .insert({
      invoice_id: invoiceId,
      party_kind: partyKind,
      party_company_id: partyKind === "msmm" ? null : (partyCompanyId || null),
      file_path: path,
      file_name: file.name,
      notes: notes || null,
      uploaded_by: beaconUserId,
    })
    .select("*")
    .single();
  if (error) throw new Error(`invoice_party_files insert: ${error.message}`);
  return data;
}

export async function deleteInvoicePartyFile({ fileId, filePath }) {
  // Same ordering as deleteInvoiceFile — storage binary first, then DB row.
  const rm = await supabase.storage.from("invoices").remove([filePath]);
  if (rm.error) throw new Error(`storage remove: ${rm.error.message}`);
  const { error } = await supabase.from("invoice_party_files").delete().eq("id", fileId);
  if (error) throw new Error(`invoice_party_files delete: ${error.message}`);
}

// Refetch only the invoice_party_files table and rebuild the per-invoice
// bucket. Used by App.jsx onChanged after an upload/delete inside the party
// modal so the row's count badges update without a full reload.
export async function reloadInvoicePartyFiles() {
  const { data, error } = await supabase.from("invoice_party_files").select("*");
  if (error) { console.warn("[beacon_v2] party files reload skipped:", error.message); return new Map(); }
  const byInvoice = new Map();
  for (const f of (data || [])) {
    let bucket = byInvoice.get(f.invoice_id);
    if (!bucket) {
      bucket = { msmm: [], prime: {}, sub: {} };
      byInvoice.set(f.invoice_id, bucket);
    }
    if (f.party_kind === "msmm") {
      bucket.msmm.push(f);
    } else if (f.party_company_id) {
      const slot = bucket[f.party_kind];
      (slot[f.party_company_id] = slot[f.party_company_id] || []).push(f);
    }
  }
  return byInvoice;
}

// Refetch sub_invoices + sub_invoice_files + prime_invoice_files after an
// upload/delete. Returns the same shape loadBeacon assembles for these
// pieces so App.jsx can replace its slices in one call.
export async function reloadInvoiceArtifacts(projects, companies) {
  const [subInvRows, subInvFileRows, primeInvFileRows] = await Promise.all([
    // All years — the Invoice tab is a rolling multi-year window.
    supabase.from("sub_invoices").select("*")
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
  const subFilesBySubInvoice = new Map();
  for (const f of subInvFileRows) {
    const arr = subFilesBySubInvoice.get(f.sub_invoice_id) || [];
    arr.push(f); subFilesBySubInvoice.set(f.sub_invoice_id, arr);
  }
  const subAgg = buildSubAggregate(subInvRows, subFilesBySubInvoice);
  const subInvoicesMatrix = new Map();
  for (const p of projects) {
    const subs = dedupeSubsByCompanyKind(
      (p.subs || []).slice().sort((a,b) => (a.ord||0)-(b.ord||0))
    );
    if (subs.length === 0) continue;
    const entries = subs.map(s => {
      const cId = s.cId || s.company_id;
      const kind = s.kind || "sub";
      const company = companies.find(c => c.id === cId);
      const arrays = subEntryArrays(subAgg, p.id, kind, cId);
      return {
        kind,
        companyId: cId,
        companyName: company?.name || "Unknown company",
        contractAmount: s.amt || s.amount || 0,
        remainingStart: s.remaining ?? s.remaining_to_bill_year_start ?? null,
        discipline: s.desc || s.discipline || "",
        subAgreement: !!(s.subAgreement ?? s.sub_agreement),
        w9: !!s.w9,
        coi: !!s.coi,
        amounts: arrays.amounts,
        files: arrays.files,
        subInvoiceIds: arrays.subInvoiceIds,
        paid: arrays.paid,
        paidAt: arrays.paidAt,
        byYear: arrays.byYear,
      };
    });
    subInvoicesMatrix.set(p.id, entries);
  }
  return { primeFilesByKey, subInvoicesMatrix };
}

// ============================================================================
// TIMEKEEPING
// ============================================================================
// All shape adapters convert DB snake_case → UI camelCase. Mutators are thin
// wrappers around supabase.from(...) writes; admin operations route through
// the timeclock-admin Edge Function for service-role-only paths.

const CT_TZ = "America/Chicago";

// "YYYY-MM-DD" for today in Central Time. Used everywhere the day-rollup is
// keyed (timesheet_days, week math). Mirrors the DB trigger's hardcoded tz.
export function todayInCT() {
  return new Date().toLocaleDateString("en-CA", { timeZone: CT_TZ });
}

// Monday-aligned week_start for a given ISO date string.
export function weekStartCT(isoDate) {
  const base = isoDate ? new Date(`${String(isoDate).slice(0,10)}T12:00:00`) : new Date();
  // Use Central Time wall clock to pick the day-of-week so weeks don't shift
  // across DST around the boundary.
  const local = new Date(base.toLocaleString("en-US", { timeZone: CT_TZ }));
  const dow = (local.getDay() + 6) % 7; // 0 = Monday
  local.setDate(local.getDate() - dow);
  return local.toLocaleDateString("en-CA", { timeZone: CT_TZ });
}

// Format a minute count as "Xh Ym".
//   default     → collapses zero parts ("5m", "1h", "1h 5m") for narrow UI
//   always:true → always shows both units ("0h 5m", "1h 0m", "0h 0m") — used
//                 by the Time Admin tabular views so every cell scans the
//                 same way and a 5-minute punch is never mistaken for empty.
export function fmtHM(min, opts) {
  const always = opts && opts.always === true;
  if (!Number.isFinite(min) || min <= 0) return always ? "0h 0m" : "0h";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (always) return `${h}h ${m}m`;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function fmtClock(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: CT_TZ, hour: "numeric", minute: "2-digit",
  });
}

// ----------------------------------------------------------------------
// Adapters
// ----------------------------------------------------------------------
export function adaptPunch(r) {
  if (!r) return null;
  return {
    id:             r.id,
    userId:         r.user_id,
    punchedAt:      r.punched_at,
    source:         r.source,
    sourceDeviceId: r.source_device_id || null,
    sourceNfcUid:   r.source_nfc_uid   || null,
    note:           r.note             || null,
    createdAt:      r.created_at,
    createdBy:      r.created_by || null,
  };
}

export function adaptInterval(r) {
  if (!r) return null;
  return {
    id:                    r.id,
    userId:                r.user_id,
    startAt:               r.start_at,
    endAt:                 r.end_at,
    startPunchId:          r.start_punch_id || null,
    endPunchId:            r.end_punch_id   || null,
    category:              r.category,
    categorySource:        r.category_source,
    isOut:                 !!r.is_out,
    outlookEventId:        r.outlook_event_id        || null,
    outlookEventSubject:   r.outlook_event_subject   || null,
    outlookEventLocation:  r.outlook_event_location  || null,
    notes:                 r.notes || null,
    computedAt:            r.computed_at,
    isOpen:                r.end_at == null,
    durationMinutes: r.end_at
      ? Math.max(0, Math.round((+new Date(r.end_at) - +new Date(r.start_at)) / 60000))
      : null,
  };
}

export function adaptTimesheetDay(r) {
  if (!r) return null;
  return {
    userId:           r.user_id,
    date:             r.date,
    minutesWork:      r.minutes_work     ?? 0,
    minutesLunch:     r.minutes_lunch    ?? 0,
    minutesBreak:     r.minutes_break    ?? 0,
    minutesMeeting:   r.minutes_meeting  ?? 0,
    minutesTravel:    r.minutes_travel   ?? 0,
    minutesUntagged:  r.minutes_untagged ?? 0,
    minutesOff:       r.minutes_off      ?? 0,
    firstIn:          r.first_in || null,
    lastOut:          r.last_out || null,
    approvalStatus:   r.approval_status || "open",
    flags:            r.flags || {},
    notes:            r.notes || null,
    updatedAt:        r.updated_at,
    // Worked time = IN (at-desk) minutes only. Punched-out time (meeting,
    // travel, lunch, …) is informational and never counts toward the total.
    minutesTotalCounted: r.minutes_work ?? 0,
  };
}

export function adaptTimesheetWeek(r) {
  if (!r) return null;
  return {
    userId:         r.user_id,
    weekStart:      r.week_start,
    submittedAt:    r.submitted_at || null,
    submittedBy:    r.submitted_by || null,
    approvalStatus: r.approval_status,
    approvedAt:     r.approved_at  || null,
    approvedBy:     r.approved_by  || null,
    rejectReason:   r.reject_reason || null,
    locked:         !!r.locked,
    totals:         r.totals || {},
  };
}

export function adaptCorrection(r) {
  if (!r) return null;
  return {
    id:           r.id,
    userId:       r.user_id,
    date:         r.date,
    kind:         r.kind,
    payload:      r.payload || {},
    reason:       r.reason  || "",
    status:       r.status,
    submittedAt:  r.submitted_at,
    reviewedAt:   r.reviewed_at || null,
    reviewedBy:   r.reviewed_by || null,
    reviewNote:   r.review_note || null,
  };
}

export function adaptUserCalEvent(r) {
  if (!r) return null;
  return {
    userId:           r.user_id,
    outlookEventId:   r.outlook_event_id,
    subject:          r.subject,
    startAt:          r.start_at,
    endAt:            r.end_at,
    location:         r.location || null,
    isAllDay:         !!r.is_all_day,
    isCancelled:      !!r.is_cancelled,
    sensitivity:      r.sensitivity || null,
    showAs:           r.show_as     || null,
    organizer:        r.organizer   || null,
    attendees:        r.attendees   || [],
    travelBufferMin:  r.travel_buffer_min ?? 30,
    outlookWebLink:   r.outlook_web_link  || null,
  };
}

export function adaptNfcTag(r) {
  if (!r) return null;
  return {
    uid:            r.uid,
    userId:         r.user_id,
    label:          r.label || null,
    active:         !!r.active,
    enrolledAt:     r.enrolled_at,
    enrolledBy:     r.enrolled_by || null,
    retiredAt:      r.retired_at  || null,
    lastSeenAt:     r.last_seen_at || null,
    lastSeenDevice: r.last_seen_device || null,
  };
}

// ----------------------------------------------------------------------
// Read paths
// ----------------------------------------------------------------------

// State for the punch button: open interval + today's minutes.
//
// Production hardening: errors are surfaced (not silently swallowed) so the
// UI can show an "unknown state" rather than incorrectly defaulting to OUT.
// The open-interval query intentionally takes the *most recent* row when
// `.maybeSingle()` would otherwise reject on multi-row results (the partial
// unique index makes that should-never-happen, but a bug elsewhere shouldn't
// brick the punch button).
export async function loadPunchState(userId) {
  if (!userId) throw new Error("loadPunchState: userId required");
  const [openRes, dayRes] = await Promise.all([
    supabase.from("time_intervals")
      .select("*").eq("user_id", userId).is("end_at", null)
      .order("start_at", { ascending: false }).limit(1),
    supabase.from("timesheet_days")
      .select("*").eq("user_id", userId).eq("date", todayInCT()).maybeSingle(),
  ]);
  if (openRes.error) throw new Error(`loadPunchState (open): ${openRes.error.message}`);
  if (dayRes.error  && dayRes.error.code !== "PGRST116") {
    // PGRST116 = "Results contain 0 rows" — fine, that's expected before any punch today.
    throw new Error(`loadPunchState (day): ${dayRes.error.message}`);
  }
  const openIv = (openRes.data || [])[0] || null;
  return {
    open: openIv ? adaptInterval(openIv) : null,
    today: dayRes.data ? adaptTimesheetDay(dayRes.data) : null,
  };
}

// localStorage cache for last-known punch state per user. Lets the page render
// the correct IN/OUT toggle instantly on reload while the DB query is in
// flight. Stale cache is preferred over a wrong default — the background fetch
// reconciles within ~200 ms.
const PUNCH_CACHE_VERSION = 1;
const PUNCH_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;  // 12 h (past that, treat as unknown)

function punchCacheKey(userId) {
  return `beacon.tk.punchState.v${PUNCH_CACHE_VERSION}.${userId}`;
}

export function loadCachedPunchState(userId) {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(punchCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > PUNCH_CACHE_MAX_AGE_MS) return null;
    return { open: parsed.open || null, today: parsed.today || null };
  } catch { return null; }
}

export function saveCachedPunchState(userId, state) {
  if (!userId) return;
  try {
    localStorage.setItem(punchCacheKey(userId), JSON.stringify({
      open:    state?.open  || null,
      today:   state?.today || null,
      savedAt: Date.now(),
    }));
  } catch { /* quota/private-mode — silently ignore */ }
}

// Per-admin Time Admin view preferences. Persisted to localStorage so the
// chosen range, anchor date, visible-users allowlist, and search query all
// survive reload until the admin changes them. Keyed by admin user id so
// two admins can have independent preferences in the same browser.
const ADMIN_PREFS_VERSION = 1;
function adminPrefsKey(adminUserId) {
  return `beacon.tk.admin.prefs.v${ADMIN_PREFS_VERSION}.${adminUserId}`;
}
export const DEFAULT_ADMIN_TIME_PREFS = {
  range:        "day",       // 'day' | 'week' | 'month' | 'custom'
  anchorDate:   null,        // 'YYYY-MM-DD' — null means "today (CT)" at render time
  customStart:  null,        // 'YYYY-MM-DD'
  customEnd:    null,        // 'YYYY-MM-DD' (inclusive)
  visibleUsers: "all",       // 'all' | string[]  (array = explicit allowlist)
  search:       "",          // free-text name filter
  density:      "comfortable",  // 'comfortable' | 'compact'
};
export function loadAdminTimePrefs(adminUserId) {
  if (!adminUserId) return { ...DEFAULT_ADMIN_TIME_PREFS };
  try {
    const raw = localStorage.getItem(adminPrefsKey(adminUserId));
    if (!raw) return { ...DEFAULT_ADMIN_TIME_PREFS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_ADMIN_TIME_PREFS, ...(parsed || {}) };
  } catch { return { ...DEFAULT_ADMIN_TIME_PREFS }; }
}
export function saveAdminTimePrefs(adminUserId, prefs) {
  if (!adminUserId) return;
  try {
    localStorage.setItem(adminPrefsKey(adminUserId), JSON.stringify(prefs || {}));
  } catch { /* quota — silently ignore */ }
}

// Map a timeclock-punch Edge Function response into the same shape
// loadPunchState produces, so the TimesheetTab can apply it as authoritative
// state without an extra round trip. The synthesized "interval" only has the
// fields the PunchButton actually reads (startAt); everything else is null.
export function adaptPunchResponseToState(response, prevToday = null) {
  if (!response) return null;
  const isIn = response.state === "in";
  // Only the IN state synthesizes an "open" interval — that's what drives the
  // PunchButton's "in since …" display. After a punch-out the user has an open
  // OUT interval in the DB, but for the button that simply reads as OUT (open
  // is left null here); the real OUT interval is fetched by the prompt + the
  // silent refresh right after.
  const open = isIn ? {
    id:                    null,
    userId:                response.user?.id || null,
    startAt:               response.open_since || null,
    endAt:                 null,
    startPunchId:          response.punch_id || null,
    endPunchId:            null,
    category:              "work",
    categorySource:        "auto",
    isOut:                 false,
    outlookEventId:        null,
    outlookEventSubject:   null,
    outlookEventLocation:  null,
    notes:                 null,
    computedAt:            new Date().toISOString(),
    isOpen:                true,
    durationMinutes:       null,
  } : null;
  // Merge today's minutes into the existing rollup if we have one — the
  // response only tells us minutes_work, not the full per-category breakdown.
  const today = prevToday
    ? { ...prevToday, minutesWork: response.today_minutes_work ?? prevToday.minutesWork }
    : (response.today_minutes_work != null ? {
        userId:           response.user?.id || null,
        date:             todayInCT(),
        minutesWork:      response.today_minutes_work,
        minutesLunch:     0,
        minutesBreak:     0,
        minutesMeeting:   0,
        minutesTravel:    0,
        minutesUntagged:  0,
        minutesOff:       0,
        firstIn:          response.open_since || null,
        lastOut:          null,
        approvalStatus:   "pending",
        flags:            {},
        notes:            null,
        updatedAt:        new Date().toISOString(),
        minutesTotalCounted: response.today_minutes_work,
      } : null);
  return { open, today };
}

// One day of intervals (with punches if needed) for a user.
export async function loadDayDetail(userId, date) {
  const start = new Date(`${date}T00:00:00`).toISOString();
  const end   = new Date(`${date}T23:59:59.999`).toISOString();
  const [{ data: ivs }, { data: day }, { data: punches }, leaveRes] = await Promise.all([
    supabase.from("time_intervals")
      .select("*").eq("user_id", userId)
      .gte("start_at", start).lte("start_at", end)
      .order("start_at", { ascending: true }),
    supabase.from("timesheet_days")
      .select("*").eq("user_id", userId).eq("date", date).maybeSingle(),
    supabase.from("time_punches")
      .select("*").eq("user_id", userId)
      .gte("punched_at", start).lte("punched_at", end)
      .order("punched_at", { ascending: true }),
    supabase.from("leave_requests")
      .select("*").eq("user_id", userId).eq("status", "approved")
      .lte("date_start", date).gte("date_end", date),
  ]);
  return {
    date,
    intervals: (ivs     || []).map(adaptInterval),
    punches:   (punches || []).map(adaptPunch),
    day:       day ? adaptTimesheetDay(day) : null,
    leaveBlocks: _leaveEligibleOnDate(date)
      ? (leaveRes?.data || []).map(adaptLeaveRequest)
      : [],
  };
}

// Approved leave shows as a timeline band only on days it actually consumes a
// balance: weekdays that aren't company holidays (matches leaveBusinessDays).
function _leaveEligibleOnDate(date, holidays = getAppSettings().tkHolidays) {
  if (!date) return false;
  const dow = new Date(_epochDay(date) * 86400000).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !(holidays || []).includes(date);
}

// 7 days of (timesheet_days, timesheet_week) for one user, week-aligned to Monday.
export async function loadMyWeek(userId, weekStart) {
  const start = weekStart;
  const endDate = new Date(`${weekStart}T00:00:00`);
  endDate.setDate(endDate.getDate() + 7);
  const end = endDate.toISOString().slice(0, 10);

  const [{ data: days }, { data: week }] = await Promise.all([
    supabase.from("timesheet_days")
      .select("*").eq("user_id", userId)
      .gte("date", start).lt("date", end)
      .order("date", { ascending: true }),
    supabase.from("timesheet_weeks")
      .select("*").eq("user_id", userId).eq("week_start", weekStart).maybeSingle(),
  ]);
  return {
    days: (days || []).map(adaptTimesheetDay),
    week: week ? adaptTimesheetWeek(week) : { userId, weekStart, approvalStatus: "open", locked: false, totals: {} },
  };
}

// Team-wide for a date range. Returns one row per user with their per-day
// rollups in the range, plus their currently-open interval (if any).
// `endDateExclusive` is a 'YYYY-MM-DD' string treated as exclusive — pass
// the first day AFTER the range. Used by the Time Admin Week/Month/Custom
// views.
export async function loadTeamRange(startDate, endDateExclusive) {
  const [{ data: days, error: dayErr }, { data: openIvs, error: ivErr }] = await Promise.all([
    supabase.from("timesheet_days")
      .select("*")
      .gte("date", startDate)
      .lt("date", endDateExclusive)
      .order("date", { ascending: true }),
    supabase.from("time_intervals")
      .select("user_id, start_at")
      .is("end_at", null)
      .eq("is_out", false),   // only an open IN interval means "currently in"
  ]);
  if (dayErr) throw new Error(`loadTeamRange (days): ${dayErr.message}`);
  if (ivErr)  throw new Error(`loadTeamRange (open): ${ivErr.message}`);

  const byUser = new Map();
  for (const u of getUsers()) {
    byUser.set(u.id, { user: u, days: [], openSince: null });
  }
  for (const d of (days || [])) {
    const slot = byUser.get(d.user_id);
    if (slot) slot.days.push(adaptTimesheetDay(d));
  }
  for (const iv of (openIvs || [])) {
    const slot = byUser.get(iv.user_id);
    if (slot) slot.openSince = iv.start_at;
  }
  return [...byUser.values()];
}

// Team-wide for a single day. One row per user with their intervals snippet.
export async function loadTeamDay(date) {
  const start = new Date(`${date}T00:00:00`).toISOString();
  const end   = new Date(`${date}T23:59:59.999`).toISOString();
  const { data: ivs } = await supabase
    .from("time_intervals")
    .select("*")
    .gte("start_at", start)
    .lte("start_at", end)
    .order("start_at", { ascending: true });
  const { data: days } = await supabase
    .from("timesheet_days")
    .select("*")
    .eq("date", date);
  const { data: leaves } = await supabase
    .from("leave_requests")
    .select("*").eq("status", "approved")
    .lte("date_start", date).gte("date_end", date);

  const byUser = new Map();
  for (const u of getUsers()) {
    byUser.set(u.id, {
      user: u, intervals: [], day: null, leaveBlocks: [],
    });
  }
  for (const iv of (ivs || [])) {
    const slot = byUser.get(iv.user_id);
    if (slot) slot.intervals.push(adaptInterval(iv));
  }
  for (const d of (days || [])) {
    const slot = byUser.get(d.user_id);
    if (slot) slot.day = adaptTimesheetDay(d);
  }
  if (_leaveEligibleOnDate(date)) {
    for (const lr of (leaves || [])) {
      const slot = byUser.get(lr.user_id);
      if (slot) slot.leaveBlocks.push(adaptLeaveRequest(lr));
    }
  }
  return [...byUser.values()];
}

// All pending submitted weeks across the team. Admin-only.
export async function loadPendingApprovals() {
  const { data, error } = await supabase
    .from("timesheet_weeks")
    .select("*")
    .eq("approval_status", "submitted")
    .order("week_start", { ascending: true });
  if (error) throw error;
  return (data || []).map(adaptTimesheetWeek);
}

// Calendar events for a user in a window (for the classify-preview popover).
export async function loadUserCalendarEvents(userId, startIso, endIso) {
  const { data, error } = await supabase
    .from("user_calendar_events")
    .select("*")
    .eq("user_id", userId)
    .gte("end_at", startIso)
    .lte("start_at", endIso)
    .order("start_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(adaptUserCalEvent);
}

// Calendar events for MANY users in a window — drives the Team Calendar tab.
// Falls back to an empty array if no user ids are passed so the caller doesn't
// have to short-circuit. Relies on the tk_calevents_team_select RLS policy
// (migration 20260528120000) for cross-user visibility; private + cancelled
// rows are filtered server-side.
export async function loadTeamCalendarEvents(userIds, startIso, endIso) {
  if (!userIds || userIds.length === 0) return [];
  const { data, error } = await supabase
    .from("user_calendar_events")
    .select("*")
    .in("user_id", userIds)
    .gte("end_at", startIso)
    .lte("start_at", endIso)
    .order("start_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(adaptUserCalEvent);
}

// =============================================================================
// Calendar palette — hand-curated for perceptual distinctness on Team Calendar.
// Each [h, s, l] entry is in a notably different hue family AND varies in
// saturation/lightness so colleagues never end up as "different shades of
// green" or "two near-identical blues". Designed to render legibly on both
// light and dark themes.
//
// Color tokens are derived from the base [h, s, l] with consistent formulas
// (see userColorTokens below) so light/dark/wash/ink all stay coordinated.
//
// Capacity: 24 distinct entries. Engineering has 20 active people today, so
// every engineer gets a unique color; PM gets its own offset slice so PM-#1
// is NOT the same color as Eng-#1 even though they share the same palette.
// =============================================================================
// Design principle: when two entries share a color family (e.g., both green),
// they MUST differ noticeably in *lightness* AND/OR *saturation* — not just
// hue — so users can't perceive them as "two different greens". Each family
// gets at most one vivid representative; subsequent same-family entries are
// shifted dark/muted or light/pastel so they read as distinct categories.
//
// Hue families and intentional spread within engineering subset (idx 0–19):
//   • Blues  (idx 0, 8, 12, 16): royal bright → periwinkle light → petrol
//                                 dark-muted → steel gray-muted
//   • Reds   (idx 1, 9, 15, 17): vermillion bright → crimson saturated
//                                → peach light-pastel → burgundy dark-muted
//   • Greens (idx 2, 7, 13, 18): emerald dark-vivid → olive deep-muted
//                                → grass mid-bright → sage light-muted
//   • Purpls (idx 3, 11, 19):    amethyst vivid → plum dark
//                                → orchid light-pastel
//   • Golds  (idx 4, 14):        amber bright → mustard dark-olive
//   • Teals  (idx 5, 10):        deep teal vivid → sky teal mid-muted
//   • Magent (idx 6):            singleton (different L+S from any pink-red)
const CALENDAR_PALETTE = [
  [218, 72, 48],   // 1.  Royal blue        (Eng #1)
  [12,  82, 52],   // 2.  Vermillion        (Eng #2)
  [148, 70, 32],   // 3.  Deep emerald      (Eng #3)  — dark vivid green
  [282, 60, 52],   // 4.  Amethyst purple   (Eng #4)
  [42,  88, 50],   // 5.  Amber gold        (Eng #5)
  [180, 72, 34],   // 6.  Deep teal         (Eng #6)
  [325, 65, 52],   // 7.  Magenta           (Eng #7)
  [78,  45, 30],   // 8.  Dark olive        (Eng #8)  — deep desaturated green (vs Emerald)
  [248, 75, 70],   // 9.  Light periwinkle  (Eng #9)  — light bright blue (vs Royal)
  [358, 68, 48],   // 10. Crimson           (Eng #10) — vivid red (vs Vermillion: less orange)
  [194, 38, 52],   // 11. Sky teal          (Eng #11) — desaturated mid-teal (vs Deep teal)
  [272, 35, 38],   // 12. Deep plum         (Eng #12) — dark muted purple (vs Amethyst)
  [212, 30, 38],   // 13. Slate navy        (Eng #13) — dark muted blue (vs Royal & Periwinkle)
  [105, 50, 58],   // 14. Light grass green (Eng #14) — bright light green (vs Emerald & Olive)
  [50,  45, 32],   // 15. Dark mustard      (Eng #15) — dark olive-gold (vs Amber)
  [18,  62, 70],   // 16. Peach             (Eng #16) — pale warm pink (vs Vermillion & Crimson)
  [228, 22, 58],   // 17. Steel blue gray   (Eng #17) — gray-blue (vs all other blues)
  [348, 38, 30],   // 18. Burgundy          (Eng #18) — dark muted wine (vs all other reds)
  [128, 22, 62],   // 19. Pale sage         (Eng #19) — desaturated light green (vs all other greens)
  [298, 50, 72],   // 20. Light orchid      (Eng #20) — pale purple (vs Amethyst & Plum)
  // Indices 20–29 — PM offset starts here, so no engineering ↔ PM color
  // collisions even when the whole company is selected at once.
  [340, 62, 42],   // 21. Dark wine         (PM #1)
  [80,  55, 58],   // 22. Lime green        (PM #2)
  [255, 58, 38],   // 23. Indigo            (PM #3)
  [186, 58, 62],   // 24. Light cyan        (PM #4)
  [26,  82, 58],   // 25. Tangerine         (PM #5)
  [306, 58, 38],   // 26. Dark violet       (PM #6)
  [168, 38, 48],   // 27. Sea green         (PM #7)
  [355, 78, 70],   // 28. Coral pink        (PM #8)
  [232, 42, 60],   // 29. Cornflower        (PM #9)
  [60,  35, 38],   // 30. Dark olive gold   (PM #10)
];

// Per-department starting offset into the palette. Each department starts at
// a different index so attendees from different departments don't collide on
// the same color in mixed-team meetings. Hash-based fallback keeps unfamiliar
// department names deterministic.
const DEPT_PALETTE_OFFSET = {
  "Engineering":         0,
  "Project Management":  20,
};

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// Deterministic per-user color tokens for the Team Calendar.
//
// Rotation is *scoped to the user's department* (sorted alphabetically among
// peers) rather than across the entire roster — so subsetting the calendar to
// "Engineering only" still gives every engineer a uniquely-distinguishable
// color, not 3 different greens.
export function userColorTokens(userId) {
  const users = _users || [];
  const u = users.find(x => x.id === userId);

  let paletteIdx;
  if (u) {
    const dept = u.department || "Other";
    const peers = users
      .filter(x => (x.department || "Other") === dept)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const peerIdx = Math.max(0, peers.findIndex(x => x.id === userId));
    const offset = DEPT_PALETTE_OFFSET[dept] ?? (hashString(dept) % CALENDAR_PALETTE.length);
    paletteIdx = (offset + peerIdx) % CALENDAR_PALETTE.length;
  } else {
    // Unknown user: stable hash-based fallback.
    paletteIdx = hashString(userId || "anon") % CALENDAR_PALETTE.length;
  }

  const [h, s, l] = CALENDAR_PALETTE[paletteIdx];
  // Derived tokens — same formulas every time so the relationship between
  // stripe/ink/wash stays consistent across the whole palette.
  const stripe     = `hsl(${h} ${s}% ${l}%)`;
  const ink        = `hsl(${h} ${Math.min(s,    72)}% ${Math.max(l - 14, 22)}%)`;
  const inkDark    = `hsl(${h} ${Math.min(s+8,  85)}% ${Math.min(l + 22, 78)}%)`;
  const wash       = `hsl(${h} ${Math.min(s+15, 82)}% 96%)`;
  const washDark   = `hsl(${h} ${Math.max(s-18, 20)}% 18%)`;
  const chipFill   = stripe;
  const chipBorder = `hsl(${h} ${s}% ${Math.min(l + 10, 70)}%)`;

  return { hue: h, ink, inkDark, stripe, wash, washDark, chipFill, chipBorder };
}

// All NFC tag rows (admin only).
export async function loadNfcTags() {
  const { data, error } = await supabase
    .from("nfc_tags").select("*")
    .order("enrolled_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(adaptNfcTag);
}

// Open admin's own NFC capture session row. Used by the enrollment UI to
// surface the captured UID.
export async function loadMyEnrollSession() {
  const u = getCurrentBeaconUser();
  if (!u) return null;
  const { data } = await supabase
    .from("nfc_enroll_sessions")
    .select("*").eq("admin_user_id", u.id).maybeSingle();
  return data || null;
}

// Pending correction requests across the team. Admin only.
export async function loadPendingCorrections() {
  const { data, error } = await supabase
    .from("timesheet_corrections")
    .select("*").eq("status", "pending")
    .order("submitted_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(adaptCorrection);
}

// ----------------------------------------------------------------------
// Mutators
// ----------------------------------------------------------------------

// Fetch the user's most-recent interval. `kind`:
//   "open"   → the currently-open interval (end_at IS NULL)
//   "closed" → the most-recently-closed one (max end_at)
// Used by the PunchPromptModal flow: after a successful PUNCH IN we look up
// the freshly-opened interval; after PUNCH OUT we look up the just-closed
// one. Returns the adapted interval or null.
export async function loadLatestInterval(userId, kind = "open") {
  if (!userId) return null;
  let q = supabase.from("time_intervals").select("*").eq("user_id", userId);
  if (kind === "open") {
    q = q.is("end_at", null).order("start_at", { ascending: false }).limit(1);
  } else {
    q = q.not("end_at", "is", null).order("end_at", { ascending: false }).limit(1);
  }
  const { data, error } = await q;
  if (error) throw new Error(`loadLatestInterval: ${error.message}`);
  const row = (data || [])[0];
  return row ? adaptInterval(row) : null;
}

// Update only the note on an interval (keeps existing category + source).
// Used by the PunchPromptModal when the user opts not to change category.
export async function setIntervalNote(intervalId, note) {
  const { error } = await supabase
    .from("time_intervals")
    .update({ notes: note || null, computed_at: new Date().toISOString() })
    .eq("id", intervalId);
  if (error) throw error;
}

// User-facing PUNCH IN / PUNCH OUT — calls the Edge Function so de-dupe,
// classification kick, and last-seen telemetry all happen server-side.
export async function callTimeclockPunch({ source = "web", geo = null, note = null } = {}) {
  const { data, error } = await supabase.functions.invoke("timeclock-punch", {
    body: { source, geo, note },
  });
  if (error) {
    let detail = error.message || "punch failed";
    try {
      const ctx = error.context;
      const text = ctx && typeof ctx.text === "function" ? await ctx.text() : null;
      if (text) {
        try { detail = JSON.parse(text).message || JSON.parse(text).error || text; }
        catch { detail = text; }
      }
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  if (data && data.ok === false) throw new Error(data.message || data.error || "punch failed");
  return data;
}

// User reclassifies their own interval (category + optional outlook link).
// DB RLS policy lets the row's owner UPDATE it directly.
export async function setIntervalCategory(intervalId, { category, outlookEventId = null, notes = null, interval = null }) {
  const patch = {
    ...patchForIntervalCategory({ category, interval }),
    category_source: "user",
    outlook_event_id: outlookEventId || null,
    notes,
    computed_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from("time_intervals").update(patch).eq("id", intervalId);
  if (error) throw error;
  if (interval?.userId && interval?.startAt) {
    const date = new Date(interval.startAt).toLocaleDateString("en-CA", { timeZone: CT_TZ });
    const { error: rErr } = await supabase.rpc("fn_recompute_day", { _user_id: interval.userId, _date: date });
    if (rErr) throw rErr;
  }
}

// User edits travel buffer on one of their calendar events.
export async function setEventTravelBuffer(outlookEventId, minutes) {
  const u = getCurrentBeaconUser();
  if (!u) throw new Error("not signed in");
  const m = Math.max(0, Math.min(240, Math.round(Number(minutes))));
  const { error } = await supabase
    .from("user_calendar_events")
    .update({ travel_buffer_min: m })
    .eq("user_id", u.id)
    .eq("outlook_event_id", outlookEventId);
  if (error) throw error;
}

// User submits a correction request. Status starts pending; admin reviews.
export async function submitCorrection({ date, kind, payload, reason }) {
  const u = getCurrentBeaconUser();
  if (!u) throw new Error("not signed in");
  const { data, error } = await supabase
    .from("timesheet_corrections")
    .insert({
      user_id: u.id, date, kind, payload, reason,
      status: "pending",
    })
    .select().single();
  if (error) throw error;
  return adaptCorrection(data);
}

// User withdraws their own pending correction.
export async function withdrawCorrection(correctionId) {
  const { error } = await supabase
    .from("timesheet_corrections")
    .update({ status: "withdrawn" })
    .eq("id", correctionId);
  if (error) throw error;
}

// User flips their week from open → submitted (asking for admin approval).
// Re-submits after rejection use the same call.
export async function submitWeek(userId, weekStart) {
  // Upsert so the first call creates the row; subsequent calls update.
  const { error } = await supabase
    .from("timesheet_weeks")
    .upsert({
      user_id: userId, week_start: weekStart,
      approval_status: "submitted",
      submitted_at: new Date().toISOString(),
      submitted_by: userId,
    }, { onConflict: "user_id,week_start" });
  if (error) throw error;
}

// ----------------------------------------------------------------------
// Admin Edge Function actions
// ----------------------------------------------------------------------
export async function tkAdmin(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke("timeclock-admin", {
    body: { action, payload },
  });
  if (error) {
    let detail = error.message || "admin action failed";
    try {
      const ctx = error.context;
      const text = ctx && typeof ctx.text === "function" ? await ctx.text() : null;
      if (text) {
        try { detail = JSON.parse(text).error || JSON.parse(text).message || text; }
        catch { detail = text; }
      }
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  if (data && data.ok === false) throw new Error(data.error || data.message || "admin action failed");
  return data;
}

export const tkApproveWeek       = (userId, weekStart)         => tkAdmin("approve-week",        { user_id: userId, week_start: weekStart });
export const tkRejectWeek        = (userId, weekStart, reason) => tkAdmin("reject-week",         { user_id: userId, week_start: weekStart, reason });
export const tkUnlockWeek        = (userId, weekStart)         => tkAdmin("unlock-week",         { user_id: userId, week_start: weekStart });
export const tkEnrollTag         = (userId, uid, label)        => tkAdmin("enroll-tag",          { user_id: userId, uid, label });
export const tkRetireTag         = (uid)                       => tkAdmin("retire-tag",          { uid });
export const tkStartEnroll       = (userId)                    => tkAdmin("start-enroll",        { user_id: userId });
export const tkCancelEnroll      = ()                          => tkAdmin("cancel-enroll",       {});
export const tkResolveCorrection = (id, decision, note)        => tkAdmin("resolve-correction",  { correction_id: id, decision, note });
export const tkReclassify        = (intervalId, category, eventId, notes) =>
  tkAdmin("reclassify-interval", { interval_id: intervalId, category, outlook_event_id: eventId, notes });
export const tkRegisterDevice    = (id, label, location)       => tkAdmin("register-device",     { id, label, location });
export const tkRunClassifier     = (userId = null)             => supabase.functions.invoke("timeclock-classify", { body: userId ? { user_id: userId } : {} });

// ----------------------------------------------------------------------
// Admin DIRECT day editing — the Time Admin "Day editor" canvas.
//
// These run client-side with the admin's own session (no Edge Function
// round-trip): the `tk_punches_admin_write` / `tk_intervals_admin_write` RLS
// policies authorize the writes, and the week-lock guard trigger passes for
// `is_current_user_admin()`. After any punch mutation we re-derive the day via
// fn_rebuild_user_day (INSERTs also fire fn_punch_reconcile, which the
// back-dated-punch guard migration routes through the same rebuild). Edits
// apply IMMEDIATELY to the user's timesheet — this is the admin authority path,
// distinct from the user-submitted correction queue.
// ----------------------------------------------------------------------

// CT calendar date (YYYY-MM-DD) + minutes-since-CT-midnight → UTC ISO instant,
// DST-correct. Inverse of ctMinutesOfIso(). Used when a drag/add on the canvas
// resolves a wall-clock minute into a real punch timestamp.
export function ctWallMinToISO(dateYMD, minOfDay) {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minOfDay)));
  const [Y, Mo, D] = dateYMD.split("-").map(Number);
  const h = Math.floor(clamped / 60), mi = clamped % 60;
  // The target wall time, read as if it were UTC.
  const targetWallUTC = Date.UTC(Y, Mo - 1, D, h, mi);
  // CT offset (CT − UTC, ms) at a given real instant.
  const ctOffsetAt = (instant) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: CT_TZ, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(instant)).reduce((a, x) => (a[x.type] = x.value, a), {});
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instant;
  };
  // Two-step refine so the offset is evaluated AT the target instant (DST-safe).
  const off1 = ctOffsetAt(targetWallUTC);
  let utc = targetWallUTC - off1;
  const off2 = ctOffsetAt(utc);
  if (off2 !== off1) utc = targetWallUTC - off2;
  return new Date(utc).toISOString();
}

async function rebuildUserDay(userId, date) {
  const { error } = await supabase.rpc("fn_rebuild_user_day", { _user_id: userId, _date: date });
  if (error) throw new Error(rebuildHint(error.message));
}

// The week-lock guard trigger raises check_violation when a non-admin (or a
// service-role caller without the GUC) writes into a locked week. Surface a
// human hint when that bubbles up through a direct admin write somehow.
function rebuildHint(msg) {
  if (/locked/i.test(msg)) return "This week is locked — unlock it before editing.";
  return msg;
}

// Move one or more existing punches to new instants, then rebuild the day once.
//   edits: [{ id, punchedAt }]  (punchedAt = ISO string)
export async function adminEditPunches(edits, userId, date) {
  let firstErr = null;
  await Promise.all((edits || []).map(async (e) => {
    if (!e?.id || !e?.punchedAt) return;
    const { error } = await supabase
      .from("time_punches").update({ punched_at: e.punchedAt }).eq("id", e.id);
    if (error && !firstErr) firstErr = error;
  }));
  // Always re-derive from the actual punches so intervals never go stale, even
  // if one of a multi-punch move failed (the day then reflects the punches that
  // did land — consistent, and the error still surfaces below).
  await rebuildUserDay(userId, date);
  if (firstErr) throw new Error(rebuildHint(`edit punch: ${firstErr.message}`));
}

// Carve a new block by inserting BOTH boundary punches in one shot. The
// back-dated guard trigger rebuilds the day; we then stamp the carved
// interval's category (matched by exact boundary) so the admin's label sticks.
export async function adminAddInterval({ userId, date, startISO, endISO, isOut, category, note }) {
  if (!startISO || !endISO) throw new Error("start and end are required");
  if (+new Date(endISO) <= +new Date(startISO)) throw new Error("end must be after start");
  const adminId = getCurrentBeaconUser()?.id || null;
  const trimmed = (note || "").trim();
  const punchNote = trimmed || "admin: added block";
  const { error: insErr } = await supabase.from("time_punches").insert([
    { user_id: userId, punched_at: startISO, source: "manual", note: punchNote, created_by: adminId },
    { user_id: userId, punched_at: endISO,   source: "manual", note: punchNote, created_by: adminId },
  ]);
  if (insErr) throw new Error(rebuildHint(`add block: ${insErr.message}`));
  await rebuildUserDay(userId, date);
  // Stamp the carved interval. Presence (is_out) falls out of punch order — we
  // only set the label + source so the rule/Outlook classifiers won't reclaim it.
  const cat = isOut ? (category || "break") : "work";
  const patch = { category: cat, category_source: "admin", computed_at: new Date().toISOString() };
  if (trimmed) patch.notes = trimmed;
  const { error: upErr } = await supabase.from("time_intervals")
    .update(patch).eq("user_id", userId).eq("start_at", startISO).eq("end_at", endISO);
  if (upErr) throw new Error(`label block: ${upErr.message}`);
}

// Delete a block by removing its boundary punches, then rebuild. Same-presence
// neighbors merge — the natural "remove this block" semantic.
export async function adminDeleteInterval(interval, userId, date) {
  const ids = [interval?.startPunchId, interval?.endPunchId].filter(Boolean);
  if (ids.length === 0) throw new Error("this block has no editable punches to remove");
  const { error } = await supabase.from("time_punches").delete().in("id", ids);
  if (error) throw new Error(rebuildHint(`delete block: ${error.message}`));
  await rebuildUserDay(userId, date);
}

// Admin retag + comment on one interval (category_source='admin' so it survives
// future rebuilds + the classifier). Lighter than a full rebuild — just
// re-aggregates the day's category buckets.
export async function adminReclassifyInterval(intervalId, { category, notes = null, outlookEventId = null, interval = null }, userId, date) {
  const { error } = await supabase.from("time_intervals").update({
    ...patchForIntervalCategory({ category, interval }),
    category_source:  "admin",
    notes:            notes || null,
    outlook_event_id: outlookEventId || null,
    computed_at:      new Date().toISOString(),
  }).eq("id", intervalId);
  if (error) throw new Error(`reclassify: ${error.message}`);
  const { error: rErr } = await supabase.rpc("fn_recompute_day", { _user_id: userId, _date: date });
  if (rErr) throw new Error(`recompute: ${rErr.message}`);
}

// Load the week-lock row for the week containing a date (admin editor banner).
export async function loadWeekLock(userId, date) {
  const wk = weekStartCT(date);
  const { data } = await supabase
    .from("timesheet_weeks")
    .select("*").eq("user_id", userId).eq("week_start", wk).maybeSingle();
  return data ? adaptTimesheetWeek(data) : { userId, weekStart: wk, approvalStatus: "open", locked: false };
}

// Pending corrections for one (user, date) — surfaced as an inline banner in
// the Day editor so an admin can approve/reject without leaving the canvas.
export async function loadCorrectionsForDay(userId, date) {
  const { data, error } = await supabase
    .from("timesheet_corrections")
    .select("*").eq("user_id", userId).eq("date", date).eq("status", "pending")
    .order("submitted_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(adaptCorrection);
}

// ----------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------
export async function loadTimekeepingSettings() {
  const { data } = await supabase
    .from("app_settings")
    .select("tk_enabled, tk_business_tz, tk_workday_hours, tk_overtime_threshold_min, tk_eod_window_start, tk_eod_window_end, tk_lunch_window_start, tk_lunch_window_end, tk_untagged_alert_after_min, tk_office_ip_cidr, tk_holidays, tk_default_travel_buffer_min")
    .eq("singleton", true).maybeSingle();
  return data || null;
}

export async function updateTimekeepingSettings(patch) {
  const { error } = await supabase
    .from("app_settings").update(patch).eq("singleton", true);
  if (error) throw error;
}

// ----------------------------------------------------------------------
// Realtime subscription helpers — App.jsx wires these into useEffect.
// ----------------------------------------------------------------------
export function subscribeMyTimeState(userId, onChange) {
  const ch = supabase
    .channel(`tk:user:${userId}`)
    .on("postgres_changes",
      { event: "*", schema: "beacon_v2", table: "time_intervals", filter: `user_id=eq.${userId}` },
      onChange)
    .on("postgres_changes",
      { event: "*", schema: "beacon_v2", table: "timesheet_days", filter: `user_id=eq.${userId}` },
      onChange)
    .subscribe();
  return () => { supabase.removeChannel(ch); };
}

export function subscribeEnrollSession(adminUserId, onChange) {
  const ch = supabase
    .channel(`tk:enroll:${adminUserId}`)
    .on("postgres_changes",
      { event: "*", schema: "beacon_v2", table: "nfc_enroll_sessions", filter: `admin_user_id=eq.${adminUserId}` },
      onChange)
    .subscribe();
  return () => { supabase.removeChannel(ch); };
}

// ----------------------------------------------------------------------
// Category palette — used by DayTimeline + admin views. Tones reuse the
// existing project palette so timekeeping bars feel consistent with events.
// ----------------------------------------------------------------------
export const TK_CATEGORY_TONE = {
  work:             "green",      // "you were on the clock" — bold green
  meeting:          "blue",
  travel:           "rose",
  lunch:            "sage",       // muted olive — distinct from work green
  break:            "muted",
  eod:              "muted",      // "Done for the day" — quiet end-of-day card
  meeting_untagged: "rose",       // calls user's attention to tag
  vacation:         "sage",
  holiday:          "sage",
  off:              "muted",
};

export const TK_CATEGORY_LABEL = {
  work:             "Working",
  meeting:          "Meeting",
  travel:           "Site visit",
  lunch:            "Lunch",
  break:            "Break",
  eod:              "Done for the day",   // signals "leaving the office" — stops the red gap overlay
  meeting_untagged: "Untagged",
  vacation:         "Vacation",
  holiday:          "Holiday",
  off:              "Off",
};

// Timeline color is driven by PRESENCE, not category: at-desk (IN) time is
// green, punched-out (OUT) time is red — regardless of how the away period is
// tagged. The category survives only as the text label on the bar. This is the
// single source of truth for interval coloring across the personal timesheet
// and every Team view; do not color intervals by TK_CATEGORY_TONE anymore.
export function intervalTone(iv) {
  return iv?.isOut ? "rose" : "green";
}

// ----------------------------------------------------------------------
// Workday coverage — green-IN / red-OUT timeline overlay
// ----------------------------------------------------------------------
// Render rule: inside the workday window, every minute is either covered
// by an interval (green/colored) or uncovered (red diagonal stripe).
// Outside the window, no overlay. After a "Done for the day" interval, the
// overlay truncates. computeOutGaps() returns the [startMin, endMin] ranges
// that should render red on a given day.
//
// 8 AM → 5 PM is the conventional MSMM workday. Wire to a setting later if
// teams diverge; for now hardcoded so it works without backend changes.

export const WORKDAY_START_MIN = 8 * 60;   // 08:00 CT
export const WORKDAY_END_MIN   = 17 * 60;  // 17:00 CT

// Categories that signal "I'm not expected to be working" — they truncate
// the red gap overlay after their end_at.
const EOD_LIKE_CATEGORIES = new Set(["eod", "vacation", "holiday", "off"]);

// Minutes-since-CT-midnight for an ISO timestamp.
export function ctMinutesOfIso(iso) {
  if (!iso) return 0;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ, hour12: false, hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(iso));
  const h = +parts.find(p => p.type === "hour")?.value   || 0;
  const m = +parts.find(p => p.type === "minute")?.value || 0;
  return h * 60 + m;
}

export function computeOutGaps({ intervals, date }) {
  const today = todayInCT();
  const isToday = date === today;
  const isPast  = date < today;
  const nowMin  = ctMinutesOfIso(new Date().toISOString());

  // Coverage: each interval contributes [startMin, endMin]. Open intervals
  // (no end_at) extend to "now" on today, or to end-of-day on past dates
  // (which the user should never see since past days have a final close).
  const covered = [];
  for (const iv of (intervals || [])) {
    const ivDate = new Date(iv.startAt).toLocaleDateString("en-CA", { timeZone: CT_TZ });
    if (ivDate !== date) continue;            // not this calendar day
    const start = ctMinutesOfIso(iv.startAt);
    const end   = iv.endAt
      ? ctMinutesOfIso(iv.endAt)
      : (isToday ? nowMin : 24 * 60);
    if (end <= start) continue;
    covered.push([start, end]);
  }

  // Cutoff: stop showing red after the LATEST "Done for the day" / vacation
  // / holiday interval, or at workday end, whichever is earlier. On TODAY,
  // additionally clamp to now() — future minutes aren't "missed" yet.
  let lastEodEnd = null;
  for (const iv of (intervals || [])) {
    if (!EOD_LIKE_CATEGORIES.has(iv.category)) continue;
    if (!iv.endAt) continue;
    const e = ctMinutesOfIso(iv.endAt);
    if (lastEodEnd == null || e > lastEodEnd) lastEodEnd = e;
  }

  let cutoff = WORKDAY_END_MIN;
  if (lastEodEnd != null && lastEodEnd < cutoff) cutoff = lastEodEnd;
  if (isToday && nowMin < cutoff) cutoff = nowMin;
  if (!isToday && !isPast) return [];        // future day → no red

  if (cutoff <= WORKDAY_START_MIN) return [];

  // Walk [WORKDAY_START_MIN, cutoff] subtracting covered ranges.
  covered.sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = WORKDAY_START_MIN;
  for (const [s, e] of covered) {
    if (e <= cursor) continue;
    if (s >= cutoff) break;
    if (s > cursor) gaps.push([cursor, Math.min(s, cutoff)]);
    cursor = Math.max(cursor, e);
    if (cursor >= cutoff) break;
  }
  if (cursor < cutoff) gaps.push([cursor, cutoff]);

  return gaps;
}

// ============================================================
// Open Bids — CRUD + storage helpers
// ============================================================
// Permissive-for-authenticated RLS today, with a BEFORE UPDATE trigger
// (see 20260527120000_open_bids.sql) that rejects approval-column writes
// from non-Admins. The UI also gates the approve/reject buttons; trigger
// is defense-in-depth.

// UI patch ({ rfqNumber, clientId, … }) → DB payload. Only keys that map
// to columns are forwarded; everything else is dropped silently.
const OPEN_BID_COL_MAP = {
  rfqNumber:          "rfq_rfp_number",
  clientId:           "client_id",
  serviceDescription: "service_description",
  dueAt:              "due_at",
  webLink:            "web_link",
  notes:              "notes",
  anticipatedAmount:  "anticipated_amount",
  // pdfPath / pdfName are written by upload/delete helpers below, not via
  // generic updateOpenBid — keeps file lifecycle paired with storage ops.
};

function buildOpenBidDbPatch(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const col = OPEN_BID_COL_MAP[k];
    if (!col) continue;
    out[col] = v === "" ? null : v;
  }
  return out;
}

export async function createOpenBid(payload) {
  const me = getCurrentBeaconUser();
  const dbPatch = buildOpenBidDbPatch(payload);
  if (!dbPatch.rfq_rfp_number) {
    throw new Error("RFQ/RFP Number is required");
  }
  if (me?.id) dbPatch.created_by = me.id;
  const { data, error } = await supabase
    .from("open_bids").insert(dbPatch).select("*").single();
  if (error) throw new Error(`open_bids insert: ${error.message}`);
  return adaptOpenBid(data);
}

export async function updateOpenBid(id, patch) {
  const dbPatch = buildOpenBidDbPatch(patch);
  if (Object.keys(dbPatch).length === 0) return null;
  const { data, error } = await supabase
    .from("open_bids").update(dbPatch).eq("id", id).select("*").single();
  if (error) throw new Error(`open_bids update: ${error.message}`);
  return adaptOpenBid(data);
}

export async function deleteOpenBid(id) {
  // If a PDF was uploaded, remove the binary too. We do this best-effort
  // BEFORE the DB delete so a successful row delete doesn't leave an
  // orphan binary; if the storage remove fails the bid row stays.
  const { data: existing } = await supabase
    .from("open_bids").select("pdf_file_path").eq("id", id).maybeSingle();
  if (existing?.pdf_file_path) {
    const rm = await supabase.storage.from("bid-rfqs").remove([existing.pdf_file_path]);
    if (rm.error) throw new Error(`storage remove: ${rm.error.message}`);
  }
  const { error } = await supabase.from("open_bids").delete().eq("id", id);
  if (error) throw new Error(`open_bids delete: ${error.message}`);
}

// Admin-only in practice (the DB trigger enforces this and will raise
// 42501 / "open_bids approval can only be changed by an Admin" for
// non-admin sessions). The UI also hides the buttons for non-admins.
// `status` ∈ {'approved','rejected','pending'}. Pending nulls out
// approver + timestamp; approved/rejected stamp both with current admin
// + now().
export async function setOpenBidApproval(id, status) {
  const me = getCurrentBeaconUser();
  if (status !== "pending" && status !== "approved" && status !== "rejected") {
    throw new Error(`Invalid approval status: ${status}`);
  }
  const dbPatch = status === "pending"
    ? { approval_status: "pending", approved_by: null, approved_at: null }
    : { approval_status: status, approved_by: me?.id || null, approved_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from("open_bids").update(dbPatch).eq("id", id).select("*").single();
  if (error) throw new Error(`open_bids approval: ${error.message}`);
  return adaptOpenBid(data);
}

// Link an open_bid to the freshly-created Proposals (awaiting) project.
// Called from confirmMove after the projects insert succeeds — keeps the
// historical breadcrumb intact (open_bid row stays, points forward).
export async function markOpenBidMovedForward(id, projectId) {
  const { error } = await supabase
    .from("open_bids")
    .update({ moved_to_project_id: projectId })
    .eq("id", id);
  if (error) throw new Error(`open_bids forward-link: ${error.message}`);
}

// ----------------------------------------------------------------------
// Projects (tree-structured work breakdown — beacon_v2.project_items).
// Rows key on a surrogate uuid `id`; `localId` is the scoped human ID (root =
// global, phase/subphase = unique within parent). clientId routes via
// routeClientPick; additional PMs ride the project_item_pms join (item_id,
// synced in App.jsx via shared syncJoinUsers); subs ride project_item_subs.
// ----------------------------------------------------------------------
const PROJECT_ITEM_COL_MAP = {
  localId:         "local_id",
  parentId:        "parent_id",
  name:            "name",
  itemType:        "item_type",
  addressLine1:    "address_line1",
  addressLine2:    "address_line2",
  city:            "city",
  state:           "state",
  pinCode:         "pin_code",
  contractType:    "contract_type",
  contractAmount:  "contract_amount",
  laborCost:       "total_labor_cost",
  expenseCost:     "total_expense_cost",
  billedServices:  "billed_services",
  billedExpenses:  "billed_expenses",
  billedTaxes:     "billed_taxes",
  totalBilled:     "total_billed_paid",
  startDate:       "start_date",
  dueDate:         "due_date",
  percentComplete: "percent_complete",
  managerId:       "manager_user_id",
  status:          "status",
  notes:           "notes",
  sortOrd:         "sort_ord",
  // clientId is routed via routeClientPick; pmIds + subs are join tables.
};

// Columns where "" / undefined should become NULL. local_id, item_type +
// status are NOT NULL (the UI always supplies a value), so they're
// deliberately excluded — sending null would violate the constraint.
const PROJECT_ITEM_NULL_IF_EMPTY = new Set([
  "parent_id", "contract_type", "contract_amount", "total_labor_cost",
  "total_expense_cost", "billed_services", "billed_expenses", "billed_taxes",
  "total_billed_paid", "start_date", "due_date", "percent_complete",
  "manager_user_id", "address_line1", "address_line2", "city", "state",
  "pin_code", "notes", "sort_ord",
]);

function buildProjectItemDbPatch(patch) {
  const out = {};
  for (const [k, dbCol] of Object.entries(PROJECT_ITEM_COL_MAP)) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if ((v === "" || v === undefined) && PROJECT_ITEM_NULL_IF_EMPTY.has(dbCol)) v = null;
    out[dbCol] = v;
  }
  return out;
}

// Translate the trigger / FK / unique errors into friendly text for the toast.
// The roll-up trigger raises 23514 with an already-human message; surface it.
function rewriteProjectItemError(error) {
  if (!error) return "project_items error";
  // 23505 = the scoped local_id unique index (root global, or sibling within a parent).
  if (error.code === "23505") return "That ID is already used here — project IDs must be unique system-wide, and phase/subphase IDs unique within their parent.";
  if (error.code === "23514") return error.message || "Contract validation failed";
  if (error.code === "23503") return "A linked parent, client, or user no longer exists";
  return `project_items: ${error.message}`;
}

const PROJECT_ITEM_SELECT = "*, subs:project_item_subs(*), pms:project_item_pms(user_id)";

export async function createProjectItem(payload) {
  const me = getCurrentBeaconUser();
  const localId = String(payload.localId ?? "").trim();
  if (!localId) throw new Error("ID is required");
  const dbPatch = buildProjectItemDbPatch(payload);
  if (!dbPatch.name) throw new Error("Project Name is required");
  dbPatch.local_id = localId;
  if (payload.parentId !== undefined) dbPatch.parent_id = payload.parentId || null;
  if (payload.clientId !== undefined) Object.assign(dbPatch, routeClientPick(payload.clientId));
  if (me?.id) dbPatch.created_by = me.id;
  const { data, error } = await supabase
    .from("project_items").insert(dbPatch).select(PROJECT_ITEM_SELECT).single();
  if (error) throw new Error(rewriteProjectItemError(error));
  return adaptProjectItem(data);
}

export async function updateProjectItem(id, patch) {
  const dbPatch = buildProjectItemDbPatch(patch);
  if (patch.clientId !== undefined) Object.assign(dbPatch, routeClientPick(patch.clientId));
  if (Object.keys(dbPatch).length === 0) return null;
  const { data, error } = await supabase
    .from("project_items").update(dbPatch).eq("id", id).select(PROJECT_ITEM_SELECT).single();
  if (error) throw new Error(rewriteProjectItemError(error));
  return adaptProjectItem(data);
}

// parent_id FK is ON DELETE CASCADE, so deleting a node removes its whole
// subtree (and the subs/pms join rows). The caller confirms with a count.
export async function deleteProjectItem(id) {
  const { error } = await supabase.from("project_items").delete().eq("id", id);
  if (error) throw new Error(`project_items delete: ${error.message}`);
}

export async function addProjectItemSub({ itemId, companyId, discipline, amount, ord }) {
  if (!companyId) throw new Error("Pick a sub firm");
  const payload = {
    item_id: itemId,
    company_id: companyId,
    discipline: discipline || null,
    amount: amount == null || amount === "" ? null : Number(amount),
    ord: ord ?? null,
  };
  const { data: existing } = await supabase.from("project_item_subs")
    .select("*").eq("item_id", itemId).eq("company_id", companyId).limit(1).maybeSingle();
  if (existing) return { row: existing, existed: true };
  const { data, error } = await supabase.from("project_item_subs").insert(payload).select("*").single();
  if (error?.code === "23505") {
    const { data: raced } = await supabase.from("project_item_subs")
      .select("*").eq("item_id", itemId).eq("company_id", companyId).limit(1).maybeSingle();
    if (raced) return { row: raced, existed: true };
  }
  if (error) throw new Error(`project_item_subs insert: ${error.message}`);
  return { row: data, existed: false };
}

export async function updateProjectItemSub({ itemId, companyId, amount, discipline }) {
  const patch = {};
  if (amount !== undefined) patch.amount = amount == null || amount === "" ? null : Number(amount);
  if (discipline !== undefined) patch.discipline = String(discipline) || null;
  if (Object.keys(patch).length === 0) return null;
  const { error } = await supabase.from("project_item_subs").update(patch)
    .eq("item_id", itemId).eq("company_id", companyId);
  if (error) throw new Error(`project_item_subs update: ${error.message}`);
  return patch;
}

export async function removeProjectItemSub({ itemId, companyId }) {
  const { error } = await supabase.from("project_item_subs").delete()
    .eq("item_id", itemId).eq("company_id", companyId);
  if (error) throw new Error(`project_item_subs delete: ${error.message}`);
}

// ----------------------------------------------------------------------
// Awarded ↔ Invoice project links (beacon_v2.project_invoice_links).
// One awarded project ↔ many invoice project numbers. The number (trimmed,
// original casing) is stored; matching elsewhere goes through
// normInvoiceNumber. Both calls are idempotent at the UI level — duplicate
// insert (23505) reads as "already linked", missing delete is a no-op.
// ----------------------------------------------------------------------
export async function addProjectInvoiceLink(projectId, projectNumber) {
  const num = String(projectNumber ?? "").trim();
  if (!projectId || !num) throw new Error("addProjectInvoiceLink requires projectId + projectNumber");
  const { error } = await supabase
    .from("project_invoice_links")
    .insert({ project_id: projectId, project_number: num });
  if (error) {
    if (error.code === "23505") return { existed: true };   // already linked
    throw new Error(`project_invoice_links insert: ${error.message}`);
  }
  return { existed: false };
}

export async function removeProjectInvoiceLink(projectId, projectNumber) {
  const num = String(projectNumber ?? "").trim();
  if (!projectId || !num) return;
  const { error } = await supabase
    .from("project_invoice_links")
    .delete()
    .eq("project_id", projectId)
    .eq("project_number", num);
  if (error) throw new Error(`project_invoice_links delete: ${error.message}`);
}

// ----- Storage: bid-rfqs bucket -----
// One PDF per bid (1:1 — replacing an existing upload removes the old
// binary first). Path: <bid_id>/<stamp>-<safe-name>.
export function buildOpenBidStoragePath({ bidId, originalName }) {
  const fileName = uploadFilename(originalName);
  return `${bidId}/${fileName}`;
}

export async function uploadOpenBidPdf({ bidId, file }) {
  if (!bidId || !file) throw new Error("uploadOpenBidPdf requires bidId + file");
  // Remove an existing upload first so each bid keeps at most one binary.
  const { data: existing } = await supabase
    .from("open_bids").select("pdf_file_path").eq("id", bidId).maybeSingle();
  if (existing?.pdf_file_path) {
    const rm = await supabase.storage.from("bid-rfqs").remove([existing.pdf_file_path]);
    if (rm.error) throw new Error(`storage remove (replace): ${rm.error.message}`);
  }
  const path = buildOpenBidStoragePath({ bidId, originalName: file.name || "rfq.pdf" });
  const up = await supabase.storage.from("bid-rfqs").upload(path, file, {
    upsert: false, cacheControl: "3600",
  });
  if (up.error) throw new Error(`storage upload: ${up.error.message}`);
  const { data, error } = await supabase
    .from("open_bids")
    .update({ pdf_file_path: path, pdf_file_name: file.name || "rfq.pdf" })
    .eq("id", bidId)
    .select("*").single();
  if (error) {
    // DB write failed but binary is up — try to roll back the binary so
    // we don't accumulate orphans in the bucket.
    await supabase.storage.from("bid-rfqs").remove([path]).catch(() => {});
    throw new Error(`open_bids pdf link: ${error.message}`);
  }
  return adaptOpenBid(data);
}

export async function deleteOpenBidPdf({ bidId, filePath }) {
  if (filePath) {
    const rm = await supabase.storage.from("bid-rfqs").remove([filePath]);
    if (rm.error) throw new Error(`storage remove: ${rm.error.message}`);
  }
  const { data, error } = await supabase
    .from("open_bids")
    .update({ pdf_file_path: null, pdf_file_name: null })
    .eq("id", bidId)
    .select("*").single();
  if (error) throw new Error(`open_bids pdf clear: ${error.message}`);
  return adaptOpenBid(data);
}

export async function getOpenBidPdfSignedUrl(filePath, expiresInSeconds = 60) {
  const { data, error } = await supabase.storage.from("bid-rfqs")
    .createSignedUrl(filePath, expiresInSeconds);
  if (error) throw new Error(`signed url: ${error.message}`);
  return data?.signedUrl;
}

// ----------------------------------------------------------------------
// Directory — merge duplicate companies / clients.
//
// Repoints EVERY reference (across Open Bids, Awaiting, Awarded, Closed Out,
// Potential, Invoice, sub-invoices, Hot Leads) from the loser rows onto one
// survivor, then deletes the losers — all inside a single Postgres transaction
// (the merge_companies / merge_clients RPCs in 20260606130000_merge_entities.sql).
// Server-side so the restrict-FK + unique-index handling stays atomic; a missed
// reference rolls the whole thing back rather than half-merging. Returns the
// RPC's jsonb summary of how many references were repointed per table.
// ----------------------------------------------------------------------
export async function mergeEntities({ kind, survivorId, loserIds }) {
  const losers = (loserIds || []).filter(id => id && id !== survivorId);
  if (!survivorId) throw new Error("Pick a record to keep before merging.");
  if (!losers.length) throw new Error("Select at least one other record to merge in.");
  const fn = kind === "Client" ? "merge_clients" : "merge_companies";
  const { data, error } = await supabase.rpc(fn, {
    p_survivor: survivorId,
    p_losers: losers,
  });
  if (error) throw new Error(error.message);
  return data; // { kind, survivor, merged, projects, project_subs, sub_invoices, ... }
}

// Read-only preview of everything that points at `entity`, computed from the
// already-loaded in-memory slices (no round-trip). Drives the MergeModal's
// "what will be repointed" breakdown so the user sees the blast radius before
// committing. Projects reuse linkedProjectsFor (Client / Prime / Sub roles);
// leads + open bids are scanned by their adapted `clientId` (which folds in the
// prime_company_id fallback for leads).
export function mergeRefSummary(entity, { projectsByType, invoice, hotLeads = [], openBids = [] } = {}) {
  if (!entity) return { projects: [], leadCount: 0, bidCount: 0, total: 0 };
  const projects = linkedProjectsFor(entity, projectsByType, invoice);
  const leadCount = hotLeads.filter(l => l.clientId === entity.id).length;
  const bidCount  = (entity.type === "Client")
    ? openBids.filter(b => b.clientId === entity.id).length
    : 0; // open bids only reference clients
  return {
    projects,
    leadCount,
    bidCount,
    total: projects.length + leadCount + bidCount,
  };
}
