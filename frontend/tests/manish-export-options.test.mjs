import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManishExportData,
  buildManishYearSheets,
  manishAvailableYears,
  manishMonthDescsBetween,
} from "../src/utils/manish-xlsx.js";

const rows = [
  {
    role: "Prime",
    sourceId: "p1",
    projectNumber: "202401",
    name: "Pump Station",
    byYear: {
      2020: {
        values: [1000, 2000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        msmmValues: [700, null, null, null, null, null, null, null, null, null, null, null],
        invoiceNumbers: ["INV-20-JAN"],
        primePaid: [true],
        primeFiles: [[{ id: "f1" }]],
      },
      2022: {
        values: [0, 0, 3300, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        msmmValues: [],
        invoiceNumbers: [],
        primePaid: [],
        primeFiles: [],
      },
      2025: {
        values: [0, 0, 0, 0, 5500, 0, 0, 0, 0, 0, 0, 0],
        msmmValues: [],
        invoiceNumbers: [],
        primePaid: [],
        primeFiles: [],
      },
    },
  },
  {
    // Sub-role + no subs recorded — used to be silently dropped by the old
    // "Prime role + ≥1 sub" filter; the export now includes EVERY project of
    // the selected type(s) (2026-07).
    role: "Sub",
    sourceId: "p2",
    projectNumber: "202402",
    name: "Sub Role Project",
    byYear: { 2027: { values: [] } },
  },
];

const subInvoices = new Map([
  ["p1", [
    {
      kind: "sub",
      companyName: "Delta Survey",
      byYear: {
        2020: { amounts: [300], paid: [false], files: [[]] },
        2022: { amounts: [0, 0, 800], paid: [false, false, true], files: [[], [], [{ id: "sf" }]] },
        2025: { amounts: [0, 0, 0, 0, 1500], paid: [], files: [] },
      },
    },
  ]],
]);

test("manishAvailableYears lists every invoice data year from 2020 upward", () => {
  assert.deepEqual(manishAvailableYears(rows, 2026), [2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027]);
});

test("manishMonthDescsBetween builds an inclusive month range", () => {
  assert.deepEqual(
    manishMonthDescsBetween(2020, 10, 2021, 1).map(d => d.label),
    ["Nov 2020", "Dec 2020", "Jan 2021", "Feb 2021"],
  );
});

test("buildManishYearSheets creates one workbook sheet per selected year", () => {
  const { sheets, includedCount } = buildManishYearSheets({
    years: [2020, 2022, 2025],
    baseRows: rows,
    subInvoices,
  });

  assert.equal(includedCount, 2);
  assert.deepEqual(sheets.map(s => s.name), ["2020", "2022", "2025"]);
  assert.equal(sheets[0].monthTitles[0], "JANUARY 2020");
  assert.equal(sheets[1].monthTitles[2], "MARCH 2022");
  assert.equal(sheets[2].rows[0].months[4].msmmAmount, 4000);
});

test("buildManishExportData keeps current format for arbitrary custom month ranges", () => {
  const descs = manishMonthDescsBetween(2022, 2, 2022, 4);
  const data = buildManishExportData({ baseRows: rows, subInvoices, monthDescs: descs });

  assert.deepEqual(data.monthTitles, ["MARCH 2022", "APRIL 2022", "MAY 2022"]);
  assert.equal(data.includedCount, 2);
  assert.equal(data.rows[0].months[0].msmmAmount, 2500);
  assert.equal(data.rows[0].months[0].subs[0].amount, 800);
});

test("buildManishExportData includes EVERY project of the type — Sub-role and subless rows too", () => {
  const descs = manishMonthDescsBetween(2022, 2, 2022, 2);
  const data = buildManishExportData({ baseRows: rows, subInvoices, monthDescs: descs });

  assert.equal(data.includedCount, 2);
  const subRole = data.rows.find(r => r.projectNumber === "202402");
  assert.ok(subRole, "Sub-role project with no subs must be exported");
  // No subs recorded → empty sub columns; no 2022 data → the month renders
  // empty (MSMM 0) but the project row itself is still present.
  assert.deepEqual(subRole.subNames.filter(Boolean), []);
  assert.equal(subRole.months[0].msmmAmount, 0);
});
