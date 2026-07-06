# MHZ Invoice Perspectives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MHZ invoice perspective rows linked to existing ENG rows, with synchronized project data and perspective-aware prime/sub display.

**Architecture:** Keep the existing `anticipated_invoice.type` model and extend it with `MHZ`. Add pure frontend helpers for invoice type options, HZ detection, linked-row sync, and row-chip tone so the large React files call one shared implementation. Add a v2 migration to extend the enum, relax the uniqueness rule to include type, backfill the five MHZ rows, and seed an MHZ prime firm entry for the linked projects.

**Tech Stack:** Supabase Postgres migrations, Vite React frontend, plain Node-based helper tests.

## Global Constraints

No existing ENG invoice rows may be deleted, moved, or retyped.
The live database schema is `beacon_v2`.
Project numbers to seed into MHZ: `202514`, `202419`, `202414`, `202310`, `202324`.
Linked ENG/MHZ rows synchronize project information and billing values, while `type` remains perspective-specific.

---

### Task 1: Pure Invoice Perspective Helpers

**Files:**
- Create: `frontend/src/invoice-perspectives.js`
- Create: `frontend/scripts/test_invoice_perspectives.mjs`

**Interfaces:**
- Produces: `INVOICE_TYPE_OPTIONS`, `HZ_INVOICE_TYPES`, `invoiceTypeTone(type)`, `projectNameSuggestsMhz(name)`, `linkedInvoicePatch(patch)`, `linkedInvoiceIdsFor(row, rows)`

- [ ] Write helper tests for HZ detection, type tone, and linked patch filtering.
- [ ] Run the helper test and verify it fails before implementation.
- [ ] Implement the helpers.
- [ ] Run the helper test and verify it passes.

### Task 2: Database Migration

**Files:**
- Create: `supabase/migrations_v2/20260706120000_mhz_invoice_perspectives.sql`

**Interfaces:**
- Consumes: `beacon_v2.invoice_type_enum`, `beacon_v2.anticipated_invoice`, `beacon_v2.project_subs`, `beacon_v2.companies`.
- Produces: enum value `MHZ`, unique index `(source_project_id, year, type) where source_project_id is not null`, copied MHZ invoice rows for the five project numbers.

- [ ] Write idempotent SQL that adds enum value `MHZ`.
- [ ] Replace the source/year unique index with a source/year/type unique index.
- [ ] Insert MHZ rows by copying matching ENG rows for the five project numbers where missing.
- [ ] Ensure an `MHZ` company exists and add it as a `prime` project_subs row on the linked projects where missing.

### Task 3: Wire Frontend Options And Sync

**Files:**
- Modify: `frontend/src/tables.jsx`
- Modify: `frontend/src/panels.jsx`
- Modify: `frontend/src/forms.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/data.js`

**Interfaces:**
- Consumes helpers from `frontend/src/invoice-perspectives.js`.
- Produces: `MHZ` type in manual creation, move-forward panels, filters, row chips, default sorting, and linked ENG/MHZ update propagation.

- [ ] Replace hard-coded `["ENG", "PM"]` invoice type options with `INVOICE_TYPE_OPTIONS`.
- [ ] Update type ranking and chip tones for `MHZ`.
- [ ] Propagate shared invoice scalar updates to linked ENG/MHZ rows using `linkedInvoiceIdsFor` and `linkedInvoicePatch`.
- [ ] Propagate PM join changes to linked sibling rows.
- [ ] When a name contains `HZ`/`MHZ`, prompt during invoice creation/move paths to create both ENG and MHZ perspectives.

### Task 4: Perspective-Aware Breakdown

**Files:**
- Modify: `frontend/src/tables.jsx`

**Interfaces:**
- Consumes invoice row `type`, project `role`, and `project_subs` entries.
- Produces: ENG rows display MHZ as prime; MHZ rows display MSMM/MHZ perspective while retaining all other subconsultants.

- [ ] Keep existing ENG parent rows and expand behavior intact.
- [ ] Make the expanded breakdown include the MHZ prime entry on ENG rows.
- [ ] Keep all sub entries visible in both ENG and MHZ categories.

### Task 5: Verification

**Files:**
- Verify all changed frontend and migration files.

- [ ] Run `node frontend/scripts/test_invoice_perspectives.mjs`.
- [ ] Run `npm run build` from `frontend`.
- [ ] Inspect `git diff --stat` and the relevant diffs for accidental unrelated changes.
