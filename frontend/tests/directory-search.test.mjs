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

test("matches any contact person on the record, not just the primary summary", () => {
  const record = {
    name: "Acme", contact: "Ann Prime", email: "ann@acme.com", phone: "504-555-0100",
    contacts: [
      { name: "Ann Prime", email: "ann@acme.com", phone: "504-555-0100", isPrimary: true },
      { name: "Bob Second", title: "Accounts Payable", email: "bob@acme.com", phone: "(985) 555-0199" },
    ],
  };
  assert.equal(matchesDirectoryQuery(record, "bob"), true);
  assert.equal(matchesDirectoryQuery(record, "accounts payable"), true);
  assert.equal(matchesDirectoryQuery(record, "985 555"), true);
  assert.equal(matchesDirectoryQuery(record, "5550199"), true);
  assert.equal(matchesDirectoryQuery(record, "zed"), false);
});
