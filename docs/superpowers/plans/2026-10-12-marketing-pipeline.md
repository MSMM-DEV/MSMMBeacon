# Marketing Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a database-backed Marketing page that carries SaaS and AI opportunities through the marketing lead's seven exactly named stages, including qualification, tasks, activities, documents, reminders, audit history, reporting, responsive UI, and per-user interface access.

**Architecture:** A normalized `beacon_v2` schema stores opportunities and their contacts, activities, tasks, documents, and stage history. Pure JavaScript modules own rules and data-shape conversion; a lazily loaded React page owns Pipeline, Opportunity list, and Insights views; existing Beacon alert, Directory, access, design-token, and private-storage patterns are reused. Stage transitions and optimistic-concurrency checks are enforced in Postgres so direct API writes cannot bypass history or silently overwrite another user's changes.

**Tech Stack:** React 18, Vite 5, Supabase/Postgres/PostgREST/Storage, Deno Edge Functions, Radix-based `@/ui` components, Lucide icons, CSS design tokens, Node's built-in test runner, esbuild-backed component tests.

**Spec:** `docs/superpowers/specs/2026-10-12-marketing-pipeline-design.md`

## Global Constraints

- The live database schema is `beacon_v2`; application code must not read or write the legacy `beacon` schema.
- The seven user-visible and database stage values must be exactly: `Intro to Target or prospect`; `Initial meeting to showcase products and qualify prospect`; `IQM - Initial Qualified Meeting`; `BANT - Budget Authority Need Time`; `Verbal Approval to Proceed`; `Legal and Contract Negotiation`; `Contract Signed Won or Lost`.
- A Won or Lost opportunity remains in Marketing; this release creates no Hot Lead, Proposal, Project, or Invoice record.
- Won fixes probability at 100 and requires signature date plus final contract value; Lost fixes probability at 0 and requires a configured loss reason.
- Full-access users and Admins see the new workflow; existing custom-access users must be granted the brand-new `workflow.marketing` node.
- Marketing data is collaborative for authenticated users, matching Beacon's existing RLS posture; interface access remains visibility control rather than row-level authorization.
- No Outlook, inbox, e-signature, CRM, proposal-generation, or AI-scoring integration is represented as functional.
- All migrations are idempotent and applied manually through Supabase Studio; do not run a local Supabase reset or push.
- Desktop, tablet, phone, keyboard, touch, light/dark theme, reduced motion, and 44px mobile touch targets are release requirements.
- Production code follows test-first red/green/refactor cycles; every task ends with its focused tests and a commit.

## Plain-English Delivery Map

1. **Foundation:** establish the exact stages, validation rules, database records, history, settings, and secure file bucket.
2. **Daily sales work:** add the Marketing navigation entry, Pipeline board, filters, opportunity creation, stage movement, and the detailed record sheet.
3. **Follow-through:** add contacts, activities, tasks, email reminders, and contract/proposal documents.
4. **Management:** add the list, CSV export, KPIs, Insights, aging, forecast, and Won/Lost analysis.
5. **Launch readiness:** complete responsive/accessibility behavior, conflict recovery, documentation, automated checks, and a deploy checklist.

## File Structure

- Create `frontend/src/marketing-rules.js` — exact stage registry, transition requirements, validation, health, filtering, KPIs, insights, and CSV shaping as pure functions.
- Create `frontend/src/marketing-model.js` — database/UI adapters and insert/update payload builders that preserve `null` versus zero.
- Create `frontend/src/marketing.jsx` — Marketing page state, lazy loading, view routing, filtering, deep-link opening, and write coordination.
- Create `frontend/src/marketing-components/MarketingBoard.jsx` — seven lanes, cards, desktop drag intent, mobile selected-stage rendering, and accessible move actions.
- Create `frontend/src/marketing-components/MarketingTransitionDialog.jsx` — destination guidance, recommended probability, Won/Lost fields, validation, and confirmation.
- Create `frontend/src/marketing-components/MarketingOpportunitySheet.jsx` — overview, qualification, dirty-state protection, concurrency recovery, archive/restore, and history.
- Create `frontend/src/marketing-components/MarketingActivityPanel.jsx` — activity timeline and creation form.
- Create `frontend/src/marketing-components/MarketingTaskPanel.jsx` — task list, create/edit/complete/reopen actions, and reminder controls.
- Create `frontend/src/marketing-components/MarketingDocumentPanel.jsx` — private upload, download, and remove actions.
- Create `frontend/src/marketing-components/MarketingList.jsx` — sortable table and export action.
- Create `frontend/src/marketing-components/MarketingInsights.jsx` — accessible funnel, forecast, velocity, activity, and loss reporting.
- Create `frontend/src/design/pages/marketing.css` — responsive board, cards, sheet content, list, and insight layout using tokens.
- Create `supabase/migrations_v2/20261012120000_marketing_pipeline.sql` — Marketing core tables plus activity-participant join tables, enums, constraints, triggers, RPC, RLS/grants, setting, alert subject, and Storage bucket policies.
- Modify `frontend/src/data.js` — Marketing PostgREST/Storage operations and shared scheduled-alert write helper.
- Modify `frontend/src/access.js` — stable Marketing workflow/page/view nodes.
- Modify `frontend/src/App.jsx` — lazy import, tab/nav/page metadata, rail section/icon, page render, and deep-link preservation.
- Modify `frontend/src/admin.jsx` — Admin-only Marketing stalled-day setting using the existing workspace-settings pattern.
- Modify `frontend/src/icons.jsx` — add the distinct Marketing rail icon.
- Modify `frontend/src/design/index.css` — import the Marketing page stylesheet.
- Modify `frontend/src/utils/csv.js` only if the browser-independent CSV serializer is extracted for direct testing; keep the current `exportCSV` public API.
- Modify `supabase/functions/send-alert/index.ts` — Marketing subject lookup, renderer, and `opportunity` deep link.
- Modify `frontend/tests/access.test.mjs` and `frontend/tests/redesign-surface.test.mjs`; create focused Marketing tests listed below.
- Modify `PLAN.md`, `AGENTS.md`, and the gitignored `CLAUDE.md` — document the completed workflow, migration, activation, and non-goals.

## Review Focus

- Empty or whitespace-only names and duplicate Directory organization creation must produce a useful validation or existing-record message, never a blank card or raw constraint error; Task 3 pins payload normalization and Task 5 pins create behavior.
- Money value `0`, probability `0`, and empty optional dates must survive adapters without being mistaken for missing data; Tasks 1 and 3 pin these cases.
- Due-date and quarter calculations around midnight and daylight-saving changes must use explicit Chicago/local date boundaries rather than UTC date truncation; Tasks 1 and 9 pin fixed-clock cases.
- A stale editor must not overwrite a newer opportunity version; Tasks 2, 3, and 6 pin version checks and the review-latest recovery path.
- Reminder or file partial failure must preserve the core task/opportunity and expose a safe Retry or cleanup action; Tasks 8 and 10 pin both failure paths.

---

### Task 1: Marketing Domain Rules

**Files:**
- Create: `frontend/src/marketing-rules.js`
- Create: `frontend/tests/marketing-rules.test.mjs`

**Interfaces:**
- Consumes: plain opportunity/task/activity objects and an injected `now` date.
- Produces: `MARKETING_STAGES`, `MARKETING_STAGE_NAMES`, `MARKETING_LOSS_REASONS`, `stageDefinition(name)`, `transitionDraft(opportunity, toStage)`, `validateMarketingTransition(input)`, `weightedMarketingValue(opportunity)`, `marketingHealth(opportunity, tasks, options)`, `filterMarketingOpportunities(rows, filters, options)`, `buildMarketingInsights(rows, tasks, activities, options)`, and `marketingCsvRows(rows, lookups, options)`.

- [ ] **Step 1: Write failing tests for the immutable stage contract and transition rules**

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKETING_STAGE_NAMES, transitionDraft, validateMarketingTransition,
} from "../src/marketing-rules.js";

const exactStages = [
  "Intro to Target or prospect",
  "Initial meeting to showcase products and qualify prospect",
  "IQM - Initial Qualified Meeting",
  "BANT - Budget Authority Need Time",
  "Verbal Approval to Proceed",
  "Legal and Contract Negotiation",
  "Contract Signed Won or Lost",
];

test("stage names and order exactly match the marketing lead's language", () => {
  assert.deepEqual(MARKETING_STAGE_NAMES, exactStages);
});

test("moving to BANT proposes 45 without blocking an acknowledged custom probability", () => {
  const draft = transitionDraft({ stage: exactStages[2], probability: 30 }, exactStages[3]);
  assert.equal(draft.probability, 45);
  assert.equal(validateMarketingTransition({ ...draft, probability: 55 }).errors.length, 0);
  assert.ok(validateMarketingTransition({ ...draft, probability: 55 }).warnings.length > 0);
});

test("Won and Lost require their outcome fields and fix probability", () => {
  const won = validateMarketingTransition({ toStage: exactStages[6], outcome: "won", probability: 90 });
  assert.deepEqual(won.errors.map(x => x.field), ["signedAt", "finalContractValue"]);
  assert.equal(won.normalized.probability, 100);
  const lost = validateMarketingTransition({ toStage: exactStages[6], outcome: "lost", probability: 75 });
  assert.deepEqual(lost.errors.map(x => x.field), ["lossReason"]);
  assert.equal(lost.normalized.probability, 0);
});
```

- [ ] **Step 2: Run the rule test and verify RED**

Run: `node --test frontend/tests/marketing-rules.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `marketing-rules.js`.

- [ ] **Step 3: Implement the exact registry and transition API**

```js
export const MARKETING_STAGES = Object.freeze([
  { name: "Intro to Target or prospect", min: 0, max: 10, defaultProbability: 5 },
  { name: "Initial meeting to showcase products and qualify prospect", min: 10, max: 25, defaultProbability: 20 },
  { name: "IQM - Initial Qualified Meeting", min: 25, max: 40, defaultProbability: 30 },
  { name: "BANT - Budget Authority Need Time", min: 40, max: 50, defaultProbability: 45 },
  { name: "Verbal Approval to Proceed", min: 75, max: 75, defaultProbability: 75 },
  { name: "Legal and Contract Negotiation", min: 75, max: 90, defaultProbability: 85 },
  { name: "Contract Signed Won or Lost", min: 0, max: 100, defaultProbability: 100 },
]);
export const MARKETING_STAGE_NAMES = Object.freeze(MARKETING_STAGES.map(stage => stage.name));
export const MARKETING_LOSS_REASONS = Object.freeze([
  "Price", "Did not meet their needs", "Timing was not right", "Competitor", "Internal build", "Other",
]);
```

Implement `transitionDraft` so it rejects unknown stages, proposes the destination default, preserves existing close information, and returns destination-specific missing-field guidance. Implement `validateMarketingTransition` with structured `{ errors, warnings, normalized }`; stage-range deviations are warnings, while invalid probability and missing terminal fields are errors.

- [ ] **Step 4: Add failing tests for zero values, health precedence, fixed-clock filtering, quarter boundaries, and insight totals**

```js
test("zero value and zero probability produce a real zero weighted value", () => {
  assert.equal(weightedMarketingValue({ estimatedValue: 0, probability: 50 }), 0);
  assert.equal(weightedMarketingValue({ estimatedValue: 5000, probability: 0 }), 0);
});

test("stalled outranks overdue attention and Chicago date-only filtering is stable", () => {
  const now = new Date("2026-11-01T05:30:00.000Z");
  const row = { outcome: null, lastActivityAt: "2026-10-01T12:00:00.000Z", expectedCloseDate: "2026-10-31" };
  assert.equal(marketingHealth(row, [{ dueAt: "2026-10-31T14:00:00.000Z", status: "open" }], { now, stalledAfterDays: 14 }), "stalled");
  assert.equal(filterMarketingOpportunities([row], { closePeriod: "overdue" }, { now }).length, 1);
});
```

Also assert that closed rows are excluded from active/weighted totals, quarter boundaries are correct for January and December, exact-stage filtering works, and loss-reason counts include zero-dollar losses.

- [ ] **Step 5: Implement health, filtering, insight, and CSV shaping functions**

Use injected dates in all pure functions. Convert date-only strings to local noon before comparisons, use `Intl.DateTimeFormat` or numeric year/month parts rather than `toISOString().slice(0, 10)`, and return chart-ready arrays plus accessible text summaries. `marketingCsvRows` must return data objects, not touch browser APIs.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run: `node --test frontend/tests/marketing-rules.test.mjs`

Expected: all Marketing rule tests PASS with zero failures.

- [ ] **Step 7: Commit the domain contract**

```bash
git add frontend/src/marketing-rules.js frontend/tests/marketing-rules.test.mjs
git commit -m "Add Marketing pipeline domain rules"
```

### Task 2: Database Foundation and Audit Enforcement

**Files:**
- Create: `supabase/migrations_v2/20261012120000_marketing_pipeline.sql`
- Create: `frontend/tests/marketing-migration.test.mjs`

**Interfaces:**
- Consumes: existing `beacon_v2.users`, `clients`, `contacts`, `alerts`, `app_settings`, `touch_updated_at()`, and private Storage policy conventions.
- Produces: Marketing enums/tables, `transition_marketing_opportunity(_id, _expected_version, _stage, _probability, _outcome, _signed_at, _final_contract_value, _loss_reason, _loss_detail, _transition_note)`, history/activity triggers, version enforcement, RLS/grants, `marketing_stalled_after_days`, `marketing` alert subject, and `marketing-documents` bucket.

- [ ] **Step 1: Write the failing migration contract test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const url = new URL("../../supabase/migrations_v2/20261012120000_marketing_pipeline.sql", import.meta.url);
const exactStages = [
  "Intro to Target or prospect",
  "Initial meeting to showcase products and qualify prospect",
  "IQM - Initial Qualified Meeting",
  "BANT - Budget Authority Need Time",
  "Verbal Approval to Proceed",
  "Legal and Contract Negotiation",
  "Contract Signed Won or Lost",
];

test("Marketing migration defines the normalized secured data surface", async () => {
  const sql = await readFile(url, "utf8");
  for (const stage of exactStages) assert.ok(sql.includes(`'${stage}'`), stage);
  for (const table of ["marketing_opportunities", "marketing_opportunity_contacts", "marketing_activities", "marketing_activity_users", "marketing_activity_contacts", "marketing_tasks", "marketing_documents", "marketing_stage_history"])
    assert.match(sql, new RegExp(`create table if not exists beacon_v2\\.${table}`));
  assert.match(sql, /transition_marketing_opportunity/);
  assert.match(sql, /old\.version/);
  assert.match(sql, /marketing-documents/);
  assert.match(sql, /add value if not exists 'marketing'/);
  assert.match(sql, /notify pgrst, 'reload schema'/);
});
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `node --test frontend/tests/marketing-migration.test.mjs`

Expected: FAIL with `ENOENT` because the migration does not exist.

- [ ] **Step 3: Create enums, six core tables, and two participant join tables**

Define `marketing_stage_enum` with the exact seven strings; `marketing_outcome_enum` (`won`, `lost`); `marketing_loss_reason_enum`; activity type, task priority/state, document type, and contact-role enums. Create the six core tables with all fields enumerated in the spec, foreign keys to users/clients/contacts, `numeric(14,2)` money, `text[]` product tags, `version integer not null default 1`, archive metadata, and `created_at`/`updated_at` timestamps. Create `marketing_activity_users(activity_id, user_id)` and `marketing_activity_contacts(activity_id, contact_id)` with composite primary keys and cascade deletion so internal and external participants remain normalized.

Use database checks equivalent to:

```sql
constraint marketing_probability_range check (probability between 0 and 100),
constraint marketing_estimated_value_nonnegative check (estimated_value is null or estimated_value >= 0),
constraint marketing_terminal_consistency check (
  (stage <> 'Contract Signed Won or Lost' and outcome is null)
  or (stage = 'Contract Signed Won or Lost' and outcome = 'won' and probability = 100 and signed_at is not null and final_contract_value is not null)
  or (stage = 'Contract Signed Won or Lost' and outcome = 'lost' and probability = 0 and loss_reason is not null)
)
```

Create indexes on stage, owner, client, expected close, next-action due, last activity, task due/state, activity date, document opportunity, and history opportunity/date. Uniqueness must prevent duplicate contact links and duplicate Storage paths.

- [ ] **Step 4: Add trigger and RPC enforcement**

Create a BEFORE UPDATE trigger that increments `version`, updates timestamps, maintains `stage_entered_at`, rejects direct terminal inconsistencies, and records old/new values. Create an AFTER UPDATE history trigger for stage, probability, or outcome changes. Create an AFTER INSERT/UPDATE/DELETE activity trigger that recomputes `last_activity_at` from meaningful activities.

The SECURITY INVOKER transition function must lock the row, compare `_expected_version` with the stored version, raise SQLSTATE `40001` on mismatch, update all transition fields once, and return the updated row. The history trigger supplies the audit row inside the same transaction.

- [ ] **Step 5: Add settings, alerts, RLS, grants, and private Storage policies**

Add `app_settings.marketing_stalled_after_days integer not null default 14 check (marketing_stalled_after_days between 1 and 365)`. Extend `alert_subject_enum` with `marketing`. Add the Marketing table to alert deactivation behavior when required by the existing generic function.

Enable RLS on all six core tables and both participant join tables, and add one idempotent authenticated CRUD policy per table. Grant table CRUD and RPC execution to `authenticated`; keep `anon` denied. Insert/update `storage.buckets` for private bucket `marketing-documents`; add authenticated select/insert/update/delete object policies scoped to `bucket_id = 'marketing-documents'`. End with `notify pgrst, 'reload schema';`.

- [ ] **Step 6: Run the structural migration test and SQL static checks**

Run: `node --test frontend/tests/marketing-migration.test.mjs`

Expected: PASS.

Run: `rg -n "create table|create policy|create trigger|create or replace function|grant|notify pgrst" supabase/migrations_v2/20261012120000_marketing_pipeline.sql`

Expected: all six core tables, both participant join tables, required triggers/functions, table and Storage policies, grants, and schema reload are visible.

- [ ] **Step 7: Commit the database foundation**

```bash
git add supabase/migrations_v2/20261012120000_marketing_pipeline.sql frontend/tests/marketing-migration.test.mjs
git commit -m "Add Marketing pipeline schema"
```

### Task 3: Data Shapes, CRUD, Concurrency, and Directory Reuse

**Files:**
- Create: `frontend/src/marketing-model.js`
- Create: `frontend/tests/marketing-model.test.mjs`
- Modify: `frontend/src/data.js`

**Interfaces:**
- Consumes: `supabase`, current Beacon user, existing `addContact`, Directory clients/users caches, and Task 2 tables/RPC.
- Produces: `adaptMarketingOpportunity`, `marketingOpportunityInsert`, `marketingOpportunityPatch`, `loadMarketingWorkspace`, opportunity create/update/transition/archive/restore functions, contact/activity/task/history CRUD, `updateMarketingSettings`, and authoritative returned UI rows.

- [ ] **Step 1: Write failing adapter and payload tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { adaptMarketingOpportunity, marketingOpportunityInsert, marketingOpportunityPatch } from "../src/marketing-model.js";

test("adapter preserves zero money, zero probability, null dates, and version", () => {
  const row = adaptMarketingOpportunity({ id: "o1", title: "Zero pilot", estimated_value: 0, probability: 0, expected_close_date: null, version: 4, product_tags: [] });
  assert.equal(row.estimatedValue, 0);
  assert.equal(row.probability, 0);
  assert.equal(row.expectedCloseDate, null);
  assert.equal(row.version, 4);
});

test("insert trims required text and rejects whitespace-only names", () => {
  assert.throws(() => marketingOpportunityInsert({ title: "   " }), /Opportunity name is required/);
  assert.equal(marketingOpportunityInsert({ title: "  AI assistant  ", estimatedValue: 0 }).title, "AI assistant");
});

test("patch whitelists fields and carries an explicit expected version", () => {
  assert.deepEqual(marketingOpportunityPatch({ summary: "  Fit confirmed ", estimatedValue: 0, ignored: true }, 7), {
    patch: { summary: "Fit confirmed", estimated_value: 0 }, expectedVersion: 7,
  });
});
```

- [ ] **Step 2: Run the model test and verify RED**

Run: `node --test frontend/tests/marketing-model.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement complete adapters and whitelisted payload builders**

Map every Task 2 opportunity column between snake_case and camelCase. Normalize strings with trim; convert blank optional strings to `null`; preserve `0`; accept only stage/loss values from Task 1; map nested client, owner, primary contact, tasks, contacts, activities, documents, and history without mutating Supabase responses.

Export a named `MarketingConflictError` carrying `latestVersion` when the database returns SQLSTATE `40001` or an update matches zero rows.

- [ ] **Step 4: Add `data.js` read and write functions**

`loadMarketingWorkspace()` performs parallel queries for settings, active plus archived opportunities, contacts with Directory people, activities with participants, tasks, documents, and stage history; it returns adapted arrays plus `stalledAfterDays`.

Implement:

```js
export async function createMarketingOpportunity(input) {}
export async function updateMarketingOpportunity(id, patch, expectedVersion) {}
export async function transitionMarketingOpportunity(id, input, expectedVersion) {}
export async function archiveMarketingOpportunity(id, expectedVersion) {}
export async function restoreMarketingOpportunity(id, expectedVersion) {}
export async function addMarketingContact(input) {}
export async function removeMarketingContact(opportunityId, contactId) {}
export async function createMarketingActivity(input) {}
export async function createMarketingTask(input) {}
export async function updateMarketingTask(id, patch) {}
export async function loadMarketingOpportunityFresh(id) {}
export async function updateMarketingSettings({ stalledAfterDays }) {}
```

Updates must use `.eq("version", expectedVersion).select().maybeSingle()`; no returned row means conflict, not success. Transitions call the RPC. Creation of a new Directory client/contact must call the existing Directory path and convert unique violations to the existing friendly message rather than duplicating organizations.

- [ ] **Step 5: Run model tests and the production build**

Run: `node --test frontend/tests/marketing-model.test.mjs`

Expected: PASS.

Run: `npm --prefix frontend run build`

Expected: Vite build exits 0.

- [ ] **Step 6: Commit the data layer**

```bash
git add frontend/src/marketing-model.js frontend/src/data.js frontend/tests/marketing-model.test.mjs
git commit -m "Add Marketing data adapters and CRUD"
```

### Task 4: Access Registry, Navigation, Lazy Page Shell, and Deep Links

**Files:**
- Modify: `frontend/src/access.js`
- Modify: `frontend/tests/access.test.mjs`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/icons.jsx`
- Create: `frontend/src/marketing.jsx`
- Create: `frontend/tests/marketing-shell.test.mjs`

**Interfaces:**
- Consumes: Task 3 `loadMarketingWorkspace`; existing access resolver, lazy-chunk recovery, page header, rail, Tabs, and URL routing conventions.
- Produces: routable tab `marketing`, `workflow.marketing`, `page.marketing`, view nodes `view.marketing.pipeline/list/insights`, Marketing rail section, and `?tab=marketing&opportunity=<uuid>&view=<name>` handling.

- [ ] **Step 1: Extend access tests first**

Add `marketing` to `APP_TABS`. Add assertions that full access and Admin see it, a brand-new workflow stays hidden for an old custom config, explicitly granting `view.marketing.pipeline` opens the page but not Insights, and revoking every Marketing view hides the page.

Run: `node --test frontend/tests/access.test.mjs`

Expected: FAIL because `marketing` has no access node.

- [ ] **Step 2: Add stable Marketing access keys**

```js
{
  key: "workflow.marketing", kind: "workflow", label: "Marketing & Sales", requiresChild: true,
  description: "SaaS and AI opportunities from first introduction through signed or lost.",
  children: [{
    key: "page.marketing", kind: "page", label: "Marketing", tab: "marketing", requiresChild: true,
    children: [
      { key: "view.marketing.pipeline", kind: "subtab", label: "Pipeline", view: "pipeline" },
      { key: "view.marketing.list", kind: "subtab", label: "Opportunity list", view: "list" },
      { key: "view.marketing.insights", kind: "subtab", label: "Insights", view: "insights" },
    ],
  }],
}
```

Run access tests again; expect PASS.

- [ ] **Step 3: Write the failing shell/source contract test**

The test reads `App.jsx` and `marketing.jsx` and asserts: `marketing` exists in `TAB_META`; a `marketing` NAV_GROUP uses group `marketing`; `RAIL_SECTIONS` labels the group `Marketing & Sales`; the page is lazy-loaded with the existing retry helper; the page metadata title is `Marketing`; and the shell includes shared underline view tabs filtered by `access.visibleChildren("page.marketing")`.

Run: `node --test frontend/tests/marketing-shell.test.mjs`

Expected: FAIL until App and the page shell contain those contracts.

- [ ] **Step 4: Integrate the route and minimal functional shell**

Add a distinct `marketing` icon backed by Lucide `Megaphone` or `Target`, checking it against existing 16px rail silhouettes. Add Marketing after Engineering in `RAIL_SECTIONS`. Lazy-load `MarketingPage`, render it only for `tab === "marketing"`, pass `access`, users/clients/current user, and preserve `view`/`opportunity` query parameters when the Marketing page updates its internal route.

The first shell must load Task 3 data, render loading/error/retry/empty states, render only allowed view tabs, and open the requested opportunity after data arrives. A denied view falls back to the first visible Marketing child without dropping the opportunity id.

- [ ] **Step 5: Run shell/access tests and build**

Run: `node --test frontend/tests/access.test.mjs frontend/tests/marketing-shell.test.mjs`

Expected: PASS.

Run: `npm --prefix frontend run build`

Expected: exit 0 with a separate lazy Marketing chunk.

- [ ] **Step 6: Commit navigation and access**

```bash
git add frontend/src/access.js frontend/src/App.jsx frontend/src/icons.jsx frontend/src/marketing.jsx frontend/tests/access.test.mjs frontend/tests/marketing-shell.test.mjs
git commit -m "Add Marketing navigation and access"
```

### Task 5: Pipeline Board, Filters, KPIs, Creation, and Stage Movement

**Files:**
- Create: `frontend/src/marketing-components/MarketingBoard.jsx`
- Create: `frontend/src/marketing-components/MarketingTransitionDialog.jsx`
- Create: `frontend/tests/marketing-board.test.mjs`
- Modify: `frontend/src/marketing.jsx`

**Interfaces:**
- Consumes: Task 1 stages/rules; Task 3 create/transition writes; Task 4 page shell and lookups.
- Produces: `MarketingBoard({ opportunities, tasks, clientsById, usersById, selectedMobileStage, onSelectedMobileStage, onOpen, onMoveIntent })` and `MarketingTransitionDialog({ opportunity, toStage, onCancel, onConfirm })`.

- [ ] **Step 1: Write failing stateless board tests**

Compile `MarketingBoard.jsx` with esbuild and traverse the React tree as existing component tests do. Assert all seven exact headings render in order, the final lane keeps Won and Lost badges inside one lane, every card has an accessible name, a move-menu selection calls `onMoveIntent(opportunity, exactStage)`, and archived records never render.

Run: `node --test frontend/tests/marketing-board.test.mjs`

Expected: FAIL because the board does not exist.

- [ ] **Step 2: Implement board/card rendering and shared toolbar**

Render all stages from `MARKETING_STAGES`; never duplicate names in JSX. Cards show opportunity, organization, estimated and weighted value, owner, probability, product tags, close date, next action/due date, days in stage, and icon-plus-text health. Use a horizontal scroll region on desktop and the selected-stage prop to render one lane on phone.

The toolbar stores search, owner, organization, stage, product, health, close-period, and outcome filters in the page state and calls `filterMarketingOpportunities`. KPI cards call Task 1 insights and expose plain text values to screen readers.

- [ ] **Step 3: Implement the short create dialog**

Required fields are opportunity name, organization, owner, and first next action; estimated value, product tags, and expected close date are optional. Initialize exact stage 1 and probability 5. Support selection of an existing Directory client/contact and inline creation through Task 3. Disable duplicate submission while saving; a failed save retains every field and focuses the error summary.

- [ ] **Step 4: Implement transition confirmation as the single movement path**

Desktop drag stores only movement intent and opens `MarketingTransitionDialog`; it does not mutate lane state. The move menu and drag call the same `onMoveIntent`. The dialog renders destination guidance, missing-field warnings, recommended probability, transition note, and terminal Won/Lost controls. `onConfirm` calls Task 3 with current version and replaces local data only with the authoritative returned row. Failure leaves the card in its original lane.

- [ ] **Step 5: Add tests for create normalization, failed movement, and exact final-stage requirements**

Export small coordinator helpers from `marketing.jsx` for test injection: `applyAuthoritativeOpportunity(rows, returned)` and `runMarketingTransition({ api, opportunity, transition })`. Assert the original array is unchanged on rejection and replaced only on resolution. Assert whitespace names are rejected and final-stage submit is disabled until Task 1 returns no errors.

- [ ] **Step 6: Run focused tests and build**

Run: `node --test frontend/tests/marketing-rules.test.mjs frontend/tests/marketing-board.test.mjs`

Expected: PASS.

Run: `npm --prefix frontend run build`

Expected: exit 0.

- [ ] **Step 7: Commit the daily board workflow**

```bash
git add frontend/src/marketing.jsx frontend/src/marketing-components/MarketingBoard.jsx frontend/src/marketing-components/MarketingTransitionDialog.jsx frontend/tests/marketing-board.test.mjs
git commit -m "Build Marketing opportunity board"
```

### Task 6: Opportunity Detail, Qualification, History, and Conflict Recovery

**Files:**
- Create: `frontend/src/marketing-components/MarketingOpportunitySheet.jsx`
- Create: `frontend/tests/marketing-opportunity-sheet.test.mjs`
- Modify: `frontend/src/marketing.jsx`

**Interfaces:**
- Consumes: Task 3 update/archive/restore/fresh-read APIs, Task 1 stage metadata, shared Sheet/Dialog/Field controls.
- Produces: `MarketingOpportunitySheet({ opportunity, contacts, activities, tasks, documents, history, lookups, onSaved, onArchived, onRestored, onClose })`.

- [ ] **Step 1: Write failing source/component contracts**

Assert the sheet renders six exact sections: Overview, Qualification, Activity, Tasks, Documents, History. Assert Overview contains every core field; Qualification contains IQM, four separately labeled BANT areas, proposal, verbal approval, and legal fields; History renders actor and timestamp. Assert `Escape`/outside close with dirty state opens a confirmation rather than closing.

Run: `node --test frontend/tests/marketing-opportunity-sheet.test.mjs`

Expected: FAIL because the sheet does not exist.

- [ ] **Step 2: Implement section-level draft and save behavior**

Keep a draft per editable section and a snapshot version. Save only whitelisted fields through Task 3, set a per-section busy state, and replace the opportunity with the returned row. On validation failure focus a linked error summary; on network failure keep the draft and expose Retry.

- [ ] **Step 3: Implement version-conflict recovery**

When `MarketingConflictError` is caught, show the message `This opportunity changed after you opened it.` with **Review latest** and **Keep my draft**. Review latest loads Task 3's fresh row and shows changed server values beside unsaved draft values. The user may copy their draft into a new save against the new version, but no automatic overwrite occurs.

Test with a fake API that rejects version 4 after returning version 5; assert no second update happens until the user explicitly confirms against 5.

- [ ] **Step 4: Add archive and restore**

Archive uses a danger-styled confirmation, Task 3 version check, and removes the row from active views only after the authoritative response. The list's archived filter opens the same sheet with a Restore action. No permanent delete action exists.

- [ ] **Step 5: Run focused tests and build**

Run: `node --test frontend/tests/marketing-opportunity-sheet.test.mjs frontend/tests/marketing-model.test.mjs`

Expected: PASS.

Run: `npm --prefix frontend run build`

Expected: exit 0.

- [ ] **Step 6: Commit opportunity editing**

```bash
git add frontend/src/marketing.jsx frontend/src/marketing-components/MarketingOpportunitySheet.jsx frontend/tests/marketing-opportunity-sheet.test.mjs
git commit -m "Add Marketing opportunity details"
```

### Task 7: Contacts, Activities, and Tasks

**Files:**
- Create: `frontend/src/marketing-components/MarketingActivityPanel.jsx`
- Create: `frontend/src/marketing-components/MarketingTaskPanel.jsx`
- Create: `frontend/tests/marketing-supporting-records.test.mjs`
- Modify: `frontend/src/marketing-components/MarketingOpportunitySheet.jsx`
- Modify: `frontend/src/data.js`

**Interfaces:**
- Consumes: Task 3 CRUD, existing Directory contacts/users, Task 2 last-activity trigger.
- Produces: contact-role links, manual activity timeline, task lifecycle, and deterministic next-action selection.

- [ ] **Step 1: Write failing behavior tests**

Assert contact role options are exactly Champion, Decision-maker, Budget owner, Legal contact, Technical evaluator, and Other. Assert activities sort newest-first without mutating input. Assert open tasks sort overdue first, then due date, then priority. Assert `nextMarketingAction(tasks, fallback)` returns the earliest open task and returns the opportunity fallback when every task is completed.

- [ ] **Step 2: Implement opportunity contact management**

Allow selection from the linked Directory organization's contacts, inline creation through `addContact`, role/primary/note editing, and unlinking from the opportunity without deleting the Directory person. Reject the same opportunity/contact pair twice with a friendly message.

- [ ] **Step 3: Implement manual activity logging**

The activity form requires type, occurred date/time, and summary; optionally captures internal users, Directory contacts, outcome, and next step. Render a chronological timeline with type icon, author, participants, outcome, and date. A successful write uses the server row and refreshes the opportunity's last-activity/health data.

- [ ] **Step 4: Implement task lifecycle**

The task form requires title and assignee and supports due time, priority, notes, completion, and reopen. Completed tasks record completer/time. Overdue state is based on the injected/current clock, not string ordering. The card's next action derives from open tasks through the tested helper.

- [ ] **Step 5: Run focused tests and build**

Run: `node --test frontend/tests/marketing-supporting-records.test.mjs frontend/tests/marketing-rules.test.mjs`

Expected: PASS.

Run: `npm --prefix frontend run build`

Expected: exit 0.

- [ ] **Step 6: Commit follow-through records**

```bash
git add frontend/src/data.js frontend/src/marketing-components/MarketingOpportunitySheet.jsx frontend/src/marketing-components/MarketingActivityPanel.jsx frontend/src/marketing-components/MarketingTaskPanel.jsx frontend/tests/marketing-supporting-records.test.mjs
git commit -m "Add Marketing activities and tasks"
```

### Task 8: Private Documents and Email Reminders

**Files:**
- Create: `frontend/src/marketing-components/MarketingDocumentPanel.jsx`
- Create: `frontend/tests/marketing-files-alerts.test.mjs`
- Modify: `frontend/src/data.js`
- Modify: `frontend/src/marketing-components/MarketingTaskPanel.jsx`
- Modify: `frontend/src/marketing-components/MarketingOpportunitySheet.jsx`
- Modify: `supabase/functions/send-alert/index.ts`

**Interfaces:**
- Consumes: Task 2 bucket and `marketing` alert enum; existing alert recurrence enums and Resend dispatcher.
- Produces: upload/download/remove helpers, `createScheduledAlert(input)`, task reminder status/retry, Marketing email renderer, and `?tab=marketing&opportunity=<uuid>` links.

- [ ] **Step 1: Write failing alert/file source contracts**

Read `data.js`, `MarketingDocumentPanel.jsx`, and `send-alert/index.ts`. Assert the data layer uses bucket `marketing-documents`; inserts document metadata only after a successful Storage upload; exposes signed URL and remove helpers; maps `marketing` to `marketing_opportunities`; renders opportunity title/stage/next action; and creates a deep link using `opportunity=` rather than the legacy `rowId=` parameter.

- [ ] **Step 2: Extract the shared scheduled-alert writer**

Add:

```js
export async function createScheduledAlert({
  subjectTable, subjectRowId, firstFireAt, recurrence = "one_time",
  recurrenceRule = null, message = null, recipientUserIds,
  anchorField = null, anchorOffsetMinutes = null, timezone = "America/Chicago",
}) {}
```

It inserts alert, unique recipients, and first pending fire. If recipients or fire insertion fails, deactivate the partially created alert and throw an error that names the failed step. Refactor `createOneShotAlert` to call this helper without changing leave behavior.

The Marketing reminder form offers only the recurrence modes the dispatcher currently completes end to end: one-time, weekly, biweekly, and monthly. It does not expose Custom while the Edge Function's RRULE implementation remains disabled.

- [ ] **Step 3: Implement task reminder UX and Retry**

A task may schedule its assignee plus selected users at a chosen date/time and recurrence. Save the task first. If alert creation fails, keep the task, show `Task saved; reminder was not scheduled`, and retain the reminder draft with Retry. Store returned `alert_id` on the task only after the entire alert write succeeds.

- [ ] **Step 4: Implement private document lifecycle**

Upload to `<opportunity-id>/<uuid>-<sanitized-name>`; accept PDF, DOC/DOCX, XLS/XLSX, PNG, and JPEG up to 25 MiB; reject unsupported/oversized files before network work. Insert metadata after upload success. If metadata insertion fails, remove the uploaded object and report cleanup failure separately. Download uses a 60-second signed URL. Remove deletes the object first and metadata second; a metadata delete failure keeps the visible row with Retry cleanup.

- [ ] **Step 5: Add Marketing email rendering and deep link**

Map `marketing` to `marketing_opportunities`. Render subject `Beacon · Marketing action: "<title>"`, then stage, probability, expected close, next action, and alert message. Generate `${APP_URL}?tab=marketing&opportunity=${encodeURIComponent(id)}` for Marketing while preserving existing timesheet and `rowId` logic for other subjects.

- [ ] **Step 6: Run focused tests and build**

Run: `node --test frontend/tests/marketing-files-alerts.test.mjs`

Expected: PASS.

Run: `npm --prefix frontend run build`

Expected: exit 0.

- [ ] **Step 7: Commit documents and reminders**

```bash
git add frontend/src/data.js frontend/src/marketing-components/MarketingDocumentPanel.jsx frontend/src/marketing-components/MarketingTaskPanel.jsx frontend/src/marketing-components/MarketingOpportunitySheet.jsx supabase/functions/send-alert/index.ts frontend/tests/marketing-files-alerts.test.mjs
git commit -m "Add Marketing files and reminders"
```

### Task 9: Opportunity List, CSV Export, Insights, and Marketing Setting

**Files:**
- Create: `frontend/src/marketing-components/MarketingList.jsx`
- Create: `frontend/src/marketing-components/MarketingInsights.jsx`
- Create: `frontend/tests/marketing-reporting.test.mjs`
- Modify: `frontend/src/marketing.jsx`
- Modify: `frontend/src/utils/csv.js`
- Modify: `frontend/src/admin.jsx`

**Interfaces:**
- Consumes: Task 1 filtered rows/insight/CSV functions, Task 4 allowed views, existing `exportCSV`.
- Produces: sortable accessible list, current-filter export, funnel/forecast/velocity/activity/loss reports, and text/table equivalents for charts.

- [ ] **Step 1: Write failing reporting tests with a fixed clock**

Use fixtures spanning Dec 2026 and Jan 2027, Won/Lost/open rows, zero-dollar rows, repeated loss reasons, and archived rows. Assert active and weighted totals, current-quarter grouping, average stage duration from history, lost-reason counts, owner/product/source breakdowns, CSV exact stage names, and that filtered export excludes hidden rows.

- [ ] **Step 2: Make CSV serialization testable without changing its browser API**

Extract and export `serializeCSV(columns, rows)` from `utils/csv.js`; `exportCSV` calls it and handles only Blob/download behavior. Test quotes, commas, newlines, zero, null, and UTF-8 BOM.

- [ ] **Step 3: Implement the Opportunity list**

Columns: opportunity, organization, exact stage, outcome, owner, estimated value, weighted value, probability, expected close, next action/due, health, days in stage, products, and last activity. Header buttons set `aria-sort`; rows open the same detail sheet; archived and Won/Lost filters remain explicit. Export uses current filtered/sorted rows.

- [ ] **Step 4: Implement accessible Insights**

Render KPI summary, stage funnel count/value/weighted value, expected closes by month/quarter, stage aging/average duration, overdue/stalled list, activity by type/owner, win rate, Won/Lost value, and lost reasons/competitors/sources/products/owners/organizations. Each visual has direct values, a legend, a screen-reader summary, and a compact table alternative. Do not use pie charts for more than five categories.

- [ ] **Step 5: Expose the stalled threshold to Admins**

Add a Marketing card to the existing Admin workspace-settings surface. It accepts an integer from 1 through 365, labels the unit as days without meaningful activity, saves through `updateMarketingSettings`, and refreshes the page-level threshold after a successful write. Non-admin users see the resulting health calculation but never the control. Add a test that 0 and 366 are rejected and 14 is saved as `marketing_stalled_after_days: 14`.

- [ ] **Step 6: Run reporting tests and build**

Run: `node --test frontend/tests/marketing-reporting.test.mjs`

Expected: PASS.

Run: `npm --prefix frontend run build`

Expected: exit 0.

- [ ] **Step 7: Commit management views**

```bash
git add frontend/src/marketing.jsx frontend/src/marketing-components/MarketingList.jsx frontend/src/marketing-components/MarketingInsights.jsx frontend/src/utils/csv.js frontend/src/admin.jsx frontend/tests/marketing-reporting.test.mjs
git commit -m "Add Marketing reporting and export"
```

### Task 10: Responsive Styling, Accessibility, State Preservation, and Failure Recovery

**Files:**
- Create: `frontend/src/design/pages/marketing.css`
- Modify: `frontend/src/design/index.css`
- Modify: `frontend/tests/redesign-surface.test.mjs`
- Create: `frontend/tests/marketing-accessibility.test.mjs`
- Modify: all Marketing JSX components only where the tests reveal missing semantics or recovery controls.

**Interfaces:**
- Consumes: existing design tokens, page layout, `@/ui` focus behavior, reduced-motion rule, and Task 4 query routing.
- Produces: production-ready responsive/accessibility behavior and explicit partial-failure recovery.

- [ ] **Step 1: Add failing design integration and accessibility tests**

Add `marketing` to the redesigned page stylesheet registry test. Compile/traverse Marketing components and assert: one `<h1>` comes from the shared page header; lanes have labeled regions; move controls are keyboard buttons; cards do not rely on color; dialogs have titles/descriptions; invalid forms expose `role="alert"`; charts expose summaries/tables; file/reminder partial failures render Retry; and the mobile stage selector has an accessible label.

- [ ] **Step 2: Implement token-driven desktop/tablet/phone layouts**

Desktop: KPI grid, sticky toolbar, horizontally scrollable seven-lane board with 300–340px lanes and sticky headings, right-side sheet. Tablet: narrower cards and two-column insight panels. Phone: one selected lane, full-width cards, sticky create action, bottom/full-height detail sheet, stacked form fields, and 44px controls. Long exact stage headings wrap; they are never ellipsized.

- [ ] **Step 3: Implement state preservation and deep-link cleanup**

Persist view and mobile stage in `localStorage["beacon.marketing.view"]` and `localStorage["beacon.marketing.stage"]`; keep filters in page state for the session. Opening a row sets `opportunity=<id>` with `history.replaceState`; closing removes only that parameter and preserves `tab`/`view`. Browser Back restores the previous opportunity/view without resetting filters or board scroll.

- [ ] **Step 4: Verify reduced motion, focus, and failure recovery**

Use existing global reduced-motion tokens; no Marketing-only animation may override them. After route/view changes focus the Marketing main heading; after failed submit focus error summary; after sheet close return focus to the originating card/row. Verify the task reminder failure and document cleanup failure each retain the core record and show a named Retry action.

- [ ] **Step 5: Run design/accessibility tests and build**

Run: `node --test frontend/tests/redesign-surface.test.mjs frontend/tests/marketing-accessibility.test.mjs`

Expected: PASS.

Run: `npm --prefix frontend run build`

Expected: exit 0.

- [ ] **Step 6: Commit responsive and accessibility work**

```bash
git add frontend/src/design/pages/marketing.css frontend/src/design/index.css frontend/src/marketing.jsx frontend/src/marketing-components frontend/tests/redesign-surface.test.mjs frontend/tests/marketing-accessibility.test.mjs
git commit -m "Polish Marketing responsive experience"
```

### Task 11: Documentation, Full Verification, and Activation Handoff

**Files:**
- Modify: `PLAN.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md` (gitignored; mirror the material AGENTS.md section locally)
- Modify: `docs/superpowers/specs/2026-10-12-marketing-pipeline-design.md` only if implementation revealed an approved factual correction.

**Interfaces:**
- Consumes: completed Tasks 1–10.
- Produces: current product/engineering documentation, fresh full-suite/build evidence, and an exact manual activation checklist.

- [ ] **Step 1: Update product and engineering documentation**

Add the dedicated Marketing workflow, exact stages, views, data tables, alerts/files, access behavior, non-goals, and activation steps to `PLAN.md` and `AGENTS.md`. Mirror the same material in local `CLAUDE.md`, preserving its intentionally different first three lines. Document migration `20261012120000_marketing_pipeline.sql`, `send-alert` redeploy, bucket, access grants for custom users, and the fact that Won/Lost never hands off downstream.

- [ ] **Step 2: Run the complete Node test suite**

Run: `node --test frontend/tests/*.test.mjs`

Expected: every test PASS; report any pre-existing or new failure by exact test name before continuing.

- [ ] **Step 3: Run production build and whitespace checks**

Run: `npm --prefix frontend run build`

Expected: Vite exits 0 and produces the application plus lazy Marketing chunk.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 4: Perform the acceptance walkthrough against a configured environment**

Use one test opportunity to verify create/reload, all seven exact stages, recommended-probability warning, IQM/BANT fields, contact, activity, task complete/reopen, reminder scheduling, document upload/download/remove, version conflict, Won closure, Lost closure, archive/restore, search/filter/sort/export, Insights, deep link, access denial, desktop/tablet/phone, keyboard, dark theme, and reduced motion. Record any environment-dependent step not run, rather than claiming it passed.

- [ ] **Step 5: Re-read the spec and check every acceptance criterion**

Create a ten-item checklist from the spec's Acceptance Criteria. For each item, cite the automated test, build evidence, or manual result that proves it. If an item lacks evidence, complete that verification or report it as unverified.

- [ ] **Step 6: Commit documentation**

```bash
git add PLAN.md AGENTS.md docs/superpowers/specs/2026-10-12-marketing-pipeline-design.md
git commit -m "Document Marketing pipeline rollout"
```

- [ ] **Step 7: Deliver activation instructions without mutating production**

Hand off these explicit operator steps: paste the migration into Supabase Studio; confirm `beacon_v2` remains exposed; deploy `send-alert`; deploy the frontend; grant Marketing to required custom users; and run the production smoke opportunity. Do not apply the migration, deploy the Edge Function, or send test email unless the user separately authorizes those production actions.

## Final Verification Commands

```bash
node --test frontend/tests/*.test.mjs
npm --prefix frontend run build
git diff --check
git status --short
```

Success means zero test failures, a Vite exit code of 0, no whitespace errors, only intended repository changes, and a requirement-by-requirement acceptance report that clearly distinguishes automated, manually verified, and production-activation-dependent behavior.
