-- Threaded NOTES on the Invoice row — beacon_v2.invoice_notes.
--
-- The Invoice tab's "Notes" used to be a single free-text column
-- (anticipated_invoice.notes, added in 20260607120000). In practice several
-- PMs touch the same project's billing and kept clobbering each other's text —
-- there was no author, no timestamp, and the last writer won. This turns Notes
-- into an append-only ACTIVITY THREAD: every post records who wrote it and
-- when, the UI lists them newest-first, and anyone can add an update without
-- overwriting prior ones.
--
--   • invoice_id     → the anticipated_invoice row the thread hangs off. The
--                      Invoice tab merges a project's per-year rows for display
--                      (mergeInvoiceYears), keying the chip on the primary
--                      year-row's id — exactly how the old single `notes`
--                      column behaved — so the thread lands on that same id.
--   • author_user_id → who posted (beacon_v2.users). ON DELETE SET NULL so a
--                      note survives the author being removed (renders as
--                      "Unknown"); the legacy backfill below also lands as NULL.
--   • body           → the note text (NOT NULL; the UI trims + blocks empty).
--   • created_at     → post time (drives the newest-first sort + the displayed
--                      date/time).
--   • edited_at      → set when a note is edited in place (renders "· edited").
--
-- The old anticipated_invoice.notes text column is LEFT IN PLACE (kept as the
-- backfill source + a cold fallback) but the frontend no longer reads or writes
-- it for the chip — invoice_notes is the source of truth for the Notes thread.
-- (The Description chip is unchanged: it stays a single canonical text field on
-- anticipated_invoice.description.)

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Table.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.invoice_notes (
  id             uuid primary key default gen_random_uuid(),
  invoice_id     uuid not null
                   references beacon_v2.anticipated_invoice(id) on delete cascade,
  author_user_id uuid
                   references beacon_v2.users(id) on delete set null,
  body           text not null,
  created_at     timestamptz not null default now(),
  edited_at      timestamptz
);

-- The thread is always read scoped to one invoice and rendered newest-first,
-- so index the access pattern directly.
create index if not exists invoice_notes_invoice_created_idx
  on beacon_v2.invoice_notes (invoice_id, created_at desc);

--------------------------------------------------------------------------------
-- 2. RLS — read + post open to any authenticated user (it's a shared activity
--    log); edit + delete gated to the note's AUTHOR or an Admin. Mirrors the
--    self-or-admin idiom from the timekeeping tables (is_current_user /
--    is_current_user_admin, both SECURITY DEFINER on auth.uid()).
--------------------------------------------------------------------------------
alter table beacon_v2.invoice_notes enable row level security;

drop policy if exists "invoice_notes_auth_select" on beacon_v2.invoice_notes;
drop policy if exists "invoice_notes_auth_insert" on beacon_v2.invoice_notes;
drop policy if exists "invoice_notes_owner_update" on beacon_v2.invoice_notes;
drop policy if exists "invoice_notes_owner_delete" on beacon_v2.invoice_notes;

create policy "invoice_notes_auth_select" on beacon_v2.invoice_notes
  for select to authenticated using (true);

-- A post must be attributed to the poster (or NULL for service-role / system
-- writes, which bypass RLS anyway). This stops a user from forging another
-- user's authorship via direct PostgREST.
create policy "invoice_notes_auth_insert" on beacon_v2.invoice_notes
  for insert to authenticated
  with check (author_user_id is null or beacon_v2.is_current_user(author_user_id));

create policy "invoice_notes_owner_update" on beacon_v2.invoice_notes
  for update to authenticated
  using (beacon_v2.is_current_user(author_user_id) or beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user(author_user_id) or beacon_v2.is_current_user_admin());

create policy "invoice_notes_owner_delete" on beacon_v2.invoice_notes
  for delete to authenticated
  using (beacon_v2.is_current_user(author_user_id) or beacon_v2.is_current_user_admin());

grant select, insert, update, delete on beacon_v2.invoice_notes to authenticated;

--------------------------------------------------------------------------------
-- 3. Backfill — seed the thread from any existing single-text notes so nothing
--    written under the old column is lost. author NULL (renders "Unknown" /
--    "imported"), timestamp = the row's last-touched time. Guarded so re-runs
--    don't duplicate: only seed an invoice that has non-empty notes AND no
--    thread rows yet.
--------------------------------------------------------------------------------
insert into beacon_v2.invoice_notes (invoice_id, author_user_id, body, created_at)
select ai.id, null, btrim(ai.notes), coalesce(ai.updated_at, ai.created_at, now())
from beacon_v2.anticipated_invoice ai
where ai.notes is not null
  and btrim(ai.notes) <> ''
  and not exists (
    select 1 from beacon_v2.invoice_notes n where n.invoice_id = ai.id
  );

--------------------------------------------------------------------------------
-- 4. PostgREST schema-cache reload so the frontend can read/write the new
--    table immediately (avoids the brief post-CREATE 404 window).
--------------------------------------------------------------------------------
notify pgrst, 'reload schema';
