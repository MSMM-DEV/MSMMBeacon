import assert from "node:assert/strict";
import test from "node:test";

import { buildInvoiceGridSheets } from "../src/utils/mark-xlsx.js";
import { manishMonthDescsBetween } from "../src/utils/manish-xlsx.js";

const rows = [
  {
    role: "Prime", sourceId: "p1", projectNumber: "202401", name: "Pump Station", type: "ENG",
    amount: 10000, // Total CV — drives the Contract / Total Billed / Total Remaining columns
    byYear: {
      2025: { values: [1000, 500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], msmmValues: [], primePaid: [true], primeFiles: [] },
      // Mar 2026 has a prime attachment → counts as billed (≥ actualsMinYear).
      2026: { values: [0, 0, 3000, 0, 0, 0, 0, 0, 0, 0, 0, 0], msmmValues: [], primePaid: [], primeFiles: [[], [], [{ id: "pf" }]] },
    },
  },
  {
    role: "Prime", sourceId: "p2", projectNumber: "202402", name: "No Data Project", type: "ENG",
    byYear: { 2025: { values: Array(12).fill(0) } },
  },
];

const subInvoices = new Map([
  ["p1", [{
    kind: "sub", companyName: "Delta Survey", contractAmount: 5000,
    byYear: {
      2025: { amounts: [300, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], paid: [], files: [] },
      2026: { amounts: [0, 0, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0], paid: [], files: [] },
    },
  }]],
]);

test("grid variant: one sheet per year, project total per month, zero-data projects skipped", () => {
  const { sheets, includedCount } = buildInvoiceGridSheets({
    variant: "grid", baseRows: rows, allRows: rows, subInvoices,
    monthDescs: manishMonthDescsBetween(2025, 0, 2026, 11),
  });
  assert.deepEqual(sheets.map(s => s.name), ["2025", "2026"]);
  const s25 = sheets[0];
  assert.equal(s25.rows.length, 1);                 // p2 (all-zero) is skipped
  assert.equal(s25.rows[0].proj, "202401");
  assert.equal(s25.rows[0].cells[0].value, 1000);   // Jan 2025 project total
  assert.equal(s25.rows[0].cells[1].value, 500);    // Feb 2025
  assert.equal(s25.rows[0].total, 1500);
  assert.equal(includedCount, 1);
});

test("subs variant: total row + sub + MSMM lines reconcile to the project total", () => {
  const { sheets } = buildInvoiceGridSheets({
    variant: "subs", baseRows: rows, allRows: rows, subInvoices,
    monthDescs: manishMonthDescsBetween(2025, 0, 2025, 11),
  });
  const s = sheets[0];
  const proj = s.rows.find(r => r.level === 0);
  const sub = s.rows.find(r => r.name.startsWith("Sub · Delta"));
  const msmm = s.rows.find(r => r.name === "MSMM");
  assert.ok(proj && sub && msmm);
  assert.equal(proj.total, 1500);
  assert.equal(sub.cells[0].value, 300);            // Jan sub
  assert.equal(msmm.cells[0].value, 700);           // Jan MSMM = total 1000 − sub 300
  assert.equal(msmm.cells[1].value, 500);           // Feb MSMM = 500 − 0
  assert.equal(sub.total + msmm.total, proj.total); // constituents reconcile
});

test("msmm variant (Print for Randy): one row per project, MSMM portion per month", () => {
  const { sheets, includedCount } = buildInvoiceGridSheets({
    variant: "msmm", baseRows: rows, allRows: rows, subInvoices,
    monthDescs: manishMonthDescsBetween(2025, 0, 2026, 11),
  });
  assert.deepEqual(sheets.map(s => s.name), ["2025", "2026"]);
  const s25 = sheets[0];
  assert.equal(s25.rows.length, 1);                 // p2 (no data) is skipped
  assert.equal(s25.rows[0].proj, "202401");
  assert.equal(s25.rows[0].cells[0].value, 700);    // Jan MSMM = total 1000 − sub 300
  assert.equal(s25.rows[0].cells[1].value, 500);    // Feb MSMM = 500 − 0
  assert.equal(s25.rows[0].total, 1200);            // Σ MSMM months, not project total
  const s26 = sheets[1];
  assert.equal(s26.rows[0].cells[2].value, 2000);   // Mar 2026 MSMM = 3000 − 1000
  assert.equal(includedCount, 1);
  // Whole-project summary columns (same on every year sheet).
  assert.ok(s25.hasSummary);
  assert.equal(s25.rows[0].contract, 5000);         // MSMM contract = CV 10000 − sub 5000
  assert.equal(s25.rows[0].billed, 2000);           // Mar 2026 attached → MSMM 3000 − 1000
  assert.equal(s25.rows[0].remaining, 3000);
});

test("subs variant carries Contract / Total Billed / Total Remaining per line", () => {
  const { sheets } = buildInvoiceGridSheets({
    variant: "subs", baseRows: rows, allRows: rows, subInvoices,
    monthDescs: manishMonthDescsBetween(2026, 0, 2026, 11),
  });
  const s = sheets[0];
  assert.ok(s.hasSummary);
  const proj = s.rows.find(r => r.level === 0);
  const sub = s.rows.find(r => r.name.startsWith("Sub · Delta"));
  const msmm = s.rows.find(r => r.name === "MSMM");
  // Project scope: rollforward defaults to the full contract, so Total Billed
  // collapses to the attached Actuals (Mar 2026 total = 3000).
  assert.equal(proj.contract, 10000);
  assert.equal(proj.billed, 3000);
  assert.equal(proj.remaining, 7000);
  // Sub scope: no attachments on the sub's own cells → nothing billed yet.
  assert.equal(sub.contract, 5000);
  assert.equal(sub.billed, 0);
  assert.equal(sub.remaining, 5000);
  // MSMM scope: Mar 2026 prime attachment → MSMM portion 2000 billed.
  assert.equal(msmm.contract, 5000);
  assert.equal(msmm.billed, 2000);
  assert.equal(msmm.remaining, 3000);
});

test("plain Mark grid variant is unchanged — no summary columns", () => {
  const { sheets } = buildInvoiceGridSheets({
    variant: "grid", baseRows: rows, allRows: rows, subInvoices,
    monthDescs: manishMonthDescsBetween(2025, 0, 2025, 11),
  });
  assert.equal(sheets[0].hasSummary, false);
  assert.equal(sheets[0].rows[0].contract, undefined);
});

test("custom range shows only the in-scope months for the year", () => {
  const { sheets } = buildInvoiceGridSheets({
    variant: "grid", baseRows: rows, allRows: rows, subInvoices,
    monthDescs: manishMonthDescsBetween(2026, 2, 2026, 3), // Mar–Apr 2026
  });
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].name, "2026");
  assert.deepEqual(sheets[0].monthCols.map(m => m.label), ["Mar 2026", "Apr 2026"]);
  assert.equal(sheets[0].rows[0].cells[0].value, 3000); // Mar 2026 total
});

test("subs variant on an MHZ row uses the linked ENG MSMM value + prime remainder", () => {
  const eng = {
    id: "eng-2024", sourceId: "px", projectNumber: "017", name: "Wulfert", type: "ENG", role: "Sub",
    byYear: { 2024: { values: Array(12).fill(0), msmmValues: [null, null, -29457.90, ...Array(9).fill(null)] } },
  };
  const mhz = {
    id: "mhz-2024", sourceId: "px", projectNumber: "017", mhzProjectNumber: "017", name: "Wulfert", type: "MHZ", role: "Prime",
    byYear: { 2024: { values: [0, 0, 67655.52, ...Array(9).fill(0)] } },
  };
  const subs = new Map([["px", [{
    kind: "sub", companyName: "Tetra Tech",
    byYear: { 2024: { amounts: [0, 0, 48556.71, ...Array(9).fill(0)] } },
  }]]]);
  const { sheets } = buildInvoiceGridSheets({
    variant: "subs", baseRows: [mhz], allRows: [eng, mhz], subInvoices: subs,
    monthDescs: [{ year: 2024, monthIdx: 2 }],
  });
  const s = sheets[0];
  const msmm = s.rows.find(r => r.name === "MSMM");
  assert.equal(msmm.cells[0].value, -29457.90);     // independent ENG-stored MSMM sub value
  const rem = s.rows.find(r => r.name === "MHZ (prime)");
  // remainder = total 67655.52 − sub 48556.71 − MSMM(−29457.90) = 48556.71
  assert.ok(Math.abs(rem.cells[0].value - 48556.71) < 0.01);
});
