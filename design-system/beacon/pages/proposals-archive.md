# Deleted proposals and awarded — recovery workspace

## Page understanding

- Purpose: recover a deleted proposal or awarded project without losing the retained record.
- User task: identify the correct project, check its stage-specific details, and restore it to its original list.
- Priority information: original list, project identity, client, and retained proposal/delivery fields; the number of records helps locate the right section.
- Primary action: the existing per-row Restore action. No bulk recovery or deletion operation is introduced.
- Organization: a compact recovery guide with section jump links, followed by separately labelled Proposals and Awarded registers. Each section states the restore destination. An all-clear empty state explains where future deleted records appear.

## Design decisions

The shared cool-white/graphite system applies. Frosted navigation supports solid data registers. Counts are adjacent to their explicit destinations, headings and helper text wrap, and anchor targets reserve clearance for sticky chrome. Reuse the already-redesigned AwaitingTable and AwardedTable so search, columns, and recovery actions remain consistent. A single restrained entrance animation respects reduced motion.

## Preservation and verification

All table props, calculations, deleted-mode state, read-only update callback, invoice linkage props and restore callbacks are preserved verbatim. Only the assigned render block and page CSS change. Syntax is verified locally; parent performs integrated browser checks without restoring live records.
