-- Per-view MHZ project identity on anticipated_invoice.
--
-- ENG and MHZ are LINKED perspectives of one JV project (see
-- 20260706120100_mhz_invoice_perspectives.sql). They now carry SEPARATE
-- display identities: the ENG (MSMM) view shows project_number / project_name;
-- the MHZ view shows these new mhz_* columns (falling back to project_number /
-- project_name when NULL). The shared project_number stays synced across the
-- two rows as the stable linkage key — only the MHZ-specific display fields
-- diverge. Nullable text; NULL = fall back to the ENG number/name.

alter table beacon_v2.anticipated_invoice
  add column if not exists mhz_project_number text,
  add column if not exists mhz_project_name   text;

notify pgrst, 'reload schema';
