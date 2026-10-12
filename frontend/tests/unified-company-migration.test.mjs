import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const prep = readFileSync(new URL("../../supabase/migrations_v2/20261012125000_company_unification_prep.sql", import.meta.url), "utf8");
const sql = readFileSync(new URL("../../supabase/migrations_v2/20261012130000_unified_companies.sql", import.meta.url), "utf8");
const preflight = readFileSync(new URL("../../scripts/preflight_unified_companies.sql", import.meta.url), "utf8");

test("cutover retargets every client-role table to companies", () => {
  for (const table of ["projects", "leads", "open_bids", "project_items"]) {
    assert.match(sql, new RegExp(`alter table beacon_v2\\.${table}[\\s\\S]+references beacon_v2\\.companies\\(id\\)`, "i"));
  }
  assert.match(sql, /alter table beacon_v2\.contacts[\s\S]+drop column[\s\S]+client_id/i);
  assert.match(sql, /drop column[\s\S]+prime_client_id/i);
});

test("preflight calls out district collisions and conflicting primes", () => {
  assert.match(preflight, /district/i);
  assert.match(preflight, /prime_client_id/i);
  assert.match(preflight, /prime_company_id/i);
  assert.match(preflight, /profile_conflict/i);
  assert.match(preflight, /candidate_count/i);
});

test("a preparatory migration creates the operator override table before preflight", () => {
  assert.match(prep, /create table beacon_v2\.company_unification_overrides/i);
  assert.match(prep, /client_id uuid primary key references beacon_v2\.clients/i);
});

test("post-cutover company merges repoint client roles and company-owned contacts", () => {
  assert.match(sql, /create or replace function beacon_v2\.merge_companies/i);
  for (const relation of [
    "projects set client_id", "leads set client_id", "open_bids set client_id",
    "project_items set client_id", "contacts set company_id", "project_item_subs",
  ]) {
    assert.match(sql, new RegExp(relation.replaceAll(" ", "\\s+"), "i"), relation);
  }
  assert.match(sql, /marketing_opportunities set client_id/i);
  assert.match(sql, /v_company_projects[\s\S]+'client'::text/i);
});

test("cutover blocks unresolved profile differences instead of picking silently", () => {
  assert.match(sql, /conflicting non-empty profile values/i);
  assert.match(sql, /group by m\.company_id, d\.field_name[\s\S]+count\(distinct d\.client_value\) > 1/i);
});
