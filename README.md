# MSMM Beacon

Project-lifecycle dashboard for an engineering firm. Projects flow through staged tables (Potential → Awaiting Verdict → Awarded / SOQ / Closed Out → Anticipated Invoice), with Events, Clients, Companies, and a read-only Quad Sheet as sibling views. See [`PLAN.md`](./PLAN.md) for the product spec.

## Stack

- **Database**: Supabase Postgres, `beacon` schema. Schema + seed in [`supabase/migrations/`](./supabase/migrations).
- **Frontend**: Vite + React (ES modules), `@supabase/supabase-js`. See [`frontend/`](./frontend).
- **Auth**: Supabase Auth (email + password). Every request after login uses the `authenticated` role; there are two app-level roles (`Admin`, `User`) stored on `beacon.users.role`.
- **Edge Functions** (Deno, deployed to Supabase): `admin-users` (privileged user CRUD) and `send-alert` (picks up due `alert_fires` rows, ships email via Resend). See [`supabase/functions/`](./supabase/functions).
- **Scheduler**: GitHub Actions workflow [`alert-tick.yml`](./.github/workflows/alert-tick.yml) POSTs to `send-alert` every minute.
- **Data ingest**: Python scripts in [`scripts/`](./scripts) parse the customer's original CSV/xlsx exports and write to `beacon.*` via PostgREST.

## Layout

```
MSMMBeacon/
├── PLAN.md                      product spec (carry-forward rules, fields per table, alerts, etc.)
├── CLAUDE.md                    engineering context for Claude Code sessions
├── Data/                        customer's CSV/xlsx exports (gitignored — contains PII)
├── supabase/
│   ├── migrations/
│   │   ├── 20260420120000_initial_schema.sql          beacon schema, enums, FKs, RLS, seed MSMM + 30 users
│   │   ├── 20260420140000_allow_anon_read.sql         anon SELECT grant (used before login was wired)
│   │   ├── 20260421120000_allow_anon_write.sql        anon INSERT/UPDATE/DELETE — prototype-only, drop pre-prod
│   │   ├── 20260422120000_orange_potential.sql        Orange probability bucket → auto-creates Invoice row
│   │   ├── 20260422140000_soq_and_boards.sql          beacon.soq table, anticipated_result_date, Board Meetings
│   │   ├── 20260423120000_user_roles.sql              beacon.users.role ∈ {Admin, User}; Raj = Admin
│   │   ├── 20260423130000_orange_probability_enum.sql codifies 'Orange' on probability_enum
│   │   ├── 20260423140000_invoice_overrides.sql       anticipated_invoice.ytd_actual_override + rollforward_override
│   │   └── 20260424120000_alerts_wiring.sql           alerts anchor/timezone/attempts cols, claim_pending_fires + complete_fire RPCs, row-delete triggers
│   └── functions/
│       ├── admin-users/           privileged user CRUD (create / change-password / delete / ban / set-role)
│       └── send-alert/            reads due alert_fires, renders email per subject_table, dispatches via Resend
├── .github/workflows/
│   └── alert-tick.yml             1-min cron that POSTs to send-alert
├── scripts/
│   ├── ingest_seed_data.py        parses Data/ → beacon.* (idempotent; --wipe to reseed)
│   ├── seed_auth_users.py         mirrors beacon.users into auth.users with password {first_name}123$
│   └── backfill_pms.py            extracts PMs from Potential + Invoice CSVs → *_pms join tables
└── frontend/                      the app (see frontend/README.md for dev details)
```

## Quick start

### 1. Apply the Supabase migrations

Paste each SQL file into **Dashboard → SQL Editor → Run**, in timestamp order (they're listed above). Then add `beacon` to **Dashboard → Settings → API → Exposed schemas**.

### 2. Ingest the seed data

```sh
pip install requests openpyxl python-dotenv
python3 scripts/ingest_seed_data.py           # seed beacon.*
python3 scripts/backfill_pms.py               # populate *_pms join rows from CSVs
```

Both use `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` from `.env`. Add `--wipe` to the ingest to nuke + reseed; both scripts take `--dry-run`.

### 3. Seed auth users (passwords)

```sh
python3 scripts/seed_auth_users.py --dry-run  # review
python3 scripts/seed_auth_users.py            # create/update auth.users for every roster entry
```

Passwords follow a predictable pattern: **`{first_name}123$`** (e.g. `Raj123$`, `Stuart123$`). Emails are lowercased. `rmehta@msmmeng.com` is seeded with `role=Admin`; everyone else is `User`.

### 4. Run the frontend

```sh
cd frontend
npm install
npm run dev
```

Open http://localhost:5173, sign in with your email + `{first_name}123$`. Requires `frontend/.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (template in `frontend/.env.example`).

### 5. Turn on email alerts (one-time deploy)

Scheduling + sending alerts needs three moving pieces stood up once. Skip if you just want the local app running against existing data — alert rows still persist to `beacon.alerts`, they just won't dispatch.

1. **Apply the `20260424120000_alerts_wiring.sql` migration** (adds anchor columns, `claim_pending_fires` / `complete_fire` RPCs, and row-delete triggers).
2. **Deploy the `send-alert` Edge Function** and set its secrets:
   ```sh
   supabase functions deploy send-alert --project-ref <your-ref>
   supabase secrets set RESEND_API_KEY=re_... \
                       ALERT_FROM_EMAIL="Beacon <alerts@yourdomain.com>" \
                       APP_URL="https://<deployed-app-url>" \
                       ALERTS_ENABLED=true \
                       --project-ref <your-ref>
   ```
   `ALERT_FROM_EMAIL` must be on a domain verified in your Resend dashboard. `ALERTS_ENABLED=false` is the kill switch — safe to flip without redeploying.
3. **Wire the GitHub Actions tick** by adding two repo secrets:
   - `SEND_ALERT_URL` = `https://<your-ref>.supabase.co/functions/v1/send-alert`
   - `SEND_ALERT_AUTH` = the Supabase service-role key

   The workflow runs `*/1 * * * *`; GitHub's public-runner cron slips 1–10 min, acceptable for reminders. `gh workflow run alert-tick.yml` triggers a manual smoke test.

Admin users also get a **"Run tick now"** button in the gear-icon Alerts tab that POSTs to the same endpoint using their session — handy for testing without waiting for the next cron beat.

## What's in the DB after ingest

| Table | Rows |
|---|---|
| `users` | 30 (Replicon roster; `rmehta@msmmeng.com` is Admin, rest are User) |
| `companies` | ~95 |
| `clients` | ~32 |
| `potential_projects` (+subs, +pms) | 67 (+55, +60) |
| `awaiting_verdict` | 10 |
| `awarded_projects` (+subs) | 49 (+164) |
| `anticipated_invoice` (+pms, current year) | ~42 (+96) |
| `soq`, `closed_out_projects`, `events` | empty (no source data; created via the UI) |

PM counts reflect `backfill_pms.py`. Awaiting / Awarded / Closed get 0 rows because their source files have no PM column — tag PMs in the UI instead.

## Where to look

- **Product behavior / fields**: [`PLAN.md`](./PLAN.md)
- **Frontend features, commands, config**: [`frontend/README.md`](./frontend/README.md)
- **Engineering context, conventions, gotchas**: [`CLAUDE.md`](./CLAUDE.md)
