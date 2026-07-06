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
    /EGNYTE_USERNAME\/EGNYTE_PASSWORD or EGNYTE_ACCESS_TOKEN/
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

test("getEgnyteAccessToken accepts OAuth client id/secret aliases with explicit service credentials", async () => {
  const token = await getEgnyteAccessToken({
    env: {
      EGNYTE_DOMAIN: "example.egnyte.com",
      EGNYTE_CLIENT_ID: "alias-app-client-id",
      EGNYTE_CLIENT_SECRET: "alias-app-client-secret",
      EGNYTE_USERNAME: "alias-service-user",
      EGNYTE_PASSWORD: "alias-service-password",
    },
    fetchImpl: async (_url, options) => {
      const body = options.body;
      assert.equal(body.get("grant_type"), "password");
      assert.equal(body.get("client_id"), "alias-app-client-id");
      assert.equal(body.get("client_secret"), "alias-app-client-secret");
      assert.equal(body.get("username"), "alias-service-user");
      assert.equal(body.get("password"), "alias-service-password");
      return {
        ok: true,
        json: async () => ({ access_token: "token-from-aliases" }),
      };
    },
  });
  assert.equal(token, "token-from-aliases");
});

test("getEgnyteAccessToken uses a refresh token without the password grant", async () => {
  const token = await getEgnyteAccessToken({
    env: {
      EGNYTE_DOMAIN: "example.egnyte.com",
      EGNYTE_CLIENT_ID: "refresh-client-id",
      EGNYTE_CLIENT_SECRET: "refresh-client-secret",
      EGNYTE_REFRESH_TOKEN: "stored-refresh-token",
    },
    fetchImpl: async (_url, options) => {
      const body = options.body;
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "stored-refresh-token");
      assert.equal(body.has("username"), false);
      assert.equal(body.has("password"), false);
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "token-from-refresh", expires_in: 2592000 }),
      };
    },
  });
  assert.equal(token, "token-from-refresh");
});

test("getEgnyteAccessToken refreshes an expired static access token", async () => {
  const token = await getEgnyteAccessToken({
    env: {
      EGNYTE_DOMAIN: "example.egnyte.com",
      EGNYTE_CLIENT_ID: "expired-client-id",
      EGNYTE_CLIENT_SECRET: "expired-client-secret",
      EGNYTE_ACCESS_TOKEN: "expired-static-token",
      EGNYTE_ACCESS_TOKEN_EXPIRES_AT: "2020-01-01T00:00:00.000Z",
      EGNYTE_REFRESH_TOKEN: "expired-refresh-token",
    },
    fetchImpl: async (_url, options) => {
      const body = options.body;
      assert.equal(body.get("grant_type"), "refresh_token");
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "fresh-token-from-refresh", expires_in: 2592000 }),
      };
    },
  });
  assert.equal(token, "fresh-token-from-refresh");
});

test("getEgnyteAccessToken reuses a valid OAuth token", async () => {
  let calls = 0;
  const env = {
    EGNYTE_DOMAIN: "example.egnyte.com",
    EGNYTE_CLIENT_ID: "cache-client-id",
    EGNYTE_CLIENT_SECRET: "cache-client-secret",
    EGNYTE_USERNAME: "service-user",
    EGNYTE_PASSWORD: "service-password",
  };
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ access_token: `cached-token-${calls}`, expires_in: 3600 }),
    };
  };

  const first = await getEgnyteAccessToken({ env, fetchImpl });
  const second = await getEgnyteAccessToken({ env, fetchImpl });

  assert.equal(first, "cached-token-1");
  assert.equal(second, "cached-token-1");
  assert.equal(calls, 1);
});

test("getEgnyteAccessToken preserves Egnyte OAuth rate limit failures", async () => {
  await assert.rejects(
    () => getEgnyteAccessToken({
      env: {
        EGNYTE_DOMAIN: "example.egnyte.com",
        EGNYTE_CLIENT_ID: "rate-client-id",
        EGNYTE_CLIENT_SECRET: "rate-client-secret",
        EGNYTE_USERNAME: "service-user",
        EGNYTE_PASSWORD: "service-password",
      },
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: async () => ({ message: "Oauth request from this source has gone over its rate limit quota." }),
      }),
    }),
    error => error.status === 429 && /rate limit/i.test(error.message)
  );
});
