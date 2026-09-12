# Invoice workspace

## Purpose and user tasks
Finance staff and project managers reconcile project billing, anticipated cash flow, subconsultant invoices, contract amendments and payment evidence across a rolling month window. They switch ENG / PM / MHZ perspectives, investigate a project, edit month values, attach bills, mark payments and pause/resume billing. Every underlying calculation and write handler remains unchanged.

## Information priorities
1. Current billing lifecycle and visible period establish context.
2. Project identity and perspective anchor an intentionally wide financial grid.
3. Monthly actual/projection values, billed totals and remaining balances stay readable, with money using tabular figures.
4. Expanded firm breakdowns, notes, amendments and evidence sit beside their project.
5. Cash-flow charts summarize the same window; exact values also have a disclosure table.

## Action hierarchy and organization
- Separate the working toolbar into search/filter, period navigation, and view controls. Keep new-row creation as the primary action. Remove inert PM/Export affordances; the app-level working exports remain intact.
- Label the ledger and communicate inline editing and firm expansion once above it.
- Give expanded breakdown controls their own quiet strip. Keep all data grid scrolling contained. On phones release sticky side columns so they cannot cover the month cells.
- Charts use a concise heading, legible KPI groups and an accessible monthly data disclosure; preserve benchmark and Orange semantics.
- The workspace snapshot and Revenue outlook are native expandable sections above the ledger and open by default, as requested in the approved refinement. Users can collapse either while working. Pause, Resume, Close out and Reopen have visible labels; total columns reserve enough width for full currency values.
- Receivables lead with outstanding value and a clear drill-down instruction. Pending/paid sorting uses button state semantics, without pretending to navigate tabs.
- Folder and note dialogs group current context, editable content and actions; long names/paths wrap.

## Visual and interaction decisions
Follow MASTER.md: cool surfaces, graphite dark mode, cobalt focus/selection, restrained frosted toolbar, opaque financial cells. No translucent working data. Use 140–260ms opacity/transform feedback, reduced-motion support, visible keyboard focus and readable controls. UI-UX Pro Max React focus guidance and accessibility/overflow checklist informed the implementation.

## Preserved contracts
No changes to invoice math, perspective mapping, sorting comparators, API calls, mutation handlers, source IDs, date logic, payment permissions, file handling or billing lifecycle. Cash-flow data disclosure reuses computed totals. All changes remain local for approval.

## Approved phone refinement
- At 767px and below the existing ledger rows become vertically stacked project records. The same keyed cells, editors and handler branches remain mounted. Real DOM labels identify fields; only the selected month is displayed, while the full month window and export snapshot remain intact.
- The phone toolbar retains period navigation and perspective/search controls, adds a month selector and explicit sort controls. Month selection survives filtering and expansion; a changed window preserves that month when present, otherwise selects the current or nearest available month.
- Project identity, selected-month earned value and billed/remaining totals lead. Billing breakdown opens the existing firms, contract/rollforward controls and project-total editors. File, paid, alert, lifecycle and project-detail controls are visible touch targets; synthetic MSMM rows retain their original routing to the linked perspective.
- Collapsed phone records prioritize identity, the selected month and totals, then breakdown and lifecycle actions. Role/type/PM, notes, amendments and project folders/files appear through the same breakdown toggle. Phone monthly figures omit SVG-only legends and scenario controls.
- Native project and analysis disclosures remain user-operable. Phone revenue uses the chart's existing exact monthly values as labeled vertical records, opened on entering the phone layout. Desktop charts keep their explicit 320px height and original computations.

## Approved payment-visibility and receivables refinement (2026-09-12)
- Paid monthly cells use a dedicated green surface and ink in both themes, with a check and visible Paid label. The top-row mirror uses the existing Project total paid flag; it is not a newly inferred payment status.
- Actuals use blue-tinted cells; projections use violet-tinted cells and explicit Projection headers. The period boundary is dashed. Final status precedence is Paid, then period basis, then row styling, including expanded firms and totals.
- Outstanding Invoices is a flat firm/project register. Contract, Paid, Pending and Remaining are visible immediately. The existing financial pivot is byte-for-byte unchanged; displayed Remaining remains Contract minus Paid.
- View invoices opens one accessible dialog/sheet with both payment groups expanded. Every attachment has a directly named action using the existing signed-file reader. Escape/Close restores focus to the source record.
- Search also finds projects and project numbers locally. Sorting and headline amounts continue to use the original firm totals; the heading explicitly says matching firms.
