# MHZ First-Row Remainder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MHZ/MHZ PM white invoice row the only calculated remainder while keeping MSMM as an independent editable sub row.

**Architecture:** Add small pure calculation helpers to `invoice-perspectives.js`, use them in `tables.jsx` to calculate every MHZ/MHZ PM white-row monetary cell from the editable project total minus the complete rendered sub list, and rebase linked ENG/PM reconciliation totals in `App.jsx` when shared sub values change so MSMM remains constant.

**Tech Stack:** React 18, Vite 5, plain Node assertion tests.

## Global Constraints

The first-row calculation is `Project Total - Sum(all sub rows, including MSMM)`.
MSMM must never be recalculated when another sub changes.
The behavior applies identically to `MHZ` and `MHZ PM`.
Normal unlinked `ENG` and `PM` invoice calculations must remain unchanged.

---

### Task 1: Perspective Calculation Helpers

**Files:**
- Modify: `frontend/src/invoice-perspectives.js`
- Modify: `frontend/scripts/test_invoice_perspectives.mjs`

**Interfaces:**
- Produces: `invoiceRemainderValue(total, subValues)`, `basePerspectiveOwnValue(total, subValues)`, `basePerspectiveStoredTotal(ownValue, subValues)`, and `rebaseStoredTotalForSubChange(total, oldSub, newSub)`.

- [ ] Add failing assertions showing that the MHZ remainder includes MSMM and that rebasing a linked total keeps MSMM independent from other subs.
- [ ] Run `node frontend/scripts/test_invoice_perspectives.mjs` and confirm it fails because the helpers do not exist.
- [ ] Implement the three pure helpers with numeric coercion for null/empty values.
- [ ] Run the helper test and confirm it passes.

### Task 2: Invoice Table Wiring

**Files:**
- Modify: `frontend/src/tables.jsx`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: the three helpers from Task 1 and the existing complete `subList` for each rendered invoice row.
- Produces: direct linked-MSMM edits and read-only MHZ/MHZ PM first-row remainder values for all monetary columns.

- [ ] Preserve the existing linked ENG/PM `MSMM + subs` representation and build the synthetic MSMM row from its derived value.
- [ ] Rebase linked ENG/PM Contract and monthly totals by the same delta when a shared sub cell changes.
- [ ] Replace MHZ/MHZ PM first-row Contract, Rollforward, month, Total Billed, and Total Remaining values with `project total - all sub rows` calculations.
- [ ] Remove edit handlers from calculated first-row Contract and Rollforward cells.

### Task 3: Verification

**Files:**
- Verify: `frontend/src/invoice-perspectives.js`
- Verify: `frontend/src/tables.jsx`
- Verify: `frontend/scripts/test_invoice_perspectives.mjs`

**Interfaces:**
- Consumes: completed implementation.
- Produces: passing regression test and production build.

- [ ] Run `node frontend/scripts/test_invoice_perspectives.mjs`.
- [ ] Run `npm run build` from `frontend`.
- [ ] Inspect `git diff --check`, `git diff --stat`, and the focused diff for unrelated edits.
