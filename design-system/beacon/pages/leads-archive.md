# Deleted Leads & Bids — recovery workspace

## Page understanding

This is the recovery destination for soft-deleted Hot Leads and Open Bids, not a new pipeline stage. Users need to find the correct record, inspect its identifying information, and restore it without entering its fields again. Record type, name, client/context, and the existing Restore action matter most. Bid attachments remain available through the existing PDF handler.

## Organization and interaction

- A compact recovery strip explains that saved fields remain intact and gives a count and jump link for each populated record type.
- Separate, clearly labelled sections retain both registers; users do not have to discover records behind a new filter or nested tab.
- Each section names the restore destination. Repeated register introduction blocks are hidden only inside this archive because the section heading and destination text replace them.
- The zero-record state explains what will appear here. Zero counts remain visible when only one record type is populated.
- Restore, confirmation, read-only props, permissions, PDF access, and row arrays remain unchanged. No new destructive actions or data transformations.

## Visual and accessibility contract

Use shared cool light/graphite dark tokens, a frosted recovery strip, opaque tables, and restrained accent marks. Counts are tabular and paired with full labels. Jump links are keyboard accessible, have visible focus, and remain 44px high on touch layouts. Natural text wrapping, shrinkable containers, and scoped table scrolling keep mobile content inside the page. No additional motion is required beyond shared control feedback; reduced-motion preferences remain respected.

## Skill application and verification

Applied ui-ux-pro-max's content-priority, clear recovery path, semantic color, full-label wrapping, and focus guidance. Its focused recovery search returned Error Recovery guidance, which supports explaining the next step without changing restore behavior. Validate JSX parsing, CSS parsing and whitespace locally; parent owns integrated browser checks and imports.
