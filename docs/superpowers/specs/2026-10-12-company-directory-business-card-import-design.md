# Unified Company Directory and Business-Card Import Design

## Goal

Replace Beacon's split `clients` / `companies` organization model with one canonical `beacon_v2.companies` master and add a reviewed, batch business-card import to the Directory.

The same outside organization may be the client on one record, the prime on another, and a subconsultant on a third. Those labels describe the organization's role in a project or workflow; they are not different kinds of organization and must not require duplicate Directory entries. Every company may have any number of contact people.

Users must be able to photograph or upload several business cards at once, including photos containing several cards. Beacon extracts structured contact data, matches it against the Directory, and presents every proposed create or update for human review. Card images are ephemeral and are never stored in Supabase.

## Success Criteria

- The application reads every client, prime, and sub selection from one `companies` master.
- Existing client, company, contact, and relationship data survives the cutover.
- A company has zero or more contacts, with at most one primary contact.
- The Directory no longer divides records into Client and Company categories.
- One import may contain several images and several cards per image.
- No extracted record is written before review.
- Existing values are never silently replaced. Each difference requires an explicit field-level choice.
- Exact duplicates can be skipped and uncertain matches can be reassigned or created as new records.
- Saving a reviewed batch is atomic and rejects stale updates.
- Uploaded image bytes and browser object URLs are discarded after completion or cancellation.

## Non-Goals

- Maintaining separate Client and Company organization categories.
- Automatically saving high-confidence model output without review.
- Retaining card images, card crops, OCR text dumps, or model request bodies.
- Adding a general document-management or CRM activity-history subsystem.
- Normalizing multiple email addresses and phone numbers per person in this release. A contact keeps one primary email and one primary phone; additional useful values may be copied into notes during review.
- Automatically merging ambiguous legacy organizations.

## Canonical Data Model

### Companies

`beacon_v2.companies` becomes the sole organization table. It retains its existing identity, name, address, notes, and MSMM fields and gains the client-specific attributes currently held by `clients`, including `district` and `org_type`. It may also hold a company website extracted from a card.

An organization does not store a Client, Prime, or Sub category. Those roles are inferred from its relationships:

- `projects.client_id`, `leads.client_id`, `open_bids.client_id`, and `project_items.client_id` mean "the company acting as client on this record."
- `prime_company_id` means "the company acting as prime on this record."
- company join rows such as `project_subs.company_id` mean "the company acting as a subconsultant on this record."

The existing `client_id` column names may remain because they describe relationship roles and are widely consumed by the frontend. Their foreign keys change from `clients(id)` to `companies(id)`. This avoids a large rename with no user-facing benefit while eliminating the split identity model.

The transitional `prime_client_id` column and code paths become unnecessary. Its populated values are moved to `prime_company_id`, after which new application code reads and writes `prime_company_id` only.

### Contacts

`beacon_v2.contacts` remains one row per person, but every row belongs to exactly one `company_id`. Existing client-owned contacts move to the mapped company. The `client_id` column, client-specific indexes, and two-parent check are retired after migration.

The primary-contact uniqueness rule becomes one partial unique index on `company_id`. The existing trigger continues to mirror the primary person's name, email, and phone onto the company's legacy scalar fields for compatibility with old exports and scripts.

The first release retains the current contact shape:

- name, required;
- title/role;
- email;
- phone;
- notes;
- primary flag and display order.

### Legacy Clients

After the cutover, application code does not read or write `beacon_v2.clients`. The original table is preserved temporarily under a legacy name for one verified production release, then removed in a later cleanup migration. It is a rollback reference, not a second live master.

## Migration and Cutover

### Preflight

A read-only preflight script reports:

- counts for companies, clients, contacts, and every referencing relationship;
- client names that exactly normalize to an existing company;
- probable matches that require a human decision;
- same-name clients with different districts;
- UUID collisions;
- contacts that would converge on the same company and primary-contact conflicts;
- rows with references that cannot be resolved.

Name normalization for suggestions is case-insensitive and removes repeated whitespace and insignificant punctuation. Legal suffix removal and fuzzy similarity may suggest a match, but they do not authorize a merge. The operator records approved ambiguous mappings before the migration runs.

### Transactional Migration

The migration runs in one database transaction and rolls back on an invariant failure.

1. Extend `companies` with the required client attributes.
2. Create a temporary client-to-company mapping.
3. Map operator-approved and unambiguous exact matches to existing companies.
4. Insert all remaining clients into `companies`, preserving their UUIDs when no collision exists.
5. Preserve both sides' useful profile data. Existing non-empty company values win; otherwise the client value fills the field. Conflicting non-empty values are written to the migration report for later review rather than silently concatenated.
6. Move client-owned contacts to their mapped `company_id`. Resolve multiple primary contacts deterministically by retaining the existing company's primary; otherwise retain the first ordered contact. No contact row is deleted.
7. Rewrite every client-role foreign key to the mapped company UUID and retarget its constraint to `companies(id)`.
8. Move `prime_client_id` references into `prime_company_id`, reporting any row where both columns contain different organizations.
9. Replace the dual-parent contacts constraint, indexes, primary-contact function, and mirror trigger with company-only versions.
10. Rename the old clients table to a clearly marked legacy name and revoke application writes.
11. Validate before/after counts, required references, primary-contact uniqueness, and orphan absence before commit.

The migration remains idempotent in the repository's established sense: a completed cutover can be pasted again without duplicating organizations or contacts. The one-shot v1-to-v2 backfill remains historical and must not be rerun against a live post-cutover database.

### Application Cutover

The frontend changes in the same release:

- load only `companies` and company-owned contacts;
- remove the separate clients state slice and adapters;
- replace client-only and client-or-firm picker routing with one company picker;
- remove `routeClientPick`, `routePrimePick`, and Client/Company branch logic;
- create all Directory organizations in `companies`;
- merge any companies through one company merge RPC;
- render one alphabetical Directory rather than Client and Company sections;
- retain contextual UI labels such as Client, Client/Prime, Prime, and Subs on project workflows;
- update Directory search, exports, linked-project resolution, create/edit drawers, and scripts to the canonical model.

## Business-Card Import Experience

The Directory toolbar gains an **Import business cards** action. It opens a responsive four-stage workspace.

### 1. Upload

- Accept phone camera capture, file selection, and drag-and-drop.
- Accept up to 20 photos per import and up to 10 MB per original image.
- Allow one or several cards in each photo.
- Normalize supported images in the browser to an orientation-corrected JPEG, downscaled to a practical vision resolution.
- Keep originals and normalized blobs only in component memory and browser object URLs.
- Reject unsupported or unreadable formats with a per-file explanation.

The frontend processes large batches in small chunks with limited concurrency. The normalized request payload is capped at approximately 25 MB per chunk so a large event import does not exceed Edge Function or model limits.

### 2. Analyze

The authenticated `extract-business-cards` Edge Function receives image identifiers and base64 image data. It sends the images to a configurable vision model using strict structured output. The response contains zero or more card candidates per image:

- person name;
- title/role;
- primary email;
- primary phone;
- company name;
- company website/domain, address, and extra useful details when visible;
- source image identifier and card ordinal;
- extraction warnings for uncertain or absent values.

The model performs extraction only. It does not decide what to create or update. The function does not write to Supabase Storage, the database, or logs containing image bytes or extracted personal data.

If one chunk fails, successful chunks remain available. The user may retry or remove failed images. An image with no detected card becomes a visible warning, not an empty database record.

### 3. Match and Review

After extraction, the frontend refreshes companies and contacts and runs candidates through a pure deterministic matching module.

Matching signals, strongest first:

1. exact normalized email;
2. exact normalized phone;
3. exact normalized company name;
4. email or website domain aligned with the company;
5. same normalized person name within the same company;
6. fuzzy person or company names as suggestions only.

Candidates are labeled **New contact**, **Update existing**, **Already current**, **Possible duplicate**, or **Needs attention**. Duplicate cards within the same batch are coalesced when an exact email or phone agrees; conflicting duplicates remain separate review items.

Each review item allows the user to:

- inspect its source photo while the workspace remains open;
- correct extracted text;
- choose an existing company or create a new one;
- choose a suggested existing contact or treat the card as a new person;
- compare each existing value with the card value;
- select **Keep existing** or **Use card** independently for every changed field;
- copy additional detected details into notes;
- mark or change the primary contact choice;
- skip the card.

Company and person name are required for a new contact. Email and phone are optional. No operation is pre-approved merely because its match confidence is high.

### 4. Save

The frontend converts the reviewed state into explicit operations and calls one `apply_business_card_import(jsonb)` RPC. Each update includes the `updated_at` value observed during review.

The RPC:

- validates every referenced company and contact;
- rejects cross-company contact reassignment unless the reviewed operation explicitly requests it;
- verifies optimistic versions before updates;
- creates new companies before their contacts;
- applies only fields the reviewer selected;
- uses the existing primary-contact invariant;
- returns created and updated IDs plus summary counts;
- commits all selected operations together or none of them.

If another user changes a reviewed company or contact before save, the RPC returns a stale-record conflict. The UI refreshes that item and asks the user to review the new differences; it never overwrites the newer edit.

After a successful save, the Directory state refreshes and a summary reports companies created, contacts created, contacts updated, exact duplicates skipped, and cards omitted. Completion or cancellation revokes every object URL and releases all image and extraction state.

## Components and Boundaries

### Frontend

A dedicated business-card import module owns the modal/workspace and its state machine. Image preprocessing, matching, diff construction, reviewed-operation construction, and cleanup are separate pure helpers where possible. The Directory only supplies the launch action and refresh callback.

The matching module has no React or Supabase dependency. It accepts extracted candidates plus current companies and contacts, then returns suggestions, confidence reasons, duplicate groups, and field conflicts. This keeps matching behavior explainable and unit-testable.

### Edge Function

`supabase/functions/extract-business-cards/index.ts` follows the existing authenticated `generate-description` pattern:

- require a valid Supabase session JWT linked to `beacon_v2.users`;
- enforce MIME, file-count, per-file, and total-payload limits;
- call the OpenAI Responses API with a server-only `OPENAI_API_KEY`;
- use `OPENAI_CARD_MODEL` as an optional model override;
- request strict JSON output and validate the returned shape;
- return bounded, user-safe errors.

Card content is untrusted input. The model instructions explicitly treat visible text as data and ignore instructions printed on a card. The function never interpolates extracted text into privileged instructions.

### Database RPC

The import RPC is the only batch write path. It is callable by authenticated users who already have Directory write access and uses the caller's authorization context. It performs its validation and writes in the function transaction; it does not invoke the vision model or handle image bytes.

## Permissions and Privacy

The importer follows the existing Directory authorization posture: a signed-in user who may edit the Directory may import cards. Interface access continues to hide the Directory and importer from users without Directory access. This feature does not broaden unrelated table RLS.

Images are transient request data. They are not placed in a bucket, database table, analytics event, application log, or audit record. The UI explains that images are sent to the configured AI provider for extraction and are discarded by Beacon after the request. Provider-side data handling follows the organization's API agreement and configuration.

## Error Handling

- Client-side format, decoding, or size failures appear on the affected image.
- Network and model failures are retryable per chunk.
- Schema-invalid model output fails closed and produces no candidate rows.
- Missing names or companies remain editable warnings and cannot be selected for save until resolved.
- Ambiguous matches default to **Needs attention**.
- Database validation failures preserve the reviewed workspace.
- Stale records are refreshed and re-diffed before another save attempt.
- Atomic saving prevents a half-created batch.
- Cleanup runs on success, cancellation, and component unmount.

## Testing and Verification

### Data migration

- Exact client/company matches map to one surviving company.
- Unmatched clients become companies without losing IDs or profile fields.
- Ambiguous records remain separate unless an explicit mapping is supplied.
- Every project, lead, bid, project item, prime, sub, and contact reference remains valid.
- `prime_client_id` data survives in `prime_company_id`.
- Contact UUIDs and one-primary-per-company behavior are preserved.
- Reapplying the migration is a no-op.
- Preflight and postflight counts reconcile.

### Pure logic

- Email normalization and case handling.
- Phone punctuation and country-code normalization.
- Company whitespace, punctuation, suffix, and domain suggestions.
- Exact, possible, and no-match outcomes.
- Same-batch duplicate coalescing and conflict preservation.
- Field-level keep/use-card decisions.
- Reviewed-operation serialization.

### Edge Function

- Authentication rejection.
- MIME, count, and payload limits.
- One card, several cards, no card, rotated card, and partially unreadable card fixtures.
- Strict output validation and prompt-injection text on a card.
- No persistence or sensitive logging.

### Integration and UI

- Create a company and contact from a new card.
- Add a person to an existing company.
- Update selected fields without changing rejected fields.
- Skip an exact duplicate.
- Reassign a false match.
- Reject stale updates and recover after refresh.
- Roll back the whole batch when one selected operation is invalid.
- Keyboard navigation, focus restoration, screen-reader labels, and phone/tablet/desktop layouts.
- Existing Directory create, edit, delete, primary-contact, search, export, merge, and linked-project behavior.
- Client, Prime, and Sub pickers across every workflow.

## Deployment and Activation

1. Run the preflight report against production and resolve blocking mappings.
2. Schedule a short cutover window for the schema and frontend release.
3. Apply the canonical-company migration and verify its postflight assertions.
4. Deploy the frontend and `extract-business-cards` Edge Function.
5. Configure `OPENAI_API_KEY` if not already present and optionally set `OPENAI_CARD_MODEL`.
6. Smoke-test Directory, projects, leads, bids, invoices, merges, and one reviewed card import.
7. Retain the renamed legacy clients table for one verified release.
8. Remove the legacy table in a later cleanup migration after rollback confidence is established.

## Documentation Updates

Implementation updates `AGENTS.md` and its local `CLAUDE.md` counterpart to describe the canonical-company model, the contact relationship, card import activation, and the historical status of the old clients table. Seed/import scripts and root documentation that still query `clients` are updated or explicitly marked historical.
