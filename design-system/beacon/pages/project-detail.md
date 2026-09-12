# Project detail

## Purpose and priorities
The project workspace helps a project manager understand the selected project, inspect its phase hierarchy and financial breakdown, maintain project settings, and coordinate tasks and notes. Its strongest information priorities are project identity, client and responsible manager, contractual value, schedule, status, and the relationship between project and phases. Invoices use the existing integrated invoice grid.

## Assessment
The initial Overview currently shows a duplicated record list followed by an unbuilt placeholder. Settings mixes identity, contract, dates, manager and address in a single undifferentiated grid. Phase names, assignment labels, company names and attachments are truncated, impeding identification. Supporting notes and task interfaces need clearer section hierarchy and less crowded controls.

## Design
Use the shared cool-white/graphite, cobalt-accented system. A lightly glazed project identity header anchors the workspace, followed by a wrapping, persistent project section strip. Overview presents the existing record, schedule and direct links to work structure, invoices and settings. A phase preview reveals full names and statuses. Documents honestly explains the current capability and links directly to Notes for attachments.

Structure prioritizes available contract allocation and Add phase above the wide, contained financial grid. Rows retain inline editors and calculations, while identity text wraps and add-child controls remain visible. Settings becomes a master/detail editor with readable selection labels and explicit Identity, Commercial, Schedule and Location groups. To-Dos retain priority order and completion controls. Notes keeps its composer adjacent to contextual category, attachment and publish actions.

## Contracts and checks
All data imports, mutation handlers, calculations, validation, permissions, invoice props and API calls remain unchanged. Only presentation and section navigation change. Preserve Radix behavior and reduced-motion support. Check JSX compilation, scoped CSS, contained table overflow, wrapping metadata, 375px layout and theme token usage.
