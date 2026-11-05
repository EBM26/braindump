// POST /api/dump
// Body: the raw recorded audio. Content-Type header: its MIME type (e.g. audio/webm).
//
// Bad input → a plain JSON error ({ error }) with a 4xx/5xx status.
// Valid input → 200 with a text/event-stream. Each event is `data: <json>`:
//   { type: "status", state: "retrying", attempt, maxRetries, waitSeconds, model }
//   { type: "status", state: "fallback", model }
//   { type: "result", data: { transcript, summary, tasks, ... } }   ← final
//   { type: "error", error: "readable message" }                     ← final
// The stream lets the page say "Gemini is busy, retrying…" while the function waits.

import { PROMPT } from "../prompt.js";

// Current stable Gemini Flash model with audio input and a free tier
// (checked against ai.google.dev / aistudio.google.com docs, Nov 2026).
// Override with the GEMINI_MODEL env var.
const DEFAULT_MODEL = "gemini-3.6-flash";

// Used once after the main model's retries are exhausted. Current stable Flash-Lite
// with audio input and structured output (docs, Nov 2026). Override with GEMINI_FALLBACK_MODEL.
const DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash-lite";

// Gemini "busy" responses worth retrying: 429 (rate limit / quota) and 503 (overloaded).
const RETRYABLE_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [2000, 5000, 10000]; // up to 3 retries after the first try

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Audio MIME types the Gemini API documents as supported.
const ACCEPTED_MIME_TYPES = new Set([
  "audio/wav", "audio/mp3", "audio/aiff", "audio/aac", "audio/ogg", "audio/flac",
  "audio/mpeg", "audio/m4a", "audio/l16", "audio/opus", "audio/alaw", "audio/mulaw",
  "audio/webm",
]);

// Gemini's documented cap for a request with inline data is 20 MB total
// (prompt + all files). Base64 inflates audio by 4/3, so the raw audio limit is lower.
const MAX_REQUEST_BYTES = 20 * 1000 * 1000;
const REQUEST_OVERHEAD_BYTES = 64 * 1024; // prompt, schema, JSON wrapping — generous
const MAX_AUDIO_BYTES = Math.floor(((MAX_REQUEST_BYTES - REQUEST_OVERHEAD_BYTES) * 3) / 4);

// Structured output schema (OpenAPI-style Schema object used by responseSchema).
const itemSchema = (withDue) => {
  const properties = {
    text: { type: "STRING" },
    project: { type: "STRING", nullable: true },
  };
  const order = ["text", "project"];
  if (withDue) {
    properties.due = { type: "STRING", nullable: true };
    order.push("due");
  }
  return { type: "OBJECT", properties, required: order, propertyOrdering: order };
};

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    transcript: { type: "STRING" },
    summary: { type: "STRING" },
    tasks: { type: "ARRAY", items: itemSchema(true) },
    ideas: { type: "ARRAY", items: itemSchema(false) },
    open_questions: { type: "ARRAY", items: itemSchema(false) },
    notes: { type: "ARRAY", items: itemSchema(false) },
  },
  required: ["transcript", "summary", "tasks", "ideas", "open_questions", "notes"],
  propertyOrdering: ["transcript", "summary", "tasks", "ideas", "open_questions", "notes"],
};

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return jsonError(405, "Only POST is allowed.", { Allow: "POST" });
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonError(500, "Server is missing GEMINI_API_KEY. Add it to .dev.vars (local) or the Pages project settings.");
  }
  const model = (env.GEMINI_MODEL || "").trim() || DEFAULT_MODEL;
  const fallbackModel = (env.GEMINI_FALLBACK_MODEL || "").trim() || DEFAULT_FALLBACK_MODEL;

  // --- Validate the incoming audio ---
  const mimeType = normalizeMimeType(request.headers.get("Content-Type"));
  if (!mimeType) {
    return jsonError(400, "Missing audio. Send the recording as the request body with an audio Content-Type.");
  }
  if (!ACCEPTED_MIME_TYPES.has(mimeType)) {
    return jsonError(415, `Unsupported audio format "${mimeType}". Gemini accepts: ${[...ACCEPTED_MIME_TYPES].join(", ")}.`);
  }

  const declaredLength = Number(request.headers.get("Content-Length"));
  if (declaredLength > MAX_AUDIO_BYTES) {
    return tooLarge(declaredLength);
  }

  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.byteLength === 0) {
    return jsonError(400, "Missing audio. The recording was empty.");
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return tooLarge(audio.byteLength);
  }

  // --- Build the Gemini request once; every attempt (and the fallback) reuses it ---
  // The model is in the URL, not the body, so the same body works for both models.
  const requestBody = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: toBase64(audio) } }, // base64-encoded exactly once
          { text: PROMPT },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  // --- Stream status events while retrying, then the final result or error ---
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  // Not awaited: a write only settles once the browser reads it. If the browser
  // has gone away, writes fail and are ignored.
  const sendEvent = (event) => {
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => {});
  };

  (async () => {
    try {
      const outcome = await organizeWithRetries({
        apiKey, model, fallbackModel, requestBody,
        onStatus: (status) => sendEvent({ type: "status", ...status }),
      });
      sendEvent(outcome.ok ? { type: "result", data: outcome.value } : { type: "error", error: outcome.message });
    } catch (err) {
      sendEvent({ type: "error", error: `Unexpected server error: ${scrub(String(err && err.message || err), apiKey)}` });
    } finally {
      writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
    },
  });
}

// ---------- Gemini calls ----------

// Main model: first try + up to 3 retries on 429/503 (waiting ~2s, 5s, 10s).
// If it's still busy after that, one try with the fallback model. Other errors fail immediately.
async function organizeWithRetries({ apiKey, model, fallbackModel, requestBody, onStatus }) {
  let last = await callGemini(model, requestBody, apiKey);

  for (let i = 0; i < RETRY_DELAYS_MS.length && isBusy(last); i++) {
    onStatus({
      state: "retrying",
      attempt: i + 1,
      maxRetries: RETRY_DELAYS_MS.length,
      waitSeconds: RETRY_DELAYS_MS[i] / 1000,
      model,
    });
    await sleep(RETRY_DELAYS_MS[i]);
    last = await callGemini(model, requestBody, apiKey);
  }

  if (!isBusy(last)) return last; // success, or a non-retryable error

  onStatus({ state: "fallback", model: fallbackModel });
  const fallback = await callGemini(fallbackModel, requestBody, apiKey);
  if (fallback.ok) return fallback;

  return {
    ok: false,
    message:
      `Gemini is busy. ${model} failed ${RETRY_DELAYS_MS.length + 1} times (${last.message}), ` +
      `and the fallback model ${fallbackModel} also failed (${fallback.message}). Try again in a minute.`,
  };
}

function isBusy(outcome) {
  return !outcome.ok && RETRYABLE_STATUSES.has(outcome.status);
}

// One generateContent call. Returns { ok: true, value } or { ok: false, status, message }.
// `status` is Gemini's HTTP status (0 when the request never got a response).
async function callGemini(model, requestBody, apiKey) {
  let geminiRes;
  try {
    geminiRes = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: requestBody,
    });
  } catch (err) {
    return fail(0, `Could not reach Gemini: ${scrub(String(err && err.message || err), apiKey)}`);
  }

  let payload;
  try {
    payload = await geminiRes.json();
  } catch {
    return fail(geminiRes.status, `Gemini returned an unreadable response (HTTP ${geminiRes.status}).`);
  }

  if (!geminiRes.ok) {
    return fail(geminiRes.status, describeGeminiError(geminiRes.status, payload, model, apiKey));
  }

  const candidate = payload.candidates && payload.candidates[0];
  if (!candidate) {
    const reason = payload.promptFeedback && payload.promptFeedback.blockReason;
    return fail(200, reason ? `Gemini blocked the request (${reason}).` : "Gemini returned no result.");
  }
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    const hint = candidate.finishReason === "MAX_TOKENS" ? " The recording may be too long to organize in one go." : "";
    return fail(200, `Gemini stopped early (${candidate.finishReason}).${hint}`);
  }

  const text = ((candidate.content && candidate.content.parts) || [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(200, "Gemini's answer wasn't valid JSON. Try again.");
  }

  const result = validateResult(parsed);
  if (!result.ok) {
    return fail(200, `Gemini's answer didn't match the expected format: ${result.error}`);
  }
  return { ok: true, value: result.value };
}

function fail(status, message) {
  return { ok: false, status, message };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- helpers ----------

function normalizeMimeType(header) {
  if (!header) return "";
  // Drop parameters like ";codecs=opus" — Gemini wants the bare type.
  return header.split(";")[0].trim().toLowerCase();
}

function tooLarge(bytes) {
  const mb = (n) => (n / 1e6).toFixed(1);
  return jsonError(
    413,
    `Recording is too large (${mb(bytes)} MB). Gemini accepts at most about ${mb(MAX_AUDIO_BYTES)} MB of audio per request (20 MB total after encoding). Try a shorter recording.`
  );
}

// Base64 without Node's Buffer: build a binary string in chunks, then use native btoa.
function toBase64(bytes) {
  const CHUNK = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

function describeGeminiError(status, payload, model, apiKey) {
  const msg = scrub((payload && payload.error && payload.error.message) || "", apiKey);
  if (status === 429) return "Gemini quota or rate limit reached. Wait a minute and retry." + (msg ? ` (${msg})` : "");
  if (status === 404) return `Gemini model "${model}" was not found. Check GEMINI_MODEL.` + (msg ? ` (${msg})` : "");
  if (status === 400 && /api key/i.test(msg)) return "Gemini rejected the API key. Check GEMINI_API_KEY.";
  if (status === 401 || status === 403) return "Gemini rejected the API key or permissions. Check GEMINI_API_KEY.";
  return `Gemini error (HTTP ${status})${msg ? `: ${msg}` : "."}`;
}

// Belt and braces: never let the key leave the server, even inside an upstream message.
function scrub(message, apiKey) {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}

function validateResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "not an object" };
  }
  for (const key of ["transcript", "summary"]) {
    if (typeof data[key] !== "string") return { ok: false, error: `"${key}" is not a string` };
  }

  const cleanList = (key, withDue) => {
    const list = data[key];
    if (!Array.isArray(list)) throw new Error(`"${key}" is not a list`);
    return list.map((item, i) => {
      if (!item || typeof item !== "object" || typeof item.text !== "string") {
        throw new Error(`${key}[${i}] has no text`);
      }
      const out = { text: item.text.trim(), project: optionalString(item.project, `${key}[${i}].project`) };
      if (withDue) out.due = optionalString(item.due, `${key}[${i}].due`);
      return out;
    }).filter((item) => item.text !== "");
  };

  try {
    return {
      ok: true,
      value: {
        transcript: data.transcript.trim(),
        summary: data.summary.trim(),
        tasks: cleanList("tasks", true),
        ideas: cleanList("ideas", false),
        open_questions: cleanList("open_questions", false),
        notes: cleanList("notes", false),
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function optionalString(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${label} is not a string or null`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function json(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

function jsonError(status, message, extraHeaders) {
  return json(status, { error: message }, extraHeaders);
}
