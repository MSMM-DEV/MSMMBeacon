# Beacon — frontend redesign

## Direction
An exacting, calm workspace for engineering operations. Cool white and silver in light mode; layered graphite in dark mode. A restrained cobalt accent identifies actions and selection. Generous page hierarchy surrounds compact, legible working data. Use the existing Geist font and Lucide icon family.

This direction uses ui-ux-pro-max's verified Minimalism / Swiss enterprise guidance, adapted to an operational application rather than its marketing-page pattern suggestion.

## Scope and contracts
- Presentation and local UI state only. Preserve every business calculation, permission, API call, data mapping, mutation handler, export and deep link.
- No data.js, backend, API, migration, package, lockfile, production, commit or push changes.
- Keep hidden legacy pages hidden from the primary navigation, but redesign their reachable views.
- Every page owner first documents purpose, priorities, primary actions and organization in `design-system/beacon/pages/<page>.md`.
- Each owner edits only its assigned component/function and its own CSS file. Do not revert other agents' work. Parent integrates imports and shared styles.

## Shared system
- Existing semantic variables are authoritative: --bg, --surface, --surface-2, --surface-3, --text, --text-muted, --text-soft, --accent, --accent-soft, --border, --border-strong, --sage, --rose, --blue and their soft/ink variants. Parent replaces their values globally.
- Light canvas #F4F6FA, white surfaces, dark ink #182230, secondary text #536174. Dark canvas #0D1118, surfaces #151C27, elevated surfaces #1C2533, white ink #EDF2FA, secondary #ADB9CB. Cobalt action #2459D3 (light), #91B4FF (dark text), dark-theme solid action #3D70E8 with white text.
- Fonts: Geist body/display; tabular figures for money/time. Body 14px desktop, form inputs 16px mobile. Dense metadata never below 12px where practical. Titles 28–32px, weights 550–650.
- Spacing: 4/8/12/16/24/32. Surfaces 12–16px radius; controls 8px; avoid pill overload and nested decorative cards.
- Primary button: solid cobalt; secondary: neutral outline; quiet: ghost. Use existing Button and Radix primitives.
- Tables: a distinct control area, clear column headings, quiet rules, readable row spacing, restrained status marks, visible actions. Preserve resizing, reordering, filtering, editing and exports. Horizontal scrolling remains inside wide data grids, never the entire page.
- Overlays: opaque theme surface, dimmed scrim, descriptive heading, grouped fields, pinned actions when long. Radix focus traps, Escape and restoration remain intact.
- Motion: feedback 140ms; menus 180ms; sheets/page entrances 260ms. Prefer transform and opacity, never delay input or animate all data rows. Respect prefers-reduced-motion.
- Phone: stack controls by priority, 44px tap targets, no document overflow. Preserve a discoverable route to all data and actions.
- Avoid generic promotional heroes, decorative stats with no task value, invented metrics, fake search, dead controls, gradients behind working data, yellow/cream surfaces.

## Coordination
Parent owns App.jsx shell, shared design tokens/styles, ui/* and imports. Page agents own only explicitly assigned boundaries and `design/pages/<page>.css`; CSS imports are integrated centrally by parent. Shared tables.jsx requires exact function-boundary edits using apply_patch; no whole-file rewrites or formatting.
