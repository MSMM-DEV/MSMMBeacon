import test from "node:test";
import assert from "node:assert/strict";

import {
  amendmentsTotal,
  contractValue,
  contractBreakdown,
  subAmendmentKey,
  amendmentRowKey,
  groupAmendments,
  amendmentsForInvoiceIds,
  amendmentsForSub,
  subIsAmendable,
} from "../src/invoice-amendments.js";

// --- amendmentsTotal --------------------------------------------------------

test("amendmentsTotal sums amounts", () => {
  assert.equal(amendmentsTotal([{ amount: 100 }, { amount: 250.5 }]), 350.5);
});

test("amendmentsTotal is 0 for empty/nullish input", () => {
  assert.equal(amendmentsTotal([]), 0);
  assert.equal(amendmentsTotal(null), 0);
  assert.equal(amendmentsTotal(undefined), 0);
});

test("amendmentsTotal handles negative (deductive) change orders", () => {
  assert.equal(amendmentsTotal([{ amount: 1000 }, { amount: -400 }]), 600);
});

test("amendmentsTotal coerces string and null amounts without producing NaN", () => {
  const total = amendmentsTotal([
    { amount: "1200.25" }, { amount: null }, { amount: "" }, { amount: undefined },
  ]);
  assert.equal(total, 1200.25);
});

test("amendmentsTotal treats an unparseable amount as 0, never NaN", () => {
  assert.equal(amendmentsTotal([{ amount: "not a number" }, { amount: 50 }]), 50);
});

// --- contractValue ----------------------------------------------------------

test("contractValue is base + amendments", () => {
  assert.equal(contractValue(10000, [{ amount: 2500 }, { amount: 500 }]), 13000);
});

test("contractValue with no amendments is the base alone", () => {
  assert.equal(contractValue(10000, []), 10000);
  assert.equal(contractValue(10000, null), 10000);
});

test("contractValue coerces a null/blank base to 0", () => {
  assert.equal(contractValue(null, [{ amount: 900 }]), 900);
  assert.equal(contractValue("", [{ amount: 900 }]), 900);
});

test("contractValue accepts a string base (the shape EditableCell writes)", () => {
  assert.equal(contractValue("10000", [{ amount: 250 }]), 10250);
});

// --- contractBreakdown ------------------------------------------------------

test("contractBreakdown reports base, one item per amendment, and the total", () => {
  const b = contractBreakdown(80000, [
    { id: "a1", amount: 12000, notes: "Added survey scope", fileName: "am1.pdf" },
    { id: "a2", amount: 3000, notes: "" },
  ]);
  assert.equal(b.base, 80000);
  assert.equal(b.items.length, 2);
  assert.equal(b.total, 95000);
  assert.equal(b.items[0].label, "Amendment 1");
  assert.equal(b.items[1].label, "Amendment 2");
  assert.equal(b.items[0].fileName, "am1.pdf");
  assert.equal(b.items[1].fileName, null);
});

test("contractBreakdown total always equals base plus the listed items", () => {
  const list = [{ amount: 5 }, { amount: -2 }, { amount: "3" }];
  const b = contractBreakdown(100, list);
  const summed = b.base + b.items.reduce((a, it) => a + it.amount, 0);
  assert.equal(b.total, summed);
  assert.equal(b.total, contractValue(100, list));
});

test("contractBreakdown with no amendments still returns a usable shape", () => {
  const b = contractBreakdown(500, []);
  assert.deepEqual(b, { base: 500, items: [], total: 500 });
});

// --- keying -----------------------------------------------------------------

test("subAmendmentKey defaults kind to 'sub'", () => {
  assert.equal(subAmendmentKey("p1", "c1"), subAmendmentKey("p1", "c1", "sub"));
});

test("subAmendmentKey separates kinds for the same company on one project", () => {
  assert.notEqual(subAmendmentKey("p1", "c1", "sub"), subAmendmentKey("p1", "c1", "prime"));
});

test("amendmentRowKey discriminates the two scopes", () => {
  assert.equal(amendmentRowKey({ invoiceId: "i1" }), "inv::i1");
  assert.equal(
    amendmentRowKey({ projectId: "p1", companyId: "c1", kind: "sub" }),
    "sub::p1::sub::c1",
  );
});

test("amendmentRowKey returns null for a malformed row", () => {
  assert.equal(amendmentRowKey(null), null);
  assert.equal(amendmentRowKey({}), null);
  assert.equal(amendmentRowKey({ projectId: "p1" }), null); // half a sub key
});

// --- grouping ---------------------------------------------------------------

test("groupAmendments buckets by scope and preserves order", () => {
  const { byInvoiceId, bySubKey } = groupAmendments([
    { id: "1", invoiceId: "i1", amount: 100 },
    { id: "2", invoiceId: "i1", amount: 200 },
    { id: "3", projectId: "p1", companyId: "c1", kind: "sub", amount: 50 },
  ]);
  assert.deepEqual(byInvoiceId.get("i1").map(a => a.id), ["1", "2"]);
  assert.deepEqual(bySubKey.get(subAmendmentKey("p1", "c1", "sub")).map(a => a.id), ["3"]);
});

test("groupAmendments ignores malformed rows rather than throwing", () => {
  const { byInvoiceId, bySubKey } = groupAmendments([null, {}, { projectId: "p1" }]);
  assert.equal(byInvoiceId.size, 0);
  assert.equal(bySubKey.size, 0);
});

// --- reading across a merged row's ids --------------------------------------

test("amendmentsForInvoiceIds unions every year-row and linked sibling", () => {
  const { byInvoiceId } = groupAmendments([
    { id: "1", invoiceId: "eng-2026", amount: 100 },
    { id: "2", invoiceId: "eng-2027", amount: 200 },
    { id: "3", invoiceId: "mhz-2026", amount: 300 },
  ]);
  const got = amendmentsForInvoiceIds(byInvoiceId, ["eng-2026", "eng-2027", "mhz-2026"]);
  assert.deepEqual(got.map(a => a.id), ["1", "2", "3"]);
  assert.equal(amendmentsTotal(got), 600);
});

test("amendmentsForInvoiceIds de-dupes when group and linked ids overlap", () => {
  const { byInvoiceId } = groupAmendments([{ id: "1", invoiceId: "i1", amount: 100 }]);
  const got = amendmentsForInvoiceIds(byInvoiceId, ["i1", "i1", "i1"]);
  assert.equal(got.length, 1);
  assert.equal(amendmentsTotal(got), 100);
});

test("amendmentsForInvoiceIds is empty for ids with nothing on them", () => {
  const { byInvoiceId } = groupAmendments([]);
  assert.deepEqual(amendmentsForInvoiceIds(byInvoiceId, ["nope"]), []);
  assert.deepEqual(amendmentsForInvoiceIds(byInvoiceId, null), []);
});

test("amendmentsForSub scopes to one sub line only", () => {
  const { bySubKey } = groupAmendments([
    { id: "1", projectId: "p1", companyId: "c1", kind: "sub", amount: 100 },
    { id: "2", projectId: "p1", companyId: "c2", kind: "sub", amount: 900 },
  ]);
  assert.equal(amendmentsTotal(amendmentsForSub(bySubKey, "p1", "c1")), 100);
  assert.equal(amendmentsTotal(amendmentsForSub(bySubKey, "p1", "c2")), 900);
  assert.equal(amendmentsTotal(amendmentsForSub(bySubKey, "p1", "c3")), 0);
});

// --- which sub lines may be amended ----------------------------------------

test("subIsAmendable rejects the two synthetic perspective lines", () => {
  assert.equal(subIsAmendable({ companyId: "c1" }), true);
  assert.equal(subIsAmendable({ companyId: "c1", syntheticPerspective: true }), false);
  assert.equal(subIsAmendable({ companyId: "c1", syntheticMhzPrime: true }), false);
  assert.equal(subIsAmendable({}), false);
  assert.equal(subIsAmendable(null), false);
});

// --- the property that matters: the column and the math agree ---------------

test("a project amendment raises MSMM's derived portion by exactly its amount", () => {
  // MSMM is derived as Total − Σ subs. Amending the project total (and no sub)
  // must flow straight into MSMM, or the expand stops reconciling.
  const subs = [{ base: 30000, ams: [] }, { base: 20000, ams: [] }];
  const msmm = (projBase, projAms) =>
    contractValue(projBase, projAms) -
    subs.reduce((a, s) => a + contractValue(s.base, s.ams), 0);

  assert.equal(msmm(100000, []), 50000);
  assert.equal(msmm(100000, [{ amount: 15000 }]), 65000);
});

test("a sub amendment lowers MSMM's derived portion by exactly its amount", () => {
  const projBase = 100000;
  const msmm = (subs) =>
    contractValue(projBase, []) -
    subs.reduce((a, s) => a + contractValue(s.base, s.ams), 0);

  assert.equal(msmm([{ base: 30000, ams: [] }]), 70000);
  assert.equal(msmm([{ base: 30000, ams: [{ amount: 5000 }] }]), 65000);
});

test("amending a sub leaves every other sub's contract value untouched", () => {
  const a = { base: 30000, ams: [{ amount: 5000 }] };
  const b = { base: 20000, ams: [] };
  assert.equal(contractValue(a.base, a.ams), 35000);
  assert.equal(contractValue(b.base, b.ams), 20000);
});
