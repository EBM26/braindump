# Brain Dump App — Revisions Batch 1

Four small features. Build them in order and stop after #3 (it includes a database migration) so I can test and apply the migration before #4. Same stack and conventions as before. Keep `dir="auto"` on all item text.

---

## 1. Cancel a recording without saving

- While recording, show a **Cancel** button next to Stop.
- Cancel stops the recorder, releases the microphone (stop all tracks so the iPhone mic indicator turns off), discards the audio, and returns to the idle record screen. Nothing is uploaded, nothing is saved.
- Ask for confirmation only if the recording is longer than 10 seconds ("Discard this recording?").
- Cancel must also work if the silence/auto-stop or 10-minute cap logic is in play (no upload after cancel).

## 2. Favicon

- Add a simple, original favicon: an SVG favicon (`favicon.svg`) plus a PNG fallback (`favicon.png`, 32×32) and an `apple-touch-icon.png` (180×180) for later home-screen use.
- Design: a minimal mark that matches the app (e.g. the red record circle with a small white center, or a simple speech-bubble shape). Keep it readable at 16×16.
- Link them in `index.html` with the correct `<link>` tags.

## 3. Manually add tasks, ideas, open questions, and notes

### Database change (migration in `migrations/`, the only migrations folder)

Items currently require a `dump_id` and have no creation time of their own. Change the `items` table:

- `dump_id` becomes **nullable** (manual items have no dump). SQLite can't drop NOT NULL in place, so rebuild the table in the migration (create new table, copy data, drop old, rename), keeping the foreign key with ON DELETE CASCADE and all existing indexes.
- Add `created_at TEXT NOT NULL` (ISO 8601 UTC). **Backfill existing rows from their dump's `created_at`.**
- Add `source TEXT NOT NULL DEFAULT 'voice' CHECK (source IN ('voice','manual'))`.
- Add an index on `user_id, created_at`.

Update every query that relied on joining `dumps` to get an item's date to use `items.created_at` instead. **This includes the digest worker** (`digest-worker/`): its "new tasks without a date since the last digest" section must use `items.created_at` so manual items are included.

### API

- `POST /api/items` — create an item: `type`, `text` (required, trimmed, reasonable max length), `project` (optional), `due_date` (tasks only, optional, YYYY-MM-DD). Server sets `user_id`, `created_at`, `source = 'manual'`, and `dump_id = NULL`. Behind the password middleware.

### Frontend

- An **"+ Add"** button on the Tasks tab and on the Notes tab.
- It opens a simple form: text (multi-line), type (defaults to Task on the Tasks tab, Idea on the Notes tab), project (pick from existing projects or type a new one), and due date picker (shown only for tasks).
- After saving, the item appears immediately in the right list. Validation errors shown inline.
- Manual items open and edit exactly like voice items. In views that link an item to its dump, manual items simply have no dump link.

**Stop here. I'll test and apply the migration (local and `--remote`) before #4.**

---

## 4. Select items and copy them

- On the Tasks tab, the Notes tab, and the dump detail view, add a **Select** button that enters selection mode.
- In selection mode, tapping a row selects/deselects it (it must not toggle a task's done checkbox or open the editor). Show a bar with the count, **Select all**, **Copy**, and **Done**.
- **Copy** puts the selected items on the clipboard as plain text, grouped by project then type, in the order shown on screen:

```
VeganKingz
- Finish keyword blog drafts (due Nov 12)
- Issue two press releases

Landmark Construction
- Send updated schema to client

Other
- Idea: brain dump calendar feed
```

  Tasks are plain bullets with due dates if set; other types get a short prefix (`Idea:`, `Question:`, `Note:`). Completed tasks get `(done)`.
- Use `navigator.clipboard.writeText` from the tap handler (iOS requires it to happen directly in the user gesture). Show a brief "Copied" confirmation. If the clipboard API fails, fall back to showing the text in a selectable box.
- Exiting selection mode clears the selection.

---

## Acceptance criteria

- [ ] Cancelling a recording uploads nothing, saves nothing, and turns off the iPhone mic indicator.
- [ ] Favicon shows in desktop Chrome and Safari tabs.
- [ ] After the migration, all existing items still appear with sensible dates; the History view and dumps are unchanged.
- [ ] A manually added task with a due date appears in Tasks, can be edited, checked off, and deleted, and shows up in the morning digest when due.
- [ ] A manually added idea appears in the Notes tab.
- [ ] Selecting several items across projects and copying produces the grouped plain-text format above, pasteable into email or Notes on iPhone.
- [ ] In selection mode, tapping a task never marks it done.
