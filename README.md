# Brain Dump — Phase 1

Tap record, talk, tap stop. The audio goes to Gemini, which transcribes it and sorts it into a summary, tasks, ideas, open questions and notes, tagged by project.

Phase 1 is the core loop only. Nothing is saved anywhere.

> **The API is password-protected.** Every `/api/*` request needs `APP_PASSWORD` (see [Setting the app password](#setting-the-app-password)). If `APP_PASSWORD` isn't set, the API refuses every request, so the app won't work until you set it.

## How it works

```
public/            static frontend (no build step)
  index.html
  app.js           recording, upload, rendering, Copy all, Retry
  style.css        light/dark via prefers-color-scheme
functions/
  api/_middleware.js  password check for every /api/* route (runs first)
  api/auth.js      GET /api/auth → { ok: true } (the login screen's password check)
  api/dump.js      POST /api/dump → Gemini generateContent → validated JSON
  prompt.js        the organizing prompt (edit this to tune results / add clients)
.dev.vars          local secrets (git-ignored)
```

- **Audio formats.** The browser records in the first format it supports that Gemini also accepts: WebM/Opus (Chrome, Firefox), Ogg, then MP4/AAC (Safari/iOS, sent to Gemini as `audio/m4a`). If none of those work, the browser's own recording is converted to 16 kHz mono WAV before upload. The upload is the raw audio, with its MIME type in the `Content-Type` header. Yes
- **Size limit.** Gemini accepts up to 20 MB per request with inline audio, and that limit counts the audio after base64 encoding. So `/api/dump` rejects audio over about 15 MB with a clear message. A 10-minute recording at the 64 kbps the app uses is about 5 MB. The WAV fallback is much bigger (about 1.9 MB per minute), so it can only take about 7½ minutes.
- **Model.** The default is `gemini-3.6-flash`, the current stable Flash model with audio input and a free tier. Set `GEMINI_MODEL` to switch models without changing code.
- **When Gemini is busy.** If Gemini answers 429 (rate limit) or 503 (overloaded), the function retries up to 3 times, waiting about 2 s, 5 s, then 10 s. It encodes the audio once and reuses it for every try. If all 4 tries are busy, it tries once with `GEMINI_FALLBACK_MODEL` (default `gemini-3.5-flash-lite`, the current stable Flash-Lite with audio input). Only then does the page show an error. Other errors fail immediately. While this happens the page shows "Gemini is busy, retrying…". To make that possible, `/api/dump` streams status events (`text/event-stream`) once the audio has passed the input checks; bad input still gets a plain JSON error.
- **Password.** `functions/api/_middleware.js` runs before every `/api/*` handler, so any endpoint added under `functions/api/` is protected automatically. It expects `Authorization: Bearer <APP_PASSWORD>` and returns 401 if the password is missing or wrong. The comparison takes the same time whether the guess is close or not, so timing can't leak the password. If `APP_PASSWORD` isn't set, it returns 503 for everything. The page shows a password screen the first time, then remembers the password on that device in `localStorage`. **Log out** (top right) forgets it, and any 401 clears it and shows the password screen again. If a recording was waiting when that happened, it's sent automatically after you log back in. The password must be plain ASCII (English letters, digits, standard symbols), because HTTP headers can't carry Hebrew letters or emoji.
- **API key.** Only the Pages Function reads `GEMINI_API_KEY`. The function sends it to Gemini in the `x-goog-api-key` header and never in a URL. Error messages are scrubbed in case they contain the key.

## Local development

Requires Node.js 22+.

```sh
npm install
# put your real key and a password in .dev.vars:
#   GEMINI_API_KEY=...
#   APP_PASSWORD=...
npm run dev        # = wrangler pages dev public
```

Open http://localhost:8788.

The microphone only works over **HTTPS or on `localhost`**. Opening the dev server from your phone at `http://<your-LAN-IP>:8788` won't be able to record, so test on the phone with the deployed version.

Get a key at https://aistudio.google.com/apikey.

## Tuning the prompt

Edit `functions/prompt.js`. That's where the client list and nicknames live. Restart `npm run dev`, or push to redeploy.

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

### 2. Create the Cloudflare Pages project

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Pick the repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `public`
4. **Save and Deploy.** Cloudflare picks up the `functions/` folder automatically.

### 3. Add the secrets

Pages project → **Settings** → **Variables and Secrets** → **Add**:

| Name             | Type       | Value                                     |
|------------------|------------|-------------------------------------------|
| `GEMINI_API_KEY` | **Secret** | your Gemini key                           |
| `APP_PASSWORD`   | **Secret** | the app password (see below)              |
| `GEMINI_MODEL`   | Text       | *(optional)* e.g. `gemini-3.6-flash`      |
| `GEMINI_FALLBACK_MODEL` | Text | *(optional)* e.g. `gemini-3.5-flash-lite` |

Add them to **Production** (and to Preview if you use preview deploys). Then **redeploy**, because variables only apply to new deployments: **Deployments** → latest → **⋯** → **Retry deployment**.

#### Setting the app password

1. Choose a long password: 16+ characters, English letters, digits and symbols only (no Hebrew or emoji; see "Password" above). A password manager's generator is ideal. You type it once per device.
2. Cloudflare dashboard → **Workers & Pages** → your project → **Settings** → **Variables and Secrets** → **Add**.
3. **Type: Secret** (not Text). A Secret is encrypted and hidden after saving, while a Text variable stays readable in the dashboard.
   **Name:** `APP_PASSWORD`. **Value:** your password. Save it for **Production**, and for **Preview** too if you use preview deploys.
4. **Redeploy** so the new value takes effect: **Deployments** → latest → **⋯** → **Retry deployment**. Until you do, the running deployment keeps the old value, or refuses every request if there was none.
5. Check it: open the site, enter the password, and record something. `curl -i https://<project>.pages.dev/api/auth` should return **401**.

To change the password, edit the Secret, redeploy, and enter the new one on each device. The old one now gets a 401, so the app asks again.

For local dev, add `APP_PASSWORD=...` to `.dev.vars` and restart `npm run dev`.

### 4. Optional: an extra layer with Cloudflare Access

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

## Phase 1 acceptance checklist

- [ ] Record on desktop Chrome and on iPhone Safari (deployed URL); both produce a result
- [ ] 2-minute ramble → sensible summary/tasks/ideas, correct project tags
- [ ] Nickname ("the sugaring site") → "Soft & Sweet Sugaring"
- [ ] Nothing invented: no extra tasks or due dates
- [ ] Turn off Wi-Fi / use a bad key → readable error; **Retry** works without re-recording
- [ ] Without the password every `/api/*` request returns 401; with it everything works; the phone remembers it after the first time
- [ ] With `APP_PASSWORD` unset, the API refuses every request (503)
- [ ] Key not in repo (`git grep -i AIza` finds nothing) and not in the browser (DevTools → Network → `/api/dump` request/response)
- [ ] `git status` / `git check-ignore -v .dev.vars` confirms `.dev.vars` is ignored

## Notes / known limits

- **Cloudflare free-plan CPU limit (10 ms/request).** Waiting on Gemini doesn't count toward it, but base64-encoding the audio does. Normal recordings should be fine. If long recordings start failing with a Cloudflare "exceeded resources" error, that's the cause. The fix would be the Workers Paid plan or a smaller upload.
- Gemini's docs list `audio/m4a`, not `audio/mp4`. Safari's MP4/AAC recording is the m4a format, so it's labeled `audio/m4a` when sent.
