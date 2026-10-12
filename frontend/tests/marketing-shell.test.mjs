import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../src/App.jsx", import.meta.url);
const marketingPath = new URL("../src/marketing.jsx", import.meta.url);

test("App registers and lazy-loads the dedicated Marketing page", async () => {
  const source = await readFile(appPath, "utf8");
  assert.match(source, /key:\s*"marketing"[\s\S]*label:\s*"Marketing"/);
  assert.match(source, /key:\s*"marketing"[\s\S]*group:\s*"marketing"[\s\S]*tabs:\s*\["marketing"\]/);
  assert.match(source, /group:\s*"marketing"[\s\S]*label:\s*"Marketing & Sales"/);
  assert.match(source, /lazyWithRetry\(\(\)\s*=>\s*import\("\.\/marketing\.jsx"\)\)/);
  assert.match(source, /marketing:\s*\{\s*title:\s*"Marketing"/);
  assert.match(source, /tab\s*===\s*"marketing"[\s\S]*<MarketingPage/);
});

test("Marketing shell filters underline views through access and supports deep links", async () => {
  const source = await readFile(marketingPath, "utf8");
  assert.match(source, /access\.visibleChildren\("page\.marketing"\)/);
  assert.match(source, /variant="underline"/);
  assert.match(source, /loadMarketingWorkspace/);
  assert.match(source, /opportunity/);
  assert.match(source, /URLSearchParams/);
  assert.match(source, /Loading Marketing/);
  assert.match(source, /Retry/);
});
