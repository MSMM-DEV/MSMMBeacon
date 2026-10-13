import { json, methodAllowed, requireBeaconUser } from "../_lib/beacon-api.mjs";
import {
  browseEgnyteFolders,
  DEFAULT_SALES_EGNYTE_PATH,
  EGNYTE_SHARED_ROOT,
  egnyteWebBase,
} from "../_lib/egnyte.mjs";

// GET /api/egnyte/folders
//   ?path=<cloud path>   folder to list (defaults per mode)
//   ?files=1             opt-in: list files too, confined to /Shared
//   ?info=1              no Egnyte call — returns { webBase, defaultPath, root }
//                        so the browser can build "Open in Egnyte" links for
//                        stored items without spending an API call.
// Every mode is sign-in gated; Egnyte tokens never leave the server.
export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  let includeFiles = false;
  try {
    await requireBeaconUser(req);
    const base = `http://${req.headers.host || "localhost"}`;
    const url = new URL(req.url, base);
    if (url.searchParams.get("info") === "1") {
      json(res, 200, {
        webBase: egnyteWebBase(),
        defaultPath: DEFAULT_SALES_EGNYTE_PATH,
        root: EGNYTE_SHARED_ROOT,
      });
      return;
    }
    includeFiles = url.searchParams.get("files") === "1";
    const result = await browseEgnyteFolders({ path: url.searchParams.get("path"), includeFiles });
    json(res, 200, result);
  } catch (error) {
    console.error("[egnyte/folders]", error);
    const rawStatus = Number(error?.status || 0);
    const status = [400, 401, 403, 404, 429, 500, 502].includes(rawStatus) ? rawStatus : 502;
    const noun = includeFiles ? "item" : "folder";
    const message = status === 401
      ? "Sign in again to browse Egnyte folders."
      : error?.code === "EGNYTE_CONFIG" || error?.code === "EGNYTE_PATH"
        ? error.message
        : status === 429
          ? error?.code === "EGNYTE_RATE_LIMIT"
            ? "Egnyte OAuth is rate limited right now. Please wait a few minutes and try again."
            : "Egnyte is limiting requests right now. Wait a few seconds and try again."
        : error?.code === "EGNYTE_AUTH"
          ? "Egnyte rejected the configured credentials. Check the Egnyte OAuth app and service-user environment variables."
          : status === 403
            ? `The configured Egnyte user does not have access to this ${noun}.`
            : status === 404
              ? `That Egnyte ${noun} was not found.`
              : "Egnyte folders could not be loaded.";
    json(res, status, { error: message, code: error?.code || undefined });
  }
}
