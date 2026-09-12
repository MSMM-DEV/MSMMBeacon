# Proposals — decision queue

## Purpose and user priorities

Proposals are submitted engineering opportunities awaiting a client decision. Project managers review what was submitted, how long it has waited, when a result is expected, who owns it, and the remaining contract value. Their decisive actions are awarding the work or closing it out. Reminders and deeper edits support that review.

## Organization

- A quiet orientation strip explains the decision workflow without fabricated statistics.
- The default table emphasizes project, client, role, submitted date, expected result, value and project manager. Year, contract references and the duplicated project number remain available through the existing column picker and exports.
- Project identity wraps and includes its reference number; a visible details control supports single-click and keyboard access while inline edits remain available.
- Award and Close out use labeled row controls. Alerts, details and deletion retain their existing callbacks in the secondary menu. Deleted records show Restore instead of verdict actions.
- Search, organization grouping, user sorting, year filtering, column resizing/reordering, maximizing and the existing data snapshot are preserved.
- At 767px and below the same processed rows and field editors reflow into vertical records. Real field labels identify each value; Project wraps with its reference and Details control, followed by the other visible fields and an exposed Award / Close out / More footer. Columns reveals optional fields as additional labeled entries. Organization headings and counts retain their place in the list.
- Mobile column headers are removed from display and keyboard navigation; Sort remains available in the toolbar. Inputs use 16px text, controls have 44px touch targets, and records do not require horizontal scrolling. Desktop column widths, order, resizing and data snapshots remain unchanged.
- Mobile records use neutral theme surfaces, a quiet border, 12px corners and 12px separation. Selection shares the identity header; field padding stays compact around the 44px edit targets. Touch devices do not tint whole records or outline every editor on hover.

## Visual and interaction system

Inherit `../MASTER.md`. Use neutral theme surfaces, cobalt emphasis, quiet borders, generous row identity spacing and tabular values. Glass treatment belongs in the orientation chrome; the working table stays legible. Action labels do not truncate. Wide data grids scroll inside their own viewport, not the document. Focus states remain visible and reduced motion disables entrance/press transforms.

## Skill evidence

`ui-ux-pro-max` enterprise proposal search verified Minimalism / Swiss as appropriate for enterprise software. Its marketing hero recommendation did not match this task; the focused `enterprise dashboard` style search verified Data-Dense Dashboard guidance, so this page uses task controls and a working grid instead. React stack guidance supports labeled controls and accessible role/name queries during verification.

## Scope

Presentation only in `AwaitingTable` and `design/pages/proposals.css`; no business calculations, APIs, data mapping or persistence handlers changed.
