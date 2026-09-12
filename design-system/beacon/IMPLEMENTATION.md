# Local frontend redesign — September 11, 2026

The existing master direction is retained with the user's requested glass treatment: frosted navigation and floating controls, subtle cool illumination on the canvas, opaque working data, cobalt actions. Light and dark themes are composed separately. UI-UX-Pro-Max's enterprise minimalism and glassmorphism guidance applies; its generated marketing hero pattern does not fit this internal workspace.

## Work plan

1. Dedicated Astra page owners study purpose, tasks, information priorities, actions, and organization before implementing; record assessments in pages/.
2. Rebuild global theme, navigation, typography, feedback, tables and overlay primitives.
3. Integrate each page's presentation changes while preserving data access, calculations, permission checks and write handlers.
4. Run frontend build and existing tests, then inspect local desktop/mobile and light/dark screens, dialogs, navigation and overflow.
5. Keep development local and unpushed for user review.

## Page coverage

Proposals, Awarded, Invoice, In-Between, Closed Out, Projects, Project Detail, Events & Other, Directory, Licenses, Time & Leave, Time Admin, Team Calendar, Login, Admin/Settings, Potential, Hot Leads, Open Bids, Deleted Leads, Deleted Proposals. Hidden pages remain reachable by their existing deep links without adding them to the primary navigation.

## Implementation boundaries

Page owners edit exact function boundaries in shared files, and their own page CSS only. Parent owns App.jsx shell and styles/imports. Reuse React 18, Radix, Lucide and current CSS infrastructure. Do not change data.js, API modules, migrations, backend, business rules, exports or live records. Do not commit, deploy or push.

## Verification standard

Meaningful content must be readable at 375px, 768px and desktop widths. Wide financial registers may scroll inside their containers; the document may not overflow. Long labels wrap or have an operable full-text disclosure. All actions have accessible names; focused content remains visible. Motion respects reduced-motion. Any unavailable authenticated verification must be stated accurately rather than assumed.

## Integrated design decisions

- Kept the existing React/Radix/Lucide stack and semantic token aliases. No package migration was needed.
- Replaced the inert global search with a working keyboard-accessible page finder; added a direct theme control and an expanded-by-default, collapsible navigation rail.
- Used page-specific information hierarchies rather than a single reskinned table. Individual assessments are in the 20 page documents, with shared record editors documented separately.
- Made cross-workspace financial metrics user-operable disclosures. Following the approved refinement, Invoice opens both the workspace snapshot and Revenue outlook by default; other lifecycle pages keep the snapshot optional.
- Labelled lifecycle actions and added table-scroll guidance. Full reference fields remain accessible through Columns, Full register, details or existing disclosures.
- Redesigned light/dark surfaces independently. Cobalt is the default; old stored accent keys remain compatible.

## Verification record

- Separate `gpt-6-astra` page agents covered every listed page. Another Astra agent reviewed preservation of business/data behavior.
- Frontend production build passes; existing CSS-library `@charset` and bundle-size warnings remain.
- All 136 regression tests pass: semantic color contrast, reduced-motion, CSS import coverage and icon-registry checks in addition to the original 131 behavior tests.
- Read-only authenticated browser checks at 375px and 768px covered all 17 tab routes. No document-width overflow; dense financial grids intentionally scroll internally. Desktop layouts were inspected at 1280px, 1440px and 1920px.
- Inspected both themes, sidebar collapse, page finder, project detail/settings, license create form, personal day editor, leave, Time Admin subviews, administration roster, record create/detail/move panels and invoice-files dialog. Sign-in light layout was inspected on its separate localhost origin.
- Fixed issues found in browser verification: constrained wrapped project-tree rows, oversized mobile day-editor header, stretched mobile switches, numeric total-column clipping, missing archive icons, and chart plots collapsing inside the new disclosure. Both chart plots now retain an explicit 320px height.
- No forms were submitted, records edited, alerts dispatched, approvals issued, files uploaded or punches made during verification.
- `data.js`, API/library modules, backend, migrations, scripts and data files remain unchanged. No commits, deployments or pushes.

## Approved Proposals / Awarded / Invoice refinement

- Dedicated Astra owners refined each of the three pages, with a separate read-only preservation review. UI-UX-Pro-Max guidance informed phone record layouts, progressive disclosure, semantic contrast and reduced-motion handling.
- Awarded Details uses a twenty-word display preview with literal `...` when truncated, plus a three-line visual limit. The original full text and its existing drawer/editor remain intact. The To Invoice action has a properly sized, labeled button.
- Replaced hard right-pinned column borders/shadows with a narrow, theme-aware gradient. Sticky behavior and column resizing remain unchanged.
- Proposals and Awarded use labeled phone records. Invoice presents one selectable month, billed/remaining totals and touch-sized actions; its existing billing breakdown reveals secondary fields and original firm/month editors. No parallel calculation or save path was introduced.
- Invoice snapshot and Revenue outlook open initially. Phone revenue uses the same computed monthly figures instead of squeezing the desktop chart onto a phone.
- Shared dark surfaces are neutral charcoal with separate cobalt action, focus and semantic colors. Legacy primary buttons now use the same contrast-tested filled-action pair as newer buttons.
- Navigation arrivals replay without remounting page editors. Buttons, native disclosures, menus and overlays share restrained motion; system reduced-motion disables page arrival and minimizes CSS animation/transition durations.

### Refinement verification

- All **152** frontend regression tests pass, including preview boundaries, preservation of invoice cell keys/content/handlers, proposal record labels/actions, page animation cancellation and light/dark semantic text contrast. `git diff --check` passes.
- Read-only authenticated checks covered these three pages at 375px phone, 768px tablet and 1440px desktop widths with no document overflow. Inspected both themes, all-column Awarded previews, original Awarded/Invoice details panels, selected-month changes and the ordinary Invoice billing breakdown.
- Checked desktop horizontal scrolling with pinned Invoice totals and Awarded actions; their original hard left borders/shadows are removed. Final browser error/warning log was empty.
- Original live values, lifecycle actions, payment/file operations and backend paths were not changed or exercised as writes. No commit, push or deployment was performed.

## Approved Invoice / Projects / Directory / Licenses refinement — 2026-09-12

- Applied UI-UX-Pro-Max and UI-styling guidance to compact information hierarchy, non-color-only status cues, phone records and accessible dialog behavior. The approved page directions are recorded in each page document.
- Invoice Paid cells now stay green across parent, firm and total rows. Actuals are blue, projections violet, with explicit period labels; both themes have contrast-tested semantic pairs.
- Outstanding Invoices is a flat register with a single invoice-detail dialog. Both payment groups and every attachment are immediately available inside it. Existing financial pivot is byte-for-byte unchanged. Display keys distinguish separate firm relationships on the same project, with regression coverage.
- Projects ordinary and expanded desktop rows measured about 55px. Directory defaults to five contact-first columns (64px desktop rows); its original full management view remains available. Licenses uses a single compact urgency-ordered register instead of duplicated renewal cards.
- All **159** regression tests pass; production build and diff whitespace checks pass. Existing library @charset and bundle-size warnings remain. A fresh authenticated Invoice preview produced no browser error/warning messages.
- Read-only browser checks covered 375px phone, 768px tablet and 1280–1440px desktop layouts, both themes, project expansion, contact lookup and management mode, contact details, paid-cell color precedence, invoice horizontal scrolling, individual attachment labels and invoice-dialog focus restoration. No document-level horizontal overflow on the four scoped pages.
- Astra page-review agents were requested but hit account quota; implementation and verification continued locally after the user asked to continue. No successful independent review is claimed for this pass.
- No backend, data.js, dependency/package, API, migration or financial-calculation changes. No live records were edited, payments toggled, files uploaded, reminders sent, commits created, deployments run or changes pushed.
