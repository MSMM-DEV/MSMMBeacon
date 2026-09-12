# Time & leave

## Purpose and user priorities
Employees need to record their arrival or departure immediately, understand whether they are currently clocked in, review the current day, and correct a block without learning the underlying punch model. The supporting tasks are reviewing the week, checking colleagues' availability, and planning or requesting leave.

## Organization
The Time / Leave section strip is retained. Time opens with a restrained date toolbar, then one clear status-and-punch surface. Current status, session duration and the next punch action form a single horizontal unit on desktop and stack in that order on phones. The day activity list is the main working area; the week summary sits alongside it, followed by a disclosed team-presence section. Every week date opens that day. Day blocks retain complete time ranges, category, presence, notes and Outlook context with a visible edit affordance. The overview strip remains supplementary.

Leave leads with available balances and the Request leave action, then upcoming approved leave and grouped request history. Dates, hours and request outcomes remain readable without relying on color. The form organizes type, dates, duration, reason and before/after balance preview in this order. Custom duration explicitly means the entire request total.

## Interaction and visual treatment
Use the shared cool-white/graphite surfaces and cobalt action tokens. Glass is reserved for the date/control area; working data and modal bodies remain opaque. Status uses green/rose plus explicit In/Out text. Day cards have a quiet status edge, full wrapping content, a persistent edit affordance and restrained 140ms hover/focus feedback. Editors have scrollable bodies and visible footer actions, named time inputs and clear recovery text. Reduced-motion users receive no decorative animation.

## Preserved contracts
No data loading, cache, Realtime, permissions, calculations, API calls or mutation handlers change. Punches still drive presence. Category/presence policy and merged display segments are preserved. `saveTimeBlock` remains the sole block-edit path. The personal day editor retains selfMode. Leave accrual and requested-hour calculations remain untouched. Existing day-selection callbacks are reused for weekly navigation.

## Verification
Review at desktop and phone widths in both themes. Check long names/notes, compact weekly tables, modal scrolling, keyboard focus, reduced motion, and that all controls still reach their existing handlers. No live data is mutated for visual verification.
