import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../../supabase/migrations_v2/20260716130000_mhz_msmm_independent.sql", import.meta.url),
  "utf8"
);

assert.match(sql, /create or replace function beacon_v2\.materialize_linked_msmm/i);
assert.match(sql, /msmm_amount\s*=\s*coalesce\(base\.msmm_amount/i);
assert.match(sql, /msmm_jan_amount/i);
assert.match(sql, /msmm_jul_amount/i);
assert.match(sql, /msmm_dec_amount/i);
assert.match(sql, /'ENG'.*'MHZ'/is);
assert.match(sql, /'PM'.*'MHZ PM'/is);
assert.match(sql, /after insert or update of source_project_id, project_number, type, year/i);
assert.match(sql, /authenticated non-admins may edit linked MSMM/i);
assert.match(sql, /raise exception 'Only an administrator can edit unlinked MSMM values/i);

console.log("MHZ independent MSMM migration contract passed");
