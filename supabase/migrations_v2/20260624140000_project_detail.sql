-- ============================================================================
-- 20260624140000_project_detail.sql
--   Backs the Project Detail page's two authoring tabs — To-Dos and Notes —
--   plus note attachments. Both hang off a `project_items` NODE (the root
--   project OR any phase/subphase), so a project's detail page can gather
--   every to-do / note across its whole tree by filtering on the node ids it
--   already has in memory.
--
--   • project_todos       — a task on a node: description, optional start/end
--                           dates, priority, a done flag, the user it's
--                           assigned TO and the user who assigned it (set to
--                           the creator). Team task board → permissive RLS.
--   • project_notes       — a threaded, multi-author note on a node: author +
--                           created_at stamped automatically, a category from
--                           a fixed list, free-text body. Mirrors the
--                           invoice_notes activity-log pattern (20260608130000):
--                           read/post open, edit/delete author-or-admin.
--   • project_note_files  — attachment metadata for a note; binaries live in
--                           the NEW private Storage bucket `project-files`
--                           (path `{itemId}/notes/{noteId}/{stamp-name}`),
--                           same authenticated-CRUD object policy as
--                           `invoices` / `license-files` / `bid-rfqs`.
--
-- All three cascade-delete with their parent node (and notes → note files),
-- so deleting a project subtree cleans up its to-dos / notes / attachments.
-- Author / assignee FKs are ON DELETE SET NULL so a removed user doesn't take
-- the record with them. Idempotent / re-runnable; ends with notify pgrst.
-- DB-only — no Edge Function change.
-- ============================================================================

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- 1. Enums (guarded for first-run idempotency).
--------------------------------------------------------------------------------
do $$ begin
  create type beacon_v2.project_todo_priority_enum as enum ('low','medium','high','urgent');
exception when duplicate_object then null; end $$;

do $$ begin
  create type beacon_v2.project_note_category_enum as enum (
    'billing','project_management','invoice','client','management','contract',
    'expense','general','purchase_order','time_entry','vendor_bill','vendor_contract');
exception when duplicate_object then null; end $$;

--------------------------------------------------------------------------------
-- 2. project_todos.
--------------------------------------------------------------------------------
create table if not exists beacon_v2.project_todos (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null
                 references beacon_v2.project_items(id) on delete cascade,
  description  text not null,
  start_date   date,
  end_date     date,
  priority     beacon_v2.project_todo_priority_enum not null default 'medium',
  done         boolean not null default false,
  assigned_to  uuid references beacon_v2.users(id) on delete set null,
  assigned_by  uuid references beacon_v2.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists project_todos_item_idx
  on beacon_v2.project_todos (item_id, created_at desc);

drop trigger if exists trg_project_todos_touch on beacon_v2.project_todos;
create trigger trg_project_todos_touch
  before update on beacon_v2.project_todos
  for each row execute function beacon_v2.touch_updated_at();

--------------------------------------------------------------------------------
-- 3. project_notes  (+ project_note_files).
--------------------------------------------------------------------------------
create table if not exists beacon_v2.project_notes (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null
                   references beacon_v2.project_items(id) on delete cascade,
  author_user_id uuid references beacon_v2.users(id) on delete set null,
  category       beacon_v2.project_note_category_enum not null default 'general',
  body           text not null,
  created_at     timestamptz not null default now(),
  edited_at      timestamptz
);
create index if not exists project_notes_item_created_idx
  on beacon_v2.project_notes (item_id, created_at desc);

create table if not exists beacon_v2.project_note_files (
  id          uuid primary key default gen_random_uuid(),
  note_id     uuid not null
                references beacon_v2.project_notes(id) on delete cascade,
  file_path   text not null,
  file_name   text,
  uploaded_by uuid references beacon_v2.users(id) on delete set null,
  uploaded_at timestamptz not null default now()
);
create index if not exists project_note_files_note_idx
  on beacon_v2.project_note_files (note_id);

--------------------------------------------------------------------------------
-- 4. RLS.
--    • To-dos: permissive-for-authenticated (shared team task board — anyone
--      logged in can create / reassign / complete a project's tasks).
--    • Notes + note files: read + post open to any authenticated user; edit +
--      delete gated to the note's AUTHOR or an Admin (the invoice_notes idiom,
--      is_current_user / is_current_user_admin). Note files inherit the note's
--      authorship via a subquery so only the note's author / an admin may
--      attach or remove files.
--------------------------------------------------------------------------------
alter table beacon_v2.project_todos      enable row level security;
alter table beacon_v2.project_notes      enable row level security;
alter table beacon_v2.project_note_files enable row level security;

-- project_todos --------------------------------------------------------------
drop policy if exists "project_todos_auth_select" on beacon_v2.project_todos;
drop policy if exists "project_todos_auth_insert" on beacon_v2.project_todos;
drop policy if exists "project_todos_auth_update" on beacon_v2.project_todos;
drop policy if exists "project_todos_auth_delete" on beacon_v2.project_todos;
create policy "project_todos_auth_select" on beacon_v2.project_todos for select to authenticated using (true);
create policy "project_todos_auth_insert" on beacon_v2.project_todos for insert to authenticated with check (true);
create policy "project_todos_auth_update" on beacon_v2.project_todos for update to authenticated using (true) with check (true);
create policy "project_todos_auth_delete" on beacon_v2.project_todos for delete to authenticated using (true);

-- project_notes --------------------------------------------------------------
drop policy if exists "project_notes_auth_select" on beacon_v2.project_notes;
drop policy if exists "project_notes_auth_insert" on beacon_v2.project_notes;
drop policy if exists "project_notes_owner_update" on beacon_v2.project_notes;
drop policy if exists "project_notes_owner_delete" on beacon_v2.project_notes;
create policy "project_notes_auth_select" on beacon_v2.project_notes
  for select to authenticated using (true);
create policy "project_notes_auth_insert" on beacon_v2.project_notes
  for insert to authenticated
  with check (author_user_id is null or beacon_v2.is_current_user(author_user_id));
create policy "project_notes_owner_update" on beacon_v2.project_notes
  for update to authenticated
  using (beacon_v2.is_current_user(author_user_id) or beacon_v2.is_current_user_admin())
  with check (beacon_v2.is_current_user(author_user_id) or beacon_v2.is_current_user_admin());
create policy "project_notes_owner_delete" on beacon_v2.project_notes
  for delete to authenticated
  using (beacon_v2.is_current_user(author_user_id) or beacon_v2.is_current_user_admin());

-- project_note_files ---------------------------------------------------------
drop policy if exists "project_note_files_auth_select" on beacon_v2.project_note_files;
drop policy if exists "project_note_files_owner_insert" on beacon_v2.project_note_files;
drop policy if exists "project_note_files_owner_delete" on beacon_v2.project_note_files;
create policy "project_note_files_auth_select" on beacon_v2.project_note_files
  for select to authenticated using (true);
create policy "project_note_files_owner_insert" on beacon_v2.project_note_files
  for insert to authenticated
  with check (exists (
    select 1 from beacon_v2.project_notes n
    where n.id = note_id
      and (beacon_v2.is_current_user(n.author_user_id) or beacon_v2.is_current_user_admin())));
create policy "project_note_files_owner_delete" on beacon_v2.project_note_files
  for delete to authenticated
  using (exists (
    select 1 from beacon_v2.project_notes n
    where n.id = note_id
      and (beacon_v2.is_current_user(n.author_user_id) or beacon_v2.is_current_user_admin())));

grant select, insert, update, delete on beacon_v2.project_todos      to authenticated;
grant select, insert, update, delete on beacon_v2.project_notes      to authenticated;
grant select, insert, update, delete on beacon_v2.project_note_files to authenticated;

--------------------------------------------------------------------------------
-- 5. Storage — private `project-files` bucket + authenticated CRUD on its
--    objects (same pattern as `invoices` / `license-files` / `bid-rfqs`).
--------------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('project-files', 'project-files', false)
on conflict (id) do nothing;

drop policy if exists "project_files_obj_select" on storage.objects;
drop policy if exists "project_files_obj_insert" on storage.objects;
drop policy if exists "project_files_obj_update" on storage.objects;
drop policy if exists "project_files_obj_delete" on storage.objects;
create policy "project_files_obj_select" on storage.objects
  for select to authenticated using (bucket_id = 'project-files');
create policy "project_files_obj_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'project-files');
create policy "project_files_obj_update" on storage.objects
  for update to authenticated using (bucket_id = 'project-files') with check (bucket_id = 'project-files');
create policy "project_files_obj_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'project-files');

--------------------------------------------------------------------------------
-- 6. PostgREST schema-cache reload so the new tables are reachable immediately.
--------------------------------------------------------------------------------
notify pgrst, 'reload schema';
