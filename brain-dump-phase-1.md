# Brain Dump App — Phase 1: Core Loop

## Goal

Build a personal web app: I tap record, talk freely, tap stop, and the app shows my rambling organized into tasks, ideas, open questions, and a short summary. Single user (me). Phase 1 = the core loop only. **No database or saving yet** (that's Phase 2).

## Stack (do not deviate)

- Plain HTML, CSS, and vanilla JS. No frameworks, no build step, no UI libraries.
- Hosted on **Cloudflare Pages**, deployed from a GitHub repo.
- Backend: **Cloudflare Pages Functions** (one endpoint).
- AI: **Google Gemini API** — a single call that both transcribes the audio and organizes it.
- The only npm dependency allowed is `wrangler` (dev dependency) for local dev.

## Project structure

```
/public
  index.html
  app.js
  style.css
/functions
  /api
    dump.js        # POST endpoint: receives audio, calls Gemini, returns JSON
  prompt.js        # exports the organizing prompt as a string (I'll edit this often)
.dev.vars          # local secrets — MUST be in .gitignore
.gitignore
package.json
README.md
```

## Secrets

- The Gemini key lives in an env var `GEMINI_API_KEY`. Locally in `.dev.vars`; in production as a Cloudflare Pages secret.
- Also read `GEMINI_MODEL` from env, so I can switch models without code changes.
- **The key must never appear in frontend code, in the repo, or in any response sent to the browser.** Add `.dev.vars` to `.gitignore` before anything else.

## Frontend (public/)

- One screen, mobile-first (I'll mostly use it on my phone).
- A large record button. While recording: show elapsed time and a clear stop button.
- Recording uses the browser's MediaRecorder API. Cap recordings at 10 minutes; auto-stop at the cap.
- After stop: show a "Processing…" state, POST the audio to `/api/dump`, then render the result.
- Render the result grouped into sections: Summary, Tasks, Ideas, Open questions, Notes. Show the project/client tag next to each item if present. Collapsible full transcript at the bottom.
- A "Copy all" button that copies the organized result as plain text.
- If the request fails, show the error and a **Retry** button that resends the same recording (keep the audio blob in memory until a successful result).
- Support light and dark mode via `prefers-color-scheme` with CSS variables.
- No localStorage or any other storage in Phase 1.

## Audio format — check this carefully

Browsers record different formats (Safari/iOS typically `audio/mp4`, Chrome typically `audio/webm`). Before writing the code, **check the current Gemini API docs for which audio MIME types it accepts.**

- Use `MediaRecorder.isTypeSupported()` to pick the best format the browser supports that Gemini also accepts.
- If the browser can only produce a format Gemini doesn't accept, convert on the client to 16 kHz mono WAV before uploading.
- Send the MIME type along with the audio so the function passes the correct type to Gemini.

## Backend (functions/api/dump.js)

- Accept POST with the audio (multipart form data or raw body — your choice, keep it simple).
- Reject anything that isn't POST, has no audio, or exceeds the size limit for inline audio in a Gemini request (check the docs for the current limit; return a clear error message if exceeded).
- Call the Gemini `generateContent` REST endpoint directly with `fetch` (no SDK needed). Send the audio as inline base64 data plus the prompt from `prompt.js`.
- Use **structured output** (`responseMimeType: "application/json"` with a `responseSchema`) so Gemini returns valid JSON matching the schema below.
- Validate the parsed JSON before returning it. On any Gemini error, return a JSON error with a readable message (never leak the API key or the raw request).
- For `GEMINI_MODEL`, default to the current stable Gemini Flash model that is available on the free tier and supports audio input. **Check the docs for the current model name** — don't rely on memory.

### Response schema

```json
{
  "transcript": "string — full transcript of what I said",
  "summary": "string — 2 to 3 sentences",
  "tasks": [
    { "text": "string", "project": "string or null", "due": "string or null" }
  ],
  "ideas": [
    { "text": "string", "project": "string or null" }
  ],
  "open_questions": [
    { "text": "string", "project": "string or null" }
  ],
  "notes": [
    { "text": "string", "project": "string or null" }
  ]
}
```

## The organizing prompt (functions/prompt.js)

Export this as a template string. I will tune it over time, so keep it isolated in this file and easy to read.

```
You are processing a voice brain dump from Eyal, a freelance web developer and SEO specialist.

Step 1: Transcribe the audio accurately, in the language he spoke. Remove filler words ("um", "like") but do not change his meaning.

Step 2: Organize the content into:
- tasks: anything he needs, wants, or should do. Phrases like "I need to", "I should", "remind me to", "don't forget" are tasks. Write each as a short, clear action starting with a verb.
- ideas: possibilities, product ideas, things he's considering but hasn't committed to.
- open_questions: things he's unsure about or needs to find out.
- notes: facts or information worth keeping that are none of the above.
- summary: 2 to 3 sentences covering the main points.

Projects and clients (use these exact names in the "project" field when he refers to them, including by nickname):
- Landmark Construction — also "Landmark", "mylandmark"
- VeganKingz
- Soft & Sweet Sugaring — also "the sugaring site", "Soft and Sweet"
- seotools4free — also "my SEO tools site"
- Brain Dump App — also "this app"
[Eyal: add or edit clients and nicknames here]

If an item doesn't clearly belong to a project, set project to null. Do not guess.

Rules:
- Never invent tasks, deadlines, or details he didn't say.
- Only fill "due" if he stated a time ("by Friday", "tomorrow", "next week"). Keep his wording.
- If he corrects himself mid-thought ("actually, no..."), use the corrected version.
- If one sentence contains two separate actions, split them into two tasks.
- Keep items in the language he spoke.
- If the audio is empty or unintelligible, return an empty transcript and empty arrays.
```

## Local development

- Use `wrangler pages dev public` (Functions auto-detected from `/functions`).
- Note in the README: microphone access requires HTTPS or localhost, so phone testing needs the deployed version.

## Deployment (document these steps in README.md; I'll do the dashboard parts)

1. Push to a GitHub repo.
2. In Cloudflare Pages, connect the repo. Build command: none. Output directory: `public`.
3. Add `GEMINI_API_KEY` (as a secret) and optionally `GEMINI_MODEL` in the Pages project settings.
4. **Before using it on the public URL**, set up Cloudflare Access (Zero Trust → Access → Applications) on the Pages domain so only my email can sign in. Write clear step-by-step instructions for this in the README — the app is unprotected and anyone could spend my API quota until this is done.

## Acceptance criteria

- [ ] I can record on desktop Chrome and on iPhone Safari, and both produce a result.
- [ ] A 2-minute ramble returns a sensible summary, tasks, and ideas, with correct project tags for the clients listed in the prompt.
- [ ] Mentioning a client by nickname ("the sugaring site") tags it with the full project name.
- [ ] Nothing is invented: no tasks or due dates I didn't say.
- [ ] Network failure or a Gemini error shows a readable message, and Retry works without re-recording.
- [ ] The Gemini key does not appear anywhere in the repo or in the browser (check the network tab).
- [ ] `.dev.vars` is git-ignored.

## Out of scope for Phase 1

Database/storage, history, editing results, checking off tasks, PWA/home-screen install, integrations. Don't build these yet; just keep the code clean enough to add them in Phase 2.
