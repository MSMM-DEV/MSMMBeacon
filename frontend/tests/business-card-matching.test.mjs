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
  items[0].include = true;
  items[0].reviewed = true;
  items[1].include = true;
  items[1].reviewed = true;
  assert.throws(() => buildImportPayload(items), /only one copy/i);
});

test("same-batch duplicate detection checks phone even when both cards have email", () => {
  const items = matchBusinessCards({ candidates: [
    { sourceId: "i1", cardIndex: 0, personName: "Jane Doe", email: "jane@new.test", phone: "504-555-0100", companyName: "New Co" },
    { sourceId: "i2", cardIndex: 0, personName: "Janet Different", email: "janet@other.test", phone: "(504) 555-0100", companyName: "Other Co" },
  ], companies: [] });
  assert.equal(items[1].status, "needs_attention");
  assert.match(items[1].reasons.join(" "), /same email or phone/i);
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

test("multiple reviewed cards merge non-conflicting updates for one company", () => {
  const company = { id: "co1", name: "Acme", address: "Old", website: "old.test", updatedAt: "company-v1", contacts: [] };
  const items = matchBusinessCards({ candidates: [
    { sourceId: "i1", cardIndex: 0, personName: "Jane", companyName: "Acme", companyAddress: "New address" },
    { sourceId: "i2", cardIndex: 0, personName: "Alex", companyName: "Acme", companyWebsite: "new.test" },
  ], companies: [company] });
  for (const item of items) {
    item.include = true;
    item.reviewed = true;
    for (const diff of Object.values(item.companyDiffs)) diff.decision = "use_card";
  }

  const payload = buildImportPayload(items);
  assert.deepEqual(payload.companies, [{
    action: "update",
    companyId: "co1",
    expectedUpdatedAt: "company-v1",
    patch: { address: "New address", website: "new.test" },
  }]);
  assert.equal(payload.contacts.length, 2);
});

test("multiple people at one new company share one pending company create", () => {
  const items = matchBusinessCards({ candidates: [
    { sourceId: "i1", cardIndex: 0, personName: "Jane", email: "jane@new.test", companyName: "New Co", companyWebsite: "new.test" },
    { sourceId: "i2", cardIndex: 0, personName: "Alex", email: "alex@new.test", companyName: "New Co", companyAddress: "10 Main St" },
  ], companies: [] });
  assert.equal(items[0].companyTempId, items[1].companyTempId);
  for (const item of items) {
    item.include = true;
    item.reviewed = true;
  }

  const payload = buildImportPayload(items);
  assert.equal(payload.companies.length, 1);
  assert.deepEqual(payload.companies[0].patch, {
    name: "New Co",
    website: "new.test",
    address: "10 Main St",
  });
  assert.equal(payload.contacts.length, 2);
  assert.ok(payload.contacts.every(contact => contact.companyTempId === payload.companies[0].tempId));
});

test("a reviewed batch rejects two primary contacts for the same company", () => {
  const items = matchBusinessCards({ candidates: [
    { sourceId: "i1", cardIndex: 0, personName: "Jane", companyName: "New Co" },
    { sourceId: "i2", cardIndex: 0, personName: "Alex", companyName: "New Co" },
  ], companies: [] });
  for (const item of items) {
    item.include = true;
    item.reviewed = true;
    item.isPrimary = true;
  }
  assert.throws(() => buildImportPayload(items), /only one primary contact/i);
});
