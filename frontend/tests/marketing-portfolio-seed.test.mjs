import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const url = new URL("../../supabase/migrations_v2/20261012140000_marketing_portfolio_seed.sql", import.meta.url);

const projects = [
  "HSDRRS", "Bayou Sauvage", "St. Bernard Parish", "Coastal Environmental Innovations",
  "CWPPRA", "St. Tammany", "St. Helena Parish", "CAD AI", "Fulcrum AI", "MSMM Beacon",
  "Image Tagger Mobile App", "Financial Dashboard", "Parish Intelligence",
];

test("portfolio seed preserves all fourteen supplied rows and is rerunnable", async () => {
  const sql = await readFile(url, "utf8");
  assert.match(sql, /create temporary table tmp_marketing_portfolio_seed/i);
  assert.match(sql, /source_record_key/i);
  assert.match(sql, /on conflict \(source_record_key\) do nothing/i);
  assert.match(sql, /notify pgrst, 'reload schema'/i);
  assert.equal((sql.match(/portfolio-[0-9]{2}/g) || []).filter((value, index, all) => all.indexOf(value) === index).length, 14);
  for (const project of projects) assert.ok(sql.includes(project), project);
  for (const person of ["Durand Elzey", "Vic Landry", "Mr. Pon", "Steve Price", "Mark Schexnayder", "Jeff Varisco", "Grant Black", "Dan Gerrity", "Christopher Bergeron", "Randy Pausina", "George Grimes", "Chris Gilmore", "Sean Burkes", "Jas Singh"]) {
    assert.ok(sql.includes(person), person);
  }
});

test("portfolio seed stores source sales language separately from exact Beacon stages", async () => {
  const sql = await readFile(url, "utf8");
  for (const column of ["assigned_to_summary", "task_order", "delivery_status", "project_progress", "source_sales_phase"]) {
    assert.match(sql, new RegExp(`alter table beacon_v2\\.marketing_opportunities[\\s\\S]*${column}`, "i"));
  }
  for (const stage of [
    "Intro to Target or prospect", "Initial meeting to showcase products and qualify prospect",
    "IQM - Initial Qualified Meeting", "BANT - Budget Authority Need Time",
    "Verbal Approval to Proceed", "Legal and Contract Negotiation",
  ]) assert.ok(sql.includes(stage), stage);
  assert.ok(sql.includes("NOT A SALES CONTRACT"));
  assert.ok(sql.includes("Verified BANT and Economic Buyer Approval"));
  assert.ok(sql.includes("Qualified Proposal / Solution Fit"));
});
