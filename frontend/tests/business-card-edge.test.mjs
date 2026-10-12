import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../supabase/functions/extract-business-cards/index.ts", import.meta.url), "utf8");
const config = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");

test("business-card extractor authenticates, bounds input and requests strict structured output", () => {
  assert.match(source, /auth\.getUser\(\)/);
  assert.match(source, /from\(["']users["']\)/);
  assert.match(source, /\.eq\(["']is_enabled["'], true\)/);
  assert.match(source, /MAX_IMAGES\s*=\s*20/);
  assert.match(source, /MAX_FILE_BYTES\s*=\s*10\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source, /MAX_TOTAL_BYTES\s*=\s*25\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source, /json_schema/);
  assert.match(source, /strict:\s*true/);
  assert.match(config, /\[functions\.extract-business-cards\]\s+verify_jwt\s*=\s*false/);
});

test("extractor treats card text as untrusted and performs no persistence", () => {
  assert.match(source, /untrusted data/i);
  assert.match(source, /ignore.{0,80}instructions.{0,80}card/is);
  assert.doesNotMatch(source, /storage\.from|\.insert\(/);
  assert.doesNotMatch(source, /console\.(log|debug)\([^)]*dataB64/);
});

test("extractor schema supports several cards from one source image", () => {
  for (const field of ["sourceId", "cardIndex", "personName", "companyName", "extraDetails", "warnings"]) {
    assert.match(source, new RegExp(field));
  }
  assert.match(source, /all cards/i);
});
