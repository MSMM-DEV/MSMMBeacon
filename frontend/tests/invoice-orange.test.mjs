import assert from "node:assert/strict";
import test from "node:test";

import {
  invoiceIsOrange,
  nextInvoiceOrangePatch,
} from "../src/invoice-orange.js";

test("invoiceIsOrange uses explicit invoice flag before legacy orange source ids", () => {
  const orangeSourceIds = new Set(["legacy-orange"]);

  assert.equal(invoiceIsOrange({ sourceId: "legacy-orange", invoiceOrange: false }, orangeSourceIds), false);
  assert.equal(invoiceIsOrange({ sourceId: "normal", invoiceOrange: true }, orangeSourceIds), true);
  assert.equal(invoiceIsOrange({ sourceId: "legacy-orange", invoiceOrange: null }, orangeSourceIds), true);
  assert.equal(invoiceIsOrange({ sourceId: "normal" }, orangeSourceIds), false);
});

test("nextInvoiceOrangePatch toggles the visible row tone", () => {
  const orangeSourceIds = new Set(["legacy-orange"]);

  assert.deepEqual(nextInvoiceOrangePatch({ sourceId: "legacy-orange", invoiceOrange: null }, orangeSourceIds), {
    invoiceOrange: false,
  });
  assert.deepEqual(nextInvoiceOrangePatch({ sourceId: "normal", invoiceOrange: false }, orangeSourceIds), {
    invoiceOrange: true,
  });
});
