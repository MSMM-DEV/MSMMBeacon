# Awarded projects

## Purpose and user tasks
Project managers review awarded work, maintain delivery stages, watch remaining MSMM contract capacity and expiration dates, and connect each award to invoice projects. Partner firms, contract references and submission history support those tasks. Existing inline edits, organization grouping, column customization, year/search/filter controls, alerts, billing transitions and restore/delete flows must remain intact.

## Priority and organization
Lead the register with project identity, client, delivery stage, remaining capacity, expiry, project managers and linked invoice projects. Place contract totals and usage next, followed by reference and partner information. This makes the first horizontal viewport useful for active project review while every original field remains available through the existing grid.

Above the register, use a restrained review strip summarizing the supplied project set: project count, contracts expiring inside the existing 180-day runway, expired contracts, and capacity below the existing 20% threshold. Clearly label the scope so table search is not mistaken for the summary scope. Reuse the existing expiry/capacity presentation helpers without new business rules.

## Actions and interactions
Provide a visible, keyboard-accessible project-details button beside the project reference; preserve inline name editing. Make the billing transition a labeled action and retain alerts and deletion in the existing Radix overflow menu. Restore mode retains its dedicated action. Use wrap-safe names, stages, metadata and details; wide data stays inside the table scroll container. Existing grid keyboard behavior, resizing, reordering and export integration remain unchanged.

## Visual system
Use MASTER.md's cool surfaces and cobalt accents, with subtle translucent summary surfaces over an opaque readable grid. Avoid whole-row status color fills. Separate organizations with quiet section rules. Typography is Geist, tabular money/date figures, readable supporting labels. Hover feedback uses color and opacity, with a short transform/opacity section entrance and reduced-motion support.

## Verification
Check JSX build, original column coverage and handlers, long text wrapping, summary scope, light/dark themes and narrow-screen containment during parent integration. No backend, data, API or package changes.

## Approved compact refinement
Details display the first 20 whitespace-delimited words and literal `...` only when more words follow. A three-line preview protects row height even for long unbroken tokens; the original value stays in the textarea and write path. A visible keyboard-accessible “Read full details” button opens the existing project drawer.

Below 768px, the same processed table rows reflow into labeled records. Project, client, delivery stage, remaining capacity, expiry and named PMs lead the default column order; invoice links and existing actions remain available. Columns continues to reveal references and all additional fields, and sorting/filtering/grouping remain owned by TableView. Mobile field labels are real text, and desktop column-header controls are hidden on phones. Labeled To Invoice and Restore buttons use inline flex layout and content-sized height, with 44px touch targets on phones.

Mobile records pair Client/Stage, Remaining/Expiry, and PM/Invoice links in the default column order. Selection uses a 44px label target beside project identity. Record content follows page scrolling; a separate table scroll remains only in maximized mode.
