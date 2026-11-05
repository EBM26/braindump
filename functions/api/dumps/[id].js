// GET    /api/dumps/:id → the dump with its transcript and all items, grouped by type
// DELETE /api/dumps/:id → deletes the dump; its items go with it (ON DELETE CASCADE)

import { json, jsonError, methodNotAllowed, isUuid } from "../../_lib/http.js";
import { loadDump } from "../../_lib/db.js";

export async function onRequest({ request, env, data, params }) {
  if (request.method !== "GET" && request.method !== "DELETE") return methodNotAllowed(["GET", "DELETE"]);
  if (!isUuid(params.id)) return jsonError(400, "Invalid dump id.");
  if (!env.DB) return jsonError(503, "No D1 database is bound as DB (see README).");

  if (request.method === "GET") {
    const dump = await loadDump(env.DB, data.userId, params.id);
    return dump ? json(200, dump) : jsonError(404, "Dump not found.");
  }

  const { meta } = await env.DB.prepare("DELETE FROM dumps WHERE id = ? AND user_id = ?")
    .bind(params.id, data.userId)
    .run();
  return meta.changes > 0 ? json(200, { deleted: true, id: params.id }) : jsonError(404, "Dump not found.");
}
