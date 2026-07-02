-- Invoice-owned Orange / Normal flag.
--
-- NULL means the frontend may still fall back to the legacy linked-project
-- Orange inference. true/false means the user explicitly moved the invoice
-- row to Orange or Normal/White from the Invoice table.

alter table beacon_v2.anticipated_invoice
  add column if not exists invoice_orange boolean;

notify pgrst, 'reload schema';
