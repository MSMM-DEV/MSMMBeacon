import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(new URL("../../supabase/migrations_v2/20261012130100_business_card_import.sql", import.meta.url), "utf8");

test("import RPC is authenticated, explicit and version checked", () => {
  assert.match(sql, /create or replace function beacon_v2\.apply_business_card_import\([\s\S]+p_payload jsonb[\s\S]+p_idempotency_key uuid/i);
  assert.match(sql, /expected_updated_at/i);
  assert.match(sql, /stale/i);
  assert.match(sql, /auth\.uid\(\)/i);
  assert.match(sql, /revoke all on function[\s\S]+public, anon/i);
  assert.match(sql, /grant execute[\s\S]+authenticated/i);
  assert.doesNotMatch(sql, /execute\s+format\(/i);
});

test("import RPC persists and replays an idempotent result", () => {
  assert.match(sql, /create table if not exists beacon_v2\.business_card_import_runs/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /payload_hash/i);
  assert.match(sql, /return v_result/i);
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
  assert.match(sql, /only one selected primary contact per company/i);
});

test("migration includes stale and atomic rollback verification examples", () => {
  assert.match(sql, /Studio verification[\s\S]+stale/i);
  assert.match(sql, /invalid second contact/i);
  assert.match(sql, /rollback/i);
});
