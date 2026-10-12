import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { marketingSettingsPatch } from "../src/marketing-model.js";
import { buildMarketingInsights, filterMarketingOpportunities, marketingCsvRows } from "../src/marketing-rules.js";
import { serializeCSV } from "../src/utils/csv.js";

const now = new Date("2027-01-15T18:00:00Z");
const rows = [
  { id: "open-jan", title: "January AI", stage: "BANT - Budget Authority Need Time", ownerId: "u1", clientId: "c1", source: "Referral", productTags: ["AI"], estimatedValue: 100000, probability: 50, expectedCloseDate: "2027-01-31", stageEnteredAt: "2027-01-05T18:00:00Z" },
  { id: "open-dec", title: "December SaaS", stage: "IQM - Initial Qualified Meeting", ownerId: "u2", clientId: "c2", source: "Conference", productTags: ["SaaS"], estimatedValue: 0, probability: 25, expectedCloseDate: "2026-12-20", stageEnteredAt: "2026-12-01T18:00:00Z" },
  { id: "won", title: "Won AI", stage: "Contract Signed Won or Lost", outcome: "won", lossReason: null, ownerId: "u1", clientId: "c1", source: "Referral", productTags: ["AI"], estimatedValue: 80000, finalContractValue: 75000, probability: 100, expectedCloseDate: "2027-01-10" },
  { id: "lost-1", title: "Lost one", stage: "Contract Signed Won or Lost", outcome: "lost", lossReason: "Price", competitor: "Rival", ownerId: "u1", clientId: "c2", source: "Referral", productTags: ["SaaS"], estimatedValue: 40000, probability: 0 },
  { id: "lost-2", title: "Lost two", stage: "Contract Signed Won or Lost", outcome: "lost", lossReason: "Price", competitor: "Rival", ownerId: "u2", clientId: "c2", source: "Conference", productTags: ["AI"], estimatedValue: 20000, probability: 0 },
  { id: "archived", title: "Archived", stage: "Intro to Target or prospect", estimatedValue: 999999, probability: 5, archivedAt: "2027-01-01" },
];

test("reporting totals and breakdowns stay deterministic across the year boundary", () => {
  const history = [
    { opportunityId: "open-jan", fromStage: "Intro to Target or prospect", toStage: "Initial meeting to showcase products and qualify prospect", changedAt: "2027-01-05T18:00:00Z" },
  ];
  const insights = buildMarketingInsights(rows, [], [], { now, history, usersById: { u1: { name: "Dan" }, u2: { name: "John" } }, clientsById: { c1: { name: "Acme" }, c2: { name: "Beta" } } });
  assert.equal(insights.activeCount, 2);
  assert.equal(insights.activeValue, 100000);
  assert.equal(insights.weightedValue, 50000);
  assert.equal(insights.closingThisQuarterCount, 1);
  assert.deepEqual(insights.lossReasons.find(item => item.label === "Price"), { label: "Price", count: 2, value: 60000 });
  assert.equal(insights.owners.find(item => item.label === "Dan").count, 3);
  assert.equal(insights.products.find(item => item.label === "AI").count, 3);
  assert.equal(insights.sources.find(item => item.label === "Referral").count, 3);
  assert.equal(insights.competitors.find(item => item.label === "Rival").count, 2);
  assert.equal(insights.expectedCloseMonths.find(item => item.label === "2027-01").count, 2);
  assert.ok(insights.stageVelocity.some(item => item.stage === "Intro to Target or prospect" && item.averageDays >= 0));
});

test("filtered CSV retains exact stages and excludes hidden rows", () => {
  const filtered = filterMarketingOpportunities(rows, { ownerId: "u1", outcome: "open" }, { now, tasks: [] });
  const shaped = marketingCsvRows(filtered, { usersById: { u1: { name: "Dan" } }, clientsById: { c1: { name: "Acme" } } }, { now });
  const csv = serializeCSV([{ label: "Opportunity", key: "opportunity" }, { label: "Stage", key: "stage" }, { label: "Value", key: "estimatedValue" }], shaped);
  assert.match(csv, /^\uFEFFOpportunity,Stage,Value/);
  assert.match(csv, /January AI,BANT - Budget Authority Need Time,100000/);
  assert.doesNotMatch(csv, /Archived|Lost one|December SaaS/);
});

test("portfolio context is retained in current-view CSV rows", () => {
  const [shaped] = marketingCsvRows([{
    id: "portfolio", title: "HSDRRS", stage: "Verbal Approval to Proceed",
    productTags: ["Parish Intelligence"], source: "LCECS", probability: 90,
    assignedTeam: "RAJ / KASH", taskOrder: "TO-7", deliveryStatus: "Waiting for Contract",
    projectProgress: 20, sourceSalesPhase: "Verified BANT and Economic Buyer Approval",
    contacts: [{ name: "Durand Elzey" }, { name: "Vic Landry" }],
  }], {}, { now });
  assert.equal(shaped.product, "Parish Intelligence");
  assert.equal(shaped.project, "HSDRRS");
  assert.equal(shaped.leadSource, "LCECS");
  assert.equal(shaped.poc, "Durand Elzey; Vic Landry");
  assert.equal(shaped.assignedTo, "RAJ / KASH");
  assert.equal(shaped.taskOrder, "TO-7");
  assert.equal(shaped.currentStatus, "Waiting for Contract");
  assert.equal(shaped.projectPercent, 20);
  assert.equal(shaped.salesPhase, "Verified BANT and Economic Buyer Approval");
  assert.equal(shaped.salesPercent, 90);
});

test("filtered insights scope supporting records and ignore same-stage history for velocity", () => {
  const focused = [{
    id: "focus", title: "Focused", stage: "BANT - Budget Authority Need Time",
    createdAt: "2027-01-01T18:00:00Z", stageEnteredAt: "2027-01-11T18:00:00Z",
    estimatedValue: 100, probability: 45,
  }];
  const insights = buildMarketingInsights(
    focused,
    [
      { opportunityId: "focus", status: "open", dueAt: "2027-01-14T18:00:00Z" },
      { opportunityId: "outside", status: "open", dueAt: "2027-01-01T18:00:00Z" },
    ],
    [
      { opportunityId: "focus", activityType: "Meeting", authorId: "u1" },
      { opportunityId: "outside", activityType: "Email", authorId: "u2" },
    ],
    {
      now,
      history: [
        { opportunityId: "focus", fromStage: "Intro to Target or prospect", toStage: "Intro to Target or prospect", changedAt: "2027-01-05T18:00:00Z" },
        { opportunityId: "focus", fromStage: "Intro to Target or prospect", toStage: "BANT - Budget Authority Need Time", changedAt: "2027-01-11T18:00:00Z" },
        { opportunityId: "outside", fromStage: "Intro to Target or prospect", toStage: "BANT - Budget Authority Need Time", changedAt: "2027-01-03T18:00:00Z" },
      ],
      usersById: { u1: { name: "Dan" }, u2: { name: "Outside" } },
    },
  );
  assert.equal(insights.overdueTaskCount, 1);
  assert.deepEqual(insights.activityTypes, [{ label: "Meeting", count: 1, value: 0 }]);
  assert.equal(insights.activityOwners.some(item => item.label === "Outside"), false);
  assert.deepEqual(
    insights.stageVelocity.find(item => item.stage === "Intro to Target or prospect"),
    { stage: "Intro to Target or prospect", samples: 1, averageDays: 10 },
  );
});

test("CSV serialization handles quotes, commas, newlines, zero, null and BOM", () => {
  const csv = serializeCSV([{ label: "Name", key: "name" }, { label: "Value", key: "value" }, { label: "Note", key: "note" }], [
    { name: 'A, "quoted"', value: 0, note: "line 1\nline 2" },
    { name: "Null", value: null, note: null },
  ]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.match(csv, /"A, ""quoted""",0,"line 1\nline 2"/);
  assert.match(csv, /Null,,/);
});

test("Marketing stalled setting validates and maps to the DB column", () => {
  assert.throws(() => marketingSettingsPatch(0), /between 1 and 365/);
  assert.throws(() => marketingSettingsPatch(366), /between 1 and 365/);
  assert.deepEqual(marketingSettingsPatch(14), { marketing_stalled_after_days: 14 });
});

test("list, insights and Admin setting surfaces are present", async () => {
  const list = await readFile(new URL("../src/marketing-components/MarketingList.jsx", import.meta.url), "utf8");
  const insights = await readFile(new URL("../src/marketing-components/MarketingInsights.jsx", import.meta.url), "utf8");
  const admin = await readFile(new URL("../src/admin.jsx", import.meta.url), "utf8");
  assert.match(list, /aria-sort/);
  assert.match(list, /Export current view/);
  assert.match(insights, /Stage funnel/);
  assert.match(insights, /Lost reasons/);
  assert.match(insights, /table/);
  assert.match(admin, /days without meaningful activity/);
  assert.match(admin, /updateMarketingSettings/);
});
