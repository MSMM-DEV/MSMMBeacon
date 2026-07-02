const MOBILE_RE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;

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

export function isMobileUserAgent(userAgent = "") {
  return MOBILE_RE.test(String(userAgent || ""));
}

export function egnyteFolderOpenTarget({
  path,
  platform = "",
  userAgent = "",
} = {}) {
  if (isMobileUserAgent(userAgent) || /iPhone|iPad|iPod|Android/i.test(String(platform || ""))) {
    return {
      mobile: true,
      kind: "mobile",
      url: "",
      localPath: "",
    };
  }

  const encoded = encodePathSegments(path);
  if (/Win/i.test(String(platform || ""))) {
    return {
      mobile: false,
      kind: "windows",
      url: `file:///E:/${encoded}`,
      localPath: `E:\\${cleanEgnytePath(path).split("/").filter(Boolean).join("\\")}`,
    };
  }

  return {
    mobile: false,
    kind: "mac",
    url: `file:///Volumes/Egnyte/${encoded}`,
    localPath: `/Volumes/Egnyte${cleanEgnytePath(path)}`,
  };
}
