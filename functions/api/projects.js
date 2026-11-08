// GET /api/projects
// Every project name used on any of the user's items, alphabetical. Feeds the project picker
// in the item editor. → { projects: ["Client A", "Client B", …] }

import { json, jsonError, methodNotAllowed } from "../_lib/http.js";

export async function onRequest({ request, env, data }) {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (!env.DB) return jsonError(503, "No D1 database is bound as DB (see README).");

  const { results } = await env.DB.prepare(
    `SELECT DISTINCT project FROM items
      WHERE user_id = ? AND project IS NOT NULL AND project <> ''
      ORDER BY project COLLATE NOCASE`
  ).bind(data.userId).all();

  return json(200, { projects: results.map((row) => row.project) });
}
