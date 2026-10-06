import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCESS_TREE, ALL_ACCESS_KEYS, GRANTABLE_KEYS,
  accessNodeForTab, createAccess, effectiveGrants, nodeCheckState,
  setNodeGranted, buildCustomConfig, normalizeAccessConfig, summarizeAccess,
  fullGrantSet,
} from "../src/access.js";

// Every routable tab in App.jsx TAB_META must map to a node, or a restricted
// user would be locked out of it (unknown tabs fail closed for custom users).
const APP_TABS = [
  "hotleads", "openbids", "leads-deleted", "awaiting", "awarded", "proposals-deleted",
  "potential", "invoice", "between", "closed", "projects", "events", "directory",
  "licenses", "timesheet", "time-admin", "team-cal", "user-access",
];

const custom = (keys) => buildCustomConfig(new Set(keys));

test("every App tab key maps to an access node", () => {
  for (const t of APP_TABS) assert.ok(accessNodeForTab(t), `missing node for tab ${t}`);
});

test("Leads & Bids is a visible page, not a link-only destination", () => {
  const page = ACCESS_TREE
    .flatMap(workflow => workflow.children || [])
    .find(node => node.key === "page.leads");
  assert.ok(page, "missing Leads & Bids access page");
  assert.notEqual(page.hiddenFromNav, true);
});

test("no config = today's behaviour: everything but admin-only pages", () => {
  const a = createAccess({ isAdmin: false, config: null });
  assert.equal(a.mode, "full");
  for (const t of APP_TABS) {
    const adminOnly = t === "time-admin" || t === "user-access";
    assert.equal(a.canTab(t), !adminOnly, t);
  }
});

test("admins see everything regardless of a stored restriction", () => {
  const a = createAccess({ isAdmin: true, config: custom([]) });
  for (const t of APP_TABS) assert.equal(a.canTab(t), true, t);
});

test("Time & Leave is always available, even with nothing granted or a failed load", () => {
  assert.equal(createAccess({ config: custom([]) }).canTab("timesheet"), true);
  const failed = createAccess({ failed: true });
  assert.equal(failed.canTab("timesheet"), true);
  assert.equal(failed.canTab("invoice"), false);
  assert.equal(failed.firstTab(["invoice", "awaiting"]), "timesheet");
});

test("Engineering → Proposals only", () => {
  let g = new Set();
  g = setNodeGranted(g, "tab.awaiting", true);
  const a = createAccess({ config: buildCustomConfig(g) });
  assert.equal(a.can("workflow.engineering"), true);
  assert.equal(a.can("page.proposals"), true);
  assert.equal(a.canTab("awaiting"), true);
  assert.equal(a.canTab("awarded"), false);
  assert.equal(a.canTab("invoice"), false);
  assert.equal(a.can("page.invoice"), false);
  assert.equal(a.canTab("directory"), false);
  assert.equal(a.firstTab(["invoice", "awarded", "awaiting"]), "awaiting");
});

test("a page whose tabs are all revoked disappears (requiresChild)", () => {
  let g = fullGrantSet();
  for (const t of ["tab.invoice", "tab.between", "tab.closed"]) g = setNodeGranted(g, t, false);
  assert.equal(g.has("page.invoice"), false, "editor drops the empty page");
  // Even if a stale row still holds the page key, it has nothing to show.
  const a = createAccess({ config: { ...buildCustomConfig(g), grants: [...buildCustomConfig(g).grants, "page.invoice"] } });
  assert.equal(a.can("page.invoice"), false);
  assert.equal(a.can("page.proposals"), true);
});

test("sub-tab level: Projects list without project details, or with some sections", () => {
  let g = setNodeGranted(new Set(), "page.projects", true);
  g = setNodeGranted(g, "tab.project-detail", false);
  let a = createAccess({ config: buildCustomConfig(g) });
  assert.equal(a.canTab("projects"), true);
  assert.equal(a.can("tab.project-detail"), false);

  g = setNodeGranted(g, "subtab.project.notes", true);
  a = createAccess({ config: buildCustomConfig(g) });
  assert.equal(a.can("tab.project-detail"), true);
  assert.deepEqual(a.visibleChildren("tab.project-detail").map(c => c.section), ["notes"]);
});

test("Events requires at least one view", () => {
  let g = setNodeGranted(new Set(), "tab.events.calendar", true);
  let a = createAccess({ config: buildCustomConfig(g) });
  assert.equal(a.canTab("events"), true);
  assert.deepEqual(a.visibleChildren("page.events").map(c => c.view), ["calendar"]);
  g = setNodeGranted(g, "tab.events.calendar", false);
  a = createAccess({ config: buildCustomConfig(g) });
  assert.equal(a.canTab("events"), false);
});

test("admin-only pages are never grantable to a User", () => {
  assert.equal(GRANTABLE_KEYS.includes("page.time-admin"), false);
  const g = setNodeGranted(new Set(), "page.time-admin", true);
  assert.equal(g.has("page.time-admin"), false);
  const a = createAccess({ config: { mode: "custom", grants: ["workflow.admin", "page.time-admin"], seen: ALL_ACCESS_KEYS } });
  assert.equal(a.canTab("time-admin"), false);
});

test("editor check states: checked / indeterminate / unchecked", () => {
  let g = fullGrantSet();
  assert.equal(nodeCheckState(g, "workflow.engineering"), true);
  g = setNodeGranted(g, "tab.awarded", false);
  assert.equal(nodeCheckState(g, "workflow.engineering"), "indeterminate");
  assert.equal(nodeCheckState(g, "page.proposals"), "indeterminate");
  assert.equal(nodeCheckState(g, "tab.awarded"), false);
  assert.equal(nodeCheckState(g, "workflow.time"), true, "always nodes read as checked");
});

test("new nodes: inherit when the user had the whole parent, stay hidden for a hand-picked subset", () => {
  // Simulate configs saved before "tab.closed" existed.
  const seenBefore = ALL_ACCESS_KEYS.filter(k => k !== "tab.closed");
  const wholeInvoice = {
    mode: "custom",
    grants: ["workflow.engineering", "page.invoice", "tab.invoice", "tab.between"],
    seen: seenBefore,
  };
  assert.equal(createAccess({ config: wholeInvoice }).canTab("closed"), true);

  const partialInvoice = { ...wholeInvoice, grants: ["workflow.engineering", "page.invoice", "tab.invoice"] };
  assert.equal(createAccess({ config: partialInvoice }).canTab("closed"), false);

  // The editor reflects the same inheritance, so a re-save is lossless.
  assert.equal(effectiveGrants(wholeInvoice).has("tab.closed"), true);
  assert.equal(effectiveGrants(partialInvoice).has("tab.closed"), false);
});

test("a brand-new workflow stays hidden for restricted users", () => {
  const seenBefore = ALL_ACCESS_KEYS.filter(k => !k.startsWith("workflow.operations") && k !== "page.licenses");
  const cfg = { mode: "custom", grants: GRANTABLE_KEYS.filter(k => seenBefore.includes(k)), seen: seenBefore };
  assert.equal(createAccess({ config: cfg }).canTab("licenses"), false);
});

test("normalize + summary", () => {
  assert.equal(normalizeAccessConfig(null), null);
  assert.equal(normalizeAccessConfig({ mode: "weird" }).mode, "full");
  assert.equal(summarizeAccess({ configRow: null }).label, "Full access");
  assert.equal(summarizeAccess({ isAdmin: true, configRow: custom([]) }).label, "Admin · everything");
  assert.match(summarizeAccess({ configRow: custom(["page.directory", "workflow.workspace"]) }).label, /^Custom · 1 of \d+ pages$/);
});

test("registry keys are unique and every workflow is top-level", () => {
  assert.equal(new Set(ALL_ACCESS_KEYS).size, ALL_ACCESS_KEYS.length);
  for (const w of ACCESS_TREE) assert.equal(w.kind, "workflow");
});
