import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const url = new URL("../../supabase/migrations_v2/20261012120000_marketing_pipeline.sql", import.meta.url);
const exactStages = [
  "Intro to Target or prospect",
  "Initial meeting to showcase products and qualify prospect",
  "IQM - Initial Qualified Meeting",
  "BANT - Budget Authority Need Time",
  "Verbal Approval to Proceed",
  "Legal and Contract Negotiation",
  "Contract Signed Won or Lost",
];

test("Marketing migration defines the normalized secured data surface", async () => {
  const sql = await readFile(url, "utf8");
  for (const stage of exactStages) assert.ok(sql.includes(`'${stage}'`), stage);
  for (const table of [
    "marketing_opportunities", "marketing_opportunity_contacts", "marketing_activities",
    "marketing_activity_users", "marketing_activity_contacts", "marketing_tasks",
    "marketing_documents", "marketing_stage_history",
  ]) assert.match(sql, new RegExp(`create table if not exists beacon_v2\\.${table}`));
  assert.match(sql, /transition_marketing_opportunity/);
  assert.match(sql, /old\.version/);
  assert.match(sql, /marketing-documents/);
  assert.match(sql, /add value if not exists 'marketing'/);
  assert.match(sql, /notify pgrst, 'reload schema'/);
});

test("Marketing migration enforces concurrency, terminal outcomes, RLS and private storage", async () => {
  const sql = await readFile(url, "utf8");
  assert.match(sql, /errcode\s*=\s*'40001'/i);
  assert.match(sql, /probability\s*=\s*100/i);
  assert.match(sql, /probability\s*=\s*0/i);
  assert.match(sql, /alter table beacon_v2\.marketing_opportunities enable row level security/i);
  assert.match(sql, /to authenticated using \(true\) with check \(true\)/i);
  assert.match(sql, /values \('marketing-documents', 'marketing-documents', false\)/i);
});

test("stage history is client-read-only and trigger-authored", async () => {
  const sql = await readFile(url, "utf8");
  assert.match(sql, /fn_marketing_history\(\)[\s\S]*?security definer[\s\S]*?set search_path = beacon_v2, pg_temp/i);
  assert.match(sql, /revoke all on function beacon_v2\.fn_marketing_history\(\) from public, anon, authenticated/i);
  assert.match(sql, /create policy marketing_history_auth_select[\s\S]*?for select to authenticated using \(true\)/i);
  assert.match(sql, /grant select on beacon_v2\.marketing_stage_history to authenticated/i);
  assert.doesNotMatch(sql, /grant select, insert, update, delete on beacon_v2\.marketing_stage_history to authenticated/i);
});
