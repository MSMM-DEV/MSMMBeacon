import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = relative => readFile(new URL(relative, import.meta.url), "utf8");

test("Marketing documents use private storage with metadata cleanup and signed reads", async () => {
  const data = await read("../src/data.js");
  const panel = await read("../src/marketing-components/MarketingDocumentPanel.jsx");
  assert.match(data, /storage\.from\("marketing-documents"\)\.upload/);
  assert.match(data, /from\("marketing_documents"\)\.insert/);
  assert.ok(data.indexOf('storage.from("marketing-documents").upload') < data.indexOf('from("marketing_documents").insert'));
  assert.match(data, /getMarketingDocumentSignedUrl/);
  assert.match(data, /removeMarketingDocument/);
  assert.match(data, /createSignedUrl\(filePath,\s*60\)/);
  assert.match(panel, /25 \* 1024 \* 1024/);
  assert.match(panel, /PDF|DOCX/);
  assert.match(panel, /Retry cleanup/);
});

test("scheduled alert writer deactivates partial failures and keeps one-shot compatibility", async () => {
  const data = await read("../src/data.js");
  assert.match(data, /export async function createScheduledAlert/);
  assert.match(data, /recipient/i);
  assert.match(data, /pending fire/i);
  assert.match(data, /is_active:\s*false/);
  assert.match(data, /createOneShotAlert[\s\S]*createScheduledAlert/);
});

test("Marketing reminder UI limits recurrence to supported modes and retains Retry", async () => {
  const panel = await read("../src/marketing-components/MarketingTaskPanel.jsx");
  for (const mode of ["one_time", "weekly", "biweekly", "monthly"]) assert.match(panel, new RegExp(`value="${mode}"`));
  assert.doesNotMatch(panel, /value="custom"/);
  assert.match(panel, /Task saved; reminder was not scheduled/);
  assert.match(panel, /Retry reminder/);
  assert.match(panel, /setAlertActive\(alertId, false\)/);
  const data = await read("../src/data.js");
  assert.match(data, /updateMarketingTask[\s\S]*setAlertActive\(linkedAlertId, patch\.status !== "completed"\)/);
});

test("send-alert renders Marketing details and opportunity deep links", async () => {
  const source = await read("../../supabase/functions/send-alert/index.ts");
  assert.match(source, /marketing:\s*"marketing_opportunities"/);
  assert.match(source, /Beacon · Marketing action/);
  assert.match(source, /row\.stage/);
  assert.match(source, /row\.probability/);
  assert.match(source, /row\.expected_close_date/);
  assert.match(source, /row\.next_action/);
  assert.match(source, /opportunity=\$\{encodeURIComponent\(alert\.subject_row_id\)\}/);
});
