const MOBILE_RE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
export const EGNYTE_LOCAL_ROOT_STORAGE_KEY = "beacon.egnyteLocalRoot";
export const DEFAULT_MAC_EGNYTE_ROOT = "/Users/rajmehta/Library/CloudStorage/Egnyte-msmm";
export const DEFAULT_WINDOWS_EGNYTE_ROOT = "E:\\";

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
