#!/usr/bin/env node
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const PORT = Number(process.env.BEACON_EGNYTE_OPENER_PORT || 17654);
const HOST = process.env.BEACON_EGNYTE_OPENER_HOST || "127.0.0.1";
const DEFAULT_MAC_ROOT = path.join(os.homedir(), "Library", "CloudStorage", "Egnyte-msmm");
const DEFAULT_WINDOWS_ROOT = "E:\\";
const DEFAULT_ROOT = process.platform === "win32" ? DEFAULT_WINDOWS_ROOT : DEFAULT_MAC_ROOT;
const ALLOWED_ROOTS = String(process.env.BEACON_EGNYTE_LOCAL_ROOT || DEFAULT_ROOT)
  .split(path.delimiter)
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p));

function corsHeaders(origin = "") {
  const cleanOrigin = String(origin || "");
  const allowed = cleanOrigin === "https://beacon.msmm-ai.com"
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(cleanOrigin);
  return {
    "access-control-allow-origin": allowed ? cleanOrigin : "https://beacon.msmm-ai.com",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function sendJson(res, status, body, origin) {
  res.writeHead(status, {
    ...corsHeaders(origin),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 16_384) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function isAllowedPath(input) {
  const target = path.resolve(String(input || ""));
  return ALLOWED_ROOTS.some((root) => target === root || target.startsWith(`${root}${path.sep}`));
}

function openFolder(localPath) {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32"
      ? "explorer.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
    execFile(command, [localPath], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }
  if (req.method !== "POST" || req.url !== "/open") {
    sendJson(res, 404, { error: "Not found" }, origin);
    return;
  }
  try {
    const body = JSON.parse(await readBody(req) || "{}");
    const localPath = String(body.path || "").trim();
    if (!localPath) {
      sendJson(res, 400, { error: "Missing path" }, origin);
      return;
    }
    if (!isAllowedPath(localPath)) {
      sendJson(res, 403, { error: "Path is outside the configured Egnyte root" }, origin);
      return;
    }
    await openFolder(localPath);
    sendJson(res, 200, { ok: true }, origin);
  } catch (error) {
    sendJson(res, 500, { error: error?.message || "Could not open folder" }, origin);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Beacon Egnyte opener listening at http://${HOST}:${PORT}/open`);
  console.log(`Allowed Egnyte roots: ${ALLOWED_ROOTS.join(", ")}`);
});
