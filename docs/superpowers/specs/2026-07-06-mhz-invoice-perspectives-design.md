# MHZ Invoice Perspectives Design

## Goal

Add `MHZ` as a third Invoice category while keeping the existing `ENG` rows unchanged. Selected projects must appear under both `ENG` and `MHZ` as the same underlying project data viewed from different entity perspectives.

## Data Model

`anticipated_invoice.type` gains a new enum value, `MHZ`. The existing `ENG` row remains the MSMM/engineering perspective. A linked `MHZ` row is added for the same project/year/project number. The database uniqueness rule for auto-created invoice rows changes from `(source_project_id, year)` to `(source_project_id, year, type)` so a project can have parallel `ENG`, `PM`, and `MHZ` rows.

The migration backfills MHZ rows for project numbers `202514`, `202419`, `202414`, `202310`, and `202324` by copying the matching ENG invoice rows. It also ensures each linked project has an MHZ prime entry in `project_subs` where needed, without deleting or moving the existing ENG rows.

## Synchronization

Linked ENG/MHZ rows are treated as shared project records. Updates to project-level invoice data on one side propagate to the sibling perspective rows. This includes project name, project number, year, PMs, contract details, monthly billing values, notes, description, paid flags, invoice numbers, billing state, orange flag, and similar project-level invoice columns. The `type` itself remains perspective-specific.

Subconsultants remain shared. If a firm such as ABC is attached to the project, it appears in both ENG and MHZ views with the same values.

## Perspective Display

The expanded invoice breakdown changes only by perspective. In the ENG view, MSMM is the subconsultant and MHZ is shown as prime. In the MHZ view, MHZ is the prime perspective and MSMM appears as the corresponding subconsultant. Any other subconsultants remain visible in both categories.

## Future Creation

When a project/invoice name contains `HZ` or `MHZ`, Beacon prompts the user to add both ENG and MHZ perspectives. Accepting the prompt creates the normal row plus its linked MHZ/ENG sibling. Declining creates only the selected category.

## Constraints

No existing ENG row should be deleted, moved, or retyped. The live schema is `beacon_v2`, so all SQL changes must live in `supabase/migrations_v2`.
