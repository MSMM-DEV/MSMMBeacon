import assert from "node:assert/strict";
import test from "node:test";
import { adaptDirectoryCompany, companyPickerOptions } from "../src/lib/company-directory.js";

test("one company exposes client attributes and ordered contacts without becoming a category", () => {
  const row = { id: "c1", name: "Port Authority", district: "East", org_type: "Regional", website: "https://port.test" };
  const contacts = [{ id: "p2", name: "Second", ord: 2 }, { id: "p1", name: "Primary", ord: 1, is_primary: true }];
  const got = adaptDirectoryCompany(row, contacts, ["Client", "Prime"]);
  assert.equal(got.type, undefined);
  assert.deepEqual(got.relationshipRoles, ["Client", "Prime"]);
  assert.equal(got.contacts[0].name, "Primary");
  assert.equal(got.orgType, "Regional");
  assert.equal(got.website, "https://port.test");
});

test("all company picker options use the canonical UUID directly", () => {
  assert.deepEqual(companyPickerOptions([{ id: "c1", name: "Acme" }]), [{ value: "c1", label: "Acme" }]);
});
