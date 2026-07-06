const DEFAULT_FOLDER = "/Shared/PData";
const DEFAULT_TOKEN_TTL_MS = 50 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

const oauthTokenCache = new Map();
const oauthTokenRequests = new Map();

function firstEnv(env, names) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function egnyteConfigError(message) {
  const err = new Error(message);
  err.status = 500;
  err.code = "EGNYTE_CONFIG";
  return err;
}

function egnyteAuthError(message, { status = 502, code = "EGNYTE_AUTH" } = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function egnyteAuthMessage(payload) {
  return payload?.error_description
    || payload?.errorMessage
    || payload?.message
    || payload?.error
    || "Egnyte authentication failed";
}

function tokenCacheKey({ domain, tokenUrl, clientId, username }) {
  return [domain, tokenUrl, clientId, username].join("\n");
}

function tokenExpiresAt(payload) {
  const expiresIn = Number(payload?.expires_in || 0);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + Math.max(0, expiresIn * 1000 - TOKEN_EXPIRY_SKEW_MS);
  }
  return Date.now() + DEFAULT_TOKEN_TTL_MS;
}

export function defaultEgnyteFolder(env = process.env) {
  return normalizeEgnytePath(env.EGNYTE_DEFAULT_FOLDER_PATH || DEFAULT_FOLDER);
}

export function normalizeEgnytePath(input, env = process.env) {
  const fallback = env.EGNYTE_DEFAULT_FOLDER_PATH || DEFAULT_FOLDER;
  const raw = input == null || String(input).trim() === "" ? fallback : String(input).trim();
  if (raw.includes("\\")) throw new Error("Invalid Egnyte folder path");
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  const collapsed = prefixed.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  const segments = collapsed.split("/").filter(Boolean);
  if (segments.some(seg => seg === "." || seg === "..")) {
    throw new Error("Invalid Egnyte folder path");
  }
  return collapsed;
}

export function validateProjectFolderPath(input) {
  if (input == null || String(input).trim() === "") return null;
  if (!String(input).trim().startsWith("/")) {
    throw new Error("Choose an Egnyte folder");
  }
  const clean = normalizeEgnytePath(input, { EGNYTE_DEFAULT_FOLDER_PATH: "" });
  if (clean === "/" || !clean.startsWith("/")) {
    throw new Error("Choose an Egnyte folder");
  }
  return clean;
}

export function encodeEgnytePath(path) {
  const clean = normalizeEgnytePath(path);
  if (clean === "/") return "/";
  return clean.split("/").map((part, i) => i === 0 ? "" : encodeURIComponent(part)).join("/");
}

export function foldersFromEgnyteListing(listing) {
  return (listing?.folders || [])
    .filter(f => f && (f.path || f.name))
    .map(f => {
      const path = normalizeEgnytePath(f.path || f.name);
      return {
        name: f.name || path.split("/").filter(Boolean).pop() || path,
        path,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function egnyteDomain(env = process.env) {
  const domain = String(env.EGNYTE_DOMAIN || "").trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!domain) throw egnyteConfigError("Egnyte domain is not configured. Set EGNYTE_DOMAIN.");
  return domain;
}

export async function getEgnyteAccessToken({ env = process.env, fetchImpl = fetch } = {}) {
  const direct = env.EGNYTE_ACCESS_TOKEN || env.EGNYTE_OAUTH_TOKEN || env.EGNYTE_BEARER_TOKEN;
  if (direct) return direct;

  const domain = egnyteDomain(env);
  const clientId = firstEnv(env, [
    "EGNYTE_API_KEY",
    "EGNYTE_OAUTH_CLIENT_ID",
    "EGNYTE_CLIENT_ID",
  ]);
  const clientSecret = firstEnv(env, [
    "EGNYTE_SECRET_KEY",
    "EGNYTE_API_SECRET",
    "EGNYTE_OAUTH_CLIENT_SECRET",
    "EGNYTE_CLIENT_SECRET",
  ]);
  if (!clientId || !clientSecret) {
    throw egnyteConfigError("Egnyte OAuth client credentials are not configured. Set EGNYTE_API_KEY/EGNYTE_SECRET_KEY or EGNYTE_CLIENT_ID/EGNYTE_CLIENT_SECRET.");
  }

  const url = env.EGNYTE_TOKEN_URL || `https://${domain}/puboauth/token`;
  const username = firstEnv(env, [
    "EGNYTE_USERNAME",
    "EGNYTE_SERVICE_USERNAME",
    "EGNYTE_SERVICE_USER",
  ]) || (env.EGNYTE_API_KEY ? String(env.EGNYTE_CLIENT_ID || "").trim() : "");
  const password = firstEnv(env, [
    "EGNYTE_PASSWORD",
    "EGNYTE_SERVICE_PASSWORD",
    "EGNYTE_CLIENT_PASSWORD",
  ]);
  if (!username || !password) {
    throw egnyteConfigError("Egnyte service user credentials are not configured. Set EGNYTE_USERNAME/EGNYTE_PASSWORD or EGNYTE_ACCESS_TOKEN.");
  }
  const cacheKey = tokenCacheKey({ domain, tokenUrl: url, clientId, username });
  const cached = oauthTokenCache.get(cacheKey);
  if (cached?.token && cached.expiresAt > Date.now()) return cached.token;
  if (oauthTokenRequests.has(cacheKey)) return oauthTokenRequests.get(cacheKey);

  const body = new URLSearchParams({
    grant_type: "password",
    username,
    password,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const request = (async () => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.access_token) {
      const status = response.status === 429 ? 429 : 502;
      throw egnyteAuthError(egnyteAuthMessage(payload), {
        status,
        code: status === 429 ? "EGNYTE_RATE_LIMIT" : "EGNYTE_AUTH",
      });
    }
    oauthTokenCache.set(cacheKey, {
      token: payload.access_token,
      expiresAt: tokenExpiresAt(payload),
    });
    return payload.access_token;
  })().finally(() => {
    oauthTokenRequests.delete(cacheKey);
  });
  oauthTokenRequests.set(cacheKey, request);
  return request;
}

export async function browseEgnyteFolders({ path, env = process.env, fetchImpl = fetch } = {}) {
  const cleanPath = normalizeEgnytePath(path, env);
  const token = await getEgnyteAccessToken({ env, fetchImpl });
  const url = `https://${egnyteDomain(env)}/pubapi/v1/fs${encodeEgnytePath(cleanPath)}`;
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload?.message || payload?.errorMessage || "Egnyte folders could not be loaded");
    err.status = response.status;
    throw err;
  }
  return {
    path: cleanPath,
    folders: foldersFromEgnyteListing(payload),
  };
}
