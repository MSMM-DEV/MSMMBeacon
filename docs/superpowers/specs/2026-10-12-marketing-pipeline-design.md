# Marketing Pipeline Design

## Goal

Add a dedicated, end-to-end Marketing module to Beacon for selling SaaS and AI products. The module manages an opportunity from the first introduction through a signed or lost contract, persists every record in `beacon_v2`, and gives non-technical staff a clear daily working view of pipeline health, next actions, forecast value, and results.

The Marketing pipeline is independent of the existing Engineering leads, bids, proposals, projects, and invoices. A closed-won Marketing opportunity remains in Marketing. This release does not create or update a record in any other Beacon pipeline.

## Exact Stage Model

The interface, database values, filters, reports, history, and exports use these stage names verbatim:

1. `Intro to Target or prospect` — recommended probability 0–10%, default 5%.
2. `Initial meeting to showcase products and qualify prospect` — recommended probability 10–25%, default 20%.
3. `IQM - Initial Qualified Meeting` — recommended probability 25–40%, default 30%.
4. `BANT - Budget Authority Need Time` — recommended probability 40–50%, default 45%.
5. `Verbal Approval to Proceed` — recommended probability 75%, default 75%.
6. `Legal and Contract Negotiation` — recommended probability 75–90%, default 85%.
7. `Contract Signed Won or Lost` — probability is 100% for Won and 0% for Lost.

The first six ranges are guidance, not database restrictions. A user may save a different probability after acknowledging the recommended range. When a move places the current probability outside the destination range, the transition panel proposes the destination default and lets the user confirm or change it.

Moving an opportunity opens a transition panel before any database write. The panel identifies missing information for the destination stage. Missing qualification information warns but does not block progress. Closing an opportunity is stricter: Won requires a signature date and final contract value; Lost requires a loss reason and may include an explanation, named competitor, and lesson learned.

## Stage Guidance and Transition Information

### Intro to Target or prospect

Capture referral or lead source, introducer, target organization, primary contact, opportunity owner, likely product or service, and the planned introduction or next action.

### Initial meeting to showcase products and qualify prospect

Capture meeting date, location or meeting link, attendees, products demonstrated, prospect fit, meeting outcome, and agreed follow-up.

### IQM - Initial Qualified Meeting

Capture the client's problem, desired business outcome, solution-fit validation, clarifying questions, responsible person, question due date, answers received, and draft SOW or proposal status.

### BANT - Budget Authority Need Time

Capture Budget, Authority, Need, and Time as four separately visible qualification areas. Record proposal version, proposal value, proposal sent date, scope summary, budget notes, decision process, target decision date, and timing constraints.

### Verbal Approval to Proceed

Capture the verbal approval date, approving contact, agreed commercial terms, expected signature date, risks to signature, and resource-planning action.

### Legal and Contract Negotiation

Capture MSA status, SOW status, legal owner, customer legal contact, redline status, outstanding legal or commercial issues, latest document version, and target signature date.

### Contract Signed Won or Lost

Won captures signature date, final contract value, signed document, and final notes. Lost captures one of `Price`, `Did not meet their needs`, `Timing was not right`, `Competitor`, `Internal build`, or `Other`, plus optional detail, competitor, and lesson learned. Won and Lost records remain in Marketing and remain searchable, reportable, and auditable.

## Page Structure

Beacon gains a new top-level sidebar workflow named **Marketing & Sales** with one page named **Marketing**. The Marketing page has three access-aware views:

- **Pipeline** — the primary seven-lane Kanban board.
- **Opportunity list** — a sortable, filterable table with CSV export.
- **Insights** — funnel, forecast, velocity, activity, and win/loss reporting.

The exact stage names are never shortened in user-visible headings. Desktop lane headings wrap as needed. On phones, the board renders one selected stage at a time through a stage selector so the seven long headings and opportunity cards remain readable.

The page header shows five operational indicators:

- Active pipeline value.
- Probability-weighted pipeline value.
- Opportunities expected to close in the current quarter.
- Overdue next actions.
- Stalled opportunities.

The shared toolbar supports text search plus filters for owner, organization, exact stage, product or service, health, expected-close period, and open/Won/Lost state. Opening and closing an opportunity preserves the current view, filters, selected mobile stage, and scroll position.

## Kanban Cards and Movement

Each card shows the opportunity name, organization, estimated value, weighted value, owner, probability, product tags, expected close date, next action, next-action due date, days in the current stage, and a text-and-icon health label.

Cards support pointer drag on desktop and an explicit **Move to stage** action everywhere. The explicit action is also the keyboard and touch path. Both paths open the same transition panel and call the same persistence function. A stage change is not shown as complete until the database update and history insert succeed.

The final `Contract Signed Won or Lost` lane displays Won and Lost badges and supports a local outcome filter. It is one stage, not two renamed stages.

## Opportunity Detail Experience

Selecting a card or list row opens a wide right-hand sheet on desktop and a full-height bottom sheet on phones. The sheet contains:

1. **Overview** — opportunity, organization, owner, contacts, source, products, estimated value, probability, expected close date, next action, and summary.
2. **Qualification** — problem, outcome, solution fit, clarifying questions, BANT, decision criteria, competitors, risks, proposal details, verbal approval, and legal details.
3. **Activity** — chronological meetings, calls, emails, demonstrations, proposals, legal updates, and notes.
4. **Tasks** — action, assignee, due date, priority, state, and optional email reminder.
5. **Documents** — Proposal, SOW, MSA, Contract, or Supporting document uploads.
6. **History** — stage, probability, outcome, and other material changes with actor and timestamp.

Editing uses explicit section-level Save actions. Failed saves leave entered values in place and state the cause and recovery action. Dismissing a dirty form requires confirmation. The update includes the version last read by the user; if another user changed the opportunity first, Beacon reports the conflict, refreshes the current record only after confirmation, and does not silently overwrite the newer change.

The create dialog intentionally asks only for opportunity name, organization, owner, estimated value, product or service tags, expected close date, and first next action. It starts at `Intro to Target or prospect` with 5% probability. A user may select an existing Directory organization and contact or create the minimum organization/contact record inline through the existing Directory write path.

## Data Model

One idempotent migration in `supabase/migrations_v2` creates the Marketing data surface and adds any required alert/settings fields. The migration uses `beacon_v2`, grants authenticated users the intended CRUD access, enables RLS, creates indexes, and ends with a PostgREST schema reload notification.

### `marketing_opportunities`

The core row stores:

- Identity and ownership: `id`, `title`, `client_id`, `owner_id`, `created_by`, timestamps.
- Pipeline: exact stage, `stage_entered_at`, probability, expected close date, estimated value, currency, product tags, source, introducer, summary.
- Working state: next action, next-action due date, last meaningful activity timestamp, optional archive metadata, and optimistic-concurrency version.
- IQM: problem statement, desired outcome, solution-fit notes, clarifying questions, answers status, and draft SOW/proposal status.
- BANT and proposal: budget value/notes/status, authority contact/notes, need summary, timing summary, decision process, proposal version/value/sent date, and scope summary.
- Approval and legal: verbal approval date/contact/terms, resource-planning note, MSA/SOW/redline states, legal owner, legal issues, and target signature date.
- Outcome: Won/Lost value, signature date, final contract value, loss reason, loss details, competitor, and lesson learned.

Database checks enforce 0–100 probability, non-negative money values, coherent Won/Lost fields, and the terminal probabilities. The stage column uses a stable database enum whose values are the seven exact names.

### `marketing_opportunity_contacts`

Links an opportunity to `beacon_v2.contacts`. It records an opportunity-specific role such as Champion, Decision-maker, Budget owner, Legal contact, Technical evaluator, or Other, plus primary-contact state and notes. It does not duplicate the person's Directory email or phone.

### `marketing_activities`

Stores activity type, occurred time, author, summary, outcome, and optional next-step text. Activity types are Meeting, Call, Email, Demonstration, Proposal, Legal update, and Note. Related internal users and external Directory contacts use join tables so reporting and participant display remain reliable.

A meaningful activity updates the opportunity's last-activity timestamp through a database trigger. Stage-history rows do not count as sales activity.

### `marketing_tasks`

Stores opportunity, title, assignee, due date/time, priority, Open/Completed state, completion metadata, and optional linked Beacon alert. Completing or reopening a task is retained in history. An opportunity may have many tasks, while the card's next action is the earliest open task, falling back to the opportunity-level next action when no task exists.

### `marketing_documents`

Stores opportunity, document type, display name, private Storage path, MIME type, size, uploader, and timestamps. Files live in a private `marketing-documents` bucket. Authenticated object policies follow the existing private invoice and license-file patterns. A metadata row is inserted only after upload succeeds; removing a document removes both object and metadata with recoverable error reporting when either side fails.

### `marketing_stage_history`

Stores opportunity, exact from/to stage, previous/new probability, previous/new outcome, changed-by user, timestamp, and optional transition note. A database trigger records stage, probability, and closure changes so direct database/API writes cannot bypass history.

## Health, Forecast, and Reporting Rules

The shared `app_settings` singleton gains `marketing_stalled_after_days`, defaulting to 14. Health is derived rather than manually maintained:

1. **Stalled** — an active opportunity has no meaningful activity within the configured period.
2. **Attention** — otherwise, an open task or next action is overdue, or the expected close date has passed.
3. **On track** — neither condition applies.

Won and Lost records display their outcome instead of an active health label. Color is never the only signal.

Weighted value is `estimated_value × probability / 100`. Active pipeline and forecast exclude Won, Lost, and archived rows. Insights use the current filtered opportunity set and include:

- Opportunity count, raw value, and weighted value by exact stage.
- Expected closes by month and quarter.
- Current aging and average completed duration by stage.
- Overdue tasks and stalled opportunities.
- Activity volume by type and owner.
- Win rate and Won/Lost value.
- Lost reasons, competitors, sources, products, owners, and organizations.

CSV export uses the current search and filters and includes human-readable organization, owner, stage, outcome, dates, values, probability, BANT summary, next action, health, and loss information.

## Notifications and External Integrations

Marketing task reminders use Beacon's existing alerts pipeline. The migration adds a stable `marketing` alert subject, and `send-alert` renders Marketing task context and a deep link to `?tab=marketing&opportunity=<uuid>`. The user chooses recipients, first delivery time, and supported recurrence through the existing alert behavior. This requires redeploying `send-alert` after the code change.

This release does not connect to Outlook, an email inbox, electronic-signature providers, proposal generators, or an external CRM. Users may manually log email/meeting activity and upload the resulting documents. The UI identifies integrations as future capabilities only where useful; it does not present non-functional buttons as working actions.

## Access and Navigation

`frontend/src/access.js` gains stable keys for `workflow.marketing`, `page.marketing`, and its Pipeline, Opportunity list, and Insights children. Admins and full-access users see Marketing automatically. Under the existing new-workflow rule, restricted custom users do not silently inherit the new top-level workflow; an Admin grants it in User Management.

The access setting controls interface visibility, matching Beacon's existing model. Marketing table RLS grants authenticated collaboration rather than owner-only isolation: anyone with application access to the page can create and edit opportunities, while owner and assignee fields provide accountability and filters. Admin-only destructive operations are not required; normal users archive records, and archived records can be restored.

Deep links, the command/jump menu, sidebar navigation, and focus fallback all pass through the same access resolver. A denied deep link moves the user to their first allowed page.

## Frontend Architecture

The feature lives in focused modules rather than adding another large implementation to `App.jsx`:

- `frontend/src/marketing.jsx` owns page orchestration and the three views.
- `frontend/src/marketing-rules.js` owns stages, defaults, validation, health, weighted value, transition requirements, filtering, and reporting calculations as pure functions.
- `frontend/src/marketing-components/` contains board, card, transition dialog, opportunity sheet sections, filters, list, and insight components.
- `frontend/src/data.js` exposes the Supabase adapters and write functions needed by the module.
- `frontend/src/design/pages/marketing.css` receives the Marketing-specific responsive styles, is imported by `frontend/src/design/index.css`, and uses existing design tokens and shared `@/ui` primitives.

Marketing data loads when the page is first visited rather than joining the already-large global `loadBeacon()` request. The page owns loading, error, empty, and retry states. Successful writes return authoritative database rows and update local state from those rows. Writes are never reported as successful solely because an optimistic state change rendered.

The page-level Pipeline/List/Insights switch uses the shared underline Tabs variant. On desktop the board is a horizontally scrollable lane region with sticky lane headings. On mobile only one selected lane is rendered. All interactive controls meet Beacon's focus, keyboard, screen-reader, touch-target, theme, and reduced-motion conventions.

## Error Handling and Recovery

- A failed create, update, transition, or task write keeps user input and offers retry.
- A failed transition leaves the card in its original lane.
- A concurrency conflict identifies that the record changed elsewhere and offers Review latest rather than overwriting.
- A failed reminder creation leaves the task saved but clearly marks the reminder as not scheduled, with Retry.
- A failed file upload creates no metadata row. A failed cleanup is reported with enough detail to retry safely.
- Archive requires confirmation and is reversible. The initial release does not permanently delete opportunity history from the UI.
- Empty states explain how to add the first opportunity or clear incompatible filters.
- Network errors are announced in an accessible live region and never rely on a color-only toast.

## Testing Strategy

Development follows test-first red/green/refactor cycles.

Pure Node tests cover exact stage strings and order, default probabilities, recommended-range warnings, terminal Won/Lost requirements, weighted values, health precedence, transition requirements, filters, report calculations, and CSV row shaping. Access tests add the Marketing tab/view registry and verify full, custom, admin, and denied-deep-link behavior.

Data-adapter tests cover database-to-UI mappings and payload builders without requiring the production Supabase project. Migration checks verify enums, constraints, triggers, indexes, grants, RLS policies, Storage policies, and idempotent object creation. The production build must pass after component integration.

Manual acceptance covers mouse, keyboard, and touch movement; create/edit/reload persistence; each exact stage; reminders; uploads; Won/Lost closure; archive/restore; deep links; responsive layouts; light/dark themes; loading/error/empty states; and multi-user concurrency recovery.

## Rollout and Activation

Implementation is not considered deployed by merging frontend code alone. Activation requires:

1. Apply the new idempotent `beacon_v2` migration through Supabase Studio.
2. Confirm `beacon_v2` remains exposed through the Supabase API.
3. Redeploy `send-alert` for the Marketing subject renderer and deep link.
4. Deploy the frontend.
5. Grant the new Marketing workflow to any existing custom-access users who need it.
6. Run one smoke opportunity through all seven stages in the deployed environment, including a reminder, document, Won closure, Lost closure, and reload.

## Explicit Non-Goals

- No handoff from Marketing into Hot Leads, Proposals, Projects, Invoice, or any other Beacon pipeline.
- No Outlook or email-inbox synchronization.
- No electronic signature workflow.
- No automatic proposal or SOW generation.
- No external CRM synchronization.
- No AI lead scoring.

The normalized opportunity, contact, activity, task, document, and history structure leaves room for those capabilities without redesigning the core pipeline.

## Acceptance Criteria

The release is complete when a permitted user can:

1. Create an opportunity and reload Beacon without losing it.
2. Move it through all seven exactly named stages with transition guidance.
3. Record organization contacts, qualification, BANT, activities, tasks, documents, approval, and legal progress.
4. Receive a scheduled Marketing task reminder through Beacon's email pipeline.
5. Close an opportunity as Won or Lost with the required outcome information and no downstream handoff.
6. Search, filter, sort, archive, restore, export, and review the Insights reports.
7. Use the workflow with mouse, keyboard, and touch on desktop, tablet, and phone.
8. See every write persisted in `beacon_v2` with authoritative error handling and an audit trail.
9. Have Marketing granted or denied through User Management, including deep-link enforcement.
10. Complete the workflow without any external integration.
