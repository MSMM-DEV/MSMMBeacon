import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  browseEgnyteFolders,
  DEFAULT_SALES_EGNYTE_PATH as API_DEFAULT_SALES_PATH,
  egnyteWebUrl as serverWebUrl,
  entriesFromEgnyteListing,
  foldersFromEgnyteListing,
  isWithinEgnyteRoot as serverWithinRoot,
  normalizeEgnytePath,
  validateSharedEgnytePath,
} from "../api/_lib/egnyte.mjs";
import {
  DEFAULT_SALES_EGNYTE_PATH,
  EGNYTE_SHARED_ROOT,
  egnyteBaseName,
  egnyteBreadcrumbs,
  egnyteFolderOpenTarget,
  egnyteParentPath,
  egnyteShortPath,
  egnyteWebUrl,
  formatEgnyteSize,
  isWithinEgnyteRoot,
} from "../src/egnyte-links.js";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

// A listing in the exact shape Egnyte's /pubapi/v1/fs returns (trimmed from a
// real read-only response for /Shared/PData/BD/BD-AI).
const LISTING = {
  name: "BD-AI",
  path: "/Shared/PData/BD/BD-AI",
  is_folder: true,
  total_count: 3,
  folders: [
    { name: "Presentations", path: "/Shared/PData/BD/BD-AI/Presentations", lastModified: 1774462716000, is_folder: true },
    { name: "All Proposals", path: "/Shared/PData/BD/BD-AI/All Proposals", lastModified: 1790622526000, is_folder: true },
  ],
  files: [
    {
      name: "SoftwareSubscriptionCosts.xlsx",
      path: "/Shared/PData/BD/BD-AI/SoftwareSubscriptionCosts.xlsx",
      size: 14451,
      last_modified: "Mon, 13 Apr 2026 13:24:03 GMT",
      is_folder: false,
      checksum: "should-not-leak",
      uploaded_by: "someone",
    },
  ],
};

const ENV = { EGNYTE_DOMAIN: "acme.egnyte.com", EGNYTE_ACCESS_TOKEN: "test-token" };
const okFetch = (payload, seen = []) => async (url, options) => {
  seen.push({ url, options });
  return { ok: true, status: 200, json: async () => payload };
};

test("the Sales default location is the BD-AI cloud path, shared by API and client", () => {
  assert.equal(DEFAULT_SALES_EGNYTE_PATH, "/Shared/PData/BD/BD-AI");
  assert.equal(API_DEFAULT_SALES_PATH, DEFAULT_SALES_EGNYTE_PATH);
  assert.equal(EGNYTE_SHARED_ROOT, "/Shared");
});

test("the default cloud path maps to Egnyte-msmm/Shared/PData/BD/BD-AI on a synced Mac", () => {
  const target = egnyteFolderOpenTarget({ path: DEFAULT_SALES_EGNYTE_PATH, platform: "MacIntel", userAgent: "Macintosh" });
  assert.match(target.localPath, /\/Egnyte-msmm\/Shared\/PData\/BD\/BD-AI$/);
});

test("client path helpers navigate within /Shared only", () => {
  assert.equal(egnyteParentPath("/Shared/PData/BD/BD-AI"), "/Shared/PData/BD");
  assert.equal(egnyteParentPath("/Shared"), null);
  assert.equal(egnyteParentPath("/Private/x"), null);
  assert.equal(isWithinEgnyteRoot("/Shared/PData"), true);
  assert.equal(isWithinEgnyteRoot("/SharedStuff"), false);
  assert.equal(isWithinEgnyteRoot("/Private/rmehta"), false);
  assert.equal(egnyteBaseName("/Shared/PData/BD/BD-AI/Deck.pptx"), "Deck.pptx");
  assert.deepEqual(egnyteBreadcrumbs("/Shared/PData/BD"), [
    { label: "Shared", path: "/Shared" },
    { label: "PData", path: "/Shared/PData" },
    { label: "BD", path: "/Shared/PData/BD" },
  ]);
  assert.deepEqual(egnyteBreadcrumbs("/Private/x"), []);
  assert.equal(egnyteShortPath("/Shared/PData/BD/BD-AI/All Proposals"), "…/BD-AI/All Proposals");
  assert.equal(egnyteShortPath("/Shared/PData"), "/Shared/PData");
});

test("web links use the /navigate/path form and match between server and client", () => {
  const path = "/Shared/PData/BD/BD-AI/All Proposals/R&D v2.pdf";
  const expected = "https://acme.egnyte.com/navigate/path/Shared/PData/BD/BD-AI/All%20Proposals/R%26D%20v2.pdf";
  assert.equal(egnyteWebUrl("https://acme.egnyte.com/", path), expected);
  assert.equal(serverWebUrl(path, "https://acme.egnyte.com"), expected);
  assert.equal(egnyteWebUrl("", path), "");
  assert.equal(serverWebUrl(path, null), null);
});

test("formatEgnyteSize renders human sizes and tolerates missing values", () => {
  assert.equal(formatEgnyteSize(512), "512 B");
  assert.equal(formatEgnyteSize(14451), "14 KB");
  assert.equal(formatEgnyteSize(1536), "1.5 KB");
  assert.equal(formatEgnyteSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatEgnyteSize(null), "");
  assert.equal(formatEgnyteSize("nope"), "");
});

test("validateSharedEgnytePath defaults to BD-AI and refuses anything outside /Shared", () => {
  assert.equal(validateSharedEgnytePath(""), "/Shared/PData/BD/BD-AI");
  assert.equal(validateSharedEgnytePath(null), "/Shared/PData/BD/BD-AI");
  assert.equal(validateSharedEgnytePath("/Shared//PData/"), "/Shared/PData");
  assert.equal(validateSharedEgnytePath("/Shared"), "/Shared");
  assert.throws(() => validateSharedEgnytePath("/Private/rmehta"), (e) => e.status === 400 && /\/Shared/.test(e.message));
  assert.throws(() => validateSharedEgnytePath("/SharedX"), (e) => e.status === 400);
  assert.throws(() => validateSharedEgnytePath("/Shared/../Private"), (e) => e.status === 400);
  assert.throws(() => validateSharedEgnytePath("/Shared/a\nb"), (e) => e.status === 400);
  assert.equal(serverWithinRoot("/Shared/PData"), true);
  assert.equal(serverWithinRoot("/Sharedish"), false);
});

test("normalizeEgnytePath keeps its message and now carries a 400 status", () => {
  assert.throws(() => normalizeEgnytePath("../x"), (e) => e.status === 400 && /Invalid Egnyte folder path/.test(e.message));
});

test("entriesFromEgnyteListing shapes folders then files, sorted, without leaking extra fields", () => {
  const { folders, files } = entriesFromEgnyteListing(LISTING, { webBase: "https://acme.egnyte.com" });
  assert.deepEqual(folders.map((f) => f.name), ["All Proposals", "Presentations"]);
  assert.equal(folders[0].kind, "folder");
  assert.equal(folders[0].modified, new Date(1790622526000).toISOString());
  assert.equal(folders[0].webUrl, "https://acme.egnyte.com/navigate/path/Shared/PData/BD/BD-AI/All%20Proposals");
  assert.deepEqual(files, [{
    kind: "file",
    name: "SoftwareSubscriptionCosts.xlsx",
    path: "/Shared/PData/BD/BD-AI/SoftwareSubscriptionCosts.xlsx",
    size: 14451,
    modified: "2026-04-13T13:24:03.000Z",
    webUrl: "https://acme.egnyte.com/navigate/path/Shared/PData/BD/BD-AI/SoftwareSubscriptionCosts.xlsx",
  }]);
});

test("folder-only browsing is unchanged: same request URL, same { path, folders } shape", async () => {
  const seen = [];
  const result = await browseEgnyteFolders({ path: "/Shared/PData/BD/BD-AI", env: ENV, fetchImpl: okFetch(LISTING, seen) });
  assert.equal(seen[0].url, "https://acme.egnyte.com/pubapi/v1/fs/Shared/PData/BD/BD-AI");
  assert.deepEqual(Object.keys(result).sort(), ["folders", "path"]);
  assert.deepEqual(result.folders, foldersFromEgnyteListing(LISTING));
  assert.deepEqual(result.folders[0], { name: "All Proposals", path: "/Shared/PData/BD/BD-AI/All Proposals" });
});

test("folder-only browsing still allows non-/Shared paths (Invoice behaviour untouched)", async () => {
  const result = await browseEgnyteFolders({ path: "/Private/x", env: ENV, fetchImpl: okFetch({ folders: [] }) });
  assert.equal(result.path, "/Private/x");
});

test("files opt-in returns folders + files + webBase and enforces /Shared before calling Egnyte", async () => {
  const seen = [];
  const result = await browseEgnyteFolders({ path: "", includeFiles: true, env: ENV, fetchImpl: okFetch(LISTING, seen) });
  assert.equal(seen[0].url, "https://acme.egnyte.com/pubapi/v1/fs/Shared/PData/BD/BD-AI");
  assert.equal(result.path, "/Shared/PData/BD/BD-AI");
  assert.equal(result.webBase, "https://acme.egnyte.com");
  assert.equal(result.totalCount, 3);
  assert.equal(result.folders.length, 2);
  assert.equal(result.files.length, 1);

  let called = false;
  await assert.rejects(
    () => browseEgnyteFolders({ path: "/Private/rmehta", includeFiles: true, env: ENV, fetchImpl: async () => { called = true; } }),
    (e) => e.status === 400,
  );
  assert.equal(called, false);
});

test("files opt-in on a file path answers with that file's metadata", async () => {
  const file = LISTING.files[0];
  const result = await browseEgnyteFolders({ path: file.path, includeFiles: true, env: ENV, fetchImpl: okFetch(file) });
  assert.equal(result.isFile, true);
  assert.deepEqual(result.folders, []);
  assert.equal(result.files[0].size, 14451);
});

test("the API endpoint stays sign-in gated and exposes the files + info opt-ins", () => {
  const source = read("../api/egnyte/folders.js");
  assert.match(source, /await requireBeaconUser\(req\)/);
  assert.ok(source.indexOf("requireBeaconUser(req)") < source.indexOf('get("info")'));
  assert.match(source, /get\("files"\) === "1"/);
  assert.doesNotMatch(source, /getEgnyteAccessToken/);
});

test("migration creates an idempotent, authenticated-only link table", () => {
  const sql = read("../../supabase/migrations_v2/20261013130000_marketing_egnyte_links.sql");
  assert.match(sql, /create table if not exists beacon_v2\.marketing_egnyte_links/);
  assert.match(sql, /references beacon_v2\.marketing_opportunities\(id\) on delete cascade/);
  assert.match(sql, /kind\s+text not null check \(kind in \('file', 'folder'\)\)/);
  assert.match(sql, /references beacon_v2\.users\(id\) on delete set null/);
  assert.match(sql, /unique \(opportunity_id, egnyte_path\)/);
  assert.match(sql, /create index if not exists marketing_egnyte_links_opportunity_idx/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /drop policy if exists marketing_egnyte_links_auth_all/);
  assert.match(sql, /to authenticated using \(true\) with check \(true\)/);
  assert.match(sql, /revoke all on beacon_v2\.marketing_egnyte_links from anon/);
  assert.match(sql, /notify pgrst, 'reload schema';\s*$/);
});

test("data layer degrades gracefully before the migration and never deletes in Egnyte", () => {
  const data = read("../src/data.js");
  assert.match(data, /export async function loadMarketingEgnyteLinks/);
  assert.match(data, /export async function addMarketingEgnyteLink/);
  assert.match(data, /export async function removeMarketingEgnyteLink/);
  assert.match(data, /isMissingTableError\(error\)\) return \{ links: \[\], available: false \}/);
  assert.match(data, /if \(includeFiles\) params\.set\("files", "1"\)/);
  const remove = data.slice(data.indexOf("export async function removeMarketingEgnyteLink"));
  assert.doesNotMatch(remove.slice(0, remove.indexOf("\n}\n")), /api\/egnyte|authedApiFetch/);
});

test("the Invoice table now imports the shared picker instead of inlining it", () => {
  const tables = read("../src/tables.jsx");
  assert.match(tables, /from "\.\/egnyte-picker\.jsx"/);
  assert.doesNotMatch(tables, /function EgnyteFolderModal/);
  const picker = read("../src/egnyte-picker.jsx");
  assert.match(picker, /export function EgnyteFolderModal/);
  assert.match(picker, /export function EgnytePickerDialog/);
  assert.match(picker, /useEgnyteBrowser\(\)/); // Invoice picker stays folder-only
});

test("a single short 429 from Egnyte is retried once; long waits are surfaced", async () => {
  let calls = 0;
  const slept = [];
  const flaky = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => "1" }, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => LISTING };
  };
  const result = await browseEgnyteFolders({ path: "/Shared/PData", includeFiles: true, env: ENV, fetchImpl: flaky, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(calls, 2);
  assert.deepEqual(slept, [1000]);
  assert.equal(result.files.length, 1);

  let longCalls = 0;
  await assert.rejects(
    () => browseEgnyteFolders({
      path: "/Shared/PData",
      env: ENV,
      sleep: async () => { throw new Error("should not wait"); },
      fetchImpl: async () => { longCalls += 1; return { ok: false, status: 429, headers: { get: () => "3600" }, json: async () => ({}) }; },
    }),
    (e) => e.status === 429,
  );
  assert.equal(longCalls, 1);
});
