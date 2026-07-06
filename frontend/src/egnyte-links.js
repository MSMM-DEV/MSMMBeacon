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
