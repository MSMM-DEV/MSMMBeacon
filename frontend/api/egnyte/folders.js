import { json, methodAllowed, requireBeaconUser } from "../_lib/beacon-api.mjs";
import { browseEgnyteFolders } from "../_lib/egnyte.mjs";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  try {
    await requireBeaconUser(req);
    const base = `http://${req.headers.host || "localhost"}`;
    const url = new URL(req.url, base);
    const result = await browseEgnyteFolders({ path: url.searchParams.get("path") });
    json(res, 200, result);
  } catch (error) {
    console.error("[egnyte/folders]", error);
    const status = error?.status === 401 ? 401 : error?.status === 403 ? 403 : 502;
    const message = status === 401
      ? "Sign in again to browse Egnyte folders."
      : "Egnyte folders could not be loaded.";
    json(res, status, { error: message });
  }
}
