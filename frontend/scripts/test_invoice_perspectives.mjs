import assert from "node:assert/strict";

import {
  HZ_INVOICE_TYPES,
  INVOICE_TYPE_OPTIONS,
  invoicePerspectiveRole,
  invoicePerspectiveRoleIsDerived,
  invoiceTypeTone,
  isMhzPerspectiveSub,
  isHzPrimeType,
  isBaseInvoiceType,
  pairSiblingOf,
  hzTypeForBase,
  baseTypeForHz,
  linkedInvoiceIdsFor,
  linkedInvoicePatch,
  invoiceRemainderValue,
  basePerspectiveOwnValue,
  basePerspectiveStoredTotal,
  rebaseStoredTotalForSubChange,
  perspectiveSubListBase,
  projectNameSuggestsMhz,
} from "../src/invoice-perspectives.js";

assert.deepEqual(INVOICE_TYPE_OPTIONS, ["ENG", "PM", "MHZ", "MHZ PM"]);
assert.deepEqual(HZ_INVOICE_TYPES, ["ENG", "MHZ", "PM", "MHZ PM"]);

// Pair helpers — ENG↔MHZ and PM↔MHZ PM, isolated.
assert.equal(pairSiblingOf("ENG"), "MHZ");
assert.equal(pairSiblingOf("MHZ"), "ENG");
assert.equal(pairSiblingOf("PM"), "MHZ PM");
assert.equal(pairSiblingOf("MHZ PM"), "PM");
assert.equal(pairSiblingOf("OTHER"), null);
assert.equal(hzTypeForBase("ENG"), "MHZ");
assert.equal(hzTypeForBase("PM"), "MHZ PM");
assert.equal(baseTypeForHz("MHZ"), "ENG");
assert.equal(baseTypeForHz("MHZ PM"), "PM");
assert.equal(isBaseInvoiceType("ENG"), true);
assert.equal(isBaseInvoiceType("PM"), true);
assert.equal(isBaseInvoiceType("MHZ"), false);
assert.equal(isBaseInvoiceType("MHZ PM"), false);
assert.equal(isHzPrimeType("MHZ"), true);
assert.equal(isHzPrimeType("MHZ PM"), true);
assert.equal(isHzPrimeType("ENG"), false);
assert.equal(isHzPrimeType("PM"), false);

assert.equal(projectNameSuggestsMhz("MSMM / MHZ drainage"), true);
assert.equal(projectNameSuggestsMhz("HZ joint venture"), true);
// "MHZ" glued to other letters (real data: MHZ joint venture → "MHZJV").
assert.equal(projectNameSuggestsMhz("USACE_MVN-SWF-MHZJV-PM_Support_Services"), true);
assert.equal(projectNameSuggestsMhz("USACE_MVM-MHZJV-PMO"), true);
assert.equal(projectNameSuggestsMhz("Hazard mitigation"), false);
assert.equal(projectNameSuggestsMhz("Prime services"), false);

assert.equal(invoiceTypeTone("ENG"), "sage");
assert.equal(invoiceTypeTone("PM"), "blue");
assert.equal(invoiceTypeTone("MHZ"), "amber");
assert.equal(invoiceTypeTone("MHZ PM"), "rose");
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
  { id: "eng-2026",   sourceId: "p1", projectNumber: "202514", type: "ENG" },
  { id: "mhz-2026",   sourceId: "p1", projectNumber: "202514", type: "MHZ" },
  { id: "pm-2026",    sourceId: "p1", projectNumber: "202514", type: "PM" },
  { id: "mhzpm-2026", sourceId: "p1", projectNumber: "202514", type: "MHZ PM" },
  { id: "eng-other",  sourceId: "p2", projectNumber: "202419", type: "ENG" },
  { id: "mhz-number-only", sourceId: null, projectNumber: "202514", type: "MHZ" },
];

// Linkage is scoped to the pair: ENG↔MHZ never bleeds into PM/MHZ PM even though
// all four rows share source p1 + number 202514.
assert.deepEqual(
  linkedInvoiceIdsFor(rows[0], rows).sort(),
  ["eng-2026", "mhz-2026", "mhz-number-only"].sort()
);
assert.deepEqual(
  linkedInvoiceIdsFor(rows[2], rows).sort(),
  ["pm-2026", "mhzpm-2026"].sort()
);
assert.deepEqual(
  linkedInvoiceIdsFor(rows[3], rows).sort(),
  ["pm-2026", "mhzpm-2026"].sort()
);

// Roles: hz rows are Prime; a base row with an hz sibling is a derived Sub.
assert.equal(invoicePerspectiveRole({ ...rows[0], role: "Sub" }, rows), "Sub");   // ENG (has MHZ)
assert.equal(invoicePerspectiveRole({ ...rows[1], role: "Sub" }, rows), "Prime"); // MHZ
assert.equal(invoicePerspectiveRole({ ...rows[2], role: "Sub" }, rows), "Sub");   // PM (has MHZ PM)
assert.equal(invoicePerspectiveRole({ ...rows[3], role: "Sub" }, rows), "Prime"); // MHZ PM
assert.equal(invoicePerspectiveRole({ id: "plain-eng", type: "ENG", role: "Prime" }, rows), "Prime");
assert.equal(invoicePerspectiveRole({ id: "plain-pm", type: "PM", role: "Prime" }, rows), "Prime");

assert.equal(invoicePerspectiveRoleIsDerived(rows[0], rows), true);  // ENG (has MHZ)
assert.equal(invoicePerspectiveRoleIsDerived(rows[1], rows), true);  // MHZ
assert.equal(invoicePerspectiveRoleIsDerived(rows[2], rows), true);  // PM (has MHZ PM)
assert.equal(invoicePerspectiveRoleIsDerived(rows[3], rows), true);  // MHZ PM
// A PM row WITHOUT an MHZ PM sibling is a normal MSMM-prime PM row — not derived.
assert.equal(invoicePerspectiveRoleIsDerived({ id: "pm-solo", sourceId: "p9", projectNumber: "99", type: "PM" }, rows), false);

// isMhzPerspectiveSub — true for a BASE row (ENG or PM) that has a linked hz
// sibling. False for the hz row itself and for a base row with no hz sibling.
assert.equal(isMhzPerspectiveSub(rows[0], rows), true);   // eng-2026 (has MHZ sibling)
assert.equal(isMhzPerspectiveSub(rows[1], rows), false);  // mhz-2026 (hz row)
assert.equal(isMhzPerspectiveSub(rows[2], rows), true);   // pm-2026 (has MHZ PM sibling)
assert.equal(isMhzPerspectiveSub(rows[3], rows), false);  // mhzpm-2026 (hz row)
assert.equal(isMhzPerspectiveSub(rows[4], rows), false);  // eng-other (no MHZ sibling)
assert.equal(isMhzPerspectiveSub({ id: "ext-sub", type: "ENG", role: "Sub" }, rows), false); // external-prime Sub, no hz sibling

// perspectiveSubListBase — the base entry list before withPerspectiveRows injects
// the synthetic line. A=B=C are stand-ins for real sub entries; P is a prime entry.
const A = { kind: "sub", companyName: "A" };
const B = { kind: "sub", companyName: "B" };
const P = { kind: "prime", companyName: "SomePrime" };
// Prime row (incl. the hz row): its own subs only.
assert.deepEqual(perspectiveSubListBase({ isPrimeRow: true, mhzPerspectiveSub: false, primeEntry: undefined, subEntries: [A, B] }), [A, B]);
// MHZ-perspective Sub (base view of an hz-prime project): EMPTY — the sibling
// subs are hidden and withPerspectiveRows injects exactly one hz prime line.
assert.deepEqual(perspectiveSubListBase({ isPrimeRow: false, mhzPerspectiveSub: true, primeEntry: P, subEntries: [A, B] }), []);
// Genuine external-prime Sub: upstream prime + its subs (unchanged behavior).
assert.deepEqual(perspectiveSubListBase({ isPrimeRow: false, mhzPerspectiveSub: false, primeEntry: P, subEntries: [A, B] }), [P, A, B]);
assert.deepEqual(perspectiveSubListBase({ isPrimeRow: false, mhzPerspectiveSub: false, primeEntry: undefined, subEntries: [A] }), [A]);

// MHZ/MHZ PM white-row values are the project total minus EVERY expanded sub,
// including the linked MSMM row. This is the reported project-style example:
// 893,067.34 - (329,453.93 + 250,005 + 80,682.63 + 29,775 + 201,075.39)
// = 2,075.39.
const mhzSubsIncludingMsmm = [329453.93, 250005, 80682.63, 29775, 201075.39];
const assertCurrencyEqual = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 0.000001, `expected ${expected}, received ${actual}`);
assertCurrencyEqual(invoiceRemainderValue(893067.34, mhzSubsIncludingMsmm), 2075.39);

// ENG/PM keeps the existing total-minus-subs storage representation. Editing
// MSMM stores MSMM + subs, while changing another sub rebases that stored total
// by the same delta so the derived MSMM value stays unchanged.
assertCurrencyEqual(basePerspectiveOwnValue(622045.82, [420970.43]), 201075.39);
assertCurrencyEqual(basePerspectiveStoredTotal(225000, [329453.93, 250005]), 804458.93);
assertCurrencyEqual(rebaseStoredTotalForSubChange(622045.82, 80000, 90000), 632045.82);
assertCurrencyEqual(
  basePerspectiveOwnValue(
    rebaseStoredTotalForSubChange(622045.82, 80000, 90000),
    [430970.43]
  ),
  201075.39
);

console.log("invoice perspective helper tests passed");
