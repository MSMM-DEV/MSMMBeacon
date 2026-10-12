import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeEmail,
  normalizePhone,
  normalizeCompanyName,
  matchBusinessCards,
  buildImportPayload,
} from "../src/lib/business-card-matching.js";

test("normalizers compare email, phone and company punctuation safely", () => {
  assert.equal(normalizeEmail(" Jane@EXAMPLE.com "), "jane@example.com");
  assert.equal(normalizePhone("+1 (504) 555-0100"), "5045550100");
  assert.equal(normalizeCompanyName("Acme, Inc."), "acme");
});

test("exact email matches an existing contact and produces reviewer-owned diffs", () => {
  const companies = [{
    id: "co1", name: "Acme", updatedAt: "v1",
    contacts: [{ id: "ct1", companyId: "co1", name: "Jane Doe", email: "jane@acme.com", title: "PM", updatedAt: "v2" }],
  }];
  const [item] = matchBusinessCards({
    candidates: [{ sourceId: "img1", cardIndex: 0, personName: "Jane Doe", email: "JANE@acme.com", title: "Principal", companyName: "Acme" }],
    companies,
  });
  assert.equal(item.status, "update_existing");
  assert.equal(item.contactMatch.id, "ct1");
  assert.deepEqual(item.contactDiffs.title, { existing: "PM", card: "Principal", decision: "keep" });
  assert.equal(item.include, false);
});

test("an exact unchanged card is already current", () => {
  const companies = [{ id: "co1", name: "Acme", contacts: [{ id: "ct1", companyId: "co1", name: "Jane Doe", email: "jane@acme.com", title: "PM" }] }];
  const [item] = matchBusinessCards({ candidates: [{ sourceId: "i", cardIndex: 0, personName: "Jane Doe", email: "jane@acme.com", title: "PM", companyName: "Acme" }], companies });
  assert.equal(item.status, "already_current");
  assert.deepEqual(item.contactDiffs, {});
});

test("an exact company creates a new contact while an ambiguous signal needs attention", () => {
  const companies = [
    { id: "co1", name: "Acme", website: "https://acme.com", contacts: [{ id: "a", companyId: "co1", name: "Ann", email: "ann@acme.com", phone: "5045550001" }] },
    { id: "co2", name: "Beta", contacts: [{ id: "b", companyId: "co2", name: "Bob", email: "bob@beta.com", phone: "5045550002" }] },
  ];
  const [fresh, conflict] = matchBusinessCards({ candidates: [
    { sourceId: "i", cardIndex: 0, personName: "New Person", email: "new@acme.com", companyName: "Acme" },
    { sourceId: "i", cardIndex: 1, personName: "Mystery", email: "ann@acme.com", phone: "5045550002", companyName: "" },
  ], companies });
  assert.equal(fresh.status, "new_contact");
  assert.equal(fresh.companyMatch.id, "co1");
  assert.equal(fresh.contactMode, "new");
  assert.equal(conflict.status, "needs_attention");
  assert.match(conflict.reasons.join(" "), /different contacts/i);
});

test("same-batch exact duplicates coalesce but conflicting cards stay reviewable", () => {
  const items = matchBusinessCards({ candidates: [
    { sourceId: "i1", cardIndex: 0, personName: "Jane Doe", email: "jane@new.test", companyName: "New Co" },
    { sourceId: "i2", cardIndex: 0, personName: "Jane Doe", email: "JANE@new.test", companyName: "New Co" },
    { sourceId: "i3", cardIndex: 0, personName: "Janet Different", email: "jane@new.test", companyName: "Other Co" },
  ], companies: [] });
  assert.equal(items[1].status, "possible_duplicate");
  assert.equal(items[1].duplicateOf, items[0].id);
  assert.equal(items[2].status, "needs_attention");
  assert.equal(items[2].duplicateOf, null);
  assert.match(items[2].reasons.join(" "), /conflicts with another card/i);
});

test("name-only fuzzy suggestions never authorize an update", () => {
  const companies = [{ id: "co1", name: "Acme Engineering", contacts: [] }];
  const [item] = matchBusinessCards({ candidates: [{ sourceId: "i", cardIndex: 0, personName: "Jane", companyName: "Acme Enginering" }], companies });
  assert.equal(item.status, "needs_attention");
  assert.equal(item.companyMatch.id, "co1");
  assert.equal(item.companyMode, "unresolved");
});

test("payload contains only reviewed creates and selected field updates", () => {
  const companies = [{
    id: "co1", name: "Acme", updatedAt: "company-v1",
    contacts: [{ id: "ct1", companyId: "co1", name: "Jane Doe", title: "PM", email: "jane@acme.com", updatedAt: "contact-v1" }],
  }];
  const [update] = matchBusinessCards({ candidates: [{ sourceId: "i1", cardIndex: 0, personName: "Jane Doe", title: "Principal", email: "jane@acme.com", companyName: "Acme", companyAddress: "New address" }], companies });
  update.include = true;
  update.reviewed = true;
  update.contactDiffs.title.decision = "use_card";
  // Address remains keep; it must not appear in the company patch.

  const [created] = matchBusinessCards({ candidates: [{ sourceId: "i2", cardIndex: 0, personName: "Alex New", email: "alex@newco.test", companyName: "New Co", companyWebsite: "newco.test" }], companies: [] });
  created.include = true;
  created.reviewed = true;

  const skipped = { ...created, id: "skip", include: false, reviewed: true };
  const payload = buildImportPayload([update, created, skipped]);
  assert.deepEqual(payload.companies, [{
    tempId: created.companyTempId,
    action: "create",
    patch: { name: "New Co", website: "newco.test" },
  }]);
  assert.deepEqual(payload.contacts[0], {
    action: "update", contactId: "ct1", companyId: "co1",
    expectedUpdatedAt: "contact-v1", patch: { title: "Principal" },
  });
  assert.deepEqual(payload.contacts[1], {
    action: "create", companyTempId: created.companyTempId,
    patch: { name: "Alex New", email: "alex@newco.test" },
  });
  assert.equal(payload.skipped, 1);
});

test("new contacts require both person and company names", () => {
  const [item] = matchBusinessCards({ candidates: [{ sourceId: "i", cardIndex: 0, personName: "", companyName: "Acme" }], companies: [] });
  item.include = true;
  item.reviewed = true;
  assert.throws(() => buildImportPayload([item]), /person name/i);
});
