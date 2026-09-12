import test from "node:test";
import assert from "node:assert/strict";
import { matchesDirectoryQuery } from "../src/lib/directory-search.js";

const record = { name: "North Engineering", baseName: "North", type: "Client", contact: "Jamie Lake", email: "jamie@example.test", phone: "(312) 555-0198", district: "Central", address: "40 Main Street" };
test("phone-book search finds names, contacts, email, phone and location", () => {
  for (const q of ["north", " JAMIE ", "example.test", "555-0198", "3125550198", "Central", "Main Street"]) assert.equal(matchesDirectoryQuery(record, q), true, q);
});
test("existing relationship and linked-project searches remain available", () => {
  assert.equal(matchesDirectoryQuery(record, "Partner Co", ["Partner Co", "12"]), true);
  assert.equal(matchesDirectoryQuery(record, "12", ["Partner Co", "12"]), true);
  assert.equal(matchesDirectoryQuery(record, "missing"), false);
  assert.equal(matchesDirectoryQuery({}, ""), true);
  assert.equal(matchesDirectoryQuery({}, "Jamie"), false);
});
