-- MSMM Beacon v2 — merge duplicate directory entities (companies / clients).
--
-- The Directory accumulates duplicate firms ("SVS" entered twice, "USACE —
-- New Orleans" entered as both a client and a slightly different spelling).
-- Merging consolidates a set of duplicate rows into one SURVIVOR and repoints
-- EVERY reference to the losers onto the survivor, then deletes the losers.
--
-- Two RPCs, one per master table:
--   merge_companies(survivor uuid, losers uuid[])
--   merge_clients  (survivor uuid, losers uuid[])
--
-- Why an RPC and not client-side UPDATEs: the repoint + child-row dedup + the
-- final delete must be ONE transaction. Several referencing FKs are
-- `on delete restrict` (projects.prime_company_id, project_subs.company_id,
-- sub_invoices.company_id, projects.client_id, projects.prime_client_id) — so
-- if even one reference were missed, the final DELETE would raise and the WHOLE
-- transaction rolls back. That restrict-FK wall is a feature: a merge can never
-- half-apply. The set-null / cascade FKs (leads.*, open_bids.client_id,
-- invoice_party_files.party_company_id) are ALSO repointed explicitly so no row
-- is silently nulled or cascade-deleted.
--
-- Collision handling: two unique indexes can collide when both a survivor and a
-- loser already touch the same project line —
--   project_subs_proj_company_kind_uniq (project_id, company_id, kind)
--   sub_invoices_kind_uniq              (project_id, kind, company_id, year, month)
-- For those we COALESCE the loser's data onto the survivor's existing row
-- (richest value wins; booleans OR; sub-invoice PDFs are re-parented to the
-- survivor row so binaries are never orphaned), delete the loser's now-duplicate
-- child row, THEN repoint the remaining (non-colliding) loser rows. Sub-invoice
-- amounts are NEVER summed on collision — duplicates are the same bill entered
-- twice, so the survivor's value is kept to avoid silent double-counting.
--
-- Profile fields (contact / email / phone / address / notes) are intentionally
-- NOT merged here — only references are repointed. The MSMM company singleton
-- (is_msmm = true) may be a survivor but can never be a loser (never deleted).
--
-- Idempotent: create or replace; re-pasting is safe. EXECUTE is granted to
-- `authenticated` only (anon — i.e. logged-out — cannot merge).

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- merge_companies — consolidate beacon_v2.companies rows.
--------------------------------------------------------------------------------
create or replace function beacon_v2.merge_companies(p_survivor uuid, p_losers uuid[])
returns jsonb
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  v_loser    uuid;
  v_is_msmm  boolean;
  n          int;
  c_projects int := 0;
  c_subs     int := 0;
  c_subinv   int := 0;
  c_party    int := 0;
  c_leads    int := 0;
  c_merged   int := 0;
begin
  if p_survivor is null then
    raise exception 'merge_companies: survivor id is required';
  end if;
  if p_losers is null or array_length(p_losers, 1) is null then
    raise exception 'merge_companies: at least one loser id is required';
  end if;
  if p_survivor = any(p_losers) then
    raise exception 'merge_companies: survivor cannot also be a loser';
  end if;

  perform 1 from beacon_v2.companies where id = p_survivor;
  if not found then
    raise exception 'merge_companies: survivor % does not exist', p_survivor;
  end if;

  foreach v_loser in array p_losers loop
    -- Skip ids that aren't (or are no longer) companies.
    select is_msmm into v_is_msmm from beacon_v2.companies where id = v_loser;
    if not found then continue; end if;
    if v_is_msmm then
      raise exception 'merge_companies: the MSMM company (%) cannot be merged away', v_loser;
    end if;

    ----------------------------------------------------------------------------
    -- project_subs — unique (project_id, company_id, kind). Coalesce, delete
    -- the duplicate, then repoint the rest.
    ----------------------------------------------------------------------------
    update beacon_v2.project_subs s
       set amount        = coalesce(s.amount, l.amount),
           discipline    = coalesce(s.discipline, l.discipline),
           sub_agreement = s.sub_agreement or l.sub_agreement,
           w9            = s.w9 or l.w9,
           coi           = s.coi or l.coi
      from beacon_v2.project_subs l
     where s.company_id = p_survivor
       and l.company_id = v_loser
       and s.project_id = l.project_id
       and s.kind       = l.kind;

    delete from beacon_v2.project_subs l
     using beacon_v2.project_subs s
     where l.company_id = v_loser
       and s.company_id = p_survivor
       and s.project_id = l.project_id
       and s.kind       = l.kind;

    update beacon_v2.project_subs
       set company_id = p_survivor
     where company_id = v_loser;
    get diagnostics n = row_count; c_subs := c_subs + n;

    ----------------------------------------------------------------------------
    -- sub_invoices — unique (project_id, kind, company_id, year, month).
    -- Re-parent the loser's PDFs onto the survivor's colliding cell FIRST so
    -- they survive the delete, then coalesce, delete, repoint the rest.
    ----------------------------------------------------------------------------
    update beacon_v2.sub_invoice_files f
       set sub_invoice_id = s.id
      from beacon_v2.sub_invoices l
      join beacon_v2.sub_invoices s
        on s.project_id = l.project_id
       and s.kind       = l.kind
       and s.year       = l.year
       and s.month      = l.month
       and s.company_id = p_survivor
     where f.sub_invoice_id = l.id
       and l.company_id     = v_loser;

    update beacon_v2.sub_invoices s
       set amount = coalesce(s.amount, l.amount),
           paid   = s.paid or l.paid,
           notes  = coalesce(nullif(s.notes, ''), l.notes)
      from beacon_v2.sub_invoices l
     where s.company_id = p_survivor
       and l.company_id = v_loser
       and s.project_id = l.project_id
       and s.kind       = l.kind
       and s.year       = l.year
       and s.month      = l.month;

    delete from beacon_v2.sub_invoices l
     using beacon_v2.sub_invoices s
     where l.company_id = v_loser
       and s.company_id = p_survivor
       and s.project_id = l.project_id
       and s.kind       = l.kind
       and s.year       = l.year
       and s.month      = l.month;

    update beacon_v2.sub_invoices
       set company_id = p_survivor
     where company_id = v_loser;
    get diagnostics n = row_count; c_subinv := c_subinv + n;

    ----------------------------------------------------------------------------
    -- Straight repoints (no unique constraint on these columns).
    ----------------------------------------------------------------------------
    update beacon_v2.projects
       set prime_company_id = p_survivor
     where prime_company_id = v_loser;
    get diagnostics n = row_count; c_projects := c_projects + n;

    -- invoice_party_files (20260514120000) may not be applied on every DB.
    -- Guard with to_regclass + dynamic SQL so this function still CREATEs and
    -- runs where the table is absent (CREATE FUNCTION validates static table
    -- refs but not strings passed to EXECUTE). Once the table exists, the
    -- repoint runs normally.
    if to_regclass('beacon_v2.invoice_party_files') is not null then
      execute 'update beacon_v2.invoice_party_files set party_company_id = $1 where party_company_id = $2'
        using p_survivor, v_loser;
      get diagnostics n = row_count; c_party := c_party + n;
    end if;

    update beacon_v2.leads
       set prime_company_id = p_survivor
     where prime_company_id = v_loser;
    get diagnostics n = row_count; c_leads := c_leads + n;

    -- All references repointed → the restrict FKs are satisfied and this is safe.
    delete from beacon_v2.companies where id = v_loser;
    c_merged := c_merged + 1;
  end loop;

  return jsonb_build_object(
    'kind',                'company',
    'survivor',           p_survivor,
    'merged',             c_merged,
    'projects',           c_projects,
    'project_subs',       c_subs,
    'sub_invoices',       c_subinv,
    'invoice_party_files',c_party,
    'leads',              c_leads
  );
end;
$$;

--------------------------------------------------------------------------------
-- merge_clients — consolidate beacon_v2.clients rows. No referencing column is
-- part of a unique constraint, so every repoint is a straight UPDATE.
--------------------------------------------------------------------------------
create or replace function beacon_v2.merge_clients(p_survivor uuid, p_losers uuid[])
returns jsonb
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  v_loser   uuid;
  n         int;
  c_client  int := 0;
  c_prime   int := 0;
  c_leads   int := 0;
  c_bids    int := 0;
  c_merged  int := 0;
begin
  if p_survivor is null then
    raise exception 'merge_clients: survivor id is required';
  end if;
  if p_losers is null or array_length(p_losers, 1) is null then
    raise exception 'merge_clients: at least one loser id is required';
  end if;
  if p_survivor = any(p_losers) then
    raise exception 'merge_clients: survivor cannot also be a loser';
  end if;

  perform 1 from beacon_v2.clients where id = p_survivor;
  if not found then
    raise exception 'merge_clients: survivor % does not exist', p_survivor;
  end if;

  foreach v_loser in array p_losers loop
    perform 1 from beacon_v2.clients where id = v_loser;
    if not found then continue; end if;

    update beacon_v2.projects set client_id = p_survivor where client_id = v_loser;
    get diagnostics n = row_count; c_client := c_client + n;

    update beacon_v2.projects set prime_client_id = p_survivor where prime_client_id = v_loser;
    get diagnostics n = row_count; c_prime := c_prime + n;

    update beacon_v2.leads set client_id = p_survivor where client_id = v_loser;
    get diagnostics n = row_count; c_leads := c_leads + n;

    update beacon_v2.open_bids set client_id = p_survivor where client_id = v_loser;
    get diagnostics n = row_count; c_bids := c_bids + n;

    delete from beacon_v2.clients where id = v_loser;
    c_merged := c_merged + 1;
  end loop;

  return jsonb_build_object(
    'kind',      'client',
    'survivor',  p_survivor,
    'merged',    c_merged,
    'projects',  c_client,
    'prime',     c_prime,
    'leads',     c_leads,
    'open_bids', c_bids
  );
end;
$$;

-- Logged-in users only (the frontend uses the anon key but requires a session).
revoke all on function beacon_v2.merge_companies(uuid, uuid[]) from public, anon;
revoke all on function beacon_v2.merge_clients(uuid, uuid[])   from public, anon;
grant execute on function beacon_v2.merge_companies(uuid, uuid[]) to authenticated;
grant execute on function beacon_v2.merge_clients(uuid, uuid[])   to authenticated;

notify pgrst, 'reload schema';
