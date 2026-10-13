import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const path = new URL("../src/marketing-components/MarketingOpportunitySheet.jsx", import.meta.url);

test("opportunity details use a centered popup with the simplified workspace", async () => {
  const source = await readFile(path, "utf8");
  for (const section of ["Overview", "Qualification", "People", "Activity", "Tasks", "Files & History"]) {
    assert.match(source, new RegExp(`label:\\s*"${section}"`), section);
  }
  assert.match(source, /<Dialog open/);
  assert.match(source, /<DialogContent size="xl"/);
  assert.doesNotMatch(source, /<Sheet(?:Content|Header|Body|Footer)?\b/);
  for (const label of [
    "Opportunity name", "Organization", "Owner", "Source", "Introducer", "Summary",
    "Next action", "Expected close date", "Estimated value", "Products", "Probability",
    "Problem statement", "Desired outcome", "Solution fit", "Clarifying questions",
    "Budget", "Authority", "Need", "Time", "Proposal", "Verbal approval", "Legal and contract",
    "Assigned team", "Task order", "Phases / Current Status", "Project %", "Original sales phase",
  ]) assert.match(source, new RegExp(label, "i"), label);
  assert.match(source, /changedBy/);
  assert.match(source, /changedAt/);
});

test("dirty dismissal confirms and conflict recovery never overwrites automatically", async () => {
  const source = await readFile(path, "utf8");
  assert.match(source, /requestClose[\s\S]*setConfirmClose\(true\)/);
  assert.match(source, /This opportunity changed after you opened it\./);
  assert.match(source, /Review latest/);
  assert.match(source, /Keep my draft/);
  assert.doesNotMatch(source, /forceOverwrite|overwrite:\s*true/);

  const { attemptMarketingSectionSave } = await import("../src/marketing-components/marketing-sheet-model.js");
  const calls = [];
  const api = async (_id, _draft, version) => {
    calls.push(version);
    if (version === 4) throw Object.assign(new Error("conflict"), { code: "MARKETING_CONFLICT", latestVersion: 5 });
    return { id: "o1", version: 6 };
  };
  await assert.rejects(() => attemptMarketingSectionSave({ api, id: "o1", draft: { summary: "Mine" }, version: 4 }));
  assert.deepEqual(calls, [4]);
  await attemptMarketingSectionSave({ api, id: "o1", draft: { summary: "Mine" }, version: 5 });
  assert.deepEqual(calls, [4, 5]);
});

test("sheet saves preserve supporting records and datetime-local values round trip", async () => {
  const {
    mergeMarketingRelations,
    toMarketingDateTimeLocal,
    fromMarketingDateTimeLocal,
  } = await import("../src/marketing-components/marketing-sheet-model.js");
  const supporting = {
    contacts: [{ id: "c1" }], activities: [{ id: "a1" }], tasks: [{ id: "t1" }],
    documents: [{ id: "d1" }], history: [{ id: "h1" }],
  };
  assert.deepEqual(mergeMarketingRelations({ id: "o1", version: 2 }, supporting), {
    id: "o1", version: 2, ...supporting,
  });
  const iso = "2026-10-12T18:30:00.000Z";
  const local = toMarketingDateTimeLocal(iso);
  assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(fromMarketingDateTimeLocal(local), iso);
  assert.equal(fromMarketingDateTimeLocal(""), null);
});

test("qualification UUID relationships use contact and user selectors", async () => {
  const source = await readFile(path, "utf8");
  for (const label of ["Clarifying owner", "Authority contact", "Approver contact", "Legal owner", "Customer legal contact"]) {
    assert.match(source, new RegExp(`selectField\\(\"${label}\"`), label);
  }
});

test("archive is recoverable and permanent delete is absent", async () => {
  const source = await readFile(path, "utf8");
  assert.match(source, /Archive opportunity/);
  assert.match(source, /Restore opportunity/);
  assert.doesNotMatch(source, /deleteMarketingOpportunity|Permanently delete/);
});
