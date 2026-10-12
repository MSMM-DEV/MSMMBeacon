**Project: MSMM Beacon**

I want to build a dashboard that tracks projects through their lifecycle in an engineering company. The dashboard has 6 tables that follow a logical flow. Data flows forward — when a project moves to the next stage, all shared values carry over automatically and the user is only prompted for the new fields required by the next stage.

**Flow overview:**
1. A project starts as a *Potential Project*.
2. After submission, it moves to *Awaiting Verdict*.
3. The verdict is either **Awarded** (moves to *Awarded Projects*) or **Closed Out** (moves to *Closed Out Projects*).
4. Every Awarded Project also generates a row in the *Anticipated Invoice* table for billing tracking.
5. A separate *Events and Other* table runs independently to track partners, meetings, and events.

**User tagging:** The platform has user logins for employees. Any field that refers to a person (e.g., PM, MSMM attendees) should be a tag linked to a user account, not free text.

**Clients and Companies:** These are two separate master tables.
- **Clients** — organizations that hire us (referenced in the Client field on project tables).
- **Companies** — firms we work alongside as Primes or Subs (referenced in the Prime and Subs fields on project tables).

Each project can reference entries from these master lists, but the **contract amount is specific to each project** — so the amount lives on the project row, not on the client or company record.

**Data carry-forward between tables (critical behavior):**
Tables 1, 2, 3, and 4 share many columns. When a user moves a row to the next stage:
- All overlapping/shared fields are copied automatically from the source row to the new row — the user should never have to re-enter data that already exists.
- The system then opens a form that shows **only the new fields** required by the destination table, pre-filling any that can be inferred.
- The original row remains linked to the new row (so history is preserved and you can trace a project back to its origin).
- If a shared field is later edited in the destination table, the system should ask whether to also update the source row, or keep them independent going forward. (Please flag a preference here during build.)

**Row-level actions (all 5 main project tables):** Every row has two action elements:
1. **Move forward** — a button/action to push that row to the next stage table, triggering the carry-forward behavior above.
2. **Set alert** — a button to create a custom email reminder tied to that specific row. The user configures:
   - Who to notify (tagged users)
   - Date and time of first alert
   - Recurrence (one-time, weekly, biweekly, monthly, custom)
   - Optional message/reason for the alert
   The system emails the tagged users at the scheduled time with a link back to the exact row.

---

**Table 1 — Potential Projects**
Year, Project Name, Prime or Sub, Client, Total Contract Amount, MSMM, Subs (multiple allowed, each with company + amount — e.g., "Survey – $90,000; Geotech – $5,000"), PM, Notes, Dates and Comments, Project Number, Probability (High, Medium, Low)

**Table 2 — Awaiting Verdict** (carries forward from Table 1)
Carried over: Year, Project Name, Client, Prime, Subs, Notes, Project Number.
New fields prompted: Status (= "Awaiting Verdict"), Date Submitted, Client Contract Number, MSMM Contract Number, MSMM Used, MSMM Remaining, Org Type (City, State, Federal, Local, Parish, Regional, Other)

**Table 3a — Awarded Projects** (carries forward from Table 2 when verdict = Awarded)
Carried over: Year, Project Name, Client, Prime, Subs, Date Submitted, Client Contract Number, MSMM Contract Number, MSMM Used, MSMM Remaining.
New fields prompted: Status (= "Awarded"), Stage, Details, Pools, Contract Expiry Date, Org Type (City, State, Federal, Local, Parish, Regional, Other)

**Table 3b — Closed Out Projects** (carries forward from Table 2 when verdict = Closed Out)
Carried over: Year, Project Name, Client, Prime, Subs, Date Submitted, Notes, Client Contract Number, MSMM Contract Number.
New fields prompted: Status (= "Closed Out"), Date Closed, Reason for Closure.

**Table 4 — Anticipated Invoice Spreadsheet** (auto-generated when a project is moved to Awarded)
Carried over from Awarded Projects: Project Number, Project Name, PM, Contract Amount.
New fields prompted: Type (ENG or PM), MSMM Remaining to Bill (as of Jan 1 of current year).
Then 12 monthly columns for the year.

**Automatic Actual/Projection logic:** The system uses the current system date to determine the split. All months before and including the current month display as **Actual** (editable, user-entered). All months after the current month display as **Projection**. This switches automatically on the 1st of each new month — no manual toggle needed. Example: on April 20, 2026 → Jan/Feb/Mar/Apr = Actual, May–Dec = Projection.

Also include: YTD MSMM Total Actual (auto-summed), and MSMM Rollforward to next year.

**Table 5 — Events and Other** (standalone, not linked to projects)
Date, Status (Happened or Booked), Type (Partner / AI / Project / Meetings / Event), Title, Date and Time, Attendees from MSMM (tagged user accounts).

This table also supports the **row-level alert action** described above.

---

**Dedicated Marketing module** (standalone commercial pipeline; it does not hand contracts into Projects or Invoice)

Marketing is its own top-level Beacon workflow with three access-controlled views: **Pipeline**, **Opportunity list**, and **Insights**. The Pipeline is a seven-lane Kanban board. These stage names are product language and must remain exact and in this order:

1. Intro to Target or prospect
2. Initial meeting to showcase products and qualify prospect
3. IQM - Initial Qualified Meeting
4. BANT - Budget Authority Need Time
5. Verbal Approval to Proceed
6. Legal and Contract Negotiation
7. Contract Signed Won or Lost

Each opportunity records its organization, owner, estimated and weighted value, expected close, probability, products, source, introducer, next action, and detailed qualification evidence. IQM captures the client problem, desired outcome, fit, clarifying questions, answers, and draft SOW status. BANT captures Budget, Authority, Need, Time, and the decision process. Proposal, verbal approval, legal/MSA/SOW, contract, competitor, and lessons-learned fields keep the full commercial story in one record.

Stage changes are confirmed before persistence, keep an immutable history entry, use optimistic version checks, and recommend a probability within the destination stage's band without silently overwriting an acknowledged custom value. The terminal lane requires either **Won** (signature date and final contract value) or **Lost** (one of Price / Did not meet needs / Timing was not right / Competitor / Internal build / Other, plus optional detail). Won and Lost opportunities remain in Marketing; there is intentionally no automatic downstream handoff.

Stakeholders link to Directory contacts with the relationship roles Champion, Decision-maker, Budget owner, Legal contact, Technical evaluator, or Other. The detail workspace also includes activities, assigned tasks with complete/reopen actions, optional email reminders, private proposal/SOW/MSA/contract files, and stage history. Archive is recoverable; permanent deletion is not part of this module.

The list view is sortable and exports the current filtered view to CSV. Insights show active and weighted pipeline, wins/losses, close timing, funnel value, stage velocity, overdue/stalled opportunities, activity, loss reasons, competitors, sources, products, owners, and organizations. Admins configure how many days without meaningful activity marks an opportunity stalled.

Persistence is provided by `supabase/migrations_v2/20261012120000_marketing_pipeline.sql`: `marketing_opportunities`, `marketing_opportunity_contacts`, `marketing_activities`, `marketing_activity_users`, `marketing_activity_contacts`, `marketing_tasks`, `marketing_documents`, and `marketing_stage_history`, plus the private `marketing-documents` Storage bucket, `app_settings.marketing_stalled_after_days`, and the `marketing` alert subject. Activation is manual: apply the migration in Supabase Studio, confirm `beacon_v2` remains exposed, redeploy `send-alert`, deploy the frontend, grant the Marketing workflow/views to any custom-access users who need them, then run one production smoke opportunity through the full flow.

---

**Supporting master tables**

**Clients table** — organizations we work for.
Client Name, District/State, Contact Person, Email, Phone, Address, Notes.
ONLY Client Name Required Field

**Companies table** — firms we work with as Primes or Subs.
Company Name, Contact Person, Email, Phone, Address, Notes.
ONLY Company Name Required Field

Both are referenced by the project tables; contract-specific amounts stay on the project row.
