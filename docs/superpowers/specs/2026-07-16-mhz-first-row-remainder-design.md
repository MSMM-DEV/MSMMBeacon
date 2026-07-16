# MHZ First-Row Remainder Design

## Goal

For `MHZ` and `MHZ PM` invoice rows, make the white project row the only auto-calculated remainder row. Every monetary column on that row is the project-total value minus every expanded sub-row value, including MSMM.

## Data Semantics

- The expanded `Project total` row remains the editable project-total source.
- Every real sub row remains independently editable.
- The synthetic MSMM sub row reads and writes the linked `ENG` or `PM` reconciliation row. Existing data stores `MSMM + shared subs` there, so MSMM is displayed as that total minus the shared subs.
- The MHZ/MHZ PM white row is read-only for calculated monetary values.

For each column `C`:

```text
whiteRow[C] = projectTotal[C] - sum(expandedSubRows[*][C])
```

This applies independently to Contract, Rollforward, every Actual/Projected month, Total Billed, and Total Remaining.

## Update Flow

Editing the project total changes only the project-total source value. Editing MSMM rewrites the linked ENG/PM reconciliation total as `typed MSMM + current subs`. Editing another sub changes that sub and rebases the linked ENG/PM reconciliation total by the same delta, keeping the displayed MSMM value unchanged. React then recomputes the white-row remainder from the updated inputs; no edit handler writes the white-row remainder back to another row.

## Compatibility

Normal ENG/PM projects without an MHZ/MHZ PM sibling keep their existing `total minus subs` MSMM calculation. Linked ENG/PM rows keep the same storage representation for compatibility with live data; only their sub-edit handlers add the delta-preservation behavior.

## Testing

Pure helper tests cover:

- the provided contract-style remainder example, including MSMM in the subtraction;
- linked MSMM values remaining unchanged when another sub changes;
- persistence of linked MSMM edits as `MSMM + current subs`;
- preservation of the existing derived behavior for unlinked ENG/PM rows.

The frontend production build provides integration-level syntax and bundling verification.
