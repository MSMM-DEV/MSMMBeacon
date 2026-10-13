const MOBILE_RE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
export const EGNYTE_LOCAL_ROOT_STORAGE_KEY = "beacon.egnyteLocalRoot";
export const DEFAULT_MAC_EGNYTE_ROOT = "/Users/rajmehta/Library/CloudStorage/Egnyte-msmm";
export const DEFAULT_WINDOWS_EGNYTE_ROOT = "E:\\";
export const DEFAULT_EGNYTE_LOCAL_OPENER_URL = "http://127.0.0.1:17654/open";

function cleanEgnytePath(path) {
  const raw = String(path || "").trim();
  if (!raw) return "";
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return prefixed.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function encodePathSegments(path) {
  const clean = cleanEgnytePath(path);
  if (!clean || clean === "/") return "";
  return clean.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function pathParts(path) {
  return cleanEgnytePath(path).split("/").filter(Boolean);
}

function trimTrailingSlashes(value, slash = "/") {
  const escaped = slash === "\\" ? "\\\\" : slash;
  return String(value || "").trim().replace(new RegExp(`${escaped}+$`), "");
}

function encodePosixFileUrl(path) {
  const clean = String(path || "").replace(/\/+/g, "/");
  return `file://${clean.split("/").map((part, index) => (
    index === 0 ? "" : encodeURIComponent(part)
  )).join("/")}`;
}

function encodeWindowsFileUrl(path) {
  const clean = String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/");
  const encoded = clean.split("/").map((part, index) => (
    index === 0 ? part : encodeURIComponent(part)
  )).join("/");
  return `file:///${encoded}`;
}

export function isMobileUserAgent(userAgent = "") {
  return MOBILE_RE.test(String(userAgent || ""));
}

export function defaultEgnyteLocalRoot(platform = "") {
  if (/Win/i.test(String(platform || ""))) return DEFAULT_WINDOWS_EGNYTE_ROOT;
  return DEFAULT_MAC_EGNYTE_ROOT;
}

export function filterEgnyteFolders(folders = [], query = "") {
  const list = Array.isArray(folders) ? folders : [];
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((folder) => {
    const name = String(folder?.name || "").toLowerCase();
    const path = String(folder?.path || "").toLowerCase();
    return name.includes(q) || path.includes(q);
  });
}

export function canAttemptLocalFileOpen(pageProtocol = "") {
  const protocol = String(pageProtocol || "").toLowerCase();
  return protocol === "file:" || protocol === "https:";
}

export async function openLocalFolderWithHelper({
  localPath,
  openerUrl = DEFAULT_EGNYTE_LOCAL_OPENER_URL,
  fetchImpl = typeof fetch !== "undefined" ? fetch : null,
  timeoutMs = 900,
} = {}) {
  const cleanPath = String(localPath || "").trim();
  if (!cleanPath || !fetchImpl) return false;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(openerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: cleanPath }),
      signal: controller?.signal,
    });
    return !!response?.ok;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function egnyteFolderOpenTarget({
  path,
  platform = "",
  userAgent = "",
  localRoot = "",
} = {}) {
  if (isMobileUserAgent(userAgent) || /iPhone|iPad|iPod|Android/i.test(String(platform || ""))) {
    return {
      mobile: true,
      kind: "mobile",
      url: "",
      localPath: "",
    };
  }

  if (/Win/i.test(String(platform || ""))) {
    const root = trimTrailingSlashes(localRoot || defaultEgnyteLocalRoot(platform), "\\") || DEFAULT_WINDOWS_EGNYTE_ROOT.replace(/\\+$/, "");
    const localPath = [root, ...pathParts(path)].join("\\");
    return {
      mobile: false,
      kind: "windows",
      url: encodeWindowsFileUrl(localPath),
      localPath,
    };
  }

  const root = trimTrailingSlashes(localRoot || defaultEgnyteLocalRoot(platform), "/") || DEFAULT_MAC_EGNYTE_ROOT;
  const suffix = encodePathSegments(path);
  const localPath = `${root}${cleanEgnytePath(path)}`;
  return {
    mobile: false,
    kind: "mac",
    url: `${encodePosixFileUrl(root)}${suffix ? `/${suffix}` : ""}`,
    localPath,
  };
}

// ---------------------------------------------------------------------------
// File-and-folder linking (Sales opportunity "Link from Egnyte").
//
// Cloud paths start at `/Shared/...`; the local sync root (`Egnyte-msmm` on a
// Mac) is prepended by egnyteFolderOpenTarget, so the local folder
// `Egnyte-msmm/Shared/PData/BD/BD-AI` is the cloud path below.
// ---------------------------------------------------------------------------
export const EGNYTE_SHARED_ROOT = "/Shared";
export const DEFAULT_SALES_EGNYTE_PATH = "/Shared/PData/BD/BD-AI";

export function normalizeEgnyteClientPath(path) {
  return cleanEgnytePath(path);
}

export function egnyteBaseName(path) {
  const parts = pathParts(path);
  return parts[parts.length - 1] || "/";
}

export function egnyteParentPath(path, root = EGNYTE_SHARED_ROOT) {
  const clean = cleanEgnytePath(path);
  if (!clean || clean === "/") return null;
  const cleanRoot = cleanEgnytePath(root) || "/";
  if (clean === cleanRoot) return null;
  const parent = `/${pathParts(clean).slice(0, -1).join("/")}`;
  return isWithinEgnyteRoot(parent, cleanRoot) ? parent : null;
}

export function isWithinEgnyteRoot(path, root = EGNYTE_SHARED_ROOT) {
  const clean = cleanEgnytePath(path);
  const cleanRoot = cleanEgnytePath(root) || "/";
  if (!clean) return false;
  if (cleanRoot === "/") return true;
  return clean === cleanRoot || clean.startsWith(`${cleanRoot}/`);
}

// Breadcrumbs from the browsing root down to `path`. Ancestors above the
// root are not navigable, so they are folded into the root crumb.
export function egnyteBreadcrumbs(path, root = EGNYTE_SHARED_ROOT) {
  const clean = cleanEgnytePath(path);
  if (!clean || !isWithinEgnyteRoot(clean, root)) return [];
  const rootParts = pathParts(root);
  const parts = pathParts(clean);
  const crumbs = [];
  for (let i = Math.max(rootParts.length, 1); i <= parts.length; i += 1) {
    crumbs.push({ label: parts[i - 1], path: `/${parts.slice(0, i).join("/")}` });
  }
  return crumbs;
}

// "Open in Egnyte" web link — same `/navigate/path/...` shape the server
// returns per listing entry. `webBase` comes from the API (never hardcoded).
export function egnyteWebUrl(webBase, path) {
  const base = String(webBase || "").trim().replace(/\/+$/, "");
  const suffix = encodePathSegments(path);
  if (!base || !suffix) return "";
  return `${base}/navigate/path/${suffix}`;
}

export function formatEgnyteSize(bytes) {
  const n = Number(bytes);
  if (bytes == null || bytes === "" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// Compact display of a path that keeps its most specific end:
// "/Shared/PData/BD/BD-AI/Proposals" → "…/BD-AI/Proposals" (keep = 2).
export function egnyteShortPath(path, keep = 2) {
  const parts = pathParts(path);
  if (!parts.length) return "/";
  if (parts.length <= keep) return `/${parts.join("/")}`;
  return `…/${parts.slice(-keep).join("/")}`;
}
