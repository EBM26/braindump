# Brain Dump

Tap record, talk, tap stop. The audio goes to Gemini, which transcribes it and sorts it into a summary, tasks, ideas, open questions and notes, tagged by project. Every dump is saved to a Cloudflare D1 database. The **Tasks** tab collects open tasks from all dumps, **Notes** collects ideas, open questions and notes, and **History** lists past dumps. Tap any item in Tasks, Notes or a past dump to edit or delete it.

> **The API is password-protected.** Every `/api/*` request needs `APP_PASSWORD` (see [Setting the app password](#setting-the-app-password)). If `APP_PASSWORD` isn't set, the API refuses every request, so the app won't work until you set it.

## How it works

```
public/                 static frontend (no build step)
  index.html            Record / Tasks / Notes / History views, bottom tab bar, item editor dialog
  app.js                recording, upload, rendering, Tasks, Notes, History, item editor, password screen
  style.css             light/dark via prefers-color-scheme
functions/
  api/_middleware.js    password check for every /api/* route (runs first); sets the user id
  api/auth.js           GET    /api/auth           → { ok: true } (login screen's password check)
  api/dump.js           POST   /api/dump           → Gemini → validated JSON → saved to D1
  api/dumps/index.js    GET    /api/dumps          → dumps, newest first (limit + cursor)
  api/dumps/[id].js     GET    /api/dumps/:id      → one dump with transcript + items
                        DELETE /api/dumps/:id      → deletes the dump and its items
  api/tasks.js          GET    /api/tasks?status=open|done|all&project=…
  api/notes.js          GET    /api/notes?type=idea|open_question|note&project=…  (newest first)
  api/projects.js       GET    /api/projects       → every project name in use (for the editor's picker)
  api/items/[id].js     PATCH  /api/items/:id      any of { text, project, type, due_date, done }
                        DELETE /api/items/:id      → deletes one item
  _lib/http.js, db.js   shared helpers (not routes)
  prompt.js             the organizing prompt: generic instructions + your personal context
migrations/
  0001_init.sql         D1 schema (dumps, items, indexes)
wrangler.jsonc          Pages config: output dir, compatibility date, D1 binding
.dev.vars               local secrets (git-ignored)
```

- **Audio formats.** The browser records in the first format it supports that Gemini also accepts: WebM/Opus (Chrome, Firefox), Ogg, then MP4/AAC (Safari/iOS, sent to Gemini as `audio/m4a`). If none of those work, the browser's own recording is converted to 16 kHz mono WAV before upload. The upload is the raw audio, with its MIME type in the `Content-Type` header. Yes
- **Size limit.** Gemini accepts up to 20 MB per request with inline audio, and that limit counts the audio after base64 encoding. So `/api/dump` rejects audio over about 15 MB with a clear message. A 10-minute recording at the 64 kbps the app uses is about 5 MB. The WAV fallback is much bigger (about 1.9 MB per minute), so it can only take about 7½ minutes.
- **Model.** The default is `gemini-3.6-flash`, the current stable Flash model with audio input and a free tier. Set `GEMINI_MODEL` to switch models without changing code.
- **When Gemini is busy.** If Gemini answers 429 (rate limit) or 503 (overloaded), the function retries up to 3 times, waiting about 2 s, 5 s, then 10 s. It encodes the audio once and reuses it for every try. If all 4 tries are busy, it tries once with `GEMINI_FALLBACK_MODEL` (default `gemini-3.5-flash-lite`, the current stable Flash-Lite with audio input). Only then does the page show an error. Other errors fail immediately. While this happens the page shows "Gemini is busy, retrying…". To make that possible, `/api/dump` streams status events (`text/event-stream`) once the audio has passed the input checks; bad input still gets a plain JSON error.
- **Password.** `functions/api/_middleware.js` runs before every `/api/*` handler, so any endpoint added under `functions/api/` is protected automatically. It expects `Authorization: Bearer <APP_PASSWORD>` and returns 401 if the password is missing or wrong. The comparison takes the same time whether the guess is close or not, so timing can't leak the password. If `APP_PASSWORD` isn't set, it returns 503 for everything. The page shows a password screen the first time, then remembers the password on that device in `localStorage`. **Log out** (top right) forgets it, and any 401 clears it and shows the password screen again. If a recording was waiting when that happened, it's sent automatically after you log back in. The password must be plain ASCII (English letters, digits, standard symbols), because HTTP headers can't carry Hebrew letters or emoji.
- **Saving.** After Gemini succeeds, `/api/dump` writes the dump and all its items to D1 in one batch, which is one transaction: either everything is saved or nothing is. The result then shows **✓ Saved**. If Gemini succeeded but saving failed, you still get the result, with a **Not saved** warning and the reason, and **Copy all** still works.
- **Data model.** Every row has a `user_id`. For now the server always sets it to `"eyal"` (in `_middleware.js`, never from the browser), and every query filters by it, so more users can be added later without one seeing another's data. Deleting a dump deletes its items, because D1 enforces foreign keys and `items.dump_id` uses `ON DELETE CASCADE`.
- **Due dates.** Today's date in Israel time (Asia/Jerusalem) is sent to Gemini with the prompt. Each task gets `due_text` (your exact words, like "מחר" or "next Thursday") and `due_date` (`YYYY-MM-DD`). `due_date` is filled only when the wording points to one specific day. Vague timing ("soon", "next week") gives `due_date: null`. The server also drops any `due_date` that isn't a real calendar date, or that comes without any spoken wording. "Thursday" and "next Thursday" both mean the first Thursday after today.
- **Editing items.** Tap an item in Tasks, Notes or a past dump (in History) to change its text, project (pick one already in use, or **New project…**), type, and for tasks the due date. Results on the Record screen aren't editable; open the dump from History to edit it. Picking a due date sets `due_date` and clears `due_text`, since your spoken words no longer describe it. **Clear** removes both. Changing a task to another type drops its due date and done state; changing an item to a task moves it between the Tasks and Notes tabs. **Delete item** asks for confirmation first. `PATCH /api/items/:id` takes only the fields that changed, validates each one (text not empty, type one of the four, a real calendar date, done and due date for tasks only), and rejects unknown fields. Like every query, it filters by `user_id`, so another user's item returns 404.
- **Hebrew.** Every element that shows transcript, summary or item text has `dir="auto"`, so Hebrew displays right-to-left and English left-to-right, even when mixed in one list.
- **API key.** Only the Pages Function reads `GEMINI_API_KEY`. The function sends it to Gemini in the `x-goog-api-key` header and never in a URL. Error messages are scrubbed in case they contain the key.

## Local development

Requires Node.js 22+.

```sh
npm install
# put your real key and a password in .dev.vars:
#   GEMINI_API_KEY=...
#   APP_PASSWORD=...
npm run db:migrate:local   # creates the tables in a local D1 database (first time, and after new migrations)
npm run dev                # = wrangler pages dev (reads wrangler.jsonc)
```

Open http://localhost:8788.

Local dev uses a **local** D1 database, stored in `.wrangler/state` (git-ignored). It never touches production data. To start fresh, stop the dev server, delete `.wrangler/state`, and run `npm run db:migrate:local` again. To look inside:

```sh
npx wrangler d1 execute braindump --local --command "SELECT created_at, summary FROM dumps ORDER BY created_at DESC LIMIT 5"
```

The microphone only works over **HTTPS or on `localhost`**. Opening the dev server from your phone at `http://<your-LAN-IP>:8788` won't be able to record, so test on the phone with the deployed version.

Get a key at https://aistudio.google.com/apikey.

## Tuning the prompt

Edit `functions/prompt.js`. Restart `npm run dev`, or push to redeploy.

- **Your personal context** is `USER_CONTEXT.eyal`: who you are, your time zone, your clients/projects and their nicknames, and any personal rules (one per line, starting with `- `). This is the part you'll edit most.
- **The generic instructions**, the same for any future user, are in `buildPrompt()`.

## Database migrations

The schema lives in `migrations/` as numbered `.sql` files. Wrangler records which ones have been applied (in a `d1_migrations` table), so `apply` only runs new ones.

| What | Command |
|---|---|
| Apply to your **local** dev database | `npm run db:migrate:local` |
| Apply to the **production** database | `npm run db:migrate:remote` (needs `npx wrangler login` once) |
| Add a new migration later | `npx wrangler d1 migrations create braindump <short_name>`, then edit the new file |
| See what's not applied yet | `npx wrangler d1 migrations list braindump --local` (or `--remote`) |

Apply new migrations to production **before** pushing code that needs them. Never edit a migration that has already been applied; add a new one instead.

## Deployment

### 1. Push to GitHub

```sh
git init
git add .
git status          # confirm .dev.vars is NOT listed
git commit -m "Brain Dump phase 1"
git branch -M main
git remote add origin git@github.com:<you>/brain-dump.git
git push -u origin main
```

Make the repo **private** if you'd rather not publish your prompt and client list.

### 2. Create the D1 database (once)

```sh
npx wrangler login                      # opens the browser; sign in to Cloudflare
npx wrangler d1 create braindump        # prints a database_id
```

1. Copy the printed `database_id` into `wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`.
2. Check that `"name"` in `wrangler.jsonc` matches your Pages project name exactly (it's `brain-dump` in the file now; change it if your project is called something else).
3. Create the tables in production: `npm run db:migrate:remote`
4. Commit and push `wrangler.jsonc`.

Cloudflare reads the D1 binding (`DB`) from `wrangler.jsonc` on every deploy, so you **don't** add the binding in the dashboard.

### 3. Create the Cloudflare Pages project (skip if it already exists)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Pick the repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `public`
4. **Save and Deploy.** Cloudflare picks up the `functions/` folder and `wrangler.jsonc` automatically.

### 4. Add the secrets

Pages project → **Settings** → **Variables and Secrets** → **Add**:

| Name             | Type       | Value                                     |
|------------------|------------|-------------------------------------------|
| `GEMINI_API_KEY` | **Secret** | your Gemini key                           |
| `APP_PASSWORD`   | **Secret** | the app password (see below)              |

Add them to **Production** (and to Preview if you use preview deploys). Then **redeploy**, because variables only apply to new deployments: **Deployments** → latest → **⋯** → **Retry deployment**.

**Since `wrangler.jsonc` was added:** Cloudflare treats the file as the source of truth, and its settings become read-only in the dashboard.
- **Models:** set the optional `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` in the file's `"vars"` block (there's a commented example), not in the dashboard. If you had set them as dashboard Text variables, they may stop applying; the code then falls back to the defaults.
- **Secrets:** these aren't in the file and should stay where they are. After the first deploy with the file, check that **Settings → Variables and Secrets** still lists `GEMINI_API_KEY` and `APP_PASSWORD`. If either is missing, add it again, as a Secret, with `npx wrangler pages secret put APP_PASSWORD --project-name <project>`, or in the dashboard, then redeploy.

#### Setting the app password

1. Choose a long password: 16+ characters, English letters, digits and symbols only (no Hebrew or emoji; see "Password" above). A password manager's generator is ideal. You type it once per device.
2. Cloudflare dashboard → **Workers & Pages** → your project → **Settings** → **Variables and Secrets** → **Add**.
3. **Type: Secret** (not Text). A Secret is encrypted and hidden after saving, while a Text variable stays readable in the dashboard.
   **Name:** `APP_PASSWORD`. **Value:** your password. Save it for **Production**, and for **Preview** too if you use preview deploys.
4. **Redeploy** so the new value takes effect: **Deployments** → latest → **⋯** → **Retry deployment**. Until you do, the running deployment keeps the old value, or refuses every request if there was none.
5. Check it: open the site, enter the password, and record something. `curl -i https://<project>.pages.dev/api/auth` should return **401**.

To change the password, edit the Secret, redeploy, and enter the new one on each device. The old one now gets a 401, so the app asks again.

For local dev, add `APP_PASSWORD=...` to `.dev.vars` and restart `npm run dev`.

### 5. Optional: an extra layer with Cloudflare Access

The password gate above is enough on its own. If you also want an email login in front of the whole site, Cloudflare Access does that. It's free for up to 50 users.

**a. Turn on email one-time PIN login (first time only)**

1. Cloudflare dashboard → **Zero Trust**. If asked, pick a team name and the **Free** plan.
2. **Integrations** → **Identity providers** → **Add new identity provider** → **One-time PIN**.

**b. Protect the preview *and* production `*.pages.dev` URLs**

Pages' built-in toggle only covers preview deployments at first, so it takes a few extra steps:

1. **Workers & Pages** → your project → **Settings** → **General** → **Enable access policy**.
   This creates an Access application for `*.<project>.pages.dev` (preview deployments).
2. Select **Manage** on that new policy. This opens Zero Trust → **Access controls** → **Applications**.
3. Select your project's application → **Configure**.
4. Under **Public hostname**, clear the `*` from the **Subdomain** field, so the hostname is just `<project>.pages.dev`. Then **Save**. If you get a name-conflict error, change the **Application name** (for example, add "prod").
5. Go back to the Pages project → **Settings** → **General** → select **Enable access policy** again. This creates a second application for the `*.` preview URLs.
6. In Zero Trust → **Access controls** → **Applications** you should now see **two** applications: `<project>.pages.dev` and `*.<project>.pages.dev`.

**c. Restrict both to your email only**

For **each** of the two applications: **Configure** → **Policies**. Edit the policy, or add one, so it reads:

- **Action:** Allow
- **Include** → Selector **Emails** → value `you@example.com` (your own email address)
- Remove any other Include rules, such as "Emails ending in" or an Everyone rule.

Under **Login methods** / authentication, make sure **One-time PIN** is enabled. **Save.**

**d. Check that it worked**

1. Open `https://<project>.pages.dev` in a **private window**. You should see a Cloudflare Access login page, not the app.
2. Enter a different email address. It must **not** receive a code or get in.
3. Enter your email. You should get a code by email, and once you enter it the app loads.
4. Run `curl -i -X POST https://<project>.pages.dev/api/dump`. It should return a redirect or 403 from Access, not a JSON error from the app.

If you add a **custom domain** later, protect it too: Zero Trust → **Access controls** → **Applications** → **Create new application** → **Self-hosted** → add the custom hostname, with the same Allow-your-email policy.

## Acceptance checklist

- [ ] Record on desktop Chrome and on iPhone Safari (deployed URL); both produce a result
- [ ] 2-minute ramble → sensible summary/tasks/ideas, correct project tags
- [ ] Nickname ("the sugaring site") → "Soft & Sweet Sugaring"
- [ ] Nothing invented: no extra tasks or due dates
- [ ] Turn off Wi-Fi / use a bad key → readable error; **Retry** works without re-recording
- [ ] Without the password every `/api/*` request returns 401; with it everything works; the phone remembers it after the first time
- [ ] With `APP_PASSWORD` unset, the API refuses every request (503)
- [ ] Key not in repo (`git grep -i AIza` finds nothing) and not in the browser (DevTools → Network → `/api/dump` request/response)
- [ ] `git status` / `git check-ignore -v .dev.vars` confirms `.dev.vars` is ignored
- [ ] A 503 from Gemini is retried; the fallback model is used if retries fail; the page shows "retrying" meanwhile
- [ ] Every dump is saved and appears in History right after recording
- [ ] Tasks shows open tasks from all dumps, grouped by project; checking one off survives a reload
- [ ] "Remind me tomorrow" → `due_date` is tomorrow (Israel time); "sometime soon" → `due_date: null`
- [ ] Deleting a dump removes it and its tasks
- [ ] Tapping an item in Tasks, Notes or a past dump opens the editor; text, project (existing or new), type and due date changes are saved and survive a reload
- [ ] Picking a due date replaces the spoken wording; a single item can be deleted after confirming
- [ ] Notes tab shows ideas, open questions and notes, newest first, grouped by project; the chips filter by type
- [ ] Hebrew displays right-to-left on iPhone Safari and desktop Chrome
- [ ] Local dev works with the local D1 database (`npm run db:migrate:local`, then `npm run dev`)

## Notes / known limits

- **Cloudflare free-plan CPU limit (10 ms/request).** Waiting on Gemini doesn't count toward it, but base64-encoding the audio does. Normal recordings should be fine. If long recordings start failing with a Cloudflare "exceeded resources" error, that's the cause. The fix would be the Workers Paid plan or a smaller upload.
- Gemini's docs list `audio/m4a`, not `audio/mp4`. Safari's MP4/AAC recording is the m4a format, so it's labeled `audio/m4a` when sent.
