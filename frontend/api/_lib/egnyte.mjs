const DEFAULT_FOLDER = "/Shared/PData";
// File-and-folder browsing (the Sales opportunity "Link from Egnyte" flow) is
// confined to the shared tree. Private user folders stay out of reach even
// though the service user can technically see them.
export const EGNYTE_SHARED_ROOT = "/Shared";
// Default starting point for the Sales picker. Locally this is
// `Egnyte-msmm/Shared/PData/BD/BD-AI` — `Egnyte-msmm` is only the sync-root
// folder name on disk; the cloud API path starts at `/Shared`.
export const DEFAULT_SALES_EGNYTE_PATH = "/Shared/PData/BD/BD-AI";
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

function tokenExpiryFromEnv(env) {
  const raw = firstEnv(env, [
    "EGNYTE_ACCESS_TOKEN_EXPIRES_AT",
    "EGNYTE_TOKEN_EXPIRES_AT",
  ]);
  if (!raw) return 0;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : 0;
}

function tokenIsFresh(expiresAt) {
  return !expiresAt || expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS;
}

async function requestEgnyteOAuthToken({ url, cacheKey, body, fetchImpl }) {
  const cached = oauthTokenCache.get(cacheKey);
  if (cached?.token && cached.expiresAt > Date.now()) return cached.token;
  if (oauthTokenRequests.has(cacheKey)) return oauthTokenRequests.get(cacheKey);

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

export function defaultEgnyteFolder(env = process.env) {
  return normalizeEgnytePath(env.EGNYTE_DEFAULT_FOLDER_PATH || DEFAULT_FOLDER);
}

function invalidPathError(message = "Invalid Egnyte folder path") {
  const err = new Error(message);
  err.status = 400;
  err.code = "EGNYTE_PATH";
  return err;
}

export function normalizeEgnytePath(input, env = process.env) {
  const fallback = env.EGNYTE_DEFAULT_FOLDER_PATH || DEFAULT_FOLDER;
  const raw = input == null || String(input).trim() === "" ? fallback : String(input).trim();
  if (raw.includes("\\")) throw invalidPathError();
  // Control characters (incl. NUL / newlines) never appear in a real Egnyte
  // name and would only ever be an attempt to smuggle something past us.
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw invalidPathError();
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  const collapsed = prefixed.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  const segments = collapsed.split("/").filter(Boolean);
  if (segments.some(seg => seg === "." || seg === "..")) {
    throw invalidPathError();
  }
  return collapsed;
}

export function isWithinEgnyteRoot(path, root = EGNYTE_SHARED_ROOT) {
  const cleanRoot = String(root || "/").replace(/\/+$/, "") || "/";
  const clean = String(path || "");
  if (cleanRoot === "/") return clean.startsWith("/");
  return clean === cleanRoot || clean.startsWith(`${cleanRoot}/`);
}

// Validates a path for the file-and-folder browser: normalised, no
// traversal, and inside /Shared. Empty input starts at the Sales default.
export function validateSharedEgnytePath(input) {
  const clean = normalizeEgnytePath(input, { EGNYTE_DEFAULT_FOLDER_PATH: DEFAULT_SALES_EGNYTE_PATH });
  if (!isWithinEgnyteRoot(clean, EGNYTE_SHARED_ROOT)) {
    throw invalidPathError("Only Egnyte items under /Shared can be browsed here");
  }
  return clean;
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

function egnyteModifiedIso(entry) {
  // Folders carry `lastModified` (epoch ms); files carry `last_modified`
  // (an RFC 1123 string). Either may be absent.
  const raw = entry?.lastModified ?? entry?.last_modified ?? null;
  if (raw == null || raw === "") return null;
  const ts = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null;
}

function egnyteEntryName(entry, path) {
  return entry?.name || path.split("/").filter(Boolean).pop() || path;
}

// Web link that opens an item in the Egnyte web UI. `/navigate/path/...`
// resolves files and folders alike (it bounces through Egnyte sign-in and
// back), so it survives the item being re-uploaded with a new entry id.
export function egnyteWebUrl(path, webBase) {
  if (!webBase) return null;
  return `${String(webBase).replace(/\/+$/, "")}/navigate/path${encodeEgnytePath(path)}`;
}

function shapeFileEntry(entry, webBase) {
  const path = normalizeEgnytePath(entry.path || entry.name);
  const size = Number(entry.size);
  return {
    kind: "file",
    name: egnyteEntryName(entry, path),
    path,
    size: Number.isFinite(size) && size >= 0 ? size : null,
    modified: egnyteModifiedIso(entry),
    webUrl: egnyteWebUrl(path, webBase),
  };
}

// Folder + file listing for the file-aware browser. Folders keep the same
// alphabetical order as foldersFromEgnyteListing; files follow, also sorted.
export function entriesFromEgnyteListing(listing, { webBase = null } = {}) {
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const folders = (listing?.folders || [])
    .filter(f => f && (f.path || f.name))
    .map(f => {
      const path = normalizeEgnytePath(f.path || f.name);
      return {
        kind: "folder",
        name: egnyteEntryName(f, path),
        path,
        modified: egnyteModifiedIso(f),
        webUrl: egnyteWebUrl(path, webBase),
      };
    })
    .sort(byName);
  const files = (listing?.files || [])
    .filter(f => f && (f.path || f.name))
    .map(f => shapeFileEntry(f, webBase))
    .sort(byName);
  return { folders, files };
}

export function egnyteDomain(env = process.env) {
  const domain = String(env.EGNYTE_DOMAIN || "").trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!domain) throw egnyteConfigError("Egnyte domain is not configured. Set EGNYTE_DOMAIN.");
  return domain;
}

export async function getEgnyteAccessToken({ env = process.env, fetchImpl = fetch } = {}) {
  const direct = firstEnv(env, [
    "EGNYTE_ACCESS_TOKEN",
    "EGNYTE_OAUTH_TOKEN",
    "EGNYTE_BEARER_TOKEN",
  ]);
  if (direct && tokenIsFresh(tokenExpiryFromEnv(env))) return direct;

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
  const refreshToken = firstEnv(env, [
    "EGNYTE_REFRESH_TOKEN",
    "EGNYTE_OAUTH_REFRESH_TOKEN",
  ]);
  if (refreshToken) {
    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    return requestEgnyteOAuthToken({
      url,
      cacheKey: tokenCacheKey({ domain, tokenUrl: url, clientId, username: `refresh:${refreshToken}` }),
      body: refreshBody,
      fetchImpl,
    });
  }

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
  const body = new URLSearchParams({
    grant_type: "password",
    username,
    password,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return requestEgnyteOAuthToken({ url, cacheKey, body, fetchImpl });
}

export function egnyteWebBase(env = process.env) {
  return `https://${egnyteDomain(env)}`;
}

// `includeFiles` is the opt-in used by the Sales "Link from Egnyte" flow. It
// confines browsing to /Shared and returns files alongside folders. Without
// it the response is byte-for-byte the folder-only shape the Invoice table
// has always consumed: { path, folders: [{ name, path }] }.
// Egnyte enforces a per-second request cap (a burst of 3+ listings in the
// same second answers 429 with a short Retry-After). One bounded retry turns
// that transient bounce into a slightly slower success; anything longer —
// e.g. the daily quota — is surfaced to the caller unchanged.
const MAX_RETRY_AFTER_MS = 2500;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response) {
  const raw = response?.headers?.get?.("retry-after");
  if (raw == null || raw === "") return 1000;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Infinity;
}

export async function browseEgnyteFolders({
  path,
  includeFiles = false,
  env = process.env,
  fetchImpl = fetch,
  sleep = defaultSleep,
} = {}) {
  const cleanPath = includeFiles ? validateSharedEgnytePath(path) : normalizeEgnytePath(path, env);
  const token = await getEgnyteAccessToken({ env, fetchImpl });
  const url = `https://${egnyteDomain(env)}/pubapi/v1/fs${encodeEgnytePath(cleanPath)}`;
  const request = () => fetchImpl(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });
  let response = await request();
  if (response.status === 429) {
    const wait = retryAfterMs(response);
    if (wait <= MAX_RETRY_AFTER_MS) {
      await sleep(wait);
      response = await request();
    }
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload?.message || payload?.errorMessage || "Egnyte folders could not be loaded");
    err.status = response.status;
    throw err;
  }
  if (includeFiles) {
    const webBase = egnyteWebBase(env);
    if (payload?.is_folder === false) {
      // The path names a file; answer with just that file's metadata.
      return { path: cleanPath, isFile: true, folders: [], files: [shapeFileEntry({ ...payload, path: cleanPath }, webBase)], webBase };
    }
    const { folders, files } = entriesFromEgnyteListing(payload, { webBase });
    const total = Number(payload?.total_count);
    return {
      path: cleanPath,
      folders,
      files,
      webBase,
      totalCount: Number.isFinite(total) ? total : folders.length + files.length,
    };
  }
  return {
    path: cleanPath,
    folders: foldersFromEgnyteListing(payload),
  };
}
