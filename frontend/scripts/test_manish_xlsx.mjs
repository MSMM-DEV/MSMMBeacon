import assert from "node:assert/strict";
import { buildManishExportData } from "../src/utils/manish-xlsx.js";

const sourceId = "project-017";
const eng = {
  id: "eng-2024",
  sourceId,
  projectNumber: "017",
  name: "NPS_FWS-WulfertBayou",
  type: "ENG",
  role: "Sub",
  byYear: {
    2024: {
      id: "eng-2024",
      values: Array(12).fill(0),
      msmmValues: [null, null, -29457.90, ...Array(9).fill(null)],
    },
  },
};
const mhz = {
  id: "mhz-2024",
  sourceId,
  projectNumber: "017",
  mhzProjectNumber: "017",
  name: "NPS_FWS-WulfertBayou",
  type: "MHZ",
  role: "Prime",
  byYear: {
    2024: {
      id: "mhz-2024",
      values: [0, 0, 67655.52, ...Array(9).fill(0)],
      msmmValues: Array(12).fill(null),
    },
  },
};
const subInvoices = new Map([[sourceId, [{
  kind: "sub",
  companyName: "Tetra Tech",
  byYear: { 2024: { amounts: [0, 0, 48556.71, ...Array(9).fill(0)] } },
}]]]);

const data = buildManishExportData({
  baseRows: [mhz],
  allRows: [eng, mhz],
  subInvoices,
  monthDescs: [{ year: 2024, monthIdx: 2, label: "Mar 2024" }],
});

assert.equal(data.rows.length, 1);
assert.equal(data.rows[0].months[0].msmmAmount, -29457.90,
  "MHZ export must use the independent ENG-stored MSMM sub value");

console.log("Manish export MSMM tests passed");
