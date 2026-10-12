import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKETING_STAGE_NAMES,
  buildMarketingInsights,
  filterMarketingOpportunities,
  marketingCsvRows,
  marketingHealth,
  transitionDraft,
  validateMarketingTransition,
  weightedMarketingValue,
} from "../src/marketing-rules.js";

const exactStages = [
  "Intro to Target or prospect",
  "Initial meeting to showcase products and qualify prospect",
  "IQM - Initial Qualified Meeting",
  "BANT - Budget Authority Need Time",
  "Verbal Approval to Proceed",
  "Legal and Contract Negotiation",
  "Contract Signed Won or Lost",
];

test("stage names and order exactly match the marketing lead's language", () => {
  assert.deepEqual(MARKETING_STAGE_NAMES, exactStages);
});

test("moving to BANT proposes 45 without blocking an acknowledged custom probability", () => {
  const draft = transitionDraft({ stage: exactStages[2], probability: 30 }, exactStages[3]);
  assert.equal(draft.probability, 45);
  assert.equal(validateMarketingTransition({ ...draft, probability: 55 }).errors.length, 0);
  assert.ok(validateMarketingTransition({ ...draft, probability: 55 }).warnings.length > 0);
});

test("Won and Lost require their outcome fields and fix probability", () => {
  const won = validateMarketingTransition({ toStage: exactStages[6], outcome: "won", probability: 90 });
  assert.deepEqual(won.errors.map(x => x.field), ["signedAt", "finalContractValue"]);
  assert.equal(won.normalized.probability, 100);
  const lost = validateMarketingTransition({ toStage: exactStages[6], outcome: "lost", probability: 75 });
  assert.deepEqual(lost.errors.map(x => x.field), ["lossReason"]);
  assert.equal(lost.normalized.probability, 0);
});

test("unknown stages are rejected and ordinary stages clear terminal outcome", () => {
  assert.throws(() => transitionDraft({}, "Discovery"), /Unknown marketing stage/);
  const result = validateMarketingTransition({
    toStage: exactStages[1], probability: 20, outcome: "won", signedAt: "2026-10-12", finalContractValue: 1,
  });
  assert.equal(result.normalized.outcome, null);
  assert.equal(result.normalized.signedAt, null);
});

test("zero value and zero probability produce a real zero weighted value", () => {
  assert.equal(weightedMarketingValue({ estimatedValue: 0, probability: 50 }), 0);
  assert.equal(weightedMarketingValue({ estimatedValue: 5000, probability: 0 }), 0);
});

test("stalled outranks overdue attention and Chicago date-only filtering is stable", () => {
  const now = new Date("2026-11-01T05:30:00.000Z");
  const row = {
    id: "a", title: "A", stage: exactStages[2], outcome: null,
    lastActivityAt: "2026-10-01T12:00:00.000Z", expectedCloseDate: "2026-10-31",
  };
  assert.equal(marketingHealth(row, [{ opportunityId: "a", dueAt: "2026-10-31T14:00:00.000Z", status: "open" }], { now, stalledAfterDays: 14 }), "stalled");
  assert.equal(filterMarketingOpportunities([row], { closePeriod: "overdue" }, { now }).length, 1);
});

test("attention applies to an overdue action when the deal is not stalled", () => {
  const now = new Date("2026-10-12T18:00:00-05:00");
  const row = { id: "a", outcome: null, lastActivityAt: "2026-10-11T12:00:00-05:00" };
  const tasks = [{ opportunityId: "a", dueAt: "2026-10-10T09:00:00-05:00", status: "open" }];
  assert.equal(marketingHealth(row, tasks, { now, stalledAfterDays: 14 }), "attention");
});

test("insights exclude closed and archived rows from active totals while retaining loss reasons", () => {
  const rows = [
    { id: "open", stage: exactStages[2], probability: 40, estimatedValue: 1000, expectedCloseDate: "2026-12-15" },
    { id: "won", stage: exactStages[6], outcome: "won", probability: 100, estimatedValue: 2000, finalContractValue: 1800, signedAt: "2026-10-01" },
    { id: "lost", stage: exactStages[6], outcome: "lost", probability: 0, estimatedValue: 0, lossReason: "Price" },
    { id: "archived", stage: exactStages[1], probability: 20, estimatedValue: 9000, archivedAt: "2026-09-01" },
  ];
  const out = buildMarketingInsights(rows, [], [], { now: new Date("2026-10-12T12:00:00-05:00") });
  assert.equal(out.activeCount, 1);
  assert.equal(out.activeValue, 1000);
  assert.equal(out.weightedValue, 400);
  assert.equal(out.wonValue, 1800);
  assert.deepEqual(out.lossReasons, [{ label: "Price", count: 1, value: 0 }]);
});

test("quarter filtering crosses a year boundary without UTC drift", () => {
  const rows = [
    { id: "dec", title: "December", expectedCloseDate: "2026-12-31" },
    { id: "jan", title: "January", expectedCloseDate: "2027-01-01" },
  ];
  const december = filterMarketingOpportunities(rows, { closePeriod: "quarter" }, { now: new Date("2026-12-15T12:00:00-06:00") });
  const january = filterMarketingOpportunities(rows, { closePeriod: "quarter" }, { now: new Date("2027-01-02T12:00:00-06:00") });
  assert.deepEqual(december.map(row => row.id), ["dec"]);
  assert.deepEqual(january.map(row => row.id), ["jan"]);
});

test("exact-stage filtering and CSV shaping retain the approved language", () => {
  const rows = [
    { id: "a", title: "Pilot", stage: exactStages[3], probability: 45, estimatedValue: 5000, ownerId: "u1", clientId: "c1", productTags: ["AI"] },
    { id: "b", title: "Other", stage: exactStages[4], probability: 75, estimatedValue: 1000 },
  ];
  const filtered = filterMarketingOpportunities(rows, { stages: [exactStages[3]] });
  assert.deepEqual(filtered.map(row => row.id), ["a"]);
  const csv = marketingCsvRows(filtered, {
    usersById: { u1: { name: "Ada Owner" } }, clientsById: { c1: { name: "Acme" } },
  });
  assert.equal(csv[0].stage, exactStages[3]);
  assert.equal(csv[0].owner, "Ada Owner");
  assert.equal(csv[0].organization, "Acme");
  assert.equal(csv[0].weightedValue, 2250);
});
