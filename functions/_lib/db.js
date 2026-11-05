// D1 helpers shared by the API functions. Every query is scoped by user_id.
// (No onRequest export, so this is not a route.)

// Response section key ↔ items.type value.
export const SECTIONS = [
  { key: "tasks", type: "task" },
  { key: "ideas", type: "idea" },
  { key: "open_questions", type: "open_question" },
  { key: "notes", type: "note" },
];

const emptySections = () => Object.fromEntries(SECTIONS.map((s) => [s.key, []]));
const keyForType = Object.fromEntries(SECTIONS.map((s) => [s.type, s.key]));

/** An items row → the shape the API returns. */
export function itemFromRow(row) {
  const item = { id: row.id, type: row.type, text: row.text, project: row.project };
  if (row.type === "task") {
    item.due_text = row.due_text;
    item.due_date = row.due_date;
    item.done = row.done === 1;
    item.done_at = row.done_at;
  }
  return item;
}

function dumpFromRow(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    transcript: row.transcript,
    summary: row.summary,
    model: row.model,
    duration_sec: row.duration_sec,
  };
}

/**
 * Saves an organized result (validated Gemini output) as one dump + its items,
 * in a single D1 batch (one transaction: all rows are written or none).
 * Returns the saved dump in the same shape as GET /api/dumps/:id.
 */
export async function saveDump(db, userId, organized, { model, durationSec }) {
  const dump = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    transcript: organized.transcript,
    summary: organized.summary || null,
    model,
    duration_sec: durationSec,
  };

  const statements = [
    db.prepare(
      "INSERT INTO dumps (id, user_id, created_at, transcript, summary, model, duration_sec) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(dump.id, userId, dump.created_at, dump.transcript, dump.summary, dump.model, dump.duration_sec),
  ];

  const insertItem = db.prepare(
    "INSERT INTO items (id, dump_id, user_id, type, text, project, due_text, due_date, done, done_at, position) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)"
  );
  const sections = emptySections();
  let position = 0;
  for (const { key, type } of SECTIONS) {
    for (const item of organized[key]) {
      const row = {
        id: crypto.randomUUID(),
        type,
        text: item.text,
        project: item.project ?? null,
        due_text: type === "task" ? item.due_text ?? null : null,
        due_date: type === "task" ? item.due_date ?? null : null,
        done: 0,
        done_at: null,
      };
      statements.push(insertItem.bind(row.id, dump.id, userId, type, row.text, row.project, row.due_text, row.due_date, position++));
      sections[key].push(itemFromRow(row));
    }
  }

  await db.batch(statements);
  return { ...dump, ...sections };
}

/** One dump with all its items, or null if it doesn't exist for this user. */
export async function loadDump(db, userId, dumpId) {
  const [dumpRes, itemsRes] = await db.batch([
    db.prepare(
      "SELECT id, created_at, transcript, summary, model, duration_sec FROM dumps WHERE id = ? AND user_id = ?"
    ).bind(dumpId, userId),
    db.prepare(
      "SELECT id, type, text, project, due_text, due_date, done, done_at FROM items " +
      "WHERE dump_id = ? AND user_id = ? ORDER BY position"
    ).bind(dumpId, userId),
  ]);
  const row = dumpRes.results[0];
  if (!row) return null;

  const sections = emptySections();
  for (const itemRow of itemsRes.results) sections[keyForType[itemRow.type]].push(itemFromRow(itemRow));
  return { ...dumpFromRow(row), ...sections };
}
