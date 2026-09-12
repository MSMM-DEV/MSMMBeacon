# Directory

## Purpose and tasks
The shared roster connects the organizations that hire MSMM (clients) and firms working alongside it (companies) to their projects. Users need to identify the right organization, find its contact information, inspect shared relationships, open linked projects, edit master details, and merge duplicate records safely.

## Information and action priorities
Organization name and classification lead each entry. Contact name, full email and phone should be readable together. Related firms/clients and project counts explain the relationship. Address and notes remain available through the expanded record and the full table. Opening details and expanding relationships are visible row actions; merge remains a deliberate multi-selection action with its existing same-kind restriction.

## Organization
Default to a compact relationship directory, with contact channels grouped rather than spread across a very wide table. Provide a full-table view retaining all original sortable columns. Keep clients and companies as explicit groups. Put search, filters and view selection in a glass control surface above the roster. Expanded rows organize address and notes before linked projects. Show complete related names and use an operable disclosure for additional relationships.

## Visual and interaction rules
Use MASTER.md semantic colors, Geist and Lucide. Neutral table surfaces, crisp cobalt interaction accents, readable multiline text, generous row rhythm, 44px touch controls on small screens, and opacity/transform entrance motion with reduced-motion support. Wide full-table scrolling is contained inside the table. No changes to data mapping, callbacks, exports, sorting semantics, merge rules, or API paths.

## Verification
Build and JSX compilation; parent integrates the stylesheet and performs local cross-page browser verification in both themes. Contact details and expanded relationship lists must remain readable at narrow widths.

## Approved phone-book refinement (2026-09-12)
- Contacts is the default: Name, Contact, Email, Phone and Details. Email and telephone links are direct actions. Desktop rows measure 64px.
- Manage records retains the complete 13-column editable register, same-kind merge selection, relationships and linked-project expansion. Switching back to Contacts hides management-only expanded content without discarding its state.
- Search now includes contact person, email, formatted or unformatted phone, address and district, while preserving name/relationship/project-count search.
- At narrow widths contact records fit the viewport; filters scroll independently instead of occupying several rows. No horizontal scrolling is required to reach contact information.
