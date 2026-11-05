# Brain Dump App — Phase 2: Reliability, Password, and Saving

Phase 1 is deployed on Cloudflare Pages and working (Chrome, iPhone Safari, Hebrew, 3-minute recordings). Phase 2 has three parts. **Build them in order (A, then B, then C) and stop after each part so I can test and push before the next one.**

Keep the existing stack and conventions from Phase 1: plain HTML/CSS/vanilla JS, Cloudflare Pages Functions, Gemini REST via `fetch`, no frameworks, no new npm dependencies besides `wrangler`.

---

## Part A — Handle Gemini overload (503 / 429)

Gemini often returns HTTP 503 ("model is experiencing high demand"). Make this mostly invisible to me.

- In the function, when Gemini returns 503 or 429, retry automatically up to 3 times with backoff of about 2s, 5s, 10s.
- **Encode the audio to base64 once** and reuse it across all retries (re-encoding wastes CPU, and the free plan's CPU limit is tight).
- If all retries fail, try once with a fallback model from env var `GEMINI_FALLBACK_MODEL`. Default it to a current Flash-Lite model that supports audio input and is on the free tier. **Check the Gemini docs for the current model name.**
- Only after the fallback also fails, return the error to the frontend.
- The frontend shows "Gemini is busy, retrying…" while this happens. Simplest approach: show it if the request has been pending more than ~8 seconds.
- Record which model actually produced the result and return it in the response (`model` field), so I can see when the fallback was used.
- Don't retry on other errors (400, 401, 403): those won't fix themselves.

**Stop here. I'll test and push.**

---

## Part B — Password gate

The app URL is public. Before saving any data, require a password.

- New secret env var `APP_PASSWORD` (set in Cloudflare and in `.dev.vars`).
- **Every `/api/*` request** must include the password in a header (`Authorization: Bearer <password>`). The functions check it before doing anything else and return 401 if it's missing or wrong. Use a constant-time comparison (`crypto.subtle.timingSafeEqual` is available in Workers).
- Put the check in one shared place (Pages Functions middleware, `functions/api/_middleware.js`) so new endpoints are protected automatically.
- If `APP_PASSWORD` isn't set, the API must refuse all requests (fail closed), never allow them.
- Frontend: on first load, if no password is stored, show a simple password screen. On submit, verify it with a lightweight API call; if valid, store it in `localStorage` so I'm not asked again on that device. On any 401, clear the stored password and show the password screen again.
- Add a small "Log out" link that clears the stored password.
- Update the README with how to set `APP_PASSWORD` in Cloudflare (it must be a Secret) and redeploy.

**Stop here. I'll test and push.**

---

## Part C — Saving with D1, plus Tasks and History views

### Setup

- Create a D1 database named `braindump`. Bind it to the Pages project as `DB`.
- Use a Wrangler config file for Pages (`pages_build_output_dir = "public"` plus the D1 binding) so local dev and production use the same setup. Local dev should use a local D1 database.
- Use D1 migrations (`migrations/` folder, `wrangler d1 migrations`) for the schema, and document in the README how to apply them locally and to production.
- Document in the README any dashboard steps I need to do myself.

### Schema

Design for possible multiple users later, even though I'm the only user now: **every row has a `user_id`**. For now it's always the constant `"eyal"` set on the server (not sent by the browser).

```
dumps
  id              TEXT PRIMARY KEY   -- UUID
  user_id         TEXT NOT NULL
  created_at      TEXT NOT NULL      -- ISO 8601 UTC
  transcript      TEXT NOT NULL
  summary         TEXT
  model           TEXT               -- which Gemini model produced it
  duration_sec    INTEGER

items
  id              TEXT PRIMARY KEY   -- UUID
  dump_id         TEXT NOT NULL REFERENCES dumps(id) ON DELETE CASCADE
  user_id         TEXT NOT NULL
  type            TEXT NOT NULL CHECK (type IN ('task','idea','open_question','note'))
  text            TEXT NOT NULL
  project         TEXT
  due_text        TEXT               -- what I said, e.g. "next Thursday"
  due_date        TEXT               -- resolved date YYYY-MM-DD, or NULL
  done            INTEGER NOT NULL DEFAULT 0
  done_at         TEXT
  position        INTEGER NOT NULL   -- order within the dump
```

Add indexes for listing dumps by `user_id, created_at` and open tasks by `user_id, type, done`. Make sure foreign keys are enforced so deleting a dump deletes its items.

### Resolving relative due dates

- The function passes today's date **in my time zone (Asia/Jerusalem)** to Gemini along with the prompt.
- Update the response schema: tasks get `due_text` (my exact wording) and `due_date` (YYYY-MM-DD, or null if it can't be resolved confidently, like "soon" or "one month-ish").
- Add a prompt rule: resolve relative dates ("tomorrow", "next Thursday", "in two weeks") against today's date; never invent a date for vague timing.

### Prompt structure for future users

Restructure `functions/prompt.js` so the generic instructions are separate from **my personal context** (the client/project list and nicknames, and any personal rules). For example, export a `USER_CONTEXT` object keyed by `user_id` and build the final prompt from instructions + that user's context. Behavior stays identical for me; this just makes per-user context possible later.

### API endpoints (all behind the Part B password check)

- `POST /api/dump` — as now, but after Gemini succeeds, save the dump and its items in a single D1 batch, and return the saved dump with item IDs.
  - If Gemini succeeds but saving fails, still return the organized result with `saved: false` and an error message, so the frontend shows the result with a "Not saved" warning (Copy all still works).
- `GET /api/dumps` — list my dumps, newest first, with pagination (`limit` + cursor). Return id, created_at, summary, and item counts per type.
- `GET /api/dumps/:id` — one dump with transcript and all items.
- `DELETE /api/dumps/:id` — delete a dump and its items.
- `GET /api/tasks?status=open|done|all&project=…` — tasks across all dumps, default `open`.
- `PATCH /api/items/:id` — set `done` true/false (set or clear `done_at`).

Every query filters by `user_id`, so one user can never see another's data later. Validate IDs and inputs; return clear JSON errors.

### Frontend

Three views, switched by a simple bottom tab bar (mobile-first):

1. **Record** — as now. After processing, show the result plus a small "Saved" confirmation (or the "Not saved" warning).
2. **Tasks** — all open tasks across every dump, grouped by project (tasks with no project in an "Other" group at the end). Each task has a checkbox; checking it marks it done (update the UI immediately, revert if the request fails). Show the due date if present, highlighting overdue ones. A toggle to show completed tasks.
3. **History** — dumps newest first: date/time, summary, and counts ("3 tasks · 1 idea"). Tap to open the full dump (all sections + collapsible transcript) with a Delete button that asks for confirmation. Load more as I scroll or with a "Load more" button.

Keep `dir="auto"` on every element that displays transcript or item text, so Hebrew renders correctly.

### Acceptance criteria

- [ ] A 503 from Gemini is retried automatically; the fallback model is used if retries fail; the UI shows "retrying" while waiting.
- [ ] Without the password, every `/api/*` request returns 401. With it, everything works. The password is remembered on my phone after entering it once.
- [ ] If `APP_PASSWORD` is unset, the API refuses requests.
- [ ] Every dump is saved; it appears in History immediately after recording.
- [ ] Tasks view shows open tasks from all dumps, grouped by project; checking one off persists after reload.
- [ ] "Remind me tomorrow" produces a `due_date` of tomorrow's date (Israel time); "sometime soon" produces `due_date: null`.
- [ ] Deleting a dump removes it and its tasks.
- [ ] Everything works on iPhone Safari and desktop Chrome; Hebrew displays right-to-left.
- [ ] Local dev works with a local D1 database; README covers migrations for local and production.

## Out of scope for Phase 2

User accounts/sign-up, editing item text, search, integrations, PWA/home-screen install (Phase 3). Don't build these.
