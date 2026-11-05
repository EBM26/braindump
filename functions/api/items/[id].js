// PATCH /api/items/:id   body: { "done": true | false }
// Marks a task done (sets done_at, keeping the original time if it was already done)
// or not done (clears done_at). Returns the updated task.

import { json, jsonError, methodNotAllowed, readJsonBody, isUuid } from "../../_lib/http.js";
import { itemFromRow } from "../../_lib/db.js";

export async function onRequest({ request, env, data, params }) {
  if (request.method !== "PATCH") return methodNotAllowed(["PATCH"]);
  if (!isUuid(params.id)) return jsonError(400, "Invalid item id.");
  if (!env.DB) return jsonError(503, "No D1 database is bound as DB (see README).");

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const { done } = body.value;
  if (typeof done !== "boolean") return jsonError(400, 'Body must be { "done": true } or { "done": false }.');

  // Only tasks can be checked off; other item types have no done state in the app.
  const row = await env.DB.prepare(
    `UPDATE items
        SET done = ?,
            done_at = CASE WHEN ? = 1 THEN COALESCE(done_at, ?) ELSE NULL END
      WHERE id = ? AND user_id = ? AND type = 'task'
  RETURNING id, type, text, project, due_text, due_date, done, done_at`
  ).bind(done ? 1 : 0, done ? 1 : 0, new Date().toISOString(), params.id, data.userId).first();

  return row ? json(200, itemFromRow(row)) : jsonError(404, "Task not found.");
}
