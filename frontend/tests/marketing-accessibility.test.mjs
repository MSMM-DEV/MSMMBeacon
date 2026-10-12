import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = name => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const page = src("marketing.jsx");
const board = src("marketing-components/MarketingBoard.jsx");
const transition = src("marketing-components/MarketingTransitionDialog.jsx");
const details = src("marketing-components/MarketingOpportunitySheet.jsx");
const tasks = src("marketing-components/MarketingTaskPanel.jsx");
const documents = src("marketing-components/MarketingDocumentPanel.jsx");
const insights = src("marketing-components/MarketingInsights.jsx");

test("Marketing keeps the shared single page heading and labels each Kanban lane", () => {
  assert.doesNotMatch(page, /<h1\b/);
  assert.match(board, /role="region"/);
  assert.match(board, /aria-labelledby=/);
  assert.match(board, /aria-label="Choose pipeline stage"/);
});

test("cards and transitions expose text, keyboard controls, and error summaries", () => {
  assert.match(board, /type="button"/);
  assert.match(board, /label: "On track"/);
  assert.match(board, /label: "Needs attention"/);
  assert.match(board, /label: "Stalled"/);
  assert.match(transition, /<DialogTitle>/);
  assert.match(transition, /<DialogDescription/);
  assert.match(transition, /role="alert"/);
  assert.match(details, /role="alert"/);
});

test("reports expose a spoken summary and direct-value tables", () => {
  assert.match(insights, /className="sr-only"/);
  assert.match(insights, /<table>/);
  assert.match(insights, /<caption/);
});

test("partial failures retain the saved record and provide named retries", () => {
  assert.match(tasks, /Task saved; reminder was not scheduled/);
  assert.match(tasks, />Retry reminder</);
  assert.match(documents, />Retry cleanup</);
});

test("Marketing view state is persisted and URL state responds to browser navigation", () => {
  assert.match(page, /beacon\.marketing\.view/);
  assert.match(page, /beacon\.marketing\.stage/);
  assert.match(page, /popstate/);
  assert.match(page, /replaceState/);
});
