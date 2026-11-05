-- Brain Dump schema, v1.
-- Every row carries user_id so multiple users can be added later; for now the
-- server always sets it to "eyal" (see functions/api/_middleware.js).
-- D1 enforces foreign keys by default, so deleting a dump deletes its items (ON DELETE CASCADE).

CREATE TABLE dumps (
  id           TEXT PRIMARY KEY,          -- UUID
  user_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,             -- ISO 8601 UTC, e.g. 2026-11-05T09:12:33.120Z
  transcript   TEXT NOT NULL,
  summary      TEXT,
  model        TEXT,                      -- which Gemini model produced it
  duration_sec INTEGER
);

CREATE TABLE items (
  id        TEXT PRIMARY KEY,             -- UUID
  dump_id   TEXT NOT NULL REFERENCES dumps(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('task', 'idea', 'open_question', 'note')),
  text      TEXT NOT NULL,
  project   TEXT,
  due_text  TEXT,                         -- what was said, e.g. "next Thursday"
  due_date  TEXT,                         -- resolved YYYY-MM-DD, or NULL
  done      INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  done_at   TEXT,
  position  INTEGER NOT NULL              -- order within the dump
);

-- History: a user's dumps, newest first.
CREATE INDEX idx_dumps_user_created ON dumps (user_id, created_at DESC);

-- Tasks view: a user's open (or done) tasks.
CREATE INDEX idx_items_user_type_done ON items (user_id, type, done);

-- Loading one dump's items in order, and the cascade delete from dumps.
CREATE INDEX idx_items_dump_position ON items (dump_id, position);
