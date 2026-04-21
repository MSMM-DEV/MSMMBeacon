# MSMM Beacon — frontend

Vite + React, reading from Supabase (`beacon` schema) via PostgREST.

## Run

```sh
cd frontend
npm install          # first time only
npm run dev          # http://localhost:5173
```

Other scripts: `npm run build` (production bundle → `dist/`), `npm run preview` (serve the built bundle).

## Config

Secrets live in `.env.local` — **not** in source. A template is in `.env.example`.

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
```

- Only vars prefixed `VITE_` are exposed to the browser. That's by design for public config like the anon key.
- `.env.local` is gitignored.
- The **anon public** key is browser-safe: Supabase security is enforced by RLS policies in the DB, not by key secrecy. Supabase actively **blocks** the `service_role` key from browsers — never try to use it here.

## Prerequisites in Supabase (one-time)

1. Apply `supabase/migrations/20260420120000_initial_schema.sql` (creates the `beacon` schema).
2. Expose it: **Dashboard → Settings → API → Exposed schemas** → add `beacon`.
3. Apply `supabase/migrations/20260420140000_allow_anon_read.sql` so the anon role can SELECT.

## File layout

```
frontend/
├── .env.local          VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (gitignored)
├── .env.example        template
├── index.html          Vite entry
├── package.json        react, react-dom, @supabase/supabase-js, jspdf, jspdf-autotable
├── vite.config.js
└── src/
    ├── main.jsx        mounts <App/>, imports styles.css
    ├── App.jsx         top-level: data loader, filter state, tab routing, overlays, export
    ├── data.js         supabase-js client, DB-row → UI-row adapters, formatting helpers
    ├── icons.jsx       inline-SVG icon set
    ├── primitives.jsx  UserTag, chips, Sparkline, EditableCell (single-click inline editor), SubsCell
    ├── tables.jsx      eight table components (7 grid tables + InvoiceTable); sort/filter/reorder/resize/search/columns chrome
    ├── panels.jsx      DetailDrawer, MoveForwardPanel, AlertModal
    ├── forms.jsx       CreateModal — persists new rows to Supabase
    ├── tweaks.jsx      accent / theme / density / font-pair panel
    ├── table-state.js  module-level snapshot published by the active table (used by Export)
    ├── utils/pdf.js    landscape-A4 PDF export via jsPDF + autotable (lazy-loaded on first click)
    └── styles.css      design-drop CSS + probability palette + total-row styling + resize/drag affordances
```

Everything is ES modules with explicit imports/exports. No `window.*` globals.

## Features

### Pipeline navigation
- **8 tabs**: Potential → Awaiting Verdict → Awarded → Closed Out → Invoice → Events & Other · Clients · Companies.
- Pipeline arrows in the tab bar signal the forward flow. Active tab persists in `localStorage`.
- Stats strip (Pipeline MSMM / Awaiting / Active backlog / YTD billed) on pipeline tabs.

### Reading + editing
- **Single-click a cell → inline edit** of that field. Pops the right editor per type: text, number, date, datetime-local, textarea, or select (Role Prime/Sub, Probability High/Medium/Low, Org Type, Stage, PM from user roster, Client from company list, Type Prime/Sub/Multiple, etc.).
- **Double-click a row → detail drawer** opens on the right with every field from PLAN.md for that stage. Includes the full subs editor (company picker + discipline + amount + running total).
- **220 ms debounce** disambiguates single vs. double click.
- **Escape** cancels inline edit; **Enter** commits text/number/date/select; **Cmd/Ctrl+Enter** commits textarea.
- Current caveat: mutations stay in local React state. `supabase.from(...).update(...)` is not wired yet.

### Filtering, sorting, search
- **Preset filter chips** per tab (`Prime` / `Sub` / `Over 30 days` / `Expiring soon` / `Losses only` / `Upcoming` / `Happened` / `Federal` / `State` / …).
- **Year chip** on pipeline tabs — derives available years from the data.
- **Add filter** popover — free-text search across all fields.
- **Sort popover** + click-on-header toggles none → asc → desc → none.
- **Columns popover** with per-column visibility checkboxes; default-hidden cols are rare low-priority fields that stay one click away.
- On **Potential**, default sort is `[probability, role]`. User sort slots in as secondary key so probability grouping stays intact.

### Column manipulation
- **Drag a header** onto another to reorder columns.
- **Drag the right-edge handle** of any header to resize.
- Locked columns (checkbox, row actions) can't be moved or hidden.

### Visuals
- **Probability row stripes** (High = green / Medium = yellow / Low = red) on Potential, with darker hues + subtle row tint.
- **Group totals** at each probability boundary on Potential: Contract / MSMM / Subs sums, plus a **grand total** at the bottom. Recomputes on every filter change.
- **Row flash** on newly-inserted / recently-moved rows.
- **Tweaks panel** (top-right gear icon): accent swatch, light/dark toggle, comfortable/compact density, font-pair selector. Persisted to `localStorage`.

### Creating rows
- **New X** button opens `CreateModal`. Supported: Potential projects, Events, Clients, Companies. (Awaiting/Awarded/Closed Out come via Move Forward; Invoice rows are auto-created when a project moves to Awarded.)
- Inserts go to Supabase via `supabase-js`. On success, the row is adapted and inserted into local state so it appears immediately.

### Move forward + alerts
- **Move forward** button on row hover triggers `MoveForwardPanel` — shows carried fields as locked chips and prompts only for the new fields the next stage requires.
- Awarded transitions auto-create an Invoice row.
- **Set alert** button opens `AlertModal` — recipients (user picker), first-fire datetime, recurrence (one-time / weekly / biweekly / monthly / custom), optional message. Persistence is stubbed for now.

### Export (PDF)
- **Export PDF** button in the page header — landscape A4 with all columns fit on the page width (column wrap enabled, no content cut).
- Reflects the user's active state:
  - filters, year, search
  - sort order (including Potential's grouped default)
  - column order (from drag-reorder)
  - column visibility (hidden columns stay out)
  - probability row colors
  - group totals + grand total
- Subtitle annotates active filter / year / search so the output self-documents.
- jsPDF + jspdf-autotable are **lazy-loaded** on first export — the main bundle stays light.

## Current limitations

| Area | Status |
|---|---|
| Read data from Supabase | ✅ all tables |
| Create rows (Potential / Events / Clients / Companies) | ✅ persists to Supabase |
| Inline edits, move-forward, alerts | UI works; mutations stay in local state (not persisted) |
| PM tags | Blank in seeded rows — legacy `pm_raw` strings haven't been mapped to `users.short_name` |
| Events + Closed Out tables | Empty — no source data; schema + UI ready |
| Auth | None yet — app reads as `anon` via a permissive RLS policy |

## What to wire up next (recommended order)

1. **Persist inline edits** → `supabase.from(...).update(...)` in each `updateRow` / `updateInvoiceCell` handler in `App.jsx`.
2. **Persist move-forward + auto-invoice** → a transaction inside `confirmMove`.
3. **Persist alerts** → `alerts` + `alert_recipients` inserts in `confirmAlert`, plus a scheduler worker (pg_cron or external) for recurring fires.
4. **PM mapping** → resolve legacy `pm_raw` strings (`Stuart`, `Scott C.`, `Chris/ Jeff`, …) against `users.short_name` / `display_name` and populate the `*_pms` join tables.
5. **Supabase Auth sign-in** → wire `signInWithPassword` / magic link, drop the `"anon read"` RLS policy, restore authenticated-only access.
