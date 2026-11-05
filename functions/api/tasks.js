// GET /api/tasks?status=open|done|all&project=<exact project name>
// Tasks across all of the user's dumps. status defaults to "open".
// Order: tasks with a due date first (soonest first), then newest dump first.
// → { tasks: [{ id, text, project, due_text, due_date, done, done_at, dump_id, dump_created_at }], today }
//   `today` is today's date in the user's time zone (YYYY-MM-DD), for highlighting overdue tasks.

import { json, jsonError, methodNotAllowed } from "../_lib/http.js";
import { itemFromRow } from "../_lib/db.js";
import { todayIn, USER_CONTEXT } from "../prompt.js";

const STATUSES = { open: 0, done: 1, all: null };
const MAX_TASKS = 1000;

export async function onRequest({ request, env, data }) {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  if (!env.DB) return jsonError(503, "No D1 database is bound as DB (see README).");

  const params = new URL(request.url).searchParams;
  const status = params.get("status") || "open";
  if (!(status in STATUSES)) return jsonError(400, 'status must be "open", "done" or "all".');

  const where = ["i.user_id = ?", "i.type = 'task'"];
  const binds = [data.userId];
  if (STATUSES[status] !== null) {
    where.push("i.done = ?");
    binds.push(STATUSES[status]);
  }
  const project = params.get("project");
  if (project) {
    where.push("i.project = ?");
    binds.push(project);
  }

  const { results } = await env.DB.prepare(
    `SELECT i.id, i.type, i.text, i.project, i.due_text, i.due_date, i.done, i.done_at,
            i.dump_id, d.created_at AS dump_created_at
       FROM items i
       JOIN dumps d ON d.id = i.dump_id AND d.user_id = i.user_id
      WHERE ${where.join(" AND ")}
      ORDER BY i.due_date IS NULL, i.due_date, d.created_at DESC, i.position
      LIMIT ?`
  ).bind(...binds, MAX_TASKS).all();

  const timeZone = (USER_CONTEXT[data.userId] || {}).timeZone || "UTC";
  return json(200, {
    tasks: results.map((row) => ({
      ...itemFromRow(row),
      dump_id: row.dump_id,
      dump_created_at: row.dump_created_at,
    })),
    today: todayIn(timeZone).date,
  });
}
