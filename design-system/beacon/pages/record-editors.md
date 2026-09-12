# Record editors and overlays

## Tasks and priorities
- Create: enter identity first, then ownership, commercial details and notes. Preserve every table-specific field and validation. Make groups scannable and distinguish required from optional input.
- Detail: inspect and edit the selected record without losing the table. Keep its full identity and stage visible; give each related-information group room. Existing edit-on-blur semantics remain unchanged.
- Move: understand the destination, complete only new fields, and verify the inherited data. Present inherited values as a collapsible review so they do not bury the actual work.
- Alert: choose recipients, date anchor, send time, recurrence and message, with the first-send summary beside the action.
- Invoice files: identify the invoice, inspect/open current attachments, stage files, then upload. Paid state and invoice-number edits retain their exact current permissions and write paths.
- Merge/confirmation: distinguish the survivor and consequence clearly; retain cancellation and all permission checks.

## Implementation
Use cool token-driven solid field surfaces, a subtly frosted contextual header, clear section labels, readable full record and file names, and a single scrolling body between fixed header/footer. Invoice Files adopts the existing Radix shell for focus containment and keyboard dismissal; no handlers or data logic change. All forms have touch-friendly controls at phone widths and wrap supporting text. Shared motion comes from the dialog/sheet primitives and honors reduced motion.

## Verification boundary
Syntax/build checks are local. Parent owns integration and read-only browser checks; do not submit any form against live data during review.
