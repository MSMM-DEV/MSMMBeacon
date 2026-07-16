# MHZ Independent MSMM and First-Row Remainder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the white first row the only automatically changing remainder for every MHZ/MHZ PM invoice while storing MSMM as an independently editable sub-row value.

**Architecture:** React reads linked MSMM Contract and month values from the existing `anticipated_invoice.msmm_*` columns on the ENG/PM base year-row and writes those columns directly. A migration snapshots every currently displayed linked MSMM value, permits regular users to edit linked MSMM fields, and initializes future linked pairs. Non-MSMM sub and project-total writes remain isolated, so render-time `Project Total − all subs` math changes only the white first row.

**Tech Stack:** React 18, Vite 5, Supabase Postgres/PostgREST (`beacon_v2`), plain Node assertion tests.

## Global Constraints

The first-row calculation is `Project Total − Sum(all sub rows, including MSMM)`.
MSMM must never be recalculated or overwritten when any other sub changes.
Editing MSMM must change only the stored MSMM field.
Editing Project Total must change only the MHZ/MHZ PM total field.
The behavior and permissions apply identically to `ENG ↔ MHZ` and `PM ↔ MHZ PM`.
Every authenticated invoice user may edit the synthetic MSMM sub-row on linked MHZ/MHZ PM projects.
Unlinked ENG/PM rows retain their existing derived and admin-gated behavior.

---

### Task 1: Stored-MSMM Selection Contract

**Files:**
- Modify: `frontend/src/invoice-perspectives.js`
- Modify: `frontend/scripts/test_invoice_perspectives.mjs`

**Interfaces:**
- Produces: `linkedMsmmValue({ linked, storedValue, total, subValues }): number`.
- Removes after consumers migrate: `basePerspectiveStoredTotal`, `rebaseStoredTotalForSubChange`, and `linkedBaseInvoiceRowsForSubRebase`.

- [ ] **Step 1: Write failing stored-value assertions**

Add assertions that a linked stored value remains unchanged when the external sub list changes, while an unlinked/null value falls back to `total − subs`:

```js
assert.equal(linkedMsmmValue({
  linked: true,
  storedValue: -29457.90,
  total: 48556.71,
  subValues: [48556.71],
}), -29457.90);
assert.equal(linkedMsmmValue({
  linked: true,
  storedValue: -29457.90,
  total: 58556.71,
  subValues: [58556.71],
}), -29457.90);
assert.equal(linkedMsmmValue({
  linked: false,
  storedValue: null,
  total: 100000,
  subValues: [25000],
}), 75000);
```

- [ ] **Step 2: Run the helper test and verify RED**

Run: `cd frontend && node scripts/test_invoice_perspectives.mjs`

Expected: module import failure because `linkedMsmmValue` is not exported.

- [ ] **Step 3: Implement the minimal selector**

```js
export function linkedMsmmValue({ linked = false, storedValue = null, total = 0, subValues = [] } = {}) {
  if (linked && storedValue != null && storedValue !== "") return invoiceNumber(storedValue);
  return basePerspectiveOwnValue(total, subValues);
}
```

- [ ] **Step 4: Add both perspective-pair fixtures**

Assert that the helper is used with stored values for an ENG/MHZ base row and a PM/MHZ PM base row, including a stored zero and a negative value.

- [ ] **Step 5: Run the helper test and verify GREEN**

Run: `cd frontend && node scripts/test_invoice_perspectives.mjs`

Expected: `invoice perspective helper tests passed`.

---

### Task 2: Database Snapshot, Future Initialization, and Permissions

**Files:**
- Create: `supabase/migrations_v2/20260716130000_mhz_msmm_independent.sql`
- Create: `frontend/scripts/test_mhz_msmm_migration.mjs`

**Interfaces:**
- Produces: authoritative linked values in `anticipated_invoice.msmm_amount`, `msmm_remaining_to_bill_year_start`, and `msmm_{jan..dec}_amount`.
- Produces: `beacon_v2.materialize_linked_msmm(uuid)` and `beacon_v2.tg_materialize_linked_msmm()`.
- Replaces: `beacon_v2.guard_msmm_admin_only()` with linked-base permission handling.

- [ ] **Step 1: Write a failing migration contract test**

Create a Node test that loads the planned SQL file and asserts the required structural statements:

```js
const sql = readFileSync(new URL("../../supabase/migrations_v2/20260716130000_mhz_msmm_independent.sql", import.meta.url), "utf8");
assert.match(sql, /create or replace function beacon_v2\.materialize_linked_msmm/i);
assert.match(sql, /msmm_amount\s*=\s*coalesce\(base\.msmm_amount/i);
assert.match(sql, /msmm_jul_amount/i);
assert.match(sql, /'ENG'.*'MHZ'/is);
assert.match(sql, /'PM'.*'MHZ PM'/is);
assert.match(sql, /authenticated non-admins may edit linked MSMM/i);
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `cd frontend && node scripts/test_mhz_msmm_migration.mjs`

Expected: `ENOENT` because the migration does not exist.

- [ ] **Step 3: Implement idempotent materialization**

Create a SECURITY DEFINER function that locks the requested base row, confirms its type is ENG or PM and that a same-year linked HZ sibling exists by source ID or normalized project number, then fills only NULL MSMM fields. Contract subtracts `project_subs(kind='sub')`; each month subtracts the matching `sub_invoices(kind='sub', year, month)` sum.

The update shape must preserve existing independent inputs:

```sql
update beacon_v2.anticipated_invoice base
   set msmm_amount = coalesce(base.msmm_amount, base.contract_amount - v_contract_subs),
       msmm_jan_amount = coalesce(base.msmm_jan_amount, base.jan_amount - v_month_subs[1]),
       msmm_feb_amount = coalesce(base.msmm_feb_amount, base.feb_amount - v_month_subs[2]),
       msmm_mar_amount = coalesce(base.msmm_mar_amount, base.mar_amount - v_month_subs[3]),
       msmm_apr_amount = coalesce(base.msmm_apr_amount, base.apr_amount - v_month_subs[4]),
       msmm_may_amount = coalesce(base.msmm_may_amount, base.may_amount - v_month_subs[5]),
       msmm_jun_amount = coalesce(base.msmm_jun_amount, base.jun_amount - v_month_subs[6]),
       msmm_jul_amount = coalesce(base.msmm_jul_amount, base.jul_amount - v_month_subs[7]),
       msmm_aug_amount = coalesce(base.msmm_aug_amount, base.aug_amount - v_month_subs[8]),
       msmm_sep_amount = coalesce(base.msmm_sep_amount, base.sep_amount - v_month_subs[9]),
       msmm_oct_amount = coalesce(base.msmm_oct_amount, base.oct_amount - v_month_subs[10]),
       msmm_nov_amount = coalesce(base.msmm_nov_amount, base.nov_amount - v_month_subs[11]),
       msmm_dec_amount = coalesce(base.msmm_dec_amount, base.dec_amount - v_month_subs[12])
 where base.id = p_base_id;
```

- [ ] **Step 4: Backfill every existing linked base year-row**

Use a DO block to call `materialize_linked_msmm(id)` for each ENG row with an MHZ sibling and each PM row with an MHZ PM sibling. Keep the same-year and same-source-or-number linkage rules used by the frontend.

- [ ] **Step 5: Initialize future linked pairs**

Create an `AFTER INSERT OR UPDATE OF source_project_id, project_number, type, year` trigger. When the changed row is a base, materialize it if its HZ sibling exists. When it is HZ, locate and materialize the matching base row. The trigger must not fire recursively when only MSMM columns change.

- [ ] **Step 6: Permit regular-user edits only for linked base MSMM**

Replace `guard_msmm_admin_only()` so service role, Studio/no-JWT, and Admin remain allowed. For an authenticated non-admin changing an MSMM field, allow the change only when OLD is ENG with an MHZ sibling or PM with an MHZ PM sibling for the same year and lineage. Continue raising `42501` for unlinked rows.

- [ ] **Step 7: Run the migration test and verify GREEN**

Run: `cd frontend && node scripts/test_mhz_msmm_migration.mjs`

Expected: `MHZ independent MSMM migration contract passed`.

---

### Task 3: Direct MSMM Writers and Isolated Sub Saves

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/invoice-perspectives.js`
- Modify: `frontend/scripts/test_invoice_perspectives.mjs`

**Interfaces:**
- Produces: `editInvoiceMsmmMonth(mergedBaseRow, year, monthIdx, value)`.
- Produces: `updateInvoiceMsmmFields(id, patch)` for `msmmAmount` and `remainingStart` without sibling fan-out.
- Consumes: `INVOICE_MSMM_MONTH_COLS` and `resolveInvoiceYearId`.

- [ ] **Step 1: Replace rebase-oriented test expectations**

Delete assertions that expect a sub edit to change a base `contract_amount` or monthly total. Add state-transition assertions showing these isolated patches:

```js
assert.deepEqual(msmmPatchForMonth(6, -29457.90), { msmm_jul_amount: -29457.90 });
assert.deepEqual(msmmFieldPatch({ msmmAmount: 295632.97 }), { msmm_amount: 295632.97 });
```

- [ ] **Step 2: Run tests and verify RED for the new patch helpers**

Run: `cd frontend && node scripts/test_invoice_perspectives.mjs`

Expected: missing `msmmPatchForMonth` / `msmmFieldPatch` exports.

- [ ] **Step 3: Add minimal pure DB-patch helpers**

Implement helpers in `invoice-perspectives.js` using the exact 12 MSMM column names and allowing `null` as an explicit stored value only for compatibility/reset operations.

- [ ] **Step 4: Implement direct App writers**

Add `msmmAmount: "msmm_amount"` to the invoice DB column map, but route synthetic MSMM edits through a dedicated writer that targets only the base row ID. Add a year-aware month writer that updates `msmmValues[monthIdx]` optimistically and PATCHes only `msmm_{month}_amount`.

- [ ] **Step 5: Delete compensating sub rebases**

Remove `rebaseLinkedBaseContractTotals`, `rebaseLinkedBaseMonthTotals`, their imports/helpers, and the base-update payloads passed through `refreshInvoiceArtifacts`. Restore `updateSubInvoiceCell` to `upsertSubInvoiceAmount` followed by artifact refresh. Restore `updateSubMeta` to updating only `project_subs` plus its local project/sub matrix mirrors.

- [ ] **Step 6: Keep future year rows initialized**

When `resolveInvoiceYearId` mints a linked base year-row, rely on the migration trigger to materialize its MSMM fields and select the returned row again when necessary before adapting it. When `maybeCreateHzInvoiceSibling` creates a pair, reload the materialized base row so local state sees the stored snapshot immediately.

- [ ] **Step 7: Run helper tests and verify GREEN**

Run: `cd frontend && node scripts/test_invoice_perspectives.mjs`

Expected: `invoice perspective helper tests passed`.

---

### Task 4: Invoice Table Reads and Red/Black-Box Edit Behavior

**Files:**
- Modify: `frontend/src/tables.jsx`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- InvoiceTable consumes: `updateMsmmMonth(baseRow, year, monthIdx, value)` and `updateMsmmFields(baseRowId, patch)`.
- InvoiceTable produces: read-only first-row remainder cells and editable linked synthetic MSMM cells.

- [ ] **Step 1: Read stored linked MSMM with derived fallback**

Change `msmmContractShown`, `msmmAtDesc`, and `msmmAtYM` so linked base rows prefer `msmmAmount` / `byYear[year].msmmValues[monthIdx]` through `linkedMsmmValue`. Unlinked rows continue using `basePerspectiveOwnValue(total, subs)`.

- [ ] **Step 2: Write MSMM fields directly**

Change `setMsmmContract` to call `updateMsmmFields(row.id, { msmmAmount: typed })`. Change `setMsmmMonth` to call `updateMsmmMonth(row, year, monthIdx, typed)`. Change the linked synthetic Roll Forward editor to call `updateMsmmFields(base.id, { remainingStart: value })`.

- [ ] **Step 3: Remove the synthetic MSMM admin lock**

For the expanded MHZ/MHZ PM MSMM sub row, keep Contract, Roll Forward, and months editable regardless of `canEditMsmm`. Preserve the lock on unlinked ENG/PM parent cells.

- [ ] **Step 4: Preserve the first-row formula**

Keep `firstRowContract`, `firstRowRollforward`, `firstRowMonth`, `firstRowTotalBilled`, and `firstRowTotalRemaining` as `Project Total − invoiceSubRowsFor(r)`, where `invoiceSubRowsFor` includes the stored synthetic MSMM line. These red-box cells remain disabled/read-only.

- [ ] **Step 5: Verify the screenshot arithmetic manually in the helper test**

Add a fixture where Project Total month is `67,655.52`, Tetra Tech is `48,556.71`, MSMM is `-29,457.90`, and confirm the first-row remainder is `48,556.71`. Then change Tetra Tech while holding MSMM fixed and assert only the first-row result changes.

---

### Task 5: Secondary Consumers Use the Same Stored MSMM

**Files:**
- Modify: `frontend/src/invoice-charts.jsx`
- Modify: `frontend/src/utils/manish-xlsx.js`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/scripts/test_manish_xlsx.mjs`

**Interfaces:**
- Consumes: `linkedMsmmValue` and linked base rows.
- Produces: charts and exports that agree with the Invoice table after an MSMM or sub edit.

- [ ] **Step 1: Add failing export assertions**

Extend the Manish export fixture with a linked base row whose derived MSMM differs from its stored MSMM. Assert the exported MSMM amount equals the stored value, including stored zero.

- [ ] **Step 2: Verify RED**

Run: `cd frontend && node scripts/test_manish_xlsx.mjs`

Expected: exported value still equals `total − subs` instead of the stored value.

- [ ] **Step 3: Update charts and exports**

For ENG/PM chart rows, prefer each year-row's `msmmValues[month]` when the base row has an HZ sibling; otherwise derive. For MHZ/MHZ PM exports, resolve the linked base row and use its stored MSMM values while retaining paid/file metadata on that base row. Update the Mark Subs PDF helpers in `App.jsx` to use the same stored-or-derived rule.

- [ ] **Step 4: Verify GREEN**

Run: `cd frontend && node scripts/test_manish_xlsx.mjs`

Expected: export tests pass with stored negative, positive, and zero MSMM values.

---

### Task 6: Full Verification, Documentation, Commit, and Push

**Files:**
- Verify all files above.
- Modify if needed: `AGENTS.md` and `CLAUDE.md` only to replace the obsolete `MSMM is purely derived` repository guidance with the linked stored-MSMM rule.

**Interfaces:**
- Produces: a deployable frontend plus required idempotent database migration.

- [ ] **Step 1: Run focused tests**

```bash
cd frontend
node scripts/test_invoice_perspectives.mjs
node scripts/test_mhz_msmm_migration.mjs
node scripts/test_manish_xlsx.mjs
```

Expected: all three scripts pass.

- [ ] **Step 2: Run the production build**

Run: `cd frontend && npm run build`

Expected: Vite build succeeds; the existing large-chunk advisory is acceptable.

- [ ] **Step 3: Inspect migration and diff hygiene**

```bash
git diff --check
git status --short
git diff --stat
git diff -- supabase/migrations_v2/20260716130000_mhz_msmm_independent.sql frontend/src/App.jsx frontend/src/tables.jsx frontend/src/invoice-perspectives.js
```

Confirm the unrelated `.claude/worktrees/projects-collapse-default` entry is untouched and unstaged.

- [ ] **Step 4: Commit only the implementation files**

Stage explicit paths and commit with:

```bash
git commit -m "Make MHZ MSMM values independent"
```

- [ ] **Step 5: Push main and verify the remote SHA**

```bash
git push origin main
git ls-remote origin refs/heads/main
```

- [ ] **Step 6: Apply the migration before validating production behavior**

Paste `supabase/migrations_v2/20260716130000_mhz_msmm_independent.sql` into Supabase Studio SQL Editor and run it, then deploy the frontend. Validate one MHZ and one MHZ PM project by editing a normal sub, MSMM, and Project Total; in all three cases only the white first-row remainder auto-updates.
