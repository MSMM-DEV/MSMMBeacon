# Unified Company Directory and Business-Card Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `beacon_v2.companies` Beacon's only outside-organization master and add an ephemeral, reviewed batch business-card importer to the Directory.

**Architecture:** A transactional SQL cutover maps legacy clients into companies and retargets every client-role foreign key while preserving contextual Client/Prime/Sub labels. The importer uses a browser image pipeline, an authenticated extraction-only Supabase Edge Function, a pure deterministic matcher, a human review workspace, and one atomic database RPC for approved writes.

**Tech Stack:** React 18, Vite 5, JavaScript ES modules, Supabase/PostgreSQL `beacon_v2`, Supabase Edge Functions/Deno, OpenAI Responses API, Node's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-12-company-directory-business-card-import-design.md`

## Global Constraints

- `beacon_v2.companies` is the sole live organization master; Client, Prime, and Sub remain relationship labels only.
- Existing organization, contact, project, lead, bid, and project-item relationships must survive migration.
- A contact belongs to exactly one company and at most one contact per company is primary.
- No card candidate writes before explicit review; no existing field changes without a field-level reviewer choice.
- Card images stay ephemeral and are never written to Storage, database tables, analytics, or logs.
- Accept at most 20 original images per import, 10 MB per original image, and approximately 25 MB per normalized request chunk.
- One photo may contain several cards.
- Keep one primary email and one primary phone per contact in this release.
- Batch save is atomic and uses `updated_at` optimistic concurrency checks.
- Preserve unrelated dirty-worktree changes and commit only task-owned files.

## Review Focus

- Same organization name across different districts: preserve distinct companies unless an explicit mapping exists; Task 1 adds a preflight/migration fixture assertion.
- Conflicting duplicate cards in one batch: keep them reviewable rather than silently coalescing; Task 4 tests this branch.
- A company or contact changed after review: reject the entire save as stale; Task 7 exercises version checks.
- Rotated, oversized, or unsupported phone photos: normalize supported inputs and report per-file failures without losing the batch; Task 5 tests chunking and validation.
- One extraction chunk fails after others succeed: retain successful candidates, make only the failed chunk retryable, and release all object URLs on close; Task 8 tests the reducer and source-level cleanup contract.

---

### Task 1: Canonical-company preflight and transactional schema cutover

**Files:**
- Create: `scripts/preflight_unified_companies.sql`
- Create: `supabase/migrations_v2/20261012120000_unified_companies.sql`
- Create: `frontend/tests/unified-company-migration.test.mjs`

**Interfaces:**
- Consumes: existing `clients`, `companies`, `contacts`, `projects`, `leads`, `open_bids`, and `project_items` tables.
- Produces: company columns `district`, `org_type`, `website`; company-only contacts; all existing `client_id` FKs retargeted to `companies(id)`; no live `prime_client_id`; renamed `clients_legacy_20261012` reference table.

- [ ] **Step 1: Write the failing migration-contract test**

```js
// frontend/tests/unified-company-migration.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../supabase/migrations_v2/20261012120000_unified_companies.sql", import.meta.url), "utf8");
const preflight = readFileSync(new URL("../../scripts/preflight_unified_companies.sql", import.meta.url), "utf8");

test("cutover retargets every client-role table to companies", () => {
  for (const table of ["projects", "leads", "open_bids", "project_items"]) {
    assert.match(sql, new RegExp(`alter table beacon_v2\\.${table}[\\s\\S]+references beacon_v2\\.companies\\(id\\)`, "i"));
  }
  assert.match(sql, /alter table beacon_v2\.contacts[\s\S]+drop column[\s\S]+client_id/i);
  assert.match(sql, /drop column[\s\S]+prime_client_id/i);
});

test("preflight calls out district collisions and conflicting primes", () => {
  assert.match(preflight, /district/i);
  assert.match(preflight, /prime_client_id/i);
  assert.match(preflight, /prime_company_id/i);
});
```

- [ ] **Step 2: Run the contract test and confirm missing-file failure**

Run: `node --test frontend/tests/unified-company-migration.test.mjs`

Expected: FAIL because both SQL files do not exist.

- [ ] **Step 3: Add the read-only preflight report**

Create queries that emit named result sets without mutating data:

```sql
-- scripts/preflight_unified_companies.sql
select 'counts' as report, jsonb_build_object(
  'clients', (select count(*) from beacon_v2.clients),
  'companies', (select count(*) from beacon_v2.companies),
  'client_contacts', (select count(*) from beacon_v2.contacts where client_id is not null),
  'company_contacts', (select count(*) from beacon_v2.contacts where company_id is not null)
) as details;

select 'same_name_different_district' as report,
       lower(regexp_replace(btrim(name), '[^a-z0-9]+', '', 'gi')) as normalized_name,
       jsonb_agg(jsonb_build_object('id', id, 'name', name, 'district', district)) as details
from beacon_v2.clients
group by 2
having count(*) > 1;

select 'conflicting_prime_columns' as report,
       id, prime_client_id, prime_company_id
from beacon_v2.projects
where prime_client_id is not null and prime_company_id is not null;
```

Also report exact normalized matches, likely suffix-stripped matches, UUID collisions, primary-contact convergence, and orphan counts. Suggestions must never execute merges.

- [ ] **Step 4: Implement the idempotent cutover migration**

Use a guarded transaction with these concrete mechanics:

```sql
set search_path = beacon_v2, public, extensions;

alter table beacon_v2.companies add column if not exists district text;
alter table beacon_v2.companies add column if not exists org_type beacon_v2.org_type_enum;
alter table beacon_v2.companies add column if not exists website text;

create table if not exists beacon_v2.company_unification_overrides (
  client_id uuid primary key,
  company_id uuid not null references beacon_v2.companies(id),
  created_at timestamptz not null default now()
);
revoke all on beacon_v2.company_unification_overrides from public, anon, authenticated;
```

Inside a `DO $$` guard that runs only while `beacon_v2.clients` exists:

- build a temporary `(client_id, company_id)` map from explicit overrides, then unambiguous normalized exact matches;
- insert unmatched clients into companies, using `name || ' — ' || district` only when required to preserve two distinct same-name records;
- fill missing company profile fields without replacing non-empty company values;
- drop old client FKs before rewriting IDs;
- rewrite `projects.client_id`, `leads.client_id`, `open_bids.client_id`, `project_items.client_id`, and `contacts.client_id` through the map;
- abort when `prime_client_id` and `prime_company_id` disagree, otherwise move the mapped value to `prime_company_id`;
- clear incoming primary flags where the destination already has a primary;
- replace contact constraints/indexes/functions with company-only equivalents;
- add the four `client_id` foreign keys back against `companies(id)` using their original delete behavior;
- drop `projects.prime_client_id` and contact `client_id`;
- rename `clients` to `clients_legacy_20261012` and revoke writes;
- assert no orphans, no dual primaries, and unchanged relationship/contact counts;
- `notify pgrst, 'reload schema'`.

- [ ] **Step 5: Run migration contract and repository SQL checks**

Run: `node --test frontend/tests/unified-company-migration.test.mjs`

Expected: PASS.

Run: `rg -n "references beacon_v2\.clients" supabase/migrations_v2/20261012120000_unified_companies.sql`

Expected: no matches.

- [ ] **Step 6: Commit the schema checkpoint**

```bash
git add scripts/preflight_unified_companies.sql supabase/migrations_v2/20261012120000_unified_companies.sql frontend/tests/unified-company-migration.test.mjs
git commit -m "Unify clients into canonical companies"
```

### Task 2: Canonical company data layer

**Files:**
- Create: `frontend/src/lib/company-directory.js`
- Create: `frontend/tests/company-directory.test.mjs`
- Modify: `frontend/src/data.js`

**Interfaces:**
- Consumes: company rows with nested or separately loaded `contacts` rows.
- Produces: `adaptDirectoryCompany(row, contacts, relationshipRoles)`, `companyPickerOptions(companies)`, `reloadDirectory()`, company-only `addContact`, and company-only `mergeCompanies`.

- [ ] **Step 1: Write failing company adapter tests**

```js
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
});

test("all company picker options use the canonical UUID directly", () => {
  assert.deepEqual(companyPickerOptions([{ id: "c1", name: "Acme" }]), [{ value: "c1", label: "Acme" }]);
});
```

- [ ] **Step 2: Run the tests and confirm missing-module failure**

Run: `node --test frontend/tests/company-directory.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the pure adapter module**

```js
export function adaptDirectoryCompany(row, contacts = [], relationshipRoles = []) {
  const ordered = [...contacts].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || (a.ord || 0) - (b.ord || 0));
  const primary = ordered[0];
  return {
    id: row.id, name: row.name, district: row.district || "", orgType: row.org_type || "",
    website: row.website || "", address: row.address || "", notes: row.notes || "",
    isMsmm: !!row.is_msmm, relationshipRoles: [...new Set(relationshipRoles)].sort(),
    contacts: ordered, contact: primary?.name || row.contact_person || "",
    email: primary?.email || row.email || "", phone: primary?.phone || row.phone || "",
    updatedAt: row.updated_at || null,
  };
}

export const companyPickerOptions = companies =>
  [...companies].sort((a, b) => a.name.localeCompare(b.name)).map(c => ({ value: c.id, label: c.name }));
```

- [ ] **Step 4: Refactor `data.js` onto one organization collection**

- Remove the `clients` query and `adaptClient` path from `loadBeacon`.
- Group every contact by `company_id` only.
- Derive `relationshipRoles` from client, prime, and sub references already loaded.
- Make `getCompanies()` the only organization getter; delete `getClientsOnly`, `getCompaniesOnly`, `buildClientOrCompanyOptions`, `routeClientPick`, and `routePrimePick` after their callers move in Task 3.
- Change contact CRUD signatures to `{ companyId, ...fields }` and query only `company_id`.
- Add `reloadDirectory()` that loads companies and contacts, adapts them, updates `_companies`, and returns the list.
- Replace dual-kind `mergeDirectoryEntities` with `mergeCompanies(survivorId, loserIds)`.
- Update project/item patch helpers so Client writes `{ client_id: id || null }` and Prime writes `{ prime_company_id: id || null }`.

- [ ] **Step 5: Run focused and existing data-independent tests**

Run: `node --test frontend/tests/company-directory.test.mjs frontend/tests/directory-search.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the data-layer checkpoint**

```bash
git add frontend/src/lib/company-directory.js frontend/src/data.js frontend/tests/company-directory.test.mjs
git commit -m "Use one company directory data model"
```

### Task 3: Remove Client/Company branching from the existing interface

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/forms.jsx`
- Modify: `frontend/src/contacts.jsx`
- Modify: `frontend/src/panels.jsx`
- Modify: `frontend/src/tables.jsx`
- Modify: `frontend/src/project-detail.jsx`
- Modify: `frontend/src/lib/directory-search.js`
- Modify: `frontend/src/design/pages/directory.css`
- Modify: `frontend/tests/directory-search.test.mjs`
- Create: `frontend/tests/unified-directory-surface.test.mjs`

**Interfaces:**
- Consumes: one adapted `companies` array and direct client/prime/sub company IDs.
- Produces: one alphabetical Directory, one New Company flow, company-only contacts and merges, and all contextual project pickers backed by the same options.

- [ ] **Step 1: Write the failing surface contract**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const tables = readFileSync(new URL("../src/tables.jsx", import.meta.url), "utf8");
const contacts = readFileSync(new URL("../src/contacts.jsx", import.meta.url), "utf8");

test("directory surface has one company model", () => {
  assert.doesNotMatch(app, /getClientsOnly|setClients\b|createTable\(\"clients\"\)/);
  assert.doesNotMatch(tables, /selectedKind === "Client"|groupedRows\.clients/);
  assert.doesNotMatch(contacts, /clientId/);
  assert.match(tables, /Import business cards/);
});
```

- [ ] **Step 2: Run the surface test and verify it fails on legacy branches**

Run: `node --test frontend/tests/unified-directory-surface.test.mjs`

Expected: FAIL on the existing Client/Company branching.

- [ ] **Step 3: Refactor application state and all picker writes**

- Replace separate `clients` and `companies` state with `companies` only.
- Replace `[...clients, ...companies]` compositions with `companies`.
- Remove kind-based filters and create routing; the Directory create action opens `table="companies"` and reads "New company".
- Update every Client field to write `client_id` directly and every Prime field to write `prime_company_id` directly.
- Remove fallbacks that fold `prime_company_id` into `clientId`; keep separate client and prime UI properties where both roles exist.
- Keep visible labels such as Client, Client/Prime, Prime, and Subs unchanged where they describe a record relationship.

- [ ] **Step 4: Refactor Directory rendering, contacts, forms, and merges**

- Render one alphabetically sorted company roster without Client/Company group headers or kind-lock merge rules.
- Replace Directory filters with role filters derived from `relationshipRoles` plus organization-type filters.
- Make `ContactsSection` always pass `{ companyId: row.id }`.
- Make create forms insert into `companies` and then insert draft contacts with `company_id`.
- Make the drawer expose district, organization type, website, address, and notes for every company.
- Update linked-project summaries so one company can show Client, Prime, and Sub relationships simultaneously.
- Add an `onImportCards` prop and an **Import business cards** toolbar button; Task 8 supplies the handler.

- [ ] **Step 5: Update search/export assumptions and tests**

Change fixtures from `type: "Client"` to category-free companies and ensure district, org type, website, every contact, and relationship labels remain searchable.

Run: `node --test frontend/tests/directory-search.test.mjs frontend/tests/unified-directory-surface.test.mjs`

Expected: PASS.

- [ ] **Step 6: Build the frontend**

Run: `npm run build`

Working directory: `frontend`

Expected: Vite build succeeds without missing exports or stale Client/Company variables.

- [ ] **Step 7: Commit the unified interface checkpoint**

```bash
git add frontend/src/App.jsx frontend/src/forms.jsx frontend/src/contacts.jsx frontend/src/panels.jsx frontend/src/tables.jsx frontend/src/project-detail.jsx frontend/src/lib/directory-search.js frontend/src/design/pages/directory.css frontend/tests/directory-search.test.mjs frontend/tests/unified-directory-surface.test.mjs
git commit -m "Present one canonical company directory"
```

### Task 4: Deterministic business-card matching and review operations

**Files:**
- Create: `frontend/src/lib/business-card-matching.js`
- Create: `frontend/tests/business-card-matching.test.mjs`

**Interfaces:**
- Consumes: `matchBusinessCards({ candidates, companies })`, where companies contain `contacts`.
- Produces: review items with `status`, `companyMatch`, `contactMatch`, `reasons`, `companyDiffs`, `contactDiffs`, and `duplicateOf`; `buildImportPayload(reviewItems)` for Task 7.

- [ ] **Step 1: Write failing normalization and exact-match tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEmail, normalizePhone, normalizeCompanyName, matchBusinessCards, buildImportPayload } from "../src/lib/business-card-matching.js";

test("normalizers compare email, phone and company punctuation safely", () => {
  assert.equal(normalizeEmail(" Jane@EXAMPLE.com "), "jane@example.com");
  assert.equal(normalizePhone("+1 (504) 555-0100"), "5045550100");
  assert.equal(normalizeCompanyName("Acme, Inc."), "acme");
});

test("exact email matches an existing contact and produces field diffs", () => {
  const companies = [{ id: "co1", name: "Acme", updatedAt: "v1", contacts: [{ id: "ct1", name: "Jane Doe", email: "jane@acme.com", title: "PM", updatedAt: "v2" }] }];
  const [item] = matchBusinessCards({ candidates: [{ sourceId: "img1", cardIndex: 0, personName: "Jane Doe", email: "JANE@acme.com", title: "Principal", companyName: "Acme" }], companies });
  assert.equal(item.status, "update_existing");
  assert.equal(item.contactMatch.id, "ct1");
  assert.deepEqual(item.contactDiffs.title, { existing: "PM", card: "Principal", decision: "keep" });
});
```

- [ ] **Step 2: Add failing duplicate, ambiguity, and payload tests**

Cover exact duplicates, same-batch exact duplicates, conflicting duplicates with the same phone but different names, name-only suggestions that remain `needs_attention`, new company/contact operations, selected field updates, skipped cards, and expected `updated_at` versions.

Run: `node --test frontend/tests/business-card-matching.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement normalization and scored suggestions**

```js
export const normalizeEmail = value => String(value || "").trim().toLowerCase();
export const normalizePhone = value => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
};
export const normalizeCompanyName = value => String(value || "").toLowerCase()
  .replace(/\b(incorporated|inc|llc|ltd|corporation|corp|company|co)\b/g, " ")
  .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
```

Implement deterministic precedence: exact email, exact phone, exact company, domain alignment, same person within company, then fuzzy suggestion only. Keep confidence reasons with every suggestion so the UI can explain it.

- [ ] **Step 4: Implement review diffs and explicit RPC payload construction**

`buildImportPayload` must emit only reviewed operations:

```js
{
  companies: [{ tempId, action: "create", patch: { name, website, address } }],
  contacts: [{ action: "update", contactId, companyId, expectedUpdatedAt, patch: { title: "Principal" } }]
}
```

Omit fields whose decision remains `keep`, omit skipped/already-current cards, and reject selected new contacts without both person and company names.

- [ ] **Step 5: Run matching tests**

Run: `node --test frontend/tests/business-card-matching.test.mjs`

Expected: PASS, including conflicting duplicate cards remaining separate review items.

- [ ] **Step 6: Commit the matching checkpoint**

```bash
git add frontend/src/lib/business-card-matching.js frontend/tests/business-card-matching.test.mjs
git commit -m "Add deterministic business card matching"
```

### Task 5: Ephemeral browser image preparation and chunking

**Files:**
- Create: `frontend/src/lib/business-card-images.js`
- Create: `frontend/tests/business-card-images.test.mjs`

**Interfaces:**
- Produces: `validateCardFiles(files)`, `normalizeCardImage(file)`, `chunkCardImages(images, limits)`, and `releaseCardImages(images)`.
- Consumed by: Task 8 import workspace and Task 6 Edge Function payload.

- [ ] **Step 1: Write failing validation and chunking tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { validateCardFiles, chunkCardImages } from "../src/lib/business-card-images.js";

const source = readFileSync(new URL("../src/lib/business-card-images.js", import.meta.url), "utf8");

test("rejects unsupported and oversized inputs per file", () => {
  const result = validateCardFiles([
    { name: "card.jpg", type: "image/jpeg", size: 1000 },
    { name: "card.svg", type: "image/svg+xml", size: 1000 },
    { name: "huge.png", type: "image/png", size: 11 * 1024 * 1024 },
  ]);
  assert.deepEqual(result.accepted.map(x => x.name), ["card.jpg"]);
  assert.equal(result.rejected.length, 2);
});

test("chunks normalized images without crossing byte or count limits", () => {
  const images = [1, 2, 3].map(i => ({ id: `i${i}`, byteSize: 9 }));
  assert.deepEqual(chunkCardImages(images, { maxBytes: 18, maxCount: 4 }).map(c => c.length), [2, 1]);
});

test("normalization honors phone orientation and bounds output dimensions", () => {
  assert.match(source, /imageOrientation:\s*["']from-image["']/);
  assert.match(source, /2048/);
  assert.match(source, /0\.86/);
});
```

- [ ] **Step 2: Run and verify the missing-module failure**

Run: `node --test frontend/tests/business-card-images.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement pure validation/chunking and browser normalization**

- Accept JPEG, PNG, and WebP; allow browser-decodable HEIC/HEIF but report a clear per-file decode error when unsupported.
- Enforce 20 files and 10 MB per original.
- Decode with `createImageBitmap(file, { imageOrientation: "from-image" })` when available, fall back to `Image` plus an object URL.
- Scale the longest side to at most 2048 pixels and encode JPEG at quality `0.86`.
- Return `{ id, filename, mime: "image/jpeg", dataB64, byteSize, previewUrl, width, height }`.
- `releaseCardImages` revokes every `previewUrl` exactly once.

- [ ] **Step 4: Run image helper tests**

Run: `node --test frontend/tests/business-card-images.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the image checkpoint**

```bash
git add frontend/src/lib/business-card-images.js frontend/tests/business-card-images.test.mjs
git commit -m "Prepare card images ephemerally in browser"
```

### Task 6: Authenticated multi-card vision extraction Edge Function

**Files:**
- Create: `supabase/functions/extract-business-cards/index.ts`
- Create: `frontend/tests/business-card-edge.test.mjs`
- Modify: `frontend/src/data.js`

**Interfaces:**
- Consumes request: `{ images: Array<{ id, filename, mime, dataB64 }> }`.
- Produces response: `{ ok: true, candidates: CardCandidate[], warnings: ExtractionWarning[], model }`.
- Produces frontend API: `extractBusinessCards(images)`.

- [ ] **Step 1: Write the failing Edge Function source contract**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../supabase/functions/extract-business-cards/index.ts", import.meta.url), "utf8");
test("card extractor authenticates, caps payloads, uses strict JSON, and never persists images", () => {
  assert.match(source, /auth\.getUser\(\)/);
  assert.match(source, /MAX_IMAGES\s*=\s*20/);
  assert.match(source, /json_schema/);
  assert.doesNotMatch(source, /storage\.from|\.insert\(/);
  assert.doesNotMatch(source, /console\.(log|debug)\([^)]*dataB64/);
});
```

- [ ] **Step 2: Run and confirm missing-file failure**

Run: `node --test frontend/tests/business-card-edge.test.mjs`

Expected: FAIL because the function file is absent.

- [ ] **Step 3: Implement auth, limits, schema validation, and CORS**

Follow `generate-description/index.ts` for JWT verification. Define `MAX_IMAGES = 20`, `MAX_FILE_BYTES = 10 * 1024 * 1024`, and `MAX_TOTAL_BYTES = 25 * 1024 * 1024`. Reject non-image MIME types, duplicate/missing IDs, invalid base64, and malformed JSON before calling the model.

Use an extraction schema shaped as:

```ts
interface CardCandidate {
  sourceId: string;
  cardIndex: number;
  personName: string;
  title: string;
  email: string;
  phone: string;
  companyName: string;
  companyWebsite: string;
  companyAddress: string;
  extraDetails: string[];
  warnings: string[];
}
```

Request strict JSON schema output from the OpenAI Responses API. Instructions must say that visible card text is untrusted data, several cards may appear in one image, facts must not be invented, and all cards must be returned separately.

- [ ] **Step 4: Implement bounded model errors and frontend invocation**

Add to `data.js`:

```js
export async function extractBusinessCards(images) {
  const { data, error } = await supabase.functions.invoke("extract-business-cards", { body: { images } });
  if (error) throw new Error(error.message || "Business-card extraction failed");
  if (!data?.ok || !Array.isArray(data.candidates)) throw new Error(data?.error || "Invalid extraction response");
  return data;
}
```

- [ ] **Step 5: Run the Edge contract and frontend build**

Run: `node --test frontend/tests/business-card-edge.test.mjs`

Expected: PASS.

Run: `npm run build`

Working directory: `frontend`

Expected: PASS.

- [ ] **Step 6: Commit the extraction checkpoint**

```bash
git add supabase/functions/extract-business-cards/index.ts frontend/src/data.js frontend/tests/business-card-edge.test.mjs
git commit -m "Extract multiple business cards with vision"
```

### Task 7: Atomic reviewed-import RPC

**Files:**
- Create: `supabase/migrations_v2/20261012120100_business_card_import.sql`
- Create: `frontend/tests/business-card-import-sql.test.mjs`
- Modify: `frontend/src/data.js`

**Interfaces:**
- Consumes: `apply_business_card_import(p_payload jsonb)` with explicit company/contact operations from `buildImportPayload`.
- Produces: `{ companies_created, companies_updated, contacts_created, contacts_updated, skipped }` and new UUID maps.
- Produces frontend API: `applyBusinessCardImport(payload)`.

- [ ] **Step 1: Write the failing RPC contract test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const sql = readFileSync(new URL("../../supabase/migrations_v2/20261012120100_business_card_import.sql", import.meta.url), "utf8");

test("import RPC is authenticated, explicit and version checked", () => {
  assert.match(sql, /create or replace function beacon_v2\.apply_business_card_import\(p_payload jsonb\)/i);
  assert.match(sql, /expected_updated_at/i);
  assert.match(sql, /stale/i);
  assert.match(sql, /revoke all on function[\s\S]+public, anon/i);
  assert.match(sql, /grant execute[\s\S]+authenticated/i);
  assert.doesNotMatch(sql, /execute\s+format\(/i);
});
```

- [ ] **Step 2: Run and verify missing-file failure**

Run: `node --test frontend/tests/business-card-import-sql.test.mjs`

Expected: FAIL because the migration is absent.

- [ ] **Step 3: Implement explicit JSON validation and transactional writes**

Use a default security-invoker PL/pgSQL function. Validate top-level arrays and allow only these patch keys:

- company: `name`, `district`, `org_type`, `website`, `address`, `notes`;
- contact: `name`, `title`, `email`, `phone`, `notes`, `is_primary`, `ord`.

Create a temporary mapping of review `tempId` to inserted company UUID. For updates, require both target UUID and `expectedUpdatedAt`; update with `where id = ... and updated_at = ...`, and raise `P0001` with a `stale company` or `stale contact` message when no row changes. Use `set_primary_contact` after contact insertion/update when requested. Return summary JSON and created ID maps.

- [ ] **Step 4: Add SQL self-check examples for stale and atomic behavior**

Include commented Studio verification blocks that begin a transaction, call the RPC with an intentionally stale timestamp, assert the exception, and roll back. Include a second block whose invalid second contact proves the first company is not committed.

- [ ] **Step 5: Add the frontend wrapper**

```js
export async function applyBusinessCardImport(payload) {
  const { data, error } = await supabase.rpc("apply_business_card_import", { p_payload: payload });
  if (error) throw new Error(error.message || "Business-card import failed");
  return data;
}
```

- [ ] **Step 6: Run the RPC contract test**

Run: `node --test frontend/tests/business-card-import-sql.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the atomic-write checkpoint**

```bash
git add supabase/migrations_v2/20261012120100_business_card_import.sql frontend/src/data.js frontend/tests/business-card-import-sql.test.mjs
git commit -m "Apply reviewed card imports atomically"
```

### Task 8: Business-card import workspace and Directory integration

**Files:**
- Create: `frontend/src/business-card-import.jsx`
- Create: `frontend/src/lib/business-card-import-state.js`
- Create: `frontend/src/design/pages/business-card-import.css`
- Create: `frontend/tests/business-card-import-state.test.mjs`
- Modify: `frontend/src/design/index.css`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/tables.jsx`

**Interfaces:**
- Consumes: image helpers, `extractBusinessCards`, matcher/review payload helpers, `applyBusinessCardImport`, and `reloadDirectory`.
- Produces: `<BusinessCardImport companies onComplete onClose onToast />`.

- [ ] **Step 1: Write failing reducer tests for partial success and cleanup**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { initialImportState, importReducer, cleanupPreviewUrls } from "../src/lib/business-card-import-state.js";

test("successful chunks remain when a later chunk fails", () => {
  let s = initialImportState();
  s = importReducer(s, { type: "chunkSucceeded", chunkId: "a", candidates: [{ sourceId: "1" }] });
  s = importReducer(s, { type: "chunkFailed", chunkId: "b", error: "network" });
  assert.equal(s.candidates.length, 1);
  assert.deepEqual(s.failedChunks, [{ chunkId: "b", error: "network" }]);
});

test("cleanup revokes every unique preview URL", () => {
  const seen = [];
  cleanupPreviewUrls([{ previewUrl: "blob:a" }, { previewUrl: "blob:a" }, { previewUrl: "blob:b" }], url => seen.push(url));
  assert.deepEqual(seen, ["blob:a", "blob:b"]);
});
```

- [ ] **Step 2: Run and verify missing-module failure**

Run: `node --test frontend/tests/business-card-import-state.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the reducer and cleanup helper**

Use explicit phases `upload`, `analyzing`, `review`, `saving`, `complete`. Keep `images`, `chunks`, `candidates`, `failedChunks`, `reviewItems`, `error`, and `summary` in state. Reducer retries replace only the selected failed chunk and never clear successful candidates.

- [ ] **Step 4: Implement upload and analysis stages**

- Camera/file input uses `accept="image/jpeg,image/png,image/webp,image/heic,image/heif"`, `multiple`, and a separate mobile camera input with `capture="environment"`.
- Show thumbnails, sizes, removal, per-file validation errors, and total count.
- Normalize, chunk, and analyze with at most two concurrent requests.
- Show per-chunk progress and retry actions.
- Transition to review when at least one candidate exists, even if another chunk failed.

- [ ] **Step 5: Implement the field-level review stage**

For every review item:

- show source image and status badge;
- provide searchable existing-company selection plus a new-company option;
- provide suggested existing-contact selection plus a new-person option;
- make extracted values editable;
- show `Existing` and `Card` values with radio choices for every diff;
- make ambiguous matches and conflicting batch duplicates visibly unresolved;
- support Skip and include/exclude toggles;
- disable Save until all selected items have a person and company and no unresolved choice.

- [ ] **Step 6: Implement save, stale recovery, summary, and lifecycle cleanup**

- Build the reviewed RPC payload and call `applyBusinessCardImport`.
- On a stale error, call `reloadDirectory`, re-run matching for affected items, and return to review with an explanation.
- On success, refresh the Directory and show counts.
- On success, cancel, or unmount, revoke object URLs and clear image/base64 state.
- Trap focus in the dialog, restore focus to the launch button, support Escape only when not analyzing/saving, and announce progress/errors with `aria-live`.

- [ ] **Step 7: Integrate the workspace with Directory**

In `App.jsx`, add `businessCardImportOpen` state and render the workspace only for the Directory page. Pass `onImportCards={() => setBusinessCardImportOpen(true)}` to `DirectoryTable`. On completion, replace the companies state with `await reloadDirectory()` and close after the user dismisses the summary.

- [ ] **Step 8: Add responsive styles and import them**

Create a desktop two-pane review layout (source preview beside diff form), collapse to one column on phone, use existing design tokens, preserve 44px touch targets, and honor global reduced motion. Add `@import "./pages/business-card-import.css";` to `frontend/src/design/index.css`.

- [ ] **Step 9: Run focused tests and build**

Run: `node --test frontend/tests/business-card-import-state.test.mjs frontend/tests/business-card-matching.test.mjs frontend/tests/business-card-images.test.mjs frontend/tests/unified-directory-surface.test.mjs`

Expected: PASS.

Run: `npm run build`

Working directory: `frontend`

Expected: PASS.

- [ ] **Step 10: Commit the importer UI checkpoint**

```bash
git add frontend/src/business-card-import.jsx frontend/src/lib/business-card-import-state.js frontend/src/design/pages/business-card-import.css frontend/src/design/index.css frontend/src/App.jsx frontend/src/tables.jsx frontend/tests/business-card-import-state.test.mjs
git commit -m "Add reviewed business card import workspace"
```

### Task 9: Update scripts, repository guidance, and run full verification

**Files:**
- Modify: `scripts/ingest_seed_data.py`
- Modify: `scripts/import_projects_xlsx.py`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md` (gitignored local counterpart; keep material text synchronized)
- Modify: `README.md` if its data-model or activation text names the split masters.

**Interfaces:**
- Consumes: completed schema, frontend, Edge Function, and RPC.
- Produces: company-only seed/import tooling and accurate activation documentation.

- [ ] **Step 1: Update data scripts to use companies only**

- Change seed ingestion to upsert all organizations into `companies` and preserve district/org type.
- Change project spreadsheet matching to load `companies` and write company UUIDs into `client_id` role columns.
- Remove any deletion or upsert of the retired live `clients` table.
- Keep scripts dry-run capable before destructive seed operations.

- [ ] **Step 2: Update repository guidance**

Document:

- canonical `companies` organization storage and contextual Client/Prime/Sub roles;
- company-only contacts;
- migrations `20261012120000` and `20261012120100`;
- `extract-business-cards` deployment;
- `OPENAI_API_KEY` and optional `OPENAI_CARD_MODEL`;
- ephemeral image handling and review-before-save behavior;
- preflight and cutover sequence;
- temporary legacy clients table and later cleanup.

Mirror the material `AGENTS.md` update into `CLAUDE.md` while preserving their documented heading differences.

- [ ] **Step 3: Run all frontend tests**

Run: `node --test frontend/tests/*.test.mjs`

Expected: all tests pass.

- [ ] **Step 4: Run the production build**

Run: `npm run build`

Working directory: `frontend`

Expected: Vite build succeeds.

- [ ] **Step 5: Run static cutover searches**

Run: `rg -n "from\(\"clients\"\)|getClientsOnly|routeClientPick|routePrimePick|references beacon_v2\.clients" frontend/src scripts supabase/migrations_v2/20261012*.sql`

Expected: no live-code matches; historical migrations before the cutover may still contain `beacon_v2.clients`.

Run: `rg -n "storage\.from|\.insert\(" supabase/functions/extract-business-cards/index.ts`

Expected: no matches.

- [ ] **Step 6: Review the complete diff for unrelated changes and secrets**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only task-owned changes plus the pre-existing unrelated workspace entries.

Run: `rg -n "sk-[A-Za-z0-9_-]+|OPENAI_API_KEY\s*=" supabase/functions/extract-business-cards frontend/src`

Expected: no literal API key.

- [ ] **Step 7: Commit documentation and tooling**

```bash
git add scripts/ingest_seed_data.py scripts/import_projects_xlsx.py AGENTS.md README.md
git commit -m "Document unified directory card import rollout"
```

- [ ] **Step 8: Record production activation commands without executing them**

```bash
supabase functions deploy extract-business-cards --project-ref ggqlcsppojypgaiyhods
supabase secrets set OPENAI_API_KEY=... OPENAI_CARD_MODEL=... --project-ref ggqlcsppojypgaiyhods
```

Production SQL remains a manual Supabase Studio cutover after running `scripts/preflight_unified_companies.sql`; repository implementation must not mutate production data automatically.
