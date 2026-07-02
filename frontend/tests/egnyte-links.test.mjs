import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultEgnyteLocalRoot,
  egnyteFolderOpenTarget,
  filterEgnyteFolders,
  isMobileUserAgent,
} from "../src/egnyte-links.js";

test("isMobileUserAgent detects phone and tablet browsers", () => {
  assert.equal(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8)"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)"), false);
});

test("defaultEgnyteLocalRoot returns the Egnyte File Provider root on Mac", () => {
  assert.equal(
    defaultEgnyteLocalRoot("MacIntel"),
    "/Users/rajmehta/Library/CloudStorage/Egnyte-msmm",
  );
});

test("egnyteFolderOpenTarget returns a Mac Finder file URL", () => {
  const target = egnyteFolderOpenTarget({
    path: "/Shared/PData/ACME & Sons",
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
  });
  assert.equal(target.mobile, false);
  assert.equal(target.kind, "mac");
  assert.equal(target.localPath, "/Users/rajmehta/Library/CloudStorage/Egnyte-msmm/Shared/PData/ACME & Sons");
  assert.equal(target.url, "file:///Users/rajmehta/Library/CloudStorage/Egnyte-msmm/Shared/PData/ACME%20%26%20Sons");
});

test("egnyteFolderOpenTarget allows a custom local root", () => {
  const target = egnyteFolderOpenTarget({
    path: "/Shared/PData/ACME & Sons",
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
    localRoot: "/Users/tester/Library/CloudStorage/Egnyte-msmm",
  });
  assert.equal(target.localPath, "/Users/tester/Library/CloudStorage/Egnyte-msmm/Shared/PData/ACME & Sons");
  assert.equal(target.url, "file:///Users/tester/Library/CloudStorage/Egnyte-msmm/Shared/PData/ACME%20%26%20Sons");
});

test("egnyteFolderOpenTarget returns a Windows Explorer file URL", () => {
  const target = egnyteFolderOpenTarget({
    path: "/Shared/PData/ACME & Sons",
    platform: "Win32",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  });
  assert.equal(target.mobile, false);
  assert.equal(target.kind, "windows");
  assert.equal(target.url, "file:///E:/Shared/PData/ACME%20%26%20Sons");
});

test("egnyteFolderOpenTarget marks mobile as unavailable", () => {
  const target = egnyteFolderOpenTarget({
    path: "/Shared/PData",
    platform: "iPhone",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
  });
  assert.equal(target.mobile, true);
  assert.equal(target.url, "");
});

test("filterEgnyteFolders matches folder names and paths case-insensitively", () => {
  const folders = [
    { name: "Accounting", path: "/Shared/PData/Accounting" },
    { name: "Baton Rouge Pump Station", path: "/Shared/PData/Capital/Baton Rouge Pump Station" },
    { name: "Civil", path: "/Shared/PData/Civil" },
  ];
  assert.deepEqual(filterEgnyteFolders(folders, "baton").map((f) => f.name), ["Baton Rouge Pump Station"]);
  assert.deepEqual(filterEgnyteFolders(folders, "capital").map((f) => f.name), ["Baton Rouge Pump Station"]);
  assert.deepEqual(filterEgnyteFolders(folders, "  ").map((f) => f.name), ["Accounting", "Baton Rouge Pump Station", "Civil"]);
});
