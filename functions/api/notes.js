// GET /api/notes?type=idea|open_question|note&project=<exact project name>
// Ideas, open questions and notes across all of the user's dumps, newest dump first
// (items keep their spoken order within a dump). Omit `type` for all three.
// → { notes: [{ id, type, text, project, dump_id, dump_created_at }] }

import { json, jsonError, methodNotAllowed } from "../_lib/http.js";
import { itemFromRow } from "../_lib/db.js";

const NOTE_TYPES = ["idea", "open_question", "note"];
const MAX_NOTES = 1000;

export async function onRequest({ request, env, data }) {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (!env.DB) return jsonError(503, "No D1 database is bound as DB (see README).");

  const params = new URL(request.url).searchParams;
  const type = params.get("type");
  if (type && !NOTE_TYPES.includes(type)) return jsonError(400, `type must be one of: ${NOTE_TYPES.join(", ")}.`);

  const types = type ? [type] : NOTE_TYPES;
  const where = ["i.user_id = ?", `i.type IN (${types.map(() => "?").join(", ")})`];
  const binds = [data.userId, ...types];
  const project = params.get("project");
  if (project) {
    where.push("i.project = ?");
    binds.push(project);
  }

  const { results } = await env.DB.prepare(
    `SELECT i.id, i.type, i.text, i.project, i.dump_id, d.created_at AS dump_created_at
       FROM items i
       JOIN dumps d ON d.id = i.dump_id AND d.user_id = i.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY d.created_at DESC, d.id DESC, i.position
      LIMIT ?`
  ).bind(...binds, MAX_NOTES).all();

  return json(200, {
    notes: results.map((row) => ({ ...itemFromRow(row), dump_id: row.dump_id, dump_created_at: row.dump_created_at })),
  });
}
