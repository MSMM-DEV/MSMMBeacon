import {
  json,
  methodAllowed,
  readJsonBody,
  requireBeaconUser,
} from "../_lib/beacon-api.mjs";
import { validateProjectFolderPath } from "../_lib/egnyte.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  try {
    const { supabase } = await requireBeaconUser(req);
    const body = await readJsonBody(req);
    const projectId = String(body.projectId || "").trim();
    if (!UUID_RE.test(projectId)) {
      json(res, 400, { error: "A valid project id is required." });
      return;
    }
    const egnyteFolderPath = validateProjectFolderPath(body.egnyteFolderPath);

    const { data: existing, error: findError } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) {
      json(res, 404, { error: "Project not found." });
      return;
    }

    const { data, error } = await supabase
      .from("projects")
      .update({ egnyte_folder_path: egnyteFolderPath })
      .eq("id", projectId)
      .select("id, egnyte_folder_path")
      .single();
    if (error) throw error;
    json(res, 200, {
      projectId: data.id,
      egnyteFolderPath: data.egnyte_folder_path || null,
    });
  } catch (error) {
    console.error("[projects/egnyte-folder]", error);
    const status = error?.status === 401 ? 401 : 500;
    const message = status === 401
      ? "Sign in again to save the Egnyte folder."
      : error?.message || "The Egnyte folder could not be saved.";
    json(res, status, { error: message });
  }
}
