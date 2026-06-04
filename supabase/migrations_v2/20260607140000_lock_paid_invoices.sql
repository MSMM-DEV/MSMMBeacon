-- MSMM Beacon v2 — lock paid invoices: only an Admin can UN-mark a paid cell.
--
-- Product rule: once an invoice cell is ticked paid it's locked. Marking paid
-- stays open to everyone; UN-ticking (paid true → false) is Admin-only. The
-- frontend already enforces this (lock visual + confirm dialog; non-admins get
-- a "locked" toast), but a UI gate alone is bypassable via direct PostgREST.
-- This adds the DB-level guard so the lock is real — exactly the pattern the
-- Open Bids approval gate uses (20260527120000_open_bids.sql).
--
-- Two BEFORE UPDATE triggers raise 42501 (insufficient_privilege) when a NON-
-- admin flips any paid flag from true to false:
--   * anticipated_invoice — the 12 prime/total month flags (jan_paid..dec_paid)
--   * sub_invoices        — the single `paid` flag
-- Only the true→false transition is guarded; marking paid (false→true) and all
-- other column edits stay open to authenticated users, matching the rest of the
-- prototype's permissive posture.
--
-- is_current_user_admin() (from 20260428121000_grants_rls.sql) returns false for
-- service_role (no auth.uid()). No Edge Function writes these flags, and the
-- merge RPCs only ever OR `paid` upward (never true→false), so nothing legit is
-- blocked. Idempotent (create or replace + drop/create trigger); safe to re-paste.

set search_path = beacon_v2, public, extensions;

--------------------------------------------------------------------------------
-- anticipated_invoice — prime/total per-month paid flags.
--------------------------------------------------------------------------------
create or replace function beacon_v2.tg_guard_invoice_paid_unset()
returns trigger language plpgsql as $$
begin
  if (old.jan_paid and not new.jan_paid)
  or (old.feb_paid and not new.feb_paid)
  or (old.mar_paid and not new.mar_paid)
  or (old.apr_paid and not new.apr_paid)
  or (old.may_paid and not new.may_paid)
  or (old.jun_paid and not new.jun_paid)
  or (old.jul_paid and not new.jul_paid)
  or (old.aug_paid and not new.aug_paid)
  or (old.sep_paid and not new.sep_paid)
  or (old.oct_paid and not new.oct_paid)
  or (old.nov_paid and not new.nov_paid)
  or (old.dec_paid and not new.dec_paid)
  then
    if not beacon_v2.is_current_user_admin() then
      raise exception 'A paid invoice can only be unmarked by an Admin'
        using errcode = '42501';  -- insufficient_privilege
    end if;
  end if;
  return new;
end $$;

drop trigger if exists invoice_guard_paid_unset on beacon_v2.anticipated_invoice;
create trigger invoice_guard_paid_unset
before update on beacon_v2.anticipated_invoice
for each row execute function beacon_v2.tg_guard_invoice_paid_unset();

--------------------------------------------------------------------------------
-- sub_invoices — per-(project, sub, month) paid flag.
--------------------------------------------------------------------------------
create or replace function beacon_v2.tg_guard_sub_invoice_paid_unset()
returns trigger language plpgsql as $$
begin
  if old.paid and not new.paid then
    if not beacon_v2.is_current_user_admin() then
      raise exception 'A paid invoice can only be unmarked by an Admin'
        using errcode = '42501';  -- insufficient_privilege
    end if;
  end if;
  return new;
end $$;

drop trigger if exists sub_invoices_guard_paid_unset on beacon_v2.sub_invoices;
create trigger sub_invoices_guard_paid_unset
before update on beacon_v2.sub_invoices
for each row execute function beacon_v2.tg_guard_sub_invoice_paid_unset();
