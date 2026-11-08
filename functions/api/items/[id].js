// PATCH  /api/items/:id   body: any of { text, project, type, due_date, done }
// DELETE /api/items/:id
//
// PATCH fields (send only what changes):
//   text      non-empty string (trimmed)
//   project   string, or null / "" for no project
//   type      "task" | "idea" | "open_question" | "note"
//             Changing a task to another type clears its due date and done state.
//   due_date  "YYYY-MM-DD" or null (tasks only). Setting it clears due_text, since the
//             spoken wording no longer describes the date.
//   done      true | false (tasks only). Marking done keeps the original done_at if it was already done.
// Returns the updated item (with dump_id).

import { json, jsonError, methodNotAllowed, readJsonBody, isUuid, isCalendarDate } from "../../_lib/http.js";
import { itemFromRow, SECTIONS } from "../../_lib/db.js";

const TYPES = new Set(SECTIONS.map((s) => s.type));
const FIELDS = ["text", "project", "type", "due_date", "done"];
const MAX_TEXT = 5000;
const MAX_PROJECT = 100;

export async function onRequest({ request, env, data, params }) {
  if (request.method !== "PATCH" && request.method !== "DELETE") return methodNotAllowed(["PATCH", "DELETE"]);
  if (!isUuid(params.id)) return jsonError(400, "Invalid item id.");
  if (!env.DB) return jsonError(503, "No D1 database is bound as DB (see README).");

  if (request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM items WHERE id = ? AND user_id = ?")
      .bind(params.id, data.userId).run();
    return result.meta.changes ? json(200, { deleted: true, id: params.id }) : jsonError(404, "Item not found.");
  }

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parsePatch(body.value);
  if (parsed.error) return jsonError(400, parsed.error);
  const patch = parsed.value;

  const current = await env.DB.prepare("SELECT type FROM items WHERE id = ? AND user_id = ?")
    .bind(params.id, data.userId).first();
  if (!current) return jsonError(404, "Item not found.");

  const finalType = patch.type ?? current.type;
  if ("done" in patch && finalType !== "task") return jsonError(400, "Only tasks can be marked done.");
  if ("due_date" in patch && finalType !== "task") return jsonError(400, "Only tasks have a due date.");

  const sets = [];
  const binds = [];
  const set = (sql, ...values) => { sets.push(sql); binds.push(...values); };

  if ("text" in patch) set("text = ?", patch.text);
  if ("project" in patch) set("project = ?", patch.project);
  if ("type" in patch) {
    set("type = ?", patch.type);
    // Due dates and done state only exist for tasks.
    if (current.type === "task" && finalType !== "task") {
      set("due_text = NULL");
      set("due_date = NULL");
      set("done = 0");
      set("done_at = NULL");
    }
  }
  if ("due_date" in patch) {
    set("due_date = ?", patch.due_date);
    set("due_text = NULL");
  }
  if ("done" in patch) {
    const done = patch.done ? 1 : 0;
    set("done = ?", done);
    set("done_at = CASE WHEN ? = 1 THEN COALESCE(done_at, ?) ELSE NULL END", done, new Date().toISOString());
  }

  const row = await env.DB.prepare(
    `UPDATE items SET ${sets.join(", ")}
      WHERE id = ? AND user_id = ?
  RETURNING id, dump_id, type, text, project, due_text, due_date, done, done_at`
  ).bind(...binds, params.id, data.userId).first();

  if (!row) return jsonError(404, "Item not found."); // deleted in the meantime
  return json(200, { ...itemFromRow(row), dump_id: row.dump_id });
}

/** Validates a PATCH body. Returns { value } (only the fields sent, normalized) or { error }. */
function parsePatch(input) {
  const keys = Object.keys(input);
  const unknown = keys.filter((k) => !FIELDS.includes(k));
  if (unknown.length) return { error: `Unknown field(s): ${unknown.join(", ")}. Allowed: ${FIELDS.join(", ")}.` };
  if (!keys.length) return { error: `Send at least one of: ${FIELDS.join(", ")}.` };

  const value = {};
  if ("text" in input) {
    if (typeof input.text !== "string" || !input.text.trim()) return { error: "text must be a non-empty string." };
    if (input.text.trim().length > MAX_TEXT) return { error: `text is too long (max ${MAX_TEXT} characters).` };
    value.text = input.text.trim();
  }
  if ("project" in input) {
    if (input.project !== null && typeof input.project !== "string") return { error: "project must be a string or null." };
    const project = input.project === null ? "" : input.project.trim();
    if (project.length > MAX_PROJECT) return { error: `project is too long (max ${MAX_PROJECT} characters).` };
    value.project = project || null;
  }
  if ("type" in input) {
    if (!TYPES.has(input.type)) return { error: `type must be one of: ${[...TYPES].join(", ")}.` };
    value.type = input.type;
  }
  if ("due_date" in input) {
    if (input.due_date !== null && !isCalendarDate(input.due_date)) {
      return { error: "due_date must be a date like 2026-11-12, or null." };
    }
    value.due_date = input.due_date;
  }
  if ("done" in input) {
    if (typeof input.done !== "boolean") return { error: "done must be true or false." };
    value.done = input.done;
  }
  return { value };
}
