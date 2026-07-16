-- Make MSMM an independently stored sub-row for linked MHZ invoice pairs.
--
-- Linked ownership:
--   ENG -> MHZ       (ENG year-row owns the MSMM fields)
--   PM  -> MHZ PM    (PM year-row owns the MSMM fields)
--
-- Existing linked rows are snapshotted from their current displayed value
-- (base total - real subs). Future pair creation materializes the same snapshot.
-- Once populated, editing a real sub never changes an MSMM column; the frontend
-- recalculates only the MHZ/MHZ PM white first-row remainder.

set search_path = beacon_v2, public, extensions;

create or replace function beacon_v2.materialize_linked_msmm(p_base_id uuid)
returns void
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  v_base beacon_v2.anticipated_invoice%rowtype;
  v_hz_type text;
  v_contract_subs numeric := 0;
  v_jan_subs numeric := 0; v_feb_subs numeric := 0;
  v_mar_subs numeric := 0; v_apr_subs numeric := 0;
  v_may_subs numeric := 0; v_jun_subs numeric := 0;
  v_jul_subs numeric := 0; v_aug_subs numeric := 0;
  v_sep_subs numeric := 0; v_oct_subs numeric := 0;
  v_nov_subs numeric := 0; v_dec_subs numeric := 0;
begin
  select * into v_base
    from beacon_v2.anticipated_invoice
   where id = p_base_id
   for update;

  if not found or v_base.type::text not in ('ENG', 'PM') then
    return;
  end if;

  v_hz_type := case v_base.type::text when 'ENG' then 'MHZ' else 'MHZ PM' end;

  if not exists (
    select 1
      from beacon_v2.anticipated_invoice sibling
     where sibling.id <> v_base.id
       and sibling.type::text = v_hz_type
       and sibling.year = v_base.year
       and (
         (v_base.source_project_id is not null
          and sibling.source_project_id = v_base.source_project_id)
         or
         (nullif(lower(trim(v_base.project_number)), '') is not null
          and lower(trim(sibling.project_number)) = lower(trim(v_base.project_number)))
       )
  ) then
    return;
  end if;

  if v_base.source_project_id is not null then
    select coalesce(sum(coalesce(ps.amount, 0)), 0)
      into v_contract_subs
      from beacon_v2.project_subs ps
     where ps.project_id = v_base.source_project_id
       and coalesce(ps.kind, 'sub') = 'sub';

    select
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 1), 0),
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 2), 0),
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 3), 0),
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 4), 0),
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 5), 0),
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 6), 0),
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 7), 0),
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 8), 0),
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 9), 0),
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 10), 0),
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 11), 0),
      coalesce(sum(coalesce(si.amount, 0)) filter (where si.month = 12), 0)
      into v_jan_subs, v_feb_subs, v_mar_subs, v_apr_subs,
           v_may_subs, v_jun_subs, v_jul_subs, v_aug_subs,
           v_sep_subs, v_oct_subs, v_nov_subs, v_dec_subs
      from beacon_v2.sub_invoices si
     where si.project_id = v_base.source_project_id
       and si.year = v_base.year
       and coalesce(si.kind, 'sub') = 'sub';
  end if;

  update beacon_v2.anticipated_invoice as base
     set msmm_amount = coalesce(base.msmm_amount,
                                coalesce(base.contract_amount, 0) - v_contract_subs),
         msmm_jan_amount = coalesce(base.msmm_jan_amount, coalesce(base.jan_amount, 0) - v_jan_subs),
         msmm_feb_amount = coalesce(base.msmm_feb_amount, coalesce(base.feb_amount, 0) - v_feb_subs),
         msmm_mar_amount = coalesce(base.msmm_mar_amount, coalesce(base.mar_amount, 0) - v_mar_subs),
         msmm_apr_amount = coalesce(base.msmm_apr_amount, coalesce(base.apr_amount, 0) - v_apr_subs),
         msmm_may_amount = coalesce(base.msmm_may_amount, coalesce(base.may_amount, 0) - v_may_subs),
         msmm_jun_amount = coalesce(base.msmm_jun_amount, coalesce(base.jun_amount, 0) - v_jun_subs),
         msmm_jul_amount = coalesce(base.msmm_jul_amount, coalesce(base.jul_amount, 0) - v_jul_subs),
         msmm_aug_amount = coalesce(base.msmm_aug_amount, coalesce(base.aug_amount, 0) - v_aug_subs),
         msmm_sep_amount = coalesce(base.msmm_sep_amount, coalesce(base.sep_amount, 0) - v_sep_subs),
         msmm_oct_amount = coalesce(base.msmm_oct_amount, coalesce(base.oct_amount, 0) - v_oct_subs),
         msmm_nov_amount = coalesce(base.msmm_nov_amount, coalesce(base.nov_amount, 0) - v_nov_subs),
         msmm_dec_amount = coalesce(base.msmm_dec_amount, coalesce(base.dec_amount, 0) - v_dec_subs)
   where base.id = p_base_id;
end;
$$;

-- Snapshot every existing linked base year-row. The function itself confirms
-- the correct sibling type/year, so this remains safe and idempotent.
do $$
declare
  v_id uuid;
begin
  for v_id in
    select id
      from beacon_v2.anticipated_invoice
     where type::text in ('ENG', 'PM')
  loop
    perform beacon_v2.materialize_linked_msmm(v_id);
  end loop;
end;
$$;

create or replace function beacon_v2.tg_materialize_linked_msmm()
returns trigger
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  v_base_id uuid;
  v_base_type text;
begin
  if new.type::text in ('ENG', 'PM') then
    perform beacon_v2.materialize_linked_msmm(new.id);
    return new;
  end if;

  v_base_type := case new.type::text
    when 'MHZ' then 'ENG'
    when 'MHZ PM' then 'PM'
    else null
  end;
  if v_base_type is null then return new; end if;

  select base.id into v_base_id
    from beacon_v2.anticipated_invoice base
   where base.type::text = v_base_type
     and base.year = new.year
     and (
       (new.source_project_id is not null
        and base.source_project_id = new.source_project_id)
       or
       (nullif(lower(trim(new.project_number)), '') is not null
        and lower(trim(base.project_number)) = lower(trim(new.project_number)))
     )
   order by base.updated_at desc nulls last
   limit 1;

  if v_base_id is not null then
    perform beacon_v2.materialize_linked_msmm(v_base_id);
  end if;
  return new;
end;
$$;

drop trigger if exists tg_materialize_linked_msmm on beacon_v2.anticipated_invoice;
create trigger tg_materialize_linked_msmm
  after insert or update of source_project_id, project_number, type, year
  on beacon_v2.anticipated_invoice
  for each row execute function beacon_v2.tg_materialize_linked_msmm();

-- Authenticated non-admins may edit linked MSMM because it is an ordinary sub
-- row on the MHZ/MHZ PM view. Unlinked ENG/PM parent values remain admin-only.
create or replace function beacon_v2.guard_msmm_admin_only()
returns trigger
language plpgsql
security definer
set search_path = beacon_v2, public
as $$
declare
  jwt_role text := coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'role', '');
  v_changed boolean;
  v_hz_type text;
  v_linked boolean := false;
begin
  v_changed :=
       (new.msmm_amount is distinct from old.msmm_amount)
    or (new.msmm_remaining_to_bill_year_start is distinct from old.msmm_remaining_to_bill_year_start)
    or (new.msmm_jan_amount is distinct from old.msmm_jan_amount)
    or (new.msmm_feb_amount is distinct from old.msmm_feb_amount)
    or (new.msmm_mar_amount is distinct from old.msmm_mar_amount)
    or (new.msmm_apr_amount is distinct from old.msmm_apr_amount)
    or (new.msmm_may_amount is distinct from old.msmm_may_amount)
    or (new.msmm_jun_amount is distinct from old.msmm_jun_amount)
    or (new.msmm_jul_amount is distinct from old.msmm_jul_amount)
    or (new.msmm_aug_amount is distinct from old.msmm_aug_amount)
    or (new.msmm_sep_amount is distinct from old.msmm_sep_amount)
    or (new.msmm_oct_amount is distinct from old.msmm_oct_amount)
    or (new.msmm_nov_amount is distinct from old.msmm_nov_amount)
    or (new.msmm_dec_amount is distinct from old.msmm_dec_amount);

  if not v_changed then return new; end if;
  if jwt_role in ('', 'service_role') or beacon_v2.is_current_user_admin() then
    return new;
  end if;

  if old.type::text in ('ENG', 'PM') then
    v_hz_type := case old.type::text when 'ENG' then 'MHZ' else 'MHZ PM' end;
    select exists (
      select 1
        from beacon_v2.anticipated_invoice sibling
       where sibling.id <> old.id
         and sibling.type::text = v_hz_type
         and sibling.year = old.year
         and (
           (old.source_project_id is not null
            and sibling.source_project_id = old.source_project_id)
           or
           (nullif(lower(trim(old.project_number)), '') is not null
            and lower(trim(sibling.project_number)) = lower(trim(old.project_number)))
         )
    ) into v_linked;
  end if;

  if jwt_role = 'authenticated' and v_linked then
    return new;
  end if;

  raise exception 'Only an administrator can edit unlinked MSMM values'
    using errcode = '42501';
end;
$$;

notify pgrst, 'reload schema';
