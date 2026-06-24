# MSMM Beacon

Project-lifecycle dashboard for an engineering firm. Opportunities flow through a staged pipeline — **Leads & Bids** (Hot Leads · Open Bids) → **Proposals & Awarded** (Proposals · Awarded) → **Invoice** (Invoices · In-Between · Closed Out) — with carry-forward between stages. Alongside the pipeline it runs an invoice/cash-flow tracker, an Events calendar (with Outlook sync), a Directory of clients & companies, a Licenses & Certifications tracker, NFC/web **timekeeping**, and **vacation/sick leave**. Installable as a PWA on desktop and mobile.

> **Source of truth for behavior:** [`PLAN.md`](./PLAN.md) (product spec) and [`CLAUDE.md`](./CLAUDE.md) (engineering context, conventions, per-migration gotchas — the current, detailed reference). This README is the high-level overview.

## Stack

- **Database** — Supabase Postgres + PostgREST. The **live schema is `beacon_v2`** (`supabase/migrations_v2/`); the legacy `beacon` schema (`supabase/migrations/`) is kept only as a cold backup. The frontend reads/writes exclusively from `beacon_v2`.
- **Frontend** — Vite + React (ES modules), `@supabase/supabase-js`. Responsive phone → tablet → desktop, installable PWA. Lives in [`frontend/`](./frontend).
- **Auth** — Supabase Auth (email + password). Two app roles (`Admin`, `User`) on `beacon_v2.users.role`, enforced in-app and via RLS.
- **Edge Functions** (Deno, on Supabase) — `admin-users`, `send-alert`, `outlook-sync`, `timeclock-punch`, `timeclock-classify`, `timeclock-admin`, `generate-description`, `license-reminders`. See [`supabase/functions/`](./supabase/functions).
- **Scheduler** — GitHub Actions crons in [`.github/workflows/`](./.github/workflows): `alert-tick` (1 min), `outlook-sync-tick` (15 min), `timekeeping-classify-tick` (5 min), `license-reminders-tick` (daily).
- **Integrations** — Resend (email), Microsoft Graph (Outlook calendar sync), OpenAI (AI invoice-description generator). All keys are server-side Edge Function secrets, never in the browser.
- **Office hardware** — a Raspberry Pi NFC reader (7" kiosk or headless OLED) posts punches to `timeclock-punch`. See [`pi/`](./pi).

## Layout

```
MSMMBeacon/
├── PLAN.md                      product spec (carry-forward rules, fields per stage, alerts)
├── CLAUDE.md / AGENTS.md        engineering context for AI coding sessions (kept in sync)
├── Data/                        customer CSV/xlsx exports (gitignored — PII)
├── supabase/
│   ├── migrations_v2/           THE LIVE SCHEMA (beacon_v2). Apply in timestamp order via Studio.
│   ├── migrations/              legacy v1 schema (beacon) — cold backup, not used by the app
│   └── functions/               8 Edge Functions (see Stack above)
├── .github/workflows/           4 cron ticks (alerts / outlook / timekeeping / licenses)
├── scripts/                     Python ingest/seed + maintenance + setup_outlook_rbac.ps1
├── pi/                          Raspberry Pi NFC tap reader (kiosk + headless)
└── frontend/                    the app (see frontend/README.md for the .env quick-start)
```

## Local development

```sh
cd frontend
npm install
npm run dev          # http://localhost:5173  (Node ≥ 20)
npm run build        # prod bundle → dist/
```

Requires `frontend/.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the `anon public` key from Supabase → Settings → API). Sign in with your email + `{first_name}123$` (the seeded password pattern, e.g. `Raj123$`).

There is **no local Supabase stack** — the app always talks to the cloud project. Don't run `supabase start` / `db reset` / `db push`.

## Database & migrations

Apply each file in `supabase/migrations_v2/` **in timestamp order** by pasting it into **Supabase Studio → SQL Editor → Run** (every migration is idempotent). Then add **`beacon_v2`** to **Settings → API → Exposed schemas** so PostgREST serves it.

Most recent work uses the same pattern — e.g. `20260624120000_leads_openbids_anticipated_amount.sql` adds the "Anticipated Amount" field to Hot Leads + Open Bids. CLAUDE.md documents every migration and the gotcha each one creates.

## Edge Functions & crons

Deploy whichever function you touched (all eight deploy the same way):

```sh
supabase functions deploy <name> --project-ref ggqlcsppojypgaiyhods
```

Secrets are set with `supabase secrets set KEY=value --project-ref ...` (Resend, Microsoft Graph, OpenAI, `TIMECLOCK_DEVICE_KEY`, `APP_URL`, kill switches, etc. — full list in CLAUDE.md → Hosting topology). The four GitHub Actions ticks each need a repo secret pair (`*_URL` + `*_AUTH`).

## Deployment (Vercel)

- **Import the repo** in Vercel → set **Root Directory = `frontend`** (Vite auto-detected). `frontend/vercel.json` handles SPA rewrites, security headers, and the no-cache headers for `/sw.js` + `/workbox-*.js`.
- **Env vars** (Production + Preview): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Never add server-only keys (service role, Resend, OpenAI, Graph) here.
- **After first deploy**, point alert email deep-links at the live URL: `supabase secrets set APP_URL="https://<your-url>" --project-ref ggqlcsppojypgaiyhods`.
- **Preview deploys** share the production Supabase — data written on a preview hits the real DB.

### Custom domain through Cloudflare — important caching caveat

Production is reachable on the Vercel domain (`beacon-msmm.vercel.app`) and on a Cloudflare-proxied custom domain (`beacon.msmm-ai.com`). **Cloudflare caches `.js` at its edge by default — including the stable-named `sw.js` / `workbox-*.js`** — so the service worker on the Cloudflare domain keeps re-fetching the *old* worker and the installed PWA **stops receiving deploys on that domain** (the Vercel domain updates fine). To fix it in the Cloudflare zone:

1. **Caching → Browser Cache TTL → "Respect Existing Headers."**
2. **Caching → Cache Rules → Bypass cache** for `"/sw.js"`, `"/"`, `"/index.html"`, `"/manifest.webmanifest"`, and paths starting `"/workbox-"`. Leave `/assets/*` cached (those are content-hashed + immutable).
3. **Purge Everything** once to evict the stale worker.

Verify with `curl -sI https://beacon.msmm-ai.com/sw.js` — you want `cf-cache-status: BYPASS`/`DYNAMIC` and an `etag` matching the Vercel domain.

## PWA update behavior

The app is an installable PWA. It actively checks for new builds (on launch, every ~60 s, and whenever you return to the window or reconnect), applies updates **silently when the app is backgrounded**, and shows an "Update available" prompt when you're actively using it. The first time you deploy the build that contains this logic, fully quit + reopen the installed app once to bootstrap the new worker; every later deploy is then automatic — provided the Cloudflare caching caveat above is handled on the custom domain.

## Scripts

Python ingest/seed + maintenance live in [`scripts/`](./scripts) (use `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` from `.env`; most take `--dry-run`). The legacy ingest tools target the v1 `beacon` schema; the newer leave/licenses/MSMM-maintenance scripts target `beacon_v2`. See CLAUDE.md for what each one does.

## Where to look

- **Product behavior / fields** → [`PLAN.md`](./PLAN.md)
- **Engineering context, conventions, every migration & gotcha** → [`CLAUDE.md`](./CLAUDE.md)
- **Frontend dev details / `.env`** → [`frontend/README.md`](./frontend/README.md) *(note: parts of that file are v1-era; this README + CLAUDE.md are current)*
