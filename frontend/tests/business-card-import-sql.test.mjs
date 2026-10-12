import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../supabase/migrations_v2/20261012120100_business_card_import.sql", import.meta.url), "utf8");

test("import RPC is authenticated, explicit and version checked", () => {
  assert.match(sql, /create or replace function beacon_v2\.apply_business_card_import\(p_payload jsonb\)/i);
  assert.match(sql, /expected_updated_at/i);
  assert.match(sql, /stale/i);
  assert.match(sql, /auth\.uid\(\)/i);
  assert.match(sql, /revoke all on function[\s\S]+public, anon/i);
  assert.match(sql, /grant execute[\s\S]+authenticated/i);
  assert.doesNotMatch(sql, /execute\s+format\(/i);
});

test("RPC allowlists company and contact patch keys and maps temporary companies", () => {
  for (const key of ["name", "district", "org_type", "website", "address", "notes"]) {
    assert.match(sql, new RegExp(`company[\\s\\S]+${key}`, "i"));
  }
  for (const key of ["name", "title", "email", "phone", "notes", "is_primary", "ord"]) {
    assert.match(sql, new RegExp(`contact[\\s\\S]+${key}`, "i"));
  }
  assert.match(sql, /company_temp_id/i);
  assert.match(sql, /set_primary_contact/i);
});

test("migration includes stale and atomic rollback verification examples", () => {
  assert.match(sql, /Studio verification[\s\S]+stale/i);
  assert.match(sql, /invalid second contact/i);
  assert.match(sql, /rollback/i);
});
