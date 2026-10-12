import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptMarketingOpportunity,
  marketingOpportunityInsert,
  marketingOpportunityPatch,
} from "../src/marketing-model.js";

test("adapter preserves zero money, zero probability, null dates, and version", () => {
  const row = adaptMarketingOpportunity({
    id: "o1",
    title: "Zero pilot",
    estimated_value: 0,
    probability: 0,
    expected_close_date: null,
    version: 4,
    product_tags: [],
  });
  assert.equal(row.estimatedValue, 0);
  assert.equal(row.probability, 0);
  assert.equal(row.expectedCloseDate, null);
  assert.equal(row.version, 4);
});

test("insert trims required text and rejects whitespace-only names", () => {
  assert.throws(() => marketingOpportunityInsert({ title: "   " }), /Opportunity name is required/);
  assert.equal(marketingOpportunityInsert({ title: "  AI assistant  ", estimatedValue: 0 }).title, "AI assistant");
});

test("patch whitelists fields and carries an explicit expected version", () => {
  assert.deepEqual(marketingOpportunityPatch({
    summary: "  Fit confirmed ",
    estimatedValue: 0,
    ignored: true,
  }, 7), {
    patch: { summary: "Fit confirmed", estimated_value: 0 },
    expectedVersion: 7,
  });
});

test("portfolio fields adapt and persist without losing zero progress", () => {
  const row = adaptMarketingOpportunity({
    id: "portfolio-1",
    title: "HSDRRS",
    assigned_to_summary: "RAJ / KASH",
    task_order: "TO-1",
    delivery_status: "Waiting for Contract",
    project_progress: 0,
    source_sales_phase: "Verified BANT and Economic Buyer Approval",
    source_record_key: "parish-intelligence-hsdrrs-usace",
  });
  assert.equal(row.assignedTeam, "RAJ / KASH");
  assert.equal(row.taskOrder, "TO-1");
  assert.equal(row.deliveryStatus, "Waiting for Contract");
  assert.equal(row.projectProgress, 0);
  assert.equal(row.sourceSalesPhase, "Verified BANT and Economic Buyer Approval");
  assert.equal(row.sourceRecordKey, "parish-intelligence-hsdrrs-usace");

  assert.deepEqual(marketingOpportunityPatch({
    assignedTeam: "RAJ",
    taskOrder: "-",
    deliveryStatus: "Initial Kickoff",
    projectProgress: 40,
    sourceSalesPhase: "IQM - Prospect",
    sourceRecordKey: "must-not-change",
  }, 2), {
    patch: {
      assigned_to_summary: "RAJ",
      task_order: "-",
      delivery_status: "Initial Kickoff",
      project_progress: 40,
      source_sales_phase: "IQM - Prospect",
    },
    expectedVersion: 2,
  });
});
