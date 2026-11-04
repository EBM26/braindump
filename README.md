# Brain Dump — Phase 1

Tap record, talk, tap stop. The audio goes to Gemini, which transcribes it and sorts it into a summary, tasks, ideas, open questions and notes, tagged by project.

Phase 1 is the core loop only. Nothing is saved anywhere.

> **Warning: the app has no login until you finish [step 4 of Deployment](#4-lock-it-down-with-cloudflare-access-do-this-before-using-the-public-url).** Until then anyone with the URL can use up your Gemini quota.

## How it works

```
public/            static frontend (no build step)
  index.html
  app.js           recording, upload, rendering, Copy all, Retry
  style.css        light/dark via prefers-color-scheme
functions/
  api/dump.js      POST /api/dump → Gemini generateContent → validated JSON
  prompt.js        the organizing prompt (edit this to tune results / add clients)
.dev.vars          local secrets (git-ignored)
```

- **Audio formats.** The browser records in the first format it supports that Gemini also accepts: WebM/Opus (Chrome, Firefox), Ogg, then MP4/AAC (Safari/iOS, sent to Gemini as `audio/m4a`). If none of those work, the browser's own recording is converted to 16 kHz mono WAV before upload. The upload is the raw audio, with its MIME type in the `Content-Type` header.
- **Size limit.** Gemini accepts up to 20 MB per request with inline audio, and that limit counts the audio after base64 encoding. So `/api/dump` rejects audio over about 15 MB with a clear message. A 10-minute recording at the 64 kbps the app uses is about 5 MB. The WAV fallback is much bigger (about 1.9 MB per minute), so it can only take about 7½ minutes.
- **Model.** The default is `gemini-3.6-flash`, the current stable Flash model with audio input and a free tier. Set `GEMINI_MODEL` to switch models without changing code.
- **API key.** Only the Pages Function reads `GEMINI_API_KEY`. The function sends it to Gemini in the `x-goog-api-key` header and never in a URL. Error messages are scrubbed in case they contain the key.

## Local development

Requires Node.js 22+.

```sh
npm install
# put your real key in .dev.vars:
#   GEMINI_API_KEY=...
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
| `GEMINI_MODEL`   | Text       | *(optional)* e.g. `gemini-3.6-flash`      |

Add them to **Production** (and to Preview if you use preview deploys). Then **redeploy**, because variables only apply to new deployments: **Deployments** → latest → **⋯** → **Retry deployment**.

### 4. Lock it down with Cloudflare Access (do this before using the public URL)

This puts a login wall in front of the whole site, including `/api/dump`, so only your email can get in. It's free for up to 50 users.

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
- [ ] Key not in repo (`git grep -i AIza` finds nothing) and not in the browser (DevTools → Network → `/api/dump` request/response)
- [ ] `git status` / `git check-ignore -v .dev.vars` confirms `.dev.vars` is ignored

## Notes / known limits

- **Cloudflare free-plan CPU limit (10 ms/request).** Waiting on Gemini doesn't count toward it, but base64-encoding the audio does. Normal recordings should be fine. If long recordings start failing with a Cloudflare "exceeded resources" error, that's the cause. The fix would be the Workers Paid plan or a smaller upload.
- Gemini's docs list `audio/m4a`, not `audio/mp4`. Safari's MP4/AAC recording is the m4a format, so it's labeled `audio/m4a` when sent.
