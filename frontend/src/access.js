// ============================================================================
// access.js — the ONE place that defines what a user is allowed to see.
//
// Pure (no React, no Supabase) so it is unit-testable with `node --test`
// (frontend/tests/access.test.mjs) and shared by App.jsx (enforcement) and
// user-access.jsx (the admin editor).
//
// ── The model ───────────────────────────────────────────────────────────────
// ACCESS_TREE is a tree of nodes: workflow → page → tab → sub-tab. Depth is
// not fixed — a single-tab page can carry its views directly, and a new level
// only needs a new `kind` label. Every node has a STABLE `key` that is stored
// in beacon_v2.user_access.grants, so:
//
//   • NEVER rename or reuse a key. Labels, order and parents can change
//     freely (keys don't encode their parent); a key is an identity.
//   • To add a page / tab / sub-tab: add a node here with a fresh key, and
//     (if it's a routable tab) set `tab: "<tab key>"`, (if it's an in-page
//     view) wire `canView`/`visibleChildren` at its render site. Existing
//     users pick it up automatically — see "New nodes" below.
//
// Node flags:
//   tab            — App.jsx TAB_META key this node renders (routing gate).
//   requiresChild  — the node has no content of its own; it's only visible
//                    while at least one child is visible (a page whose tabs
//                    are all hidden disappears instead of rendering empty).
//   always         — always visible to everyone, never editable (Time & Leave).
//                    Inherited by descendants.
//   adminOnly      — needs the Admin ROLE (its data writes are admin-gated by
//                    RLS). Never grantable to a User; always visible to Admins.
//   hiddenFromNav  — not in the sidebar (reachable by deep link only); purely
//                    informational for the editor.
//
// ── Resolution ──────────────────────────────────────────────────────────────
//   Admin role               → everything.
//   no config / mode "full"  → everything except adminOnly (today's behaviour,
//                              so every existing user is unaffected until an
//                              Admin restricts them).
//   mode "custom"            → a node is visible iff it is granted, it and all
//                              its ancestors are granted, adminOnly passes, and
//                              (requiresChild) some child is visible.
//
// New nodes: a custom config also stores `seen` — every key that existed when
// it was saved. A node NOT in `seen` was added to Beacon afterwards; it
// inherits "granted" only when its parent is granted AND every sibling that
// existed at save time was granted (i.e. the user had the WHOLE parent). A
// hand-picked subset never silently grows; a full grant grows with Beacon.
// A brand-new top-level workflow stays hidden until an Admin grants it.
//
// This is INTERFACE access control (what appears in the UI). The underlying
// tables keep their existing RLS; see supabase/migrations_v2/…_user_access.sql.
// ============================================================================

export const ACCESS_KIND_LABEL = {
  workflow: "Workflow",
  page: "Page",
  tab: "Tab",
  subtab: "Sub-tab",
};

export const ACCESS_TREE = [
  {
    key: "workflow.engineering", kind: "workflow", label: "Engineering",
    description: "The project pipeline, from proposal to invoice and close-out.",
    requiresChild: true,
    children: [
      {
        key: "page.proposals", kind: "page", label: "Proposals & Awarded", requiresChild: true,
        children: [
          { key: "tab.awaiting",          kind: "tab", label: "Proposals", tab: "awaiting" },
          { key: "tab.awarded",           kind: "tab", label: "Awarded",   tab: "awarded" },
          { key: "tab.proposals-deleted", kind: "tab", label: "Deleted",   tab: "proposals-deleted" },
        ],
      },
      {
        key: "page.invoice", kind: "page", label: "Invoice", requiresChild: true,
        children: [
          { key: "tab.invoice", kind: "tab", label: "Invoices",   tab: "invoice" },
          { key: "tab.between", kind: "tab", label: "In-Between", tab: "between" },
          { key: "tab.closed",  kind: "tab", label: "Closed Out", tab: "closed" },
        ],
      },
      {
        key: "page.leads", kind: "page", label: "Leads & Bids", requiresChild: true, hiddenFromNav: true,
        children: [
          { key: "tab.hotleads",      kind: "tab", label: "Hot Leads", tab: "hotleads" },
          { key: "tab.openbids",      kind: "tab", label: "Open Bids", tab: "openbids" },
          { key: "tab.leads-deleted", kind: "tab", label: "Deleted",   tab: "leads-deleted" },
        ],
      },
      { key: "page.potential", kind: "page", label: "Potential", tab: "potential", hiddenFromNav: true },
    ],
  },
  {
    key: "workflow.workspace", kind: "workflow", label: "Workspace",
    description: "Projects, events and the client / firm directory.",
    requiresChild: true,
    children: [
      {
        key: "page.projects", kind: "page", label: "Projects", tab: "projects",
        children: [
          {
            // The full-page detail view opened from a project root. Unchecked
            // = the project list only.
            key: "tab.project-detail", kind: "tab", label: "Project details", requiresChild: true,
            children: [
              { key: "subtab.project.overview",  kind: "subtab", label: "Overview",       section: "overview" },
              { key: "subtab.project.structure", kind: "subtab", label: "Work structure", section: "structure" },
              { key: "subtab.project.invoices",  kind: "subtab", label: "Invoices",       section: "invoices" },
              { key: "subtab.project.documents", kind: "subtab", label: "Documents",      section: "documents" },
              { key: "subtab.project.todos",     kind: "subtab", label: "To-Dos",         section: "todos" },
              { key: "subtab.project.notes",     kind: "subtab", label: "Notes",          section: "notes" },
              { key: "subtab.project.settings",  kind: "subtab", label: "Settings",       section: "settings" },
            ],
          },
        ],
      },
      {
        key: "page.events", kind: "page", label: "Events & Other", tab: "events", requiresChild: true,
        children: [
          { key: "tab.events.list",     kind: "tab", label: "List",     view: "list" },
          { key: "tab.events.calendar", kind: "tab", label: "Calendar", view: "calendar" },
        ],
      },
      { key: "page.directory", kind: "page", label: "Directory", tab: "directory" },
    ],
  },
  {
    key: "workflow.operations", kind: "workflow", label: "Management & Operations",
    description: "Licenses, certifications and renewals.",
    requiresChild: true,
    children: [
      { key: "page.licenses", kind: "page", label: "Licenses", tab: "licenses" },
    ],
  },
  {
    key: "workflow.admin", kind: "workflow", label: "Admin",
    description: "Team-wide calendars and administrative consoles.",
    requiresChild: true,
    children: [
      { key: "page.team-cal",    kind: "page", label: "Team Calendar",   tab: "team-cal" },
      { key: "page.time-admin",  kind: "page", label: "Time Admin",      tab: "time-admin",  adminOnly: true },
      { key: "page.user-access", kind: "page", label: "User Management", tab: "user-access", adminOnly: true },
    ],
  },
  {
    key: "workflow.time", kind: "workflow", label: "Time & Leave", always: true,
    description: "Punch in / out, timesheets and leave requests. Always available to everyone.",
    children: [
      { key: "page.timesheet", kind: "page", label: "Time & Leave", tab: "timesheet" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Flattened index (built once at module load).
// ---------------------------------------------------------------------------
const NODES = new Map();        // key → { ...node, parent: key|null, depth, always }
const TAB_NODE = new Map();     // App tab key → node key
(function index(list, parent, depth, inheritedAlways) {
  for (const n of list) {
    if (NODES.has(n.key)) throw new Error(`access.js: duplicate node key "${n.key}"`);
    if (n.tab && TAB_NODE.has(n.tab)) throw new Error(`access.js: tab "${n.tab}" mapped twice`);
    const always = inheritedAlways || !!n.always;
    NODES.set(n.key, { ...n, parent, depth, always, children: n.children || [] });
    if (n.tab) TAB_NODE.set(n.tab, n.key);
    if (n.children) index(n.children, n.key, depth + 1, always);
  }
})(ACCESS_TREE, null, 0, false);

export const ALL_ACCESS_KEYS = [...NODES.keys()];
export const accessNode = (key) => NODES.get(key) || null;
export const accessNodeForTab = (tabKey) => NODES.get(TAB_NODE.get(tabKey)) || null;
const childKeys = (key) => (NODES.get(key)?.children || []).map(c => c.key);

/** Keys an Admin can toggle for a (non-admin) user — excludes always + adminOnly. */
export const isGrantable = (key) => {
  const n = NODES.get(key);
  return !!n && !n.always && !n.adminOnly;
};
export const GRANTABLE_KEYS = ALL_ACCESS_KEYS.filter(isGrantable);

const descendants = (key) => {
  const out = [];
  const walk = (k) => { for (const c of childKeys(k)) { out.push(c); walk(c); } };
  walk(key);
  return out;
};
const ancestors = (key) => {
  const out = [];
  let p = NODES.get(key)?.parent;
  while (p) { out.push(p); p = NODES.get(p).parent; }
  return out;
};

// ---------------------------------------------------------------------------
// Config normalisation. A DB row is { mode, grants, seen }; a missing row is
// null (= full access).
// ---------------------------------------------------------------------------
export function normalizeAccessConfig(row) {
  if (!row) return null;
  const mode = row.mode === "custom" ? "custom" : "full";
  return {
    mode,
    grants: Array.isArray(row.grants) ? row.grants.filter(k => typeof k === "string") : [],
    seen:   Array.isArray(row.seen)   ? row.seen.filter(k => typeof k === "string")   : [],
  };
}

/**
 * The effective per-node switch state of a custom config, ignoring ancestors
 * and adminOnly: a stored grant for nodes that existed at save time, the
 * inheritance rule for nodes added since.
 */
function makeGrantedFn(config) {
  const grants = new Set(config.grants);
  const seen = new Set(config.seen);
  const memo = new Map();
  const granted = (key) => {
    if (memo.has(key)) return memo.get(key);
    const n = NODES.get(key);
    let v;
    if (!n) v = false;
    else if (n.always) v = true;
    else if (seen.has(key)) v = grants.has(key);
    else if (!n.parent) v = false;                  // a brand-new workflow
    else {
      const seenSiblings = childKeys(n.parent).filter(k => seen.has(k) && isGrantable(k));
      v = granted(n.parent) && seenSiblings.every(k => grants.has(k));
    }
    memo.set(key, v);
    return v;
  };
  return granted;
}

/**
 * Build the access object App.jsx enforces with.
 *
 * @param {{ isAdmin: boolean, config: {mode,grants,seen}|null, failed?: boolean }} opts
 *   failed = the user's access row could not be loaded for a reason OTHER than
 *   the table not existing yet. Fails closed to Time & Leave only.
 */
export function createAccess({ isAdmin = false, config = null, failed = false } = {}) {
  const mode = isAdmin ? "admin" : failed ? "fallback" : (config?.mode === "custom" ? "custom" : "full");
  const granted =
    mode === "admin" || mode === "full" ? () => true
    : mode === "fallback" ? (key) => !!NODES.get(key)?.always
    : makeGrantedFn(config);

  const openMemo = new Map();
  // Granted along the whole ancestor chain + role check.
  const open = (key) => {
    if (openMemo.has(key)) return openMemo.get(key);
    const n = NODES.get(key);
    const v = !!n
      && (n.always || !n.adminOnly || isAdmin)
      && (n.always || granted(key))
      && (!n.parent || open(n.parent));
    openMemo.set(key, v);
    return v;
  };
  const contentMemo = new Map();
  // Has something to show: requiresChild nodes need a child that is itself
  // granted + role-ok + has content (ancestors are this node's, already open).
  const hasContent = (key) => {
    if (contentMemo.has(key)) return contentMemo.get(key);
    const n = NODES.get(key);
    let v = true;
    if (n.requiresChild && n.children.length) {
      v = n.children.some(c => {
        const cn = NODES.get(c.key);
        return (cn.always || !cn.adminOnly || isAdmin) && (cn.always || granted(c.key)) && hasContent(c.key);
      });
    }
    contentMemo.set(key, v);
    return v;
  };

  const can = (key) => !!NODES.get(key) && open(key) && hasContent(key);
  // Unknown tab keys (not in the registry) are allowed only with full access.
  const canTab = (tabKey) => {
    const n = accessNodeForTab(tabKey);
    if (!n) return mode === "admin" || mode === "full";
    return can(n.key);
  };

  return {
    mode,
    isRestricted: mode === "custom" || mode === "fallback",
    can,
    /** May the user land on this App tab key? */
    canTab,
    /** Visible children of a node, in registry order (for in-page view/section gates). */
    visibleChildren(key) {
      return (NODES.get(key)?.children || []).filter(c => can(c.key));
    },
    /** First allowed tab from a preference-ordered list, else Time & Leave. */
    firstTab(order) {
      return order.find(canTab) || "timesheet";
    },
  };
}

// ---------------------------------------------------------------------------
// Editor helpers (user-access.jsx). The editor works on a Set of grantable
// keys; `effectiveGrants` seeds it from a stored config.
// ---------------------------------------------------------------------------

/** Everything grantable — the starting point when switching a user to custom. */
export const fullGrantSet = () => new Set(GRANTABLE_KEYS);

/** A stored config → the Set of grantable keys the editor should show as on. */
export function effectiveGrants(configRow) {
  const config = normalizeAccessConfig(configRow);
  if (!config || config.mode !== "custom") return fullGrantSet();
  const granted = makeGrantedFn(config);
  return new Set(GRANTABLE_KEYS.filter(granted));
}

/** Checkbox state of a node in the editor. */
export function nodeCheckState(grants, key) {
  const n = NODES.get(key);
  if (!n) return false;
  if (n.always) return true;
  if (n.adminOnly) return false;
  if (!grants.has(key)) return false;
  const sub = descendants(key).filter(isGrantable);
  return sub.every(k => grants.has(k)) ? true : "indeterminate";
}

/**
 * Toggle a node. Turning ON grants the node, its whole subtree and its
 * ancestors (so the path to it is open). Turning OFF revokes the subtree, then
 * revokes any requiresChild ancestor left with no granted child — a page with
 * no tabs hides rather than rendering empty.
 */
export function setNodeGranted(grants, key, on) {
  if (!isGrantable(key)) return new Set(grants);
  const next = new Set(grants);
  const subtree = [key, ...descendants(key)].filter(isGrantable);
  if (on) {
    subtree.forEach(k => next.add(k));
    ancestors(key).filter(isGrantable).forEach(k => next.add(k));
    return next;
  }
  subtree.forEach(k => next.delete(k));
  for (const a of ancestors(key)) {
    const n = NODES.get(a);
    if (!isGrantable(a) || !n.requiresChild) continue;
    if (!childKeys(a).some(k => isGrantable(k) && next.has(k))) next.delete(a);
  }
  return next;
}

/** Serialise an editor Set for saving. `seen` snapshots today's registry. */
export function buildCustomConfig(grants) {
  return {
    mode: "custom",
    grants: GRANTABLE_KEYS.filter(k => grants.has(k)),
    seen: ALL_ACCESS_KEYS.slice(),
  };
}

/** Short human summary for the user list, e.g. "Full access" / "4 of 9 pages". */
export function summarizeAccess({ isAdmin = false, configRow = null } = {}) {
  if (isAdmin) return { tone: "brand", label: "Admin · everything" };
  const config = normalizeAccessConfig(configRow);
  if (!config || config.mode !== "custom") return { tone: "success", label: "Full access" };
  const access = createAccess({ isAdmin: false, config });
  const pages = ALL_ACCESS_KEYS.filter(k => {
    const n = NODES.get(k);
    return n.kind === "page" && !n.always && !n.adminOnly;
  });
  const visible = pages.filter(k => access.can(k)).length;
  return { tone: "info", label: `Custom · ${visible} of ${pages.length} pages` };
}
