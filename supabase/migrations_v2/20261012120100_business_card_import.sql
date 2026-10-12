-- MSMM Beacon v2 — atomic, reviewed business-card import.
--
-- The browser sends explicit company/contact create or update operations only
-- after field-level review. Images and extracted source text are never passed
-- to this function. PostgreSQL functions already run inside the caller's
-- transaction, so any validation error rolls the entire batch back.

set search_path = beacon_v2, public, extensions;

create or replace function beacon_v2.apply_business_card_import(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = beacon_v2, public, extensions
as $function$
declare
  v_company_op jsonb;
  v_contact_op jsonb;
  v_patch jsonb;
  v_action text;
  v_temp_id text;
  v_company_temp_id text;
  v_company_id uuid;
  v_contact_id uuid;
  v_current_company_id uuid;
  v_expected_updated_at timestamptz;
  v_make_primary boolean;
  v_allow_reassign boolean;
  v_rows integer;
  v_companies_created integer := 0;
  v_companies_updated integer := 0;
  v_contacts_created integer := 0;
  v_contacts_updated integer := 0;
  v_skipped integer := 0;
  v_created_company_ids jsonb := '{}'::jsonb;
  v_created_contact_ids jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'business-card import requires authentication' using errcode = '42501';
  end if;
  if not exists (
    select 1 from beacon_v2.users u
     where u.auth_user_id = auth.uid() and u.is_enabled
  ) then
    raise exception 'business-card import requires an enabled Beacon user' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'business-card import payload must be an object';
  end if;
  if (p_payload - array['companies', 'contacts', 'skipped']::text[]) <> '{}'::jsonb then
    raise exception 'business-card import payload contains unsupported top-level keys';
  end if;
  if jsonb_typeof(coalesce(p_payload->'companies', '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_payload->'contacts', '[]'::jsonb)) <> 'array' then
    raise exception 'companies and contacts must be arrays';
  end if;
  if jsonb_array_length(coalesce(p_payload->'companies', '[]'::jsonb)) > 100
     or jsonb_array_length(coalesce(p_payload->'contacts', '[]'::jsonb)) > 200 then
    raise exception 'business-card import batch is too large';
  end if;

  v_skipped := greatest(0, coalesce(nullif(p_payload->>'skipped', '')::integer, 0));

  create temporary table if not exists business_card_company_map (
    company_temp_id text primary key,
    company_id uuid not null
  ) on commit delete rows;
  truncate table business_card_company_map;

  -- Companies must run first so contacts may refer to a reviewed tempId.
  for v_company_op in
    select value from jsonb_array_elements(coalesce(p_payload->'companies', '[]'::jsonb))
  loop
    if jsonb_typeof(v_company_op) <> 'object'
       or (v_company_op - array['action', 'tempId', 'companyId', 'expectedUpdatedAt', 'patch']::text[]) <> '{}'::jsonb then
      raise exception 'invalid company operation';
    end if;
    v_action := v_company_op->>'action';
    v_patch := coalesce(v_company_op->'patch', '{}'::jsonb);
    if jsonb_typeof(v_patch) <> 'object' then raise exception 'company patch must be an object'; end if;
    -- Company patch allowlist: name, district, org_type, website, address, notes.
    if (v_patch - array['name', 'district', 'org_type', 'website', 'address', 'notes']::text[]) <> '{}'::jsonb then
      raise exception 'company patch contains unsupported fields';
    end if;

    if v_action = 'create' then
      v_temp_id := nullif(btrim(v_company_op->>'tempId'), '');
      if v_temp_id is null then raise exception 'company create requires tempId'; end if;
      if nullif(btrim(v_patch->>'name'), '') is null then raise exception 'company create requires name'; end if;
      insert into beacon_v2.companies (name, district, org_type, website, address, notes)
      values (
        btrim(v_patch->>'name'),
        nullif(btrim(v_patch->>'district'), ''),
        nullif(btrim(v_patch->>'org_type'), '')::beacon_v2.org_type_enum,
        nullif(btrim(v_patch->>'website'), ''),
        nullif(btrim(v_patch->>'address'), ''),
        nullif(btrim(v_patch->>'notes'), '')
      )
      returning id into v_company_id;
      insert into business_card_company_map (company_temp_id, company_id)
      values (v_temp_id, v_company_id);
      v_created_company_ids := v_created_company_ids || jsonb_build_object(v_temp_id, v_company_id);
      v_companies_created := v_companies_created + 1;

    elsif v_action = 'update' then
      v_company_id := nullif(v_company_op->>'companyId', '')::uuid;
      if v_company_id is null then raise exception 'company update requires companyId'; end if;
      if nullif(v_company_op->>'expectedUpdatedAt', '') is null then
        raise exception 'company update requires expected_updated_at';
      end if;
      v_expected_updated_at := (v_company_op->>'expectedUpdatedAt')::timestamptz;
      if v_patch ? 'name' and nullif(btrim(v_patch->>'name'), '') is null then
        raise exception 'company name cannot be blank';
      end if;
      update beacon_v2.companies
         set name = case when v_patch ? 'name' then btrim(v_patch->>'name') else name end,
             district = case when v_patch ? 'district' then nullif(btrim(v_patch->>'district'), '') else district end,
             org_type = case when v_patch ? 'org_type' then nullif(btrim(v_patch->>'org_type'), '')::beacon_v2.org_type_enum else org_type end,
             website = case when v_patch ? 'website' then nullif(btrim(v_patch->>'website'), '') else website end,
             address = case when v_patch ? 'address' then nullif(btrim(v_patch->>'address'), '') else address end,
             notes = case when v_patch ? 'notes' then nullif(btrim(v_patch->>'notes'), '') else notes end
       where id = v_company_id and updated_at = v_expected_updated_at;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then
        raise exception 'stale company %: it changed after review', v_company_id using errcode = 'P0001';
      end if;
      v_companies_updated := v_companies_updated + 1;
    else
      raise exception 'company action must be create or update';
    end if;
  end loop;

  for v_contact_op in
    select value from jsonb_array_elements(coalesce(p_payload->'contacts', '[]'::jsonb))
  loop
    if jsonb_typeof(v_contact_op) <> 'object'
       or (v_contact_op - array['action', 'contactId', 'companyId', 'companyTempId', 'expectedUpdatedAt', 'allowReassign', 'patch']::text[]) <> '{}'::jsonb then
      raise exception 'invalid contact operation';
    end if;
    v_action := v_contact_op->>'action';
    v_patch := coalesce(v_contact_op->'patch', '{}'::jsonb);
    if jsonb_typeof(v_patch) <> 'object' then raise exception 'contact patch must be an object'; end if;
    -- Contact patch allowlist: name, title, email, phone, notes, is_primary, ord.
    if (v_patch - array['name', 'title', 'email', 'phone', 'notes', 'is_primary', 'ord']::text[]) <> '{}'::jsonb then
      raise exception 'contact patch contains unsupported fields';
    end if;

    v_company_id := null;
    v_company_temp_id := nullif(btrim(v_contact_op->>'companyTempId'), '');
    if nullif(v_contact_op->>'companyId', '') is not null then
      v_company_id := (v_contact_op->>'companyId')::uuid;
    elsif v_company_temp_id is not null then
      select m.company_id into v_company_id
        from business_card_company_map m
       where m.company_temp_id = v_company_temp_id;
    end if;
    if v_company_id is null or not exists (select 1 from beacon_v2.companies where id = v_company_id) then
      raise exception 'contact operation references an unknown company';
    end if;
    if v_patch ? 'name' and nullif(btrim(v_patch->>'name'), '') is null then
      raise exception 'contact name cannot be blank';
    end if;
    v_make_primary := coalesce((v_patch->>'is_primary')::boolean, false);

    if v_action = 'create' then
      if nullif(btrim(v_patch->>'name'), '') is null then raise exception 'contact create requires name'; end if;
      insert into beacon_v2.contacts (company_id, name, title, email, phone, notes, is_primary, ord)
      values (
        v_company_id,
        btrim(v_patch->>'name'),
        nullif(btrim(v_patch->>'title'), ''),
        nullif(btrim(v_patch->>'email'), ''),
        nullif(btrim(v_patch->>'phone'), ''),
        nullif(btrim(v_patch->>'notes'), ''),
        false,
        coalesce(nullif(v_patch->>'ord', '')::integer, 0)
      )
      returning id into v_contact_id;
      if v_make_primary then perform beacon_v2.set_primary_contact(v_contact_id); end if;
      v_created_contact_ids := v_created_contact_ids || jsonb_build_array(v_contact_id);
      v_contacts_created := v_contacts_created + 1;

    elsif v_action = 'update' then
      v_contact_id := nullif(v_contact_op->>'contactId', '')::uuid;
      if v_contact_id is null then raise exception 'contact update requires contactId'; end if;
      if nullif(v_contact_op->>'expectedUpdatedAt', '') is null then
        raise exception 'contact update requires expected_updated_at';
      end if;
      v_expected_updated_at := (v_contact_op->>'expectedUpdatedAt')::timestamptz;
      select company_id into v_current_company_id from beacon_v2.contacts where id = v_contact_id;
      if not found then raise exception 'contact % does not exist', v_contact_id; end if;
      v_allow_reassign := coalesce((v_contact_op->>'allowReassign')::boolean, false);
      if v_current_company_id <> v_company_id and not v_allow_reassign then
        raise exception 'cross-company contact reassignment requires explicit allowReassign';
      end if;

      update beacon_v2.contacts
         set company_id = case when v_allow_reassign then v_company_id else company_id end,
             name = case when v_patch ? 'name' then btrim(v_patch->>'name') else name end,
             title = case when v_patch ? 'title' then nullif(btrim(v_patch->>'title'), '') else title end,
             email = case when v_patch ? 'email' then nullif(btrim(v_patch->>'email'), '') else email end,
             phone = case when v_patch ? 'phone' then nullif(btrim(v_patch->>'phone'), '') else phone end,
             notes = case when v_patch ? 'notes' then nullif(btrim(v_patch->>'notes'), '') else notes end,
             is_primary = case
               when v_patch ? 'is_primary' and not coalesce((v_patch->>'is_primary')::boolean, false) then false
               else is_primary
             end,
             ord = case when v_patch ? 'ord' then (v_patch->>'ord')::integer else ord end
       where id = v_contact_id and updated_at = v_expected_updated_at;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then
        raise exception 'stale contact %: it changed after review', v_contact_id using errcode = 'P0001';
      end if;
      if v_make_primary then perform beacon_v2.set_primary_contact(v_contact_id); end if;
      v_contacts_updated := v_contacts_updated + 1;
    else
      raise exception 'contact action must be create or update';
    end if;
  end loop;

  return jsonb_build_object(
    'companies_created', v_companies_created,
    'companies_updated', v_companies_updated,
    'contacts_created', v_contacts_created,
    'contacts_updated', v_contacts_updated,
    'skipped', v_skipped,
    'company_ids', v_created_company_ids,
    'contact_ids', v_created_contact_ids
  );
end;
$function$;

revoke all on function beacon_v2.apply_business_card_import(jsonb) from public, anon;
grant execute on function beacon_v2.apply_business_card_import(jsonb) to authenticated;

notify pgrst, 'reload schema';

-- Studio verification — stale updates roll back (replace UUIDs inside a test
-- transaction only). The expectedUpdatedAt value is intentionally stale.
-- begin;
-- select beacon_v2.apply_business_card_import(jsonb_build_object(
--   'companies', jsonb_build_array(jsonb_build_object(
--     'action','update', 'companyId','00000000-0000-0000-0000-000000000000',
--     'expectedUpdatedAt','2000-01-01T00:00:00Z', 'patch',jsonb_build_object('notes','must not land'))),
--   'contacts','[]'::jsonb, 'skipped',0));
-- -- Expected: "stale company" exception.
-- rollback;

-- Studio verification — an invalid second contact proves the first company
-- is not committed. Run with a signed-in authenticated SQL context and confirm
-- the temporary company name is absent after the exception, then rollback.
-- begin;
-- select beacon_v2.apply_business_card_import('{
--   "companies":[{"action":"create","tempId":"new:1","patch":{"name":"ROLLBACK PROBE"}}],
--   "contacts":[
--     {"action":"create","companyTempId":"new:1","patch":{"name":"Valid first"}},
--     {"action":"create","companyTempId":"new:1","patch":{"name":""}}
--   ],"skipped":0}'::jsonb);
-- -- Expected: contact create requires name; SELECT from companies returns 0.
-- rollback;
