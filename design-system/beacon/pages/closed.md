# Closed Out — page design

## Purpose and user needs
Closed Out is a historical workspace, not a deleted-items bin. Users verify completed project billing, find attachments and notes, reopen invoiced projects when necessary, and understand why proposals ended before billing began.

## Information and action priorities
- Distinguish the preserved billing archive from closures with no billing rows. Both remain visible and keep their current filtering and data sources.
- Billing history retains the full shared InvoiceTable and its existing reopen, files, notes, month editing and sub-invoice controls.
- The compact closure register prioritizes project identity, closure date and reason, then client and manager. Contract references remain available in Columns.
- Make Open details a visible single-click action alongside the existing reminder action; retain double-click details and inline editing.

## Organization and visual treatment
Use a quiet frosted archive navigator with in-page links and counts, followed by separately named solid-surface sections. Avoid success-alert styling that implies the archive was just created. Wrap project names, client names, reasons and notes, use tabular dates/amounts, and keep row actions visible. Mobile links stack and wide registers scroll only within the table. Theme tokens and reduced-motion support follow MASTER.md.

## Preservation contract
No changes to classification, source matching, rows, calculations, save handlers, permissions, exports or data APIs. This implementation changes only section markup, column presentation, readable cell rendering and existing action affordances.
