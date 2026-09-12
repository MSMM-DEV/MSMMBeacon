# Potential — opportunity review

## Purpose and user needs
This legacy, deep-linked page holds early opportunities before billing. Users qualify likelihood, identify ownership and upcoming follow-up, compare MSMM and total contract exposure, review the full record, and use the existing move-to-Invoice action when appropriate. It remains hidden from primary navigation.

## Information and actions
Project identity, probability and dates/comments precede ownership and value. Client and reference details remain available through the existing Columns control. Existing probability/role grouping and every subtotal/grand-total calculation remain unchanged. The primary row action is explicitly labelled **To Invoice**; **Details** opens the existing drawer with one click, and an adjacent alert action keeps reminders accessible.

## Organization and visual treatment
Use a compact frosted orientation bar above the opaque opportunity register. Default columns prioritize Project, Probability, Dates & Comments, PM, MSMM, Contract and Client; reference columns remain selectable. Full names, comments and notes wrap; money uses tabular figures. Restore the PM and Project Number display cells by matching their existing column labels (a presentation-key mismatch), without altering data.

## Interaction and accessibility
Keep existing inline edits, selection, filter/search/year controls, sorting, exports, probability colors, row drawer and move/alert handlers intact. Actions have visible labels or descriptive accessible names, focus rings, and larger phone targets. Wide grids scroll within the shared table wrapper, never the document. Subtle surface entrance and color feedback respect reduced motion. Semantic tokens supply independent light/dark surfaces.

## Verification
Focused JSX and CSS compilation and whitespace validation; integrated browser QA belongs to the parent. No backend, data, API, business calculation, navigation exposure, or write-path changes.
