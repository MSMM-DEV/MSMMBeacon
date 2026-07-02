const DEFAULT_FOLDER = "/Shared/PData";

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
  if (!domain) throw new Error("Egnyte domain is not configured");
  return domain;
}

export async function getEgnyteAccessToken({ env = process.env, fetchImpl = fetch } = {}) {
  const direct = env.EGNYTE_ACCESS_TOKEN || env.EGNYTE_OAUTH_TOKEN || env.EGNYTE_BEARER_TOKEN;
  if (direct) return direct;

  const clientId = env.EGNYTE_API_KEY;
  const clientSecret = env.EGNYTE_SECRET_KEY;
  if (!clientId || !clientSecret) {
    throw new Error("Egnyte access token is not configured. Set EGNYTE_ACCESS_TOKEN or EGNYTE_USERNAME/EGNYTE_PASSWORD with EGNYTE_API_KEY/EGNYTE_SECRET_KEY.");
  }

  const url = env.EGNYTE_TOKEN_URL || `https://${egnyteDomain(env)}/puboauth/token`;
  const username = env.EGNYTE_USERNAME || env.EGNYTE_SERVICE_USERNAME || env.EGNYTE_CLIENT_ID;
  const password = env.EGNYTE_PASSWORD || env.EGNYTE_SERVICE_PASSWORD || env.EGNYTE_CLIENT_PASSWORD;
  if (!username || !password) {
    throw new Error("Egnyte access token is not configured. Set EGNYTE_ACCESS_TOKEN or EGNYTE_USERNAME/EGNYTE_PASSWORD with EGNYTE_API_KEY/EGNYTE_SECRET_KEY.");
  }
  const body = new URLSearchParams({
    grant_type: "password",
    username,
    password,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.errorMessage || payload?.error || "Egnyte authentication failed");
  }
  return payload.access_token;
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
