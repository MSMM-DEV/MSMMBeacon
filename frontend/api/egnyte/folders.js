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
    const rawStatus = Number(error?.status || 0);
    const status = [400, 401, 403, 404, 500, 502].includes(rawStatus) ? rawStatus : 502;
    const message = status === 401
      ? "Sign in again to browse Egnyte folders."
      : error?.code === "EGNYTE_CONFIG"
        ? error.message
        : error?.code === "EGNYTE_AUTH"
          ? "Egnyte rejected the configured credentials. Check the Egnyte OAuth app and service-user environment variables."
          : status === 403
            ? "The configured Egnyte user does not have access to this folder."
            : status === 404
              ? "That Egnyte folder was not found."
              : "Egnyte folders could not be loaded.";
    json(res, status, { error: message });
  }
}
