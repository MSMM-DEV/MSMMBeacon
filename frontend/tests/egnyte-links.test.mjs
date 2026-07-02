import assert from "node:assert/strict";
import test from "node:test";

import {
  egnyteFolderOpenTarget,
  isMobileUserAgent,
} from "../src/egnyte-links.js";

test("isMobileUserAgent detects phone and tablet browsers", () => {
  assert.equal(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8)"), true);
  assert.equal(isMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)"), false);
});

test("egnyteFolderOpenTarget returns a Mac Finder file URL", () => {
  const target = egnyteFolderOpenTarget({
    path: "/Shared/PData/ACME & Sons",
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
  });
  assert.equal(target.mobile, false);
  assert.equal(target.kind, "mac");
  assert.equal(target.url, "file:///Volumes/Egnyte/Shared/PData/ACME%20%26%20Sons");
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
