import assert from "node:assert/strict";

import {
  HZ_INVOICE_TYPES,
  INVOICE_TYPE_OPTIONS,
  invoicePerspectiveRole,
  invoicePerspectiveRoleIsDerived,
  invoiceTypeTone,
  isMhzPerspectiveSub,
  linkedInvoiceIdsFor,
  linkedInvoicePatch,
  perspectiveSubListBase,
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

// isMhzPerspectiveSub — true ONLY for an ENG row that has a linked MHZ sibling
// (MSMM is a sub because MHZ is the prime). False for the MHZ row itself, for
// PM, and for a genuine external-prime Sub (an ENG row with role='Sub' but no
// MHZ sibling — it must keep showing its real subs).
assert.equal(isMhzPerspectiveSub(rows[0], rows), true);                                  // eng-2026 (has MHZ sibling)
assert.equal(isMhzPerspectiveSub(rows[1], rows), false);                                 // mhz-2026 (type MHZ)
assert.equal(isMhzPerspectiveSub(rows[2], rows), false);                                 // pm-2026 (type PM)
assert.equal(isMhzPerspectiveSub(rows[3], rows), false);                                 // eng-other (no MHZ sibling)
assert.equal(isMhzPerspectiveSub({ id: "ext-sub", type: "ENG", role: "Sub" }, rows), false); // external-prime Sub, no MHZ sibling

// perspectiveSubListBase — the base entry list before withPerspectiveRows injects
// the synthetic line. A=B=C are stand-ins for real sub entries; P is a prime entry.
const A = { kind: "sub", companyName: "A" };
const B = { kind: "sub", companyName: "B" };
const P = { kind: "prime", companyName: "SomePrime" };
// Prime row (incl. the MHZ row): its own subs only.
assert.deepEqual(perspectiveSubListBase({ isPrimeRow: true, mhzPerspectiveSub: false, primeEntry: undefined, subEntries: [A, B] }), [A, B]);
// MHZ-perspective Sub (ENG view of an MHZ-prime project): EMPTY — the sibling
// subs are hidden and withPerspectiveRows injects exactly one MHZ prime line.
assert.deepEqual(perspectiveSubListBase({ isPrimeRow: false, mhzPerspectiveSub: true, primeEntry: P, subEntries: [A, B] }), []);
// Genuine external-prime Sub: upstream prime + its subs (unchanged behavior).
assert.deepEqual(perspectiveSubListBase({ isPrimeRow: false, mhzPerspectiveSub: false, primeEntry: P, subEntries: [A, B] }), [P, A, B]);
assert.deepEqual(perspectiveSubListBase({ isPrimeRow: false, mhzPerspectiveSub: false, primeEntry: undefined, subEntries: [A] }), [A]);

console.log("invoice perspective helper tests passed");
