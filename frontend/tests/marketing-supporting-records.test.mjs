import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MARKETING_CONTACT_ROLES,
  nextMarketingAction,
  sortMarketingActivities,
  sortMarketingTasks,
} from "../src/marketing-model.js";

test("stakeholder roles exactly match the approved relationship model", () => {
  assert.deepEqual(MARKETING_CONTACT_ROLES, [
    "Champion", "Decision-maker", "Budget owner", "Legal contact", "Technical evaluator", "Other",
  ]);
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
