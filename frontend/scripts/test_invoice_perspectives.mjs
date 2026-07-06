import assert from "node:assert/strict";

import {
  HZ_INVOICE_TYPES,
  INVOICE_TYPE_OPTIONS,
  invoicePerspectiveRole,
  invoicePerspectiveRoleIsDerived,
  invoiceTypeTone,
  linkedInvoiceIdsFor,
  linkedInvoicePatch,
  projectNameSuggestsMhz,
} from "../src/invoice-perspectives.js";

assert.deepEqual(INVOICE_TYPE_OPTIONS, ["ENG", "PM", "MHZ"]);
assert.deepEqual(HZ_INVOICE_TYPES, ["ENG", "MHZ"]);

assert.equal(projectNameSuggestsMhz("MSMM / MHZ drainage"), true);
assert.equal(projectNameSuggestsMhz("HZ joint venture"), true);
assert.equal(projectNameSuggestsMhz("Hazard mitigation"), false);
assert.equal(projectNameSuggestsMhz("Prime services"), false);

assert.equal(invoiceTypeTone("ENG"), "sage");
assert.equal(invoiceTypeTone("PM"), "blue");
assert.equal(invoiceTypeTone("MHZ"), "amber");
assert.equal(invoiceTypeTone("OTHER"), "muted");

assert.deepEqual(
  linkedInvoicePatch({
    name: "Updated",
    type: "MHZ",
    projectNumber: "202514",
    billingState: "active",
    pmIds: ["u1"],
    role: "Sub",
  }),
  {
    name: "Updated",
    projectNumber: "202514",
    billingState: "active",
    pmIds: ["u1"],
  }
);

const rows = [
  { id: "eng-2026", sourceId: "p1", projectNumber: "202514", type: "ENG" },
  { id: "mhz-2026", sourceId: "p1", projectNumber: "202514", type: "MHZ" },
  { id: "pm-2026", sourceId: "p1", projectNumber: "202514", type: "PM" },
  { id: "eng-other", sourceId: "p2", projectNumber: "202419", type: "ENG" },
  { id: "mhz-number-only", sourceId: null, projectNumber: "202514", type: "MHZ" },
];

assert.deepEqual(
  linkedInvoiceIdsFor(rows[0], rows).sort(),
  ["eng-2026", "mhz-2026", "mhz-number-only"].sort()
);
assert.deepEqual(linkedInvoiceIdsFor(rows[2], rows), ["pm-2026"]);

assert.equal(invoicePerspectiveRole({ ...rows[0], role: "Sub" }, rows), "Sub");
assert.equal(invoicePerspectiveRole({ ...rows[1], role: "Sub" }, rows), "Prime");
assert.equal(invoicePerspectiveRole({ id: "plain-eng", type: "ENG", role: "Prime" }, rows), "Prime");
assert.equal(invoicePerspectiveRoleIsDerived(rows[0], rows), true);
assert.equal(invoicePerspectiveRoleIsDerived(rows[1], rows), true);
assert.equal(invoicePerspectiveRoleIsDerived(rows[2], rows), false);

console.log("invoice perspective helper tests passed");
