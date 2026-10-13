import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MARKETING_CONTACT_ROLES,
  nextMarketingAction,
  sortMarketingActivities,
  sortMarketingTasks,
} from "../src/marketing-model.js";
import {
  marketingDirectoryContactOptions,
  saveMarketingStakeholder,
} from "../src/marketing-components/marketing-sheet-model.js";

test("stakeholder roles exactly match the approved relationship model", () => {
  assert.deepEqual(MARKETING_CONTACT_ROLES, [
    "Champion", "Decision-maker", "Budget owner", "Legal contact", "Technical evaluator", "Other",
  ]);
});

test("stakeholder picker searches the full Directory and excludes linked contacts", () => {
  const companies = [
    { id: "c1", name: "USACE", contacts: [
      { id: "p1", name: "Durand Elzey", email: "durand@example.com" },
      { id: "p2", name: "Vic Landry", email: "vic@example.com" },
    ] },
    { id: "c2", name: "CPRA", contacts: [
      { id: "p3", name: "Jas Singh", email: "jas@cpra.example" },
    ] },
  ];
  const linked = [{ contactId: "p1" }];

  assert.deepEqual(marketingDirectoryContactOptions(companies, linked, "cpra"), [{
    id: "p3",
    name: "Jas Singh",
    email: "jas@cpra.example",
    companyId: "c2",
    companyName: "CPRA",
    label: "Jas Singh — CPRA",
  }]);
  assert.deepEqual(marketingDirectoryContactOptions(companies, linked, "vic").map(row => row.id), ["p2"]);
});

test("creating and linking a stakeholder refreshes Directory state", async () => {
  const refreshed = [{ id: "c1", name: "USACE", contacts: [{ id: "p4", name: "New Person" }] }];
  const result = await saveMarketingStakeholder({
    opportunityId: "o1",
    companyId: "c1",
    form: { contactId: "", newName: " New Person ", newEmail: "new@example.com", role: "Champion", isPrimary: true, notes: "Lead" },
    createContact: async input => ({ id: "p4", ...input }),
    linkContact: async input => ({ opportunityId: input.opportunityId, contactId: input.contactId, role: input.role, isPrimary: input.isPrimary }),
    refreshDirectory: async () => refreshed,
  });

  assert.deepEqual(result, {
    linked: { opportunityId: "o1", contactId: "p4", role: "Champion", isPrimary: true },
    directory: refreshed,
  });
});

test("a completed stakeholder link is not reported as failed when Directory refresh fails", async () => {
  const result = await saveMarketingStakeholder({
    opportunityId: "o1",
    companyId: "c1",
    form: { newName: "New Person", role: "Other" },
    createContact: async () => ({ id: "p4" }),
    linkContact: async input => ({ opportunityId: input.opportunityId, contactId: input.contactId }),
    refreshDirectory: async () => { throw new Error("network unavailable"); },
  });

  assert.deepEqual(result, {
    linked: { opportunityId: "o1", contactId: "p4" },
    directory: null,
    refreshError: "network unavailable",
  });
});

test("activities sort newest first without mutating input", () => {
  const rows = [{ id: "old", occurredAt: "2026-01-01T10:00:00Z" }, { id: "new", occurredAt: "2026-02-01T10:00:00Z" }];
  const before = [...rows];
  assert.deepEqual(sortMarketingActivities(rows).map(row => row.id), ["new", "old"]);
  assert.deepEqual(rows, before);
});

test("open tasks sort overdue, then due date, then priority", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const rows = [
    { id: "later", status: "open", dueAt: "2026-10-15T12:00:00Z", priority: "urgent" },
    { id: "overdue-normal", status: "open", dueAt: "2026-10-10T12:00:00Z", priority: "normal" },
    { id: "overdue-high", status: "open", dueAt: "2026-10-10T12:00:00Z", priority: "high" },
    { id: "done", status: "completed", dueAt: "2026-10-01T12:00:00Z", priority: "urgent" },
  ];
  assert.deepEqual(sortMarketingTasks(rows, now).map(row => row.id), ["overdue-high", "overdue-normal", "later", "done"]);
});

test("next action is the earliest open task or the opportunity fallback", () => {
  const rows = [
    { id: "b", title: "Send proposal", status: "open", dueAt: "2026-10-20T12:00:00Z" },
    { id: "a", title: "Send questions", status: "open", dueAt: "2026-10-13T12:00:00Z" },
  ];
  assert.equal(nextMarketingAction(rows, "Call client").id, "a");
  assert.equal(nextMarketingAction(rows.map(row => ({ ...row, status: "completed" })), "Call client"), "Call client");
});

test("activity and task panels expose full create and lifecycle controls", async () => {
  const activity = await readFile(new URL("../src/marketing-components/MarketingActivityPanel.jsx", import.meta.url), "utf8");
  const task = await readFile(new URL("../src/marketing-components/MarketingTaskPanel.jsx", import.meta.url), "utf8");
  for (const text of ["Activity type", "Occurred", "Summary", "Internal participants", "Directory contacts", "Outcome", "Next step"]) assert.match(activity, new RegExp(text));
  for (const text of ["Task title", "Assignee", "Due", "Priority", "Notes", "Complete", "Reopen"]) assert.match(task, new RegExp(text));
});
