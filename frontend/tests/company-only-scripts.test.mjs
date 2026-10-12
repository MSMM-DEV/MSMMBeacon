import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const seed = readFileSync(new URL("../../scripts/ingest_seed_data.py", import.meta.url), "utf8");
const projects = readFileSync(new URL("../../scripts/import_projects_xlsx.py", import.meta.url), "utf8");

test("seed ingestion targets beacon_v2 and one companies master", () => {
  assert.match(seed, /Accept-Profile": "beacon_v2"/);
  assert.match(seed, /Upserting \{len\(companies_payload_by_name\)\} companies/);
  assert.match(seed, /client_company_id/);
  assert.doesNotMatch(seed, /\/clients\b/);
  assert.doesNotMatch(seed, /delete_all\("clients"/);
  assert.doesNotMatch(seed, /DELETE companies|REST}\/companies/);
  assert.match(seed, /delete_matching_rows\("projects"/);
  assert.match(seed, /delete_matching_rows\("anticipated_invoice"/);
  assert.doesNotMatch(seed, /delete_all\(/);
  assert.match(seed, /payload_groups/);
  assert.match(seed, /missing=default/);
  assert.doesNotMatch(seed, /insert_rows\("(?:potential_projects|awaiting_verdict|awarded_projects)"/);
});

test("project spreadsheet importer resolves ClientID through companies", () => {
  assert.match(projects, /rest\/v1\/companies/);
  assert.match(projects, /company_m = Matcher/);
  assert.doesNotMatch(projects, /rest\/v1\/clients/);
  assert.doesNotMatch(projects, /client_m = Matcher/);
});

test("project importer does not duplicate a district suffix in lookup keys", () => {
  const code = [
    "import importlib.util",
    "spec=importlib.util.spec_from_file_location('project_import', 'scripts/import_projects_xlsx.py')",
    "m=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(m)",
    "print(m.company_match_keys('USACE — MVN-New Orleans District', 'MVN-New Orleans District'))",
  ].join(";");
  const result = spawnSync("python3", ["-c", code], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_KEY: "test" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /'code': 'USACE MVN'/);
  assert.doesNotMatch(result.stdout, /District MVN/);
});
