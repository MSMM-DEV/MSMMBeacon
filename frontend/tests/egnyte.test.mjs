import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeEgnytePath,
  encodeEgnytePath,
  foldersFromEgnyteListing,
  validateProjectFolderPath,
  getEgnyteAccessToken,
} from "../api/_lib/egnyte.mjs";

test("normalizeEgnytePath defaults to the PData folder", () => {
  assert.equal(normalizeEgnytePath(""), "/Shared/PData");
  assert.equal(normalizeEgnytePath(null), "/Shared/PData");
});

test("normalizeEgnytePath trims, prefixes a slash, and rejects traversal", () => {
  assert.equal(normalizeEgnytePath(" PData/2026 "), "/PData/2026");
  assert.equal(normalizeEgnytePath("/Shared//PData/"), "/Shared/PData");
  assert.throws(() => normalizeEgnytePath("../Private"), /Invalid Egnyte folder path/);
});

test("encodeEgnytePath preserves folder separators while encoding names", () => {
  assert.equal(encodeEgnytePath("/Shared/PData/ACME & Sons"), "/Shared/PData/ACME%20%26%20Sons");
});

test("foldersFromEgnyteListing returns sorted folder metadata", () => {
  const folders = foldersFromEgnyteListing({
    folders: [
      { name: "Zeta", path: "/Shared/PData/Zeta" },
      { name: "Alpha", path: "/Shared/PData/Alpha" },
    ],
  });
  assert.deepEqual(folders, [
    { name: "Alpha", path: "/Shared/PData/Alpha" },
    { name: "Zeta", path: "/Shared/PData/Zeta" },
  ]);
});

test("validateProjectFolderPath accepts one selected folder or a cleared link", () => {
  assert.equal(validateProjectFolderPath("/Shared/PData/Job 1"), "/Shared/PData/Job 1");
  assert.equal(validateProjectFolderPath(""), null);
  assert.throws(() => validateProjectFolderPath("not/a/path"), /Choose an Egnyte folder/);
});

test("getEgnyteAccessToken requires a bearer token or service-user password grant", async () => {
  await assert.rejects(
    () => getEgnyteAccessToken({
      env: {
        EGNYTE_DOMAIN: "example.egnyte.com",
        EGNYTE_API_KEY: "client-id",
        EGNYTE_SECRET_KEY: "client-secret",
      },
      fetchImpl: async () => {
        throw new Error("fetch should not run");
      },
    }),
    /EGNYTE_ACCESS_TOKEN or EGNYTE_USERNAME\/EGNYTE_PASSWORD/
  );
});

test("getEgnyteAccessToken accepts EGNYTE_CLIENT_ID/EGNYTE_CLIENT_PASSWORD as password-grant aliases", async () => {
  const token = await getEgnyteAccessToken({
    env: {
      EGNYTE_DOMAIN: "example.egnyte.com",
      EGNYTE_API_KEY: "app-client-id",
      EGNYTE_SECRET_KEY: "app-client-secret",
      EGNYTE_CLIENT_ID: "service-user",
      EGNYTE_CLIENT_PASSWORD: "service-password",
    },
    fetchImpl: async (_url, options) => {
      const body = options.body;
      assert.equal(body.get("grant_type"), "password");
      assert.equal(body.get("username"), "service-user");
      assert.equal(body.get("password"), "service-password");
      return {
        ok: true,
        json: async () => ({ access_token: "token-from-egnyte" }),
      };
    },
  });
  assert.equal(token, "token-from-egnyte");
});
