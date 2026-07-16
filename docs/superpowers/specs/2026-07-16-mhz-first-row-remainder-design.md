# MHZ First-Row Remainder Design

## Goal

For every `MHZ` and `MHZ PM` invoice project, make the white first row the only auto-calculated remainder row. MSMM is an ordinary, independently editable sub-row. Editing a project total or any sub-row—including MSMM—must recalculate the first row and must never overwrite another sub-row.

## Root Cause

The current frontend does not store the linked MSMM value independently. It derives MSMM from the linked `ENG` or `PM` reconciliation row as `base total − shared subs`, then tries to keep that derived result stable by changing the base total whenever another sub changes. This compensating-write model applies to every linked pair and therefore causes the reported behavior across both `ENG ↔ MHZ` and `PM ↔ MHZ PM`.

## Authoritative Data Model

The existing `beacon_v2.anticipated_invoice` columns become authoritative for the linked MSMM sub-row:

- Contract: `msmm_amount`
- Roll Forward: `msmm_remaining_to_bill_year_start`
- Months: `msmm_jan_amount` through `msmm_dec_amount`
- Paid/file metadata remains on the linked base invoice row as it does today.

For a linked pair, the `ENG` or `PM` year-row owns these MSMM values. The `MHZ` or `MHZ PM` expanded view reads and writes those same fields through its synthetic MSMM sub-row. The project total remains owned by the `MHZ` or `MHZ PM` row.

An unlinked `ENG` or `PM` row retains its existing `Total − subs` derived behavior. The stored-MSMM behavior is activated only when a matching `MHZ` or `MHZ PM` sibling exists.

## Existing-Data Migration

A new idempotent migration snapshots every linked base row's currently displayed MSMM values before the frontend stops deriving them:

```text
msmm_amount = base contract_amount − sum(project_subs.amount where kind = 'sub')

msmm_<month>_amount = base <month>_amount
                      − sum(sub_invoices.amount for the same project, year,
                            month, and kind = 'sub')
```

The migration fills only NULL MSMM fields, preserving any independently stored value that already exists. It covers both pairings and every invoice year. Future linked-pair creation paths initialize the base row's MSMM fields from the same formulas, so a newly linked project never enters the compensating-write state.

## Calculation Rules

For each applicable column `C` on an `MHZ` or `MHZ PM` row:

```text
firstRow[C] = projectTotal[C] − sum(all expanded sub rows[C], including MSMM)
```

This applies independently to:

- Contract
- Roll Forward
- Every Actual/Projected month
- Total Billed
- Total Remaining

The first row is read-only for these calculated values. It is never persisted as a sub-row or copied into MSMM.

## Edit Flows

### Edit a non-MSMM sub

1. Update only that `project_subs` or `sub_invoices` record.
2. Leave all MSMM fields unchanged.
3. React recalculates the first-row remainder from the unchanged project total and the updated sub list.

### Edit MSMM

1. Update only the linked base row's matching MSMM field.
2. Leave every other sub and the project total unchanged.
3. React recalculates the first-row remainder.

### Edit Project Total

1. Update only the `MHZ` or `MHZ PM` project-total field.
2. Leave MSMM and every other sub unchanged.
3. React recalculates the first-row remainder.

No edit flow rebases `contract_amount` or a base monthly total to compensate for a sub change.

## Permissions

Every authenticated invoice user who can edit other sub-rows can edit the MSMM sub-row when viewing an `MHZ` or `MHZ PM` project. The database guard is changed accordingly for linked base rows while retaining the existing admin-only restriction for unlinked `ENG` or `PM` parent/MSMM values.

The frontend removes the admin-only lock from the synthetic MSMM sub-row's Contract, Roll Forward, and monthly cells. It does not broaden permissions on unrelated unlinked invoice rows.

## Compatibility and Rollout

- Existing paid flags, invoice files, and invoice numbers remain attached to their current base or project-total rows.
- A NULL stored MSMM value may use the old derived value only as a defensive display fallback during deployment. The migration and linked-pair creation paths are responsible for materializing the authoritative value.
- The migration must be applied with the frontend deployment; deploying only the frontend would leave existing linked rows in fallback mode.
- The previous sub-change rebase helpers and handlers are removed after stored MSMM reads/writes are active.

## Testing

Automated coverage must include:

- `ENG ↔ MHZ` and `PM ↔ MHZ PM` pair selection;
- migration arithmetic for Contract and monthly MSMM snapshots;
- editing a non-MSMM sub leaves stored MSMM unchanged;
- editing MSMM changes only MSMM;
- editing Project Total changes only Project Total;
- the exact project 012 July 2024 example, where MSMM remains `-145,403.77` and the first row absorbs the Neelu change;
- Contract, Roll Forward, Actual/Projected months, Total Billed, and Total Remaining first-row formulas;
- regular-user permission for linked synthetic MSMM and retained admin-only behavior for unlinked rows;
- frontend helper tests, production build, and SQL migration inspection.
