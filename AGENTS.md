# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Repository Status

Schema live in Supabase + seed data ingested + Supabase Auth sign-in gating the app + frontend running with all major features implemented. UI is responsive across phone / tablet / desktop. **Creates persist** to Supabase (New-X modals including the new New-Awaiting-Verdict entry point, auth seeder, **the full alerts pipeline — schedule, dispatch, log**). **Inline and drawer edits now persist to Supabase across every table** (Potential, Awaiting, Awarded, Closed Out, SOQ, Events, Clients, Companies, Anticipated Invoice) — each `update*` in App.jsx runs an optimistic local setState followed by a scoped `supabase.from(table).update(dbPatch).eq("id", id)`. Multi-PM edits (and event attendees) diff the old vs new array and mirror into the corresponding `*_pms` / `event_attendees` join table. Move-forward transitions still mutate local state only — those writebacks are the last remaining piece.

Alerts are wired end-to-end in code (AlertModal → `beacon.alerts`/`alert_recipients`/`alert_fires` → GitHub Actions cron → `send-alert` Edge Function → Resend). Actual email delivery additionally needs a one-time deploy: apply `20260424120000_alerts_wiring.sql`, `supabase functions deploy send-alert`, set function secrets (`RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `APP_URL`, `ALERTS_ENABLED=true`), and set the GitHub repo secrets `SEND_ALERT_URL` + `SEND_ALERT_AUTH`.

**Outlook calendar sync** is wired end-to-end (Microsoft Graph `/calendarView/delta` → `outlook-sync` Edge Function → `beacon.events` upsert with sticky `type`/`status`/`notes`). Internal `@msmmeng.com` invitees become `event_attendees` join rows; external invitees stay snapshotted on `events.outlook_external_attendees` (jsonb) — never written as users. Authority split is enforced in code: synced fields (title, datetime, internal attendees) are overwritten on every tick; Beacon-extras stay user-editable. Activation needs a manual Azure setup (App registration with `Calendars.Read` Application permission, admin consent, then run `scripts/setup_outlook_rbac.ps1` to scope the app via Exchange Online RBAC for Applications — custom Management Scopes + Role Assignments, replaces the deprecated `New-ApplicationAccessPolicy` flow). **As of 2026-06 the RBAC script provisions two scopes**: the original `Beacon Mailbox Only` and a broader `MSMM-AllUsers-Scope` covering every internal user (the timekeeping classifier reads each user's calendar). Then `supabase functions deploy outlook-sync`, set function secrets (`MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET`, `OUTLOOK_MAILBOX`, `OUTLOOK_SYNC_ENABLED=true`), and set the GitHub repo secrets `OUTLOOK_SYNC_URL` + `OUTLOOK_SYNC_AUTH`.

**Timekeeping** (added 2026-06, `beacon_v2`-native) is wired end-to-end: NFC tap on a Raspberry Pi at the office OR a web/mobile punch button in Beacon → `timeclock-punch` Edge Function → `time_punches` insert → DB trigger `fn_punch_reconcile` closes the open interval + opens a new one + classifies via time-of-day rules → async `timeclock-classify` Edge Function correlates against the per-user Outlook calendar mirror in `user_calendar_events` and fires "tag your meeting" alerts for untagged out-of-office gaps. Weekly approvals via `timesheet_weeks`; approved weeks lock through a BEFORE trigger that respects an admin-set session GUC bypass (`beacon_v2.timekeeping_bypass_lock=on`). Personal **Timesheet** tab visible to all users; admin **Time Admin** tab carries Team Day + Approvals + NFC enrollment + Settings. Activation: apply migrations `20260601120000`–`120500`, redeploy `outlook-sync` (now syncs every user via pass B), `send-alert` (migrated to `beacon_v2` + new `timesheet` render branch), and deploy `timeclock-punch`/`-classify`/`-admin` (new). Set Supabase secret `TIMECLOCK_DEVICE_KEY` (random 32-byte hex); add GH repo secrets `TIMECLOCK_CLASSIFY_URL`/`AUTH`; flip `app_settings.tk_enabled=true`; re-run `scripts/setup_outlook_rbac.ps1` for the broader scope; provision the Pi (`pi/deploy/provision.sh`); enroll per-user NFC fobs via Time Admin → NFC enrollment.

- `PLAN.md` — product spec. Source of truth for scope and behavior. Read first.
- `Data/` — customer's CSV/xlsx exports, organized by lifecycle stage. **Gitignored** (contains PII). Historical reference only; DB is now the source of truth.
- `Data/Users/MSMM-UserNames-Replicon.xlsx` — 30-user roster (Replicon export). Seeded into `beacon.users` by the initial migration.
- `supabase/migrations/` — applied in timestamp order:
  - `20260420120000_initial_schema.sql` — `beacon` schema (enums, tables, FKs, RLS, seed for MSMM company + 30 users).
  - `20260420140000_allow_anon_read.sql` — grants `anon` SELECT on every `beacon.*` table.
  - `20260421120000_allow_anon_write.sql` — grants `anon` INSERT/UPDATE/DELETE too. **Prototype-only**; drop before going public. See the security note inside the file.
  - `20260422120000_orange_potential.sql` — adds the Orange bucket columns (`potential_projects.anticipated_invoice_start_month`, `anticipated_invoice.source_potential_id` + uniqueness). Orange = pre-awarded project already being invoiced.
  - `20260422140000_soq_and_boards.sql` — `beacon.soq` + `soq_subs` + `soq_pms` (parallel pipeline to awarded_projects), `awaiting_verdict.anticipated_result_date`, `'Board Meetings'` event type.
  - `20260423120000_user_roles.sql` — `beacon.users.role` ∈ {`Admin`,`User`}, default `User`. Raj is seeded as Admin. Role is app-enforced today; DB RLS stays permissive-for-authenticated until admin-only actions are defined.
  - `20260423130000_orange_probability_enum.sql` — codifies `'Orange'` on `probability_enum` for reproducibility (Studio had added it out-of-band).
  - `20260423140000_invoice_overrides.sql` — `anticipated_invoice.ytd_actual_override` + `rollforward_override`. NULL = show auto-calc; NOT NULL = show this value verbatim. Clearing the cell writes NULL.
  - `20260424120000_alerts_wiring.sql` — adds `'soq'` to `alert_subject_enum`; adds `alerts.anchor_field` / `anchor_offset_minutes` / `timezone` / `alert_fires.attempts`; creates `beacon.claim_pending_fires(limit)` RPC (FOR UPDATE SKIP LOCKED so concurrent ticks can't double-send) and `beacon.complete_fire(id, status, error)` RPC (atomic status flip + next-fire spawn for simple recurrences, timezone-aware); generic `deactivate_alerts_for(subject_table, id)` helper + BEFORE DELETE triggers on all 7 pipeline tables.
  - `20260424120000_admin_only_user_writes.sql` — tightens `beacon.users` writes to Admin-only. Adds `beacon.is_current_user_admin()` (SECURITY DEFINER, reads `auth.uid()` → `beacon.users.role`); replaces the blanket `auth full access` policy on `beacon.users` with Admin-only INSERT/UPDATE/DELETE. SELECT stays open to authenticated + anon so PM/attendee pickers work. Service-role callers (Edge Functions) bypass RLS and are unaffected.
  - `20260425120000_hot_leads.sql` — `beacon.hot_leads` + `hot_lead_attendees` (lightweight early-stage tracker — title, date_time, client/firm, attendees, notes). Parallel to the project pipeline; no move-forward plumbing.
  - `20260426120000_hot_leads_alerts.sql` — `beacon.hot_lead_status_enum` (`'Scheduled'|'Happened'`) + `hot_leads.status` column (default `'Scheduled'`); adds `'hotlead'` to `alert_subject_enum`; wires the generic `_deactivate_alerts_trigger` on `beacon.hot_leads` so deleting a lead deactivates its future fires (history preserved).
  - `20260427120000_outlook_calendar.sql` — provenance + Outlook fields on `beacon.events` (`source` text default `'manual'` with check constraint `in ('manual','outlook')`, `outlook_event_id` + partial unique index, `outlook_ical_uid`/`outlook_etag`/`outlook_end_datetime`/`outlook_external_attendees jsonb`/`outlook_organizer jsonb`/`outlook_web_link`/`outlook_last_synced_at`/`outlook_is_cancelled`); singleton `beacon.outlook_sync_state` row holding the Graph delta cursor + last-run telemetry (RLS read-open, writes service-role-only). Idempotent via `do $$ ... end $$` guards on the constraint + policies (no `add constraint if not exists` form on PG ≤ 15).
- `supabase/functions/admin-users/` — privileged user CRUD (create / change password / delete / ban / set role). Requires a session JWT with `beacon.users.role='Admin'`; uses service-role key internally.
- `supabase/functions/send-alert/` — drains due `beacon.alert_fires`, renders per-`subject_table` email, dispatches via Resend with per-recipient `Idempotency-Key`, calls `complete_fire` to flip status + spawn next occurrence. Accepts **either** Bearer=`SUPABASE_SERVICE_ROLE_KEY` (GitHub Actions) **or** a session JWT with `role='Admin'` (the "Run tick now" button in the gear → Alerts panel). Handles custom RRULE recurrences via the `rrule` npm package since PG has no RRULE parser. Retries cap at 3 attempts, then the fire is marked `skipped` with `retry cap exceeded`.
- `supabase/functions/outlook-sync/` — pulls `beacon@msmmeng.com`'s calendar from Microsoft Graph and upserts into `beacon.events`. Client-credentials flow against `/oauth2/v2.0/token` (raw fetch, no MSAL SDK), `/v1.0/users/{mailbox}/calendarView/delta` for incremental pulls (cursor stored in `beacon.outlook_sync_state.delta_link`). Same dual-auth gate as `send-alert` (service-role Bearer for cron, Admin JWT for the "Sync now" button on the calendar view). Insert-vs-update is explicit (no `.upsert()`) so UPDATE never names sticky fields. `Prefer: outlook.timezone="UTC"` normalizes timestamps; `isoOrNull` defensively appends `Z` since Graph returns UTC datetimes without a `Z` suffix in that mode. Safety caps: `MAX_PAGES=50`, `odata.maxpagesize=200`. Catch block writes `last_run_summary={error,...}` so failures surface in the admin UI.
- `.github/workflows/alert-tick.yml` — 1-min cron + manual `workflow_dispatch`. Curls `send-alert` with `Bearer $SEND_ALERT_AUTH`. `concurrency: alert-tick` so overlapping ticks don't pile up. GitHub's public-runner scheduler slips 1–10 min in practice — fine for reminders, not for second-precision.
- `.github/workflows/outlook-sync-tick.yml` — 15-min cron + manual `workflow_dispatch`. Curls `outlook-sync` with `Bearer $OUTLOOK_SYNC_AUTH`. `concurrency: outlook-sync-tick`, `timeout-minutes: 5`, `--max-time 240` so the first-run page traversal (±12-month window) doesn't tip over.
- `scripts/ingest_seed_data.py` — parses every CSV/xlsx under `Data/` and populates the schema via PostgREST with the service_role key. Idempotent via `--wipe`. Applies 3 hand-verified Sub-row client corrections (SWB-LSLR → SWB, Westside Creek → USACE San Antonio, LPB Task Order → CPRA) and client inferences for blank-role rows. Does **not** populate `*_pms` join tables — that's a separate pass.
- `scripts/seed_auth_users.py` — upserts an `auth.users` row for every `beacon.users` row with email+first_name. **Password pattern: `{first_name}123$`** (e.g. `Raj123$`). Mirrors `role` into `app_metadata` so future JWT-based RLS can read it. Idempotent; supports `--dry-run` and `--email X`.
- `scripts/backfill_pms.py` — resolves PM names from the Potential + Invoice CSVs against `beacon.users` (short_name → first_name → display_name, with a `MANUAL_OVERRIDES` dict for ambiguous cases like `"Scott"` → Scott Douglas) and writes one row per user into `potential_project_pms` + `anticipated_invoice_pms`. Compound cells like `"Chris/ Autumn"` split into multiple PMs. Idempotent (composite-PK on-conflict-ignore). Reports names not found in the roster (currently `Randy`, `Jeff`, `Ali`). Awaiting/Awarded/Closed source files have no PM column — those stay blank and get tagged in the UI.
- `scripts/ingest_bd_events.py` — parses `Data/Events/BD.xlsx` (5 category columns: Projects / Events / Partners / AI / Meetings) and upserts into `beacon.events`. Type + status are inferred from cell formatting (red font → `Happened`, yellow fill → `Booked`, neither → NULL/tentative; literal `?` → date unknown). Dedupes by `(type, date, normalized title)`; same-(type,date) rows with different titles print as `DATE-COLLISION` for human resolution rather than auto-insert.
- `scripts/sync_2026_invoice.py` / `scripts/sync_2026_pm_invoice.py` — operational refresh scripts that **wipe** all `(year=2026, type=…)` rows in `anticipated_invoice` and reinsert from the source workbook. `sync_2026_invoice.py` reads `Data/Invoice Cycle Data/NEW_2026.xlsx` (ENG side, with Orange section detected by `FFFFC000` fill on the Name cell — Orange rows must link to a `probability='Orange'` Potential via `source_potential_id`). `sync_2026_pm_invoice.py` reads the PM workbook from the user's Egnyte CloudStorage by default (`--xlsx` to override) and writes `type='PM'`. Both share the same PM-name resolver (overrides + roster match).
- `scripts/verify_2026_invoice.py` — read-only cell-by-cell diff between the xlsx "2026" sheet and `anticipated_invoice` in Supabase. No writes; prints every discrepancy. Run after a sync to confirm it landed.
- `scripts/setup_outlook_rbac.ps1` — one-time Exchange Online setup that scopes the Beacon Entra app's `Calendars.Read` Application permission to *only* `beacon@msmmeng.com`. Creates a custom Management Scope (`PrimarySmtpAddress -eq 'beacon@msmmeng.com'`) + a Role Assignment binding the `Application Calendars.Read` role to that scope (RBAC for Applications — replaces the deprecated `New-ApplicationAccessPolicy` flow). Idempotent. Must be run from a `Connect-ExchangeOnline` session by an Exchange Administrator (Entra role); the script self-checks for that role and verifies the result with `Test-ServicePrincipalAuthorization` against both `beacon@msmmeng.com` (expect Calendars.Read granted) and `rmehta@msmmeng.com` (expect empty).
- `frontend/` — Vite + React + ES modules. Full-featured dashboard reading from `beacon.*`. See `frontend/README.md` for feature list.

## Applying migrations

The Supabase CLI is installed and logged in, but `supabase link` needs the project's DB password (separate from the service key in `.env`). Two paths:
1. `supabase link --project-ref ggqlcsppojypgaiyhods` then `supabase db push` (interactive password prompt).
2. Paste each migration into Supabase Studio → SQL Editor → Run.

After applying: **add `beacon` to Dashboard → Settings → API → Exposed schemas.** PostgREST won't serve the schema otherwise.

## Running things

```sh
# Frontend
cd frontend
npm install          # first time only
npm run dev          # http://localhost:5173
npm run build        # prod bundle → dist/

# Ingest (from repo root)
python3 scripts/ingest_seed_data.py           # seed beacon.*
python3 scripts/ingest_seed_data.py --wipe    # nuke + reseed
python3 scripts/ingest_seed_data.py --dry-run # parse only

# Auth seeding (creates/updates auth.users to match beacon.users)
python3 scripts/seed_auth_users.py                       # upsert all
python3 scripts/seed_auth_users.py --dry-run             # show plan
python3 scripts/seed_auth_users.py --email X@msmmeng.com # one user

# PM backfill (run AFTER ingest_seed_data; idempotent)
python3 scripts/backfill_pms.py                          # write *_pms join rows
python3 scripts/backfill_pms.py --dry-run                # parse + match, no writes

# Edge Functions (cloud deploys — never use `supabase start` locally; there
# is no local stack, the CLI isn't linked, and `db reset` would wipe prod).
supabase functions deploy send-alert    --project-ref ggqlcsppojypgaiyhods
supabase functions deploy admin-users   --project-ref ggqlcsppojypgaiyhods
supabase functions deploy outlook-sync  --project-ref ggqlcsppojypgaiyhods
supabase secrets set RESEND_API_KEY=… ALERT_FROM_EMAIL=… APP_URL=… ALERTS_ENABLED=true \
  --project-ref ggqlcsppojypgaiyhods
supabase secrets set MS_GRAPH_TENANT_ID=… MS_GRAPH_CLIENT_ID=… MS_GRAPH_CLIENT_SECRET=… \
  OUTLOOK_MAILBOX=beacon@msmmeng.com OUTLOOK_SYNC_ENABLED=true \
  --project-ref ggqlcsppojypgaiyhods

# Manually fire a cron tick (mostly for debugging; easier to click "Run
# tick now" in the gear → Alerts panel, or "Sync" on the calendar view, as an Admin):
gh workflow run alert-tick.yml
gh workflow run outlook-sync-tick.yml
```

No lint/test commands are defined yet.

## Stack Signals (from `.env`)

- **Supabase** Postgres + PostgREST. `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` for ingest/admin; frontend uses the `anon public` key from `frontend/.env.local`.
- **Resend** — `RESEND_API_KEY` is used only by the `send-alert` Edge Function (mirrored there via `supabase secrets set`). Don't reference this key from the frontend; it's server-only.
- **Microsoft Graph** — `MS_GRAPH_TENANT_ID` / `MS_GRAPH_CLIENT_ID` / `MS_GRAPH_CLIENT_SECRET` are used only by the `outlook-sync` Edge Function. Application-permission auth (no user delegation), scoped to `beacon@msmmeng.com` via Exchange Online RBAC for Applications (custom Management Scope + Role Assignment — see `scripts/setup_outlook_rbac.ps1`). Server-only; never reference from the frontend.
- **OpenAI** key present but unused so far. Likely intended for row-level assist features; confirm use case before wiring.
- **`PASSWORD`** in `.env` — shared gate value, not a Supabase user credential. Don't confuse it with auth.

## Core Domain Architecture

The entire product is a **staged pipeline** with data carry-forward between stages. **Two first-class entry points** — Awaiting Verdict (submitted proposals) and Potential (direct opportunities / billing candidates). Everything downstream is reached by Move Forward:

```
[entry: New Awaiting Verdict]
Awaiting Verdict ─┬─▶ Awarded ──┬──▶ Potential  (COPY; Awarded log stays)
                  │             │
                  │             └──▶ Invoice    (COPY; button)
                  │
                  └─▶ Closed Out  (MOVE)

[entry: New Potential]
Potential ───────────────────────▶ Invoice      (COPY; button)

       (Orange probability on Potential STILL auto-creates a linked Invoice
        row at create time — pre-awarded billing shortcut, unchanged.)

SOQ               (parallel to Awarded; mirrors its shape, not fed by Move Forward)
Events and Other  (standalone)
Clients, Companies  (master tables, referenced by project rows)
Quad Sheet        (read-only dashboard view over Invoice/Events/Awaiting/SOQ)
```

Transition semantics:
- **MOVE** (source row deleted): `awaiting → awarded`, `awaiting → closed`. Matches the "a proposal has only one verdict" mental model.
- **COPY** (source row stays): `awarded → potential`, `awarded → invoice`, `potential → invoice`. Awarded remains a historical log; Potential is a pipeline tracker you may keep after the Invoice exists.

Non-obvious behaviors that must be preserved:

1. **Carry-forward on stage transition.** When a row moves to the next stage, shared columns are copied automatically; the user is prompted **only** for fields new to the destination stage. The source row stays linked to the destination row (history is traceable). See PLAN.md for the exact per-stage field lists — they are not symmetric.
2. **Edit propagation is an open question.** PLAN.md explicitly flags: when a shared field is edited in a destination row, should the source row update too? Ask the user before picking a default.
3. **Contract amount lives on the project row**, never on Client or Company master records. A client can appear on many projects at different amounts.
4. **People fields are user tags, not free text, and are multi-valued.** PM, attendees, alert recipients all resolve to `beacon.users` rows. Every project table has a matching `*_pms` join table (`potential_project_pms`, `awaiting_verdict_pms`, `awarded_project_pms`, `closed_out_project_pms`, `anticipated_invoice_pms`, `soq_pms`) with composite PK `(parent_id, user_id)` — a project can have any number of PMs. The UI models this as `row.pmIds: string[]` end-to-end (table cells render a `<UserStack>`, drawer uses a multi-user picker, CreateModal uses `UserMultiPicker`, PDF export joins names with `, `). Potential + Invoice PMs are backfilled from the CSVs via `scripts/backfill_pms.py`; Awaiting/Awarded/Closed stay blank until tagged in the UI.
5. **Anticipated Invoice is manually created from Awarded or Potential.** There is no longer an auto-create on the `awaiting → awarded` move — the user clicks "Move → Invoice" from either the Awarded or Potential tab to spawn a linked Invoice row (COPY semantics; source stays). The only remaining automatic Invoice creation is the **Orange-bucket shortcut**: creating a Potential with `probability=Orange` still spawns an Invoice row at insert time, linked via `anticipated_invoice.source_potential_id` (uniqueness keyed on `(source_potential_id, year)`). Invoice rows from the manual path carry Project Number, Project Name, PMs, Contract Amount, and Invoice Type (ENG/PM). Most Move Forward wiring still mutates local React state only; only the Orange shortcut persists to Supabase today.
6. **Actual vs. Projection split is date-driven, not a flag.** In the Invoice table, months ≤ current system month render as editable "Actual"; later months render as "Projection". The split advances on the 1st of each month with no manual toggle. Also compute YTD MSMM Total Actual and MSMM Rollforward.
7. **Invoice per-row overrides + writeback.** `ytd_actual_override` and `rollforward_override` on `anticipated_invoice` let a user freeze either derived number. NULL = auto-calc; NOT NULL = display verbatim. Clearing the cell writes NULL. In addition, **all inline Invoice edits now persist to Supabase**: the 12 month columns (`jan_amount`–`dec_amount`) via `updateInvoiceCell`, and `project_name`, `project_number`, `contract_amount`, `type`, `msmm_remaining_to_bill_year_start`, `year` via a whitelist in `updateInvoice` (`INVOICE_COL_MAP` in App.jsx). Writes are optimistic (local state first, then PATCH; no rollback on failure — a toast surfaces the error). PMs still flow through the `anticipated_invoice_pms` join table separately.
8. **Row-level alerts are per-row and wired end-to-end.** Every project row and every Events row supports: tagged recipients, first-fire datetime, recurrence, optional message. Persistence: `confirmAlert` in `App.jsx` inserts three rows (`alerts` + `alert_recipients` + initial pending `alert_fires`). Dispatch: GitHub Actions → `send-alert` → `claim_pending_fires` (atomic) → render email from `subject_table` → Resend (per-recipient idempotency key) → `complete_fire` (flips status + spawns next occurrence for simple recurrences; Edge Function handles custom RRULE via `rrule`). Timezone per-alert (`alerts.timezone`) so weekly/biweekly/monthly math survives DST. Deletes on the parent row trip a BEFORE DELETE trigger that flips `is_active=false` on related alerts — history stays, future fires stop. `alert_fires.status ∈ {pending, processing, sent, failed, skipped}` IS the log table. See §"Alerts dispatch pipeline" below for the full flow.
9. **Smart anchor + offset presets on the bell modal.** `AlertModal` receives `anchors` (populated date fields on the row — `anticipatedResultDate`, `contractExpiry`, etc. from `getRowAnchors(tab, row)` in `data.js`) and shows anchor chips above offset-preset chips (30 min / 1 hr / 1 day / 2 days / Custom). Picking both fills the date + time inputs; inputs remain the source of truth. On submit, `anchor_field` + `anchor_offset_minutes` + `timezone` persist on the alert so the email body can phrase the anchor in plain English ("1 day before the anticipated verdict on Apr 30").
10. **SOQ is parallel, not downstream.** SOQ rows share the Awarded shape plus `start_date` and `recurring` (`Yes`/`No`/`Maybe`/`In Talks`). They are **not** created by Move Forward — the SOQ tab has its own New SOQ entry point.

## Auth & Roles

- **Login is required.** `App.jsx` boots with `phase="booting"` → reads the Supabase session → `phase="anon"` renders `LoginPage` (calls `signIn` then `fetchCurrentBeaconUser`) → `phase="loading"` runs `loadBeacon()` → `phase="ready"`. `onAuthStateChange` kicks cross-tab sign-outs back to `"anon"`.
- **Two roles, app-enforced + RLS-gated on `beacon.users`.** `beacon.users.role` ∈ {`Admin`,`User`}. `isAdmin()` in `data.js` keys off the row fetched on login. Writes to `beacon.users` are RLS-gated to Admin via `beacon.is_current_user_admin()` (migration `20260424120000_admin_only_user_writes.sql`) — defense-in-depth so a compromised authenticated user can't flip their own role via direct PostgREST. SELECT stays open to authenticated + anon so PM/attendee pickers work. Other `beacon.*` tables remain permissive-for-authenticated — tighten further as admin-only actions accrue.
- **Admin drawer** lives on the gear icon: tabs = Users / **Alerts** / Appearance. Non-admins see the TweaksPanel (Appearance only) from the same gear. The Alerts tab widens the drawer to ~880px via an `admin-drawer-wide` modifier.
- **Edge Function auth patterns:**
  - `admin-users` — session JWT with `role='Admin'`, validated by re-fetching `beacon.users` on each call.
  - `send-alert` — dual: service-role bearer (GitHub Actions) **or** an Admin session JWT (the "Run tick now" button). Anon callers get 401/403.
- **Seeding auth users.** `scripts/seed_auth_users.py` mirrors every `beacon.users` row into `auth.users` with password `{first_name}123$` and `app_metadata.role`. It's idempotent (PUT on match, POST on miss).
- **Anon write policies are a prototype shortcut.** `20260421120000_allow_anon_write.sql` opens full CRUD to `anon` so creates work before auth was wired. Now that login is live, the `anon insert/update/delete` policies (and the `anon read` policy) should be dropped on any table that should be sign-in-gated — see the security note inside that migration.

## Alerts dispatch pipeline

```
AlertModal  →  confirmAlert (App.jsx)              ─┐
  • 3 inserts: alerts + alert_recipients + pending  │
    alert_fires (status='pending')                  │   (every 60s)
                                                    │        │
                                                    ▼        ▼
                                         beacon.alert_fires  ◀──  GH Actions cron
                                                             │    (alert-tick.yml)
                                                             ▼
                                              send-alert Edge Function
                                              1. claim_pending_fires (SKIP LOCKED, marks 'processing')
                                              2. load alert + recipients + subject row
                                              3. render email per subject_table
                                              4. Resend (Idempotency-Key = fire.id:email)
                                              5. complete_fire ─┬─ status='sent' + spawn next fire (tz-aware)
                                                                ├─ status='failed' + error_message (retry ≤3)
                                                                └─ status='skipped' (subject deleted, disabled, etc.)
```

- **Kill switch:** `ALERTS_ENABLED=false` as an Edge Function secret short-circuits the handler → `{ok:true, disabled:true}`. No redeploy needed.
- **Logs:** `beacon.alert_fires` IS the log table. Studio-friendly query:
  ```sql
  select f.status, f.scheduled_at, f.fired_at, f.error_message,
         a.subject_table, a.subject_row_id, a.recurrence
    from beacon.alert_fires f
    join beacon.alerts a on a.id = f.alert_id
   order by f.scheduled_at desc limit 50;
  ```
  The Dispatch Desk tab renders the same info with vitals + per-alert expand-for-history + retry buttons.
- **Deep links:** `send-alert` builds `{APP_URL}?tab=X&rowId=Y`. `App.jsx` reads query params on BeaconApp mount, sets tab, then a `pendingFocusRowId` effect auto-opens the DetailDrawer when rows include that id; URL cleared via `history.replaceState`.
- **Polymorphic subject resolution:** `alerts.subject_row_id` has no FK (it spans 7 tables). The Edge Function maps `subject_table` → DB table name and selects by id. A missing row → `skipped` + `is_active=false` on the alert (the BEFORE DELETE trigger also deactivates immediately).
- **Custom RRULE:** `recurrence_rule` is an iCal RRULE string. `complete_fire` returns without spawning for `recurrence='custom'`; the Edge Function parses the rule via `rrule` (npm) and inserts the next pending fire itself.

## Frontend — domain-specific features (beyond a generic table app)

These are baked into the current implementation and rely on DB-shape details:

- **Ten tabs**: Invoice · Potential → Awaiting Verdict → Awarded → SOQ → Closed Out · Events & Other · Clients · Companies · **Quad Sheet** (read-only executive dashboard). Components are wired in `App.jsx`; render functions live in `tables.jsx` (one export per tab), `InvoiceTable` is in the same file, and `quadsheet.jsx` owns the 4-quadrant dashboard.
- **Events are grouped by Type** (Board Meetings → Partner → Meetings → Project → AI → Event) with section-header rows, using the same `primarySort + postProcess` mechanic Awarded/Awaiting use for org-type groups. `'Board Meetings'` is a first-class `event_type_enum` value.
- **Awaiting rows carry `anticipated_result_date`** — an editable column on the Awaiting table and a dedicated tile in the Quad Sheet (color-coded: overdue / soon / upcoming / TBA).
- **SOQ tab** is its own entry point (not fed by Move Forward). Mirrors the Awarded shape plus `start_date`, `contract_expiry_date`, and `recurring`. The Quad Sheet shows SOQs as horizontal gantt-style bars colored by recurring status (`Yes`/`In Talks`/`Maybe`/`No`).
- **Multi-PM everywhere.** Tables render PMs as an avatar stack; the detail drawer and CreateModal both use a multi-user picker. `App.jsx` `EXPORT_COLUMNS` join PM names with `, ` for PDF. Auto-created Invoice rows (from Awarded move-forward or Orange potential) copy the full `pmIds` array.
- **Probability buckets** include `Orange` alongside High/Medium/Low. Orange rows are pre-awarded and trigger an Invoice row on create (see Core Domain Architecture #5).
- **Probability-grouped default sort** on Potential (High → Medium → Low, then Prime → Sub). Group totals row at each boundary + grand total. User's column sort applies as a secondary key within each probability group.
- **Row-color stripes** on Potential by probability (green/yellow/orange/red) — carried through to PDF export.
- **Year filter chip** per tab (derives available years from data).
- **Column reorder + resize** (drag header to reorder; drag right-edge handle to resize). Persisted per session.
- **Column visibility toggle** (Columns menu); default-hidden columns on per-table basis.
- **Full-text "Add filter" search** — filters all fields client-side.
- **Inline edit**: single click on cell → appropriate editor (text/number/date/datetime/textarea/select). Double click on row → detail drawer. 220 ms debounce disambiguates the two. **Invoice edits persist** (see Core Domain #7 — month cells + name/number/contract/type/remaining/year/override columns). Most other tabs still mutate local React state only.
- **Bell modal (AlertModal)** — row-anchor chips + offset presets (30m / 1h / 1d / 2d / Custom) auto-populate the date+time inputs. Submits persist the alert end-to-end; the stored `anchor_field`/`anchor_offset_minutes` let the email body phrase "1 day before the anticipated verdict on Apr 30" at send time.
- **Dispatch Desk** (`frontend/src/admin-alerts.jsx`) — admin-only third tab inside the gear drawer. Masthead with LIVE/IDLE pulse driven by "last fire within 5 min", 24h vitals (active / sent / failed / skipped / pending), per-alert cards that expand to show the last 12 fires with signal-light status chips, inline retry on failures, pause/resume/delete, inline recipient editor, "Run tick now" that POSTs to `send-alert` using the admin's JWT. Polls vitals every 30s.
- **Quad Sheet invoice chart shows two lines** — a cadmium-orange `var(--prob-orange)` line for the With-Orange total (all invoices, including Orange-sourced) and a sage baseline for Without-Orange (non-Orange invoices only; filtered by `!r.sourcePotentialId`). Both carry solid-for-actual / dashed-for-projection. The vertical gap at any month equals the Orange pipeline's billing contribution. Both lines render unconditionally — they overlap visually when there's no Orange activity. KPIs and hover tooltip always show both values. Orange was picked over amber so the line is semantically self-describing (same color as the Orange probability stripe in Potential).
- **PDF export** (landscape A4, row colors, all columns fit on page width, wrapping) — reflects user's current filter + sort + column order + hidden cols + group totals.
- **Tweaks panel** (accent / theme / density / font-pair) persisted to localStorage; applied before the login page renders so sign-in matches the app theme.
- **Events tab has two views — List + Calendar** — toggled via a segmented control above the table; persisted as `localStorage["beacon.eventsViewMode"]`. The Calendar (`frontend/src/events-calendar.jsx`, react-big-calendar with date-fns localizer) supports Month / Week / Day on desktop and auto-falls to Agenda at ≤640 px. Events are color-coded by Type via `tone-{accent|sage|blue|rose|muted}` left-stripes that match the existing chip palette. Cancelled Outlook events render dimmed + strikethrough but stay visible. Clicking an event opens the same DetailDrawer; drag-selecting an empty slot opens the New Event modal pre-filled via `seed={ event_datetime }` (CreateModal merges `seed` over `INITIAL[table]` on init).
- **Outlook integration UI surface** — Outlook-sourced rows render with a small `<Icon name="link"/>` glyph in the Title cell (table) and a `.drawer-outlook-banner` with an "Edit in Outlook ↗" deep link to `outlookWebLink` (drawer). Synced fields (`title`, `dateTime`, `attendees`) become read-only for `source === "outlook"` rows in both the table and the drawer; `type` / `status` / `notes` stay editable. External invitees (non-`@msmmeng.com`) display below internal attendees as `.ext-chip` pills colored by response (`accepted` → sage / `declined` → rose strikethrough). Defense-in-depth `updateEvents` guard in `App.jsx` strips synced fields from any patch on Outlook-sourced rows so a stale UI edit can't ride through. An admin-only "Sync" pill on the calendar toolbar invokes `runOutlookSyncNow()` and reloads events on success.

## Responsive design

The app runs at phone, tablet, and desktop widths. Entry point: `frontend/index.html`'s viewport is `width=device-width, initial-scale=1, viewport-fit=cover` (formerly pinned to `width=1440`, which forced mobile Safari to render the desktop layout zoomed-out). The responsive layer lives entirely in `frontend/src/styles.css` — no per-component breakpoint JS except the tab-rail auto-scroll.

- **Breakpoint ladder** (mobile-first overrides appended to the end of `styles.css`, ~280 lines): ≤1280 → ≤1024 → ≤840 → ≤640 → ≤440. Plus `@media (hover: none) and (pointer: coarse)` for touch-target sizing, landscape-phone re-centering of modals, `@media print`, and `@media (prefers-reduced-motion: reduce)`. 11 media-query blocks total.
- **Tables keep their grid columns and scroll horizontally** inside `.table-scroll` — we explicitly did NOT collapse to card views (user muscle memory for the grid is load-bearing). Each `.table-scroll` wraps header + rows in a `.table-scroll-body { min-width: min-content }` div so all rows render at a shared width. `min-content` (not `max-content`) is intentional: it resolves to the sum of track minimums (fixed px + `minmax()` first arg), which is exactly what the grid needs to render without clipping — `max-content` would additionally pull in cell-text intrinsic widths and inflate the wrapper past what the grid requires, causing spurious horizontal scroll on wide desktops.
- **Drawer → full-width on phone**; modals (`AlertModal`, `CreateModal`, `MoveForwardPanel`) convert to **bottom-sheets** on portrait phones (slide up from bottom, rounded top corners only) and **re-center** on landscape-phone geometries via `@media (max-height: 500px) and (max-width: 900px)` where a bottom-sheet would cover the whole viewport.
- **Pipeline tab rail horizontal-scrolls** below 1024 instead of wrapping to multiple rows. `App.jsx` holds a `pipelineRef` and runs a `useEffect` on `tab` that calls `scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" })` on the active tab — so programmatic tab changes, URL-param deep links, and stale touch-scrolled positions all recover the active tab.
- **Topbar collapses** on phones: `.brand-sub`, the decorative notifications bell, the (currently non-functional) search pill, and the session role chip all hide progressively. The session name hides before the avatar.
- **Stat strip** 4 → 3 → 2 columns; sparkline drops on phones so seven-figure values don't collide with the sparkline SVG.
- **iOS notch respected** via `env(safe-area-inset-*)` on topbar / tabs / page / toast.
- **Admin drawer + Dispatch vitals** reflow: vitals grid 5 → 3 → 2 cols, admin row drops badges onto a second grid row at ≤640 so name/email don't clip at 360 px.

## Seed Data Notes

The CSVs in `Data/` are exports from live spreadsheets and have the quirks you'd expect:
- Multi-row headers, merged cells, and category rows interleaved with data (e.g., `Org Type : Federal` as a section header in `Awarded Data/`).
- "Subs" appear as repeated columns with embedded dollar amounts in strings (`"$90,000 (survey)"`) — parse, don't assume clean numerics.
- Dates are inconsistent (`4/1/26`, `decision on 4/2/26`, blank). Normalize on ingest.
- Probability is encoded by color/legend in the source; the ingester maps section-total rows (`Total Amount (High Probability)` etc.) to probability values.
- The 2025 Potential file has no Prime/Sub or Client columns — per user direction, all 2025 rows ingest as `role='Prime'`, `client_id=NULL`.
- Three rows in 2026 Potential had the Client column holding the **prime** firm rather than the end-client (because MSMM was a Sub on them); hand-verified corrections are baked into `scripts/ingest_seed_data.py`.

## Hosting topology

Three hosts, three responsibilities:

| Host | What runs there | Config |
|---|---|---|
| **Vercel** | `frontend/` static Vite build | `frontend/vercel.json` (SPA rewrites, security headers), Project Settings → Root Directory = `frontend`, env vars `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` |
| **Supabase** | Postgres + PostgREST + Edge Functions (`admin-users`, `send-alert`, `outlook-sync`) | `supabase/migrations/` applied via Studio SQL Editor; `supabase secrets set ...` for function env (`RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `APP_URL`, `ALERTS_ENABLED`, `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET`, `OUTLOOK_MAILBOX`, `OUTLOOK_SYNC_ENABLED`) |
| **GitHub Actions** | 1-min `alert-tick` + 15-min `outlook-sync-tick` crons | `.github/workflows/alert-tick.yml`, `.github/workflows/outlook-sync-tick.yml`; repo secrets `SEND_ALERT_URL` + `SEND_ALERT_AUTH` + `OUTLOOK_SYNC_URL` + `OUTLOOK_SYNC_AUTH` |
| **Microsoft 365 / Azure AD** | Tenant-level App registration with `Calendars.Read` Application permission, scoped to `beacon@msmmeng.com` via Exchange Online RBAC for Applications (custom Management Scope + Role Assignment — provisioned by `scripts/setup_outlook_rbac.ps1`) | One-time setup; tenant ID + client ID + client secret captured into the Supabase function secrets above. Verify with `Test-ServicePrincipalAuthorization -Identity <AppId> -Resource beacon@msmmeng.com` (expect `Application Calendars.Read` in `GrantedPermissions`) and against any other mailbox (expect empty). |

After the first Vercel deploy, update Supabase's `APP_URL` secret to the deployed URL so alert-email deep links point to the right place. Preview deploys share production's Supabase — creating data on a preview writes to the real DB. Custom domain: add in Vercel → Domains, re-run `supabase secrets set APP_URL=...` to match.

## Working Style

- PLAN.md has several explicit "flag a preference here during build" points. Surface those to the user instead of silently choosing.
- Customer data under `Data/` is private — never commit it back (`.gitignore` excludes the directory). Supabase now holds the canonical copy.
- `frontend/.env.local` contains the anon public key (browser-safe, but still gitignored by convention).
