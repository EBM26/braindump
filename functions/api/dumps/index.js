// GET /api/dumps?limit=20&cursor=<next_cursor>
// The user's dumps, newest first, with item counts per type.
// → { dumps: [{ id, created_at, summary, model, duration_sec, counts: { tasks, ideas, open_questions, notes } }],
//     next_cursor: string | null }   (pass next_cursor back as ?cursor= to get the next page)

import { json, jsonError, methodNotAllowed, isUuid } from "../../_lib/http.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function onRequest({ request, env, data }) {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (!env.DB) return jsonError(503, "No D1 database is bound as DB (see README).");

  const params = new URL(request.url).searchParams;

  let limit = DEFAULT_LIMIT;
  if (params.has("limit")) {
    limit = Number(params.get("limit"));
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return jsonError(400, `limit must be a whole number from 1 to ${MAX_LIMIT}.`);
    }
  }

  let cursor = null;
  if (params.has("cursor")) {
    cursor = decodeCursor(params.get("cursor"));
    if (!cursor) return jsonError(400, "Invalid cursor. Use the next_cursor value from the previous page.");
  }

  // Keyset pagination on (created_at, id): stable even when new dumps are added meanwhile.
  const where = ["d.user_id = ?"];
  const binds = [data.userId];
  if (cursor) {
    where.push("(d.created_at < ? OR (d.created_at = ? AND d.id < ?))");
    binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const { results } = await env.DB.prepare(
    `SELECT d.id, d.created_at, d.summary, d.model, d.duration_sec,
            COUNT(CASE WHEN i.type = 'task' THEN 1 END)          AS tasks,
            COUNT(CASE WHEN i.type = 'idea' THEN 1 END)          AS ideas,
            COUNT(CASE WHEN i.type = 'open_question' THEN 1 END) AS open_questions,
            COUNT(CASE WHEN i.type = 'note' THEN 1 END)          AS notes
       FROM dumps d
       LEFT JOIN items i ON i.dump_id = d.id AND i.user_id = d.user_id
      WHERE ${where.join(" AND ")}
      GROUP BY d.id
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ?`
  ).bind(...binds, limit + 1).all();

  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return json(200, {
    dumps: page.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      summary: row.summary,
      model: row.model,
      duration_sec: row.duration_sec,
      counts: { tasks: row.tasks, ideas: row.ideas, open_questions: row.open_questions, notes: row.notes },
    })),
    next_cursor: results.length > limit ? encodeCursor(last.created_at, last.id) : null,
  });
}

// The cursor is just "<created_at>|<id>" in URL-safe base64.
function encodeCursor(createdAt, id) {
  return btoa(`${createdAt}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(value) {
  try {
    const [createdAt, id] = atob(value.replace(/-/g, "+").replace(/_/g, "/")).split("|");
    if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(createdAt) || !isUuid(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
