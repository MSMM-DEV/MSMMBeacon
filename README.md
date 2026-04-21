# MSMM Beacon

Project-lifecycle dashboard for an engineering firm. Projects flow through staged tables (Potential → Awaiting Verdict → Awarded / Closed Out → Anticipated Invoice), with Events and Clients/Companies as sibling masters. See [`PLAN.md`](./PLAN.md) for the product spec.

## Stack

- **Database**: Supabase Postgres, `beacon` schema. Schema + seed in [`supabase/migrations/`](./supabase/migrations).
- **Frontend**: Vite + React (ES modules), `@supabase/supabase-js`. See [`frontend/`](./frontend).
- **Data ingest**: Python script in [`scripts/`](./scripts) that parses the customer's original CSV/xlsx exports and populates `beacon.*` via PostgREST.
- **Auth**: not wired yet. Frontend currently reads as the `anon` role via a permissive RLS policy; writes stay on the client in React state.

## Layout

```
MSMMBeacon/
├── PLAN.md                      product spec (carry-forward rules, fields per table, alerts, etc.)
├── CLAUDE.md                    engineering context for Claude Code sessions
├── Data/                        customer's CSV/xlsx exports (gitignored — see PLAN for what each contained)
├── supabase/migrations/
│   ├── 20260420120000_initial_schema.sql      tables, enums, FKs, RLS, seed users + MSMM company
│   └── 20260420140000_allow_anon_read.sql     SELECT grant for anon (pre-auth)
├── scripts/
│   └── ingest_seed_data.py      one-shot loader from Data/ → beacon.* via PostgREST
└── frontend/                    the app (see frontend/README.md for dev details)
```

## Quick start

### 1. Apply the Supabase migrations

Paste each SQL file into **Dashboard → SQL Editor → Run**, in order:

1. `supabase/migrations/20260420120000_initial_schema.sql`
2. `supabase/migrations/20260420140000_allow_anon_read.sql`

Then add `beacon` to **Dashboard → Settings → API → Exposed schemas**.

### 2. Ingest the seed data (one-time)

```sh
pip install requests openpyxl python-dotenv
python3 scripts/ingest_seed_data.py
```

(Uses the `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` in `.env`. Add `--wipe` to nuke+reseed.)

### 3. Run the frontend

```sh
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Requires `frontend/.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (see `frontend/.env.example`).

## What's in the DB after ingest

| Table | Rows |
|---|---|
| `users` | 30 (Replicon roster) |
| `companies` | 95 |
| `clients` | 32 |
| `potential_projects` (+subs) | 67 (+55) |
| `awaiting_verdict` (+subs) | 10 (+3) |
| `awarded_projects` (+subs) | 49 (+164) |
| `anticipated_invoice` (current year) | ~42 |
| `closed_out_projects`, `events` | empty (no source data) |

## Where to look

- **Product behavior / fields**: [`PLAN.md`](./PLAN.md)
- **Frontend features, commands, config**: [`frontend/README.md`](./frontend/README.md)
- **Engineering context, conventions, gotchas**: [`CLAUDE.md`](./CLAUDE.md)
