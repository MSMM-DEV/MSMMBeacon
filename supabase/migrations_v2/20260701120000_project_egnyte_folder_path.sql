-- Store the Egnyte project-folder link selected from the Invoice table.
-- Kept on projects because invoice rows point back to a source project via
-- anticipated_invoice.source_project_id.

alter table beacon_v2.projects
  add column if not exists egnyte_folder_path text;

comment on column beacon_v2.projects.egnyte_folder_path
  is 'Egnyte folder path linked to this project from the Invoice table.';

notify pgrst, 'reload schema';
