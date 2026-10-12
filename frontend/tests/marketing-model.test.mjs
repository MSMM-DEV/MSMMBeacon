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
