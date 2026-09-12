# Projects

## Purpose and work
This page is the project work breakdown register: root projects contain phases and subphases. Users locate a project, inspect its contract and progress, open its dedicated workspace, update working fields, and add work beneath the appropriate parent. It is distinct from the legacy sales pipeline.

## Information and action priorities
1. Project name, reference, hierarchy and current status establish the record.
2. Client, contract value, completion and manager support portfolio review.
3. Item type, subcontractors, contract type and additional PMs are useful when maintaining the complete register.
4. Opening a workspace and adding a phase are immediate row actions. Deletion remains separated in the existing overflow menu and retains its existing handler.

## Organization
Use a quiet register heading with the actual root-project and record counts. Place a labeled search alongside an Overview / Full register view switch. Put existing status/type filters on their own wrapping line; expose hierarchy expansion controls together with a short explanation of parent preservation while filtering. Overview prioritizes common review columns. Full register reveals every original editable column, without changing data, calculations, filtering or export snapshots. A sticky identity column supports the wide desktop register. On phones, rows become labeled records in the same DOM and retain every field available to the selected view.

## Visual and interaction decisions
Follow the shared cool-white / graphite and cobalt tokens. Restrained glass belongs to the control area; data uses opaque surfaces. Root records have stronger identity, child records have an explicit level label as well as indentation. Full names wrap. Every row action is visible; controls have focus indication and sufficiently sized targets. Motion is limited to view entrance and feedback, with a reduced-motion override.

## Preserved contracts
All original props, callbacks, ancestor-preserving query/filter logic, default collapsed state, inline mutations, exported flattened data and progress calculations remain intact. The only added state is the presentation view. No backend or data source changes.

## Approved compact-register refinement (2026-09-12)
- Desktop ordinary and expanded phase rows measured approximately 55px after reducing cell padding and redundant root-level labels (previously roughly 95–111px).
- Existing hierarchy, indentation, expansion state, editors, callbacks, filters and full-register columns are retained. Long desktop names use a two-line display clamp; their full value remains available in the original detail/editor.
- Phone records use a two-column labeled field grid, full-width identity and a separate touch-sized action row. Ordinary/phase records measured approximately 291/278px, down from roughly 440px. No data fields were removed from their existing view.
