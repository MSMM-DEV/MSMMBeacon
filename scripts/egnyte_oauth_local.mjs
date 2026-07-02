#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const envPath = path.join(root, ".env");
const rawEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

function parseEnv(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function upsertEnv(raw, values) {
  const seen = new Set();
  const lines = raw.split(/\r?\n/).map(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m || !(m[1] in values)) return line;
    seen.add(m[1]);
    return `${m[1]}=${values[m[1]] ?? ""}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) lines.push(`${key}=${value ?? ""}`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

const env = { ...process.env, ...parseEnv(rawEnv) };
const domain = String(env.EGNYTE_DOMAIN || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
const clientId = env.EGNYTE_API_KEY;
const clientSecret = env.EGNYTE_SECRET_KEY;
const redirectUri = env.EGNYTE_REDIRECT_URI || "https://127.0.0.1:8787/egnyte/callback";
const scope = env.EGNYTE_SCOPE || "Egnyte.filesystem";

if (!domain || !clientId || !clientSecret) {
  console.error("Missing EGNYTE_DOMAIN, EGNYTE_API_KEY, or EGNYTE_SECRET_KEY in .env");
  process.exit(1);
}

const redirect = new URL(redirectUri);
const authUrl = new URL(`https://${domain}/puboauth/authorize`);
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", scope);

const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));
const host = redirect.hostname;
let completed = false;

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  const res = await fetch(`https://${domain}/puboauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.access_token) {
    const safe = {
      status: res.status,
      error: payload.error || payload.message || payload.error_description || "Token exchange failed",
      keys: Object.keys(payload),
    };
    throw new Error(JSON.stringify(safe));
  }
  return payload;
}

function localHttpsOptions() {
  if (redirect.protocol !== "https:") return null;
  const dir = path.join(os.tmpdir(), "beacon-egnyte-oauth");
  const key = path.join(dir, "localhost.key");
  const cert = path.join(dir, "localhost.crt");
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key,
      "-out", cert,
      "-days", "1",
      "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ], { stdio: "ignore" });
  }
  return {
    key: fs.readFileSync(key),
    cert: fs.readFileSync(cert),
  };
}

const handleCallback = async (req, res) => {
  const reqUrl = new URL(req.url || "/", redirectUri);
  if (reqUrl.pathname !== redirect.pathname) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  if (completed) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Egnyte authorization already completed. You can close this tab.");
    return;
  }
  const err = reqUrl.searchParams.get("error");
  const code = reqUrl.searchParams.get("code");
  if (err || !code) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end(`Egnyte authorization failed: ${err || "missing code"}`);
    const keys = Array.from(reqUrl.searchParams.keys());
    console.error(`Egnyte authorization callback did not include a code (${err || "missing code"}). Query keys: ${keys.join(", ") || "none"}`);
    return;
  }
  try {
    const token = await exchangeCode(code);
    const expiresAt = token.expires_in
      ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString()
      : "";
    const nextEnv = upsertEnv(rawEnv, {
      EGNYTE_REDIRECT_URI: redirectUri,
      EGNYTE_SCOPE: scope,
      EGNYTE_ACCESS_TOKEN: token.access_token,
      EGNYTE_REFRESH_TOKEN: token.refresh_token || env.EGNYTE_REFRESH_TOKEN || "",
      EGNYTE_ACCESS_TOKEN_EXPIRES_AT: expiresAt,
    });
    fs.writeFileSync(envPath, nextEnv.endsWith("\n") ? nextEnv : `${nextEnv}\n`);
    completed = true;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Egnyte token saved to .env. You can close this tab.");
    console.log("Egnyte token saved to .env");
    if (expiresAt) console.log(`Access token expires at ${expiresAt}`);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`Egnyte token exchange failed: ${e.message}`);
    console.error(`Egnyte token exchange failed: ${e.message}`);
  } finally {
    server.close();
  }
};

const httpsOptions = localHttpsOptions();
const server = httpsOptions
  ? https.createServer(httpsOptions, handleCallback)
  : http.createServer(handleCallback);

server.listen(port, host, () => {
  console.log(`Listening for Egnyte OAuth callback at ${redirectUri}`);
  console.log("Open this URL, complete SSO, and approve access:");
  console.log(authUrl.toString());
});
