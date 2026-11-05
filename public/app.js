"use strict";

// ---------- Config ----------

const MAX_SECONDS = 10 * 60; // recording cap; auto-stop here
// Generous: the server may retry Gemini 3 times (waiting ~17s in total) and then try a fallback model.
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// Recording formats in order of preference. `record` is what we ask MediaRecorder for;
// `send` is the MIME type Gemini documents as supported for that format.
// Safari/iOS records AAC in an MP4 container, which is the .m4a format, so it is sent as audio/m4a.
const FORMATS = [
  { record: "audio/webm;codecs=opus", send: "audio/webm" },
  { record: "audio/webm", send: "audio/webm" },
  { record: "audio/ogg;codecs=opus", send: "audio/ogg" },
  { record: "audio/ogg", send: "audio/ogg" },
  { record: "audio/mp4;codecs=mp4a.40.2", send: "audio/m4a" },
  { record: "audio/mp4", send: "audio/m4a" },
  { record: "audio/aac", send: "audio/aac" },
];

const SECTIONS = [
  { key: "tasks", title: "Tasks" },
  { key: "ideas", title: "Ideas" },
  { key: "open_questions", title: "Open questions" },
  { key: "notes", title: "Notes" },
];

// ---------- Elements ----------

const $ = (id) => document.getElementById(id);
const els = {
  recorder: $("recorder"),
  recordBtn: $("recordBtn"),
  status: $("status"),
  timer: $("timer"),
  spinner: $("spinner"),
  error: $("error"),
  errorMessage: $("errorMessage"),
  retryBtn: $("retryBtn"),
  discardBtn: $("discardBtn"),
  result: $("result"),
  resultBody: $("resultBody"),
  transcript: $("transcript"),
  transcriptBox: $("transcriptBox"),
  copyBtn: $("copyBtn"),
  newBtn: $("newBtn"),
  appContent: $("appContent"),
  login: $("login"),
  passwordInput: $("passwordInput"),
  loginError: $("loginError"),
  loginBtn: $("loginBtn"),
  logoutBtn: $("logoutBtn"),
};

// ---------- State (memory only, except the password — see "Password gate") ----------

let mediaRecorder = null;
let stream = null;
let chunks = [];
let timerId = null;
let startedAt = 0;
let pending = null; // { blob, mimeType } kept until a successful result, for Retry
let lastResult = null;

// ---------- Recording ----------

function pickFormat() {
  if (typeof MediaRecorder.isTypeSupported !== "function") return null;
  return FORMATS.find((f) => MediaRecorder.isTypeSupported(f.record)) || null;
}

async function startRecording() {
  if (!window.isSecureContext || !navigator.mediaDevices || !window.MediaRecorder) {
    showError("Recording isn't available here. The microphone needs HTTPS (or localhost) and a browser with MediaRecorder support.", false);
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    showError(denied
      ? "Microphone access was blocked. Allow it in your browser settings and try again."
      : `Couldn't start the microphone: ${err && err.message ? err.message : err}`, false);
    return;
  }

  const format = pickFormat();
  const options = { audioBitsPerSecond: 64000 };
  if (format) options.mimeType = format.record;

  try {
    mediaRecorder = new MediaRecorder(stream, options);
  } catch {
    mediaRecorder = new MediaRecorder(stream); // browser default; converted to WAV later if needed
  }

  chunks = [];
  pending = null;
  lastResult = null;
  mediaRecorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });
  mediaRecorder.addEventListener("stop", onRecordingStopped, { once: true });
  mediaRecorder.start(1000);

  startedAt = Date.now();
  timerId = setInterval(tick, 250);
  tick();
  setView("recording");
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

function tick() {
  const seconds = Math.min(MAX_SECONDS, Math.floor((Date.now() - startedAt) / 1000));
  els.timer.firstChild.nodeValue = `${formatTime(seconds)} `;
  if (seconds >= MAX_SECONDS) stopRecording();
}

async function onRecordingStopped() {
  clearInterval(timerId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;

  const recordedType = mediaRecorder.mimeType || (chunks[0] && chunks[0].type) || "";
  const blob = new Blob(chunks, { type: recordedType });
  chunks = [];
  mediaRecorder = null;

  if (blob.size === 0) {
    showError("Nothing was recorded. Try again.", false);
    return;
  }

  setView("processing", "Processing…");
  try {
    pending = await prepareUpload(blob, recordedType);
  } catch (err) {
    showError(`Couldn't prepare the recording: ${err && err.message ? err.message : err}`, false);
    return;
  }
  send();
}

// Map what the browser actually recorded to a Gemini-supported type; convert to WAV if there's no match.
async function prepareUpload(blob, recordedType) {
  const base = recordedType.split(";")[0].trim().toLowerCase();
  const match = FORMATS.find((f) => f.record.split(";")[0] === base);
  if (match) return { blob, mimeType: match.send };

  setView("processing", "Converting audio…");
  const wav = await convertToWav16kMono(blob);
  return { blob: wav, mimeType: "audio/wav" };
}

async function convertToWav16kMono(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ctx.close();
  }

  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const source = offline.createBufferSource();
  source.buffer = decoded; // multichannel is down-mixed to mono by the 1-channel destination
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), rate);
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);         // fmt chunk size
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);          // block align
  view.setUint16(34, 16, true);         // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// ---------- Upload ----------

async function send() {
  if (!pending) return;
  setView("processing", "Processing…");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch("/api/dump", {
      method: "POST",
      headers: { "Content-Type": pending.mimeType, ...authHeader() },
      body: pending.blob,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    showError(err && err.name === "AbortError"
      ? "The request timed out. Check your connection and retry."
      : "Network error — couldn't reach the server. Check your connection and retry.", true);
    return;
  }
  if (res.status === 401) {
    clearTimeout(timeout);
    handleUnauthorized(); // the recording stays in `pending` and is resent after logging in
    return;
  }
  let data = null;
  let errorMessage = null;
  try {
    if ((res.headers.get("Content-Type") || "").includes("text/event-stream")) {
      // Gemini stage: status events while the server retries, then a final result/error.
      const outcome = await readEvents(res, (event) => {
        if (event.state === "retrying" || event.state === "fallback") {
          setView("processing", "Gemini is busy, retrying…");
        }
      });
      if (outcome && outcome.type === "result") data = outcome.data;
      else errorMessage = (outcome && outcome.error) || "The connection closed before the result arrived.";
    } else {
      // Rejected before reaching Gemini (bad input, missing key, …): plain JSON error.
      const body = await res.json().catch(() => null);
      if (res.ok && body && !body.error) data = body;
      else errorMessage = (body && body.error) || `Server error (HTTP ${res.status}).`;
    }
  } catch (err) {
    errorMessage = err && err.name === "AbortError"
      ? "The request timed out. Check your connection and retry."
      : "The connection dropped while waiting for the result. Check your connection and retry.";
  } finally {
    clearTimeout(timeout);
  }

  if (errorMessage || !data) {
    showError(errorMessage || "Empty response from the server.", true);
    return;
  }

  pending = null; // success — release the recording
  lastResult = data;
  renderResult(data);
  setView("result");
}

// Reads a text/event-stream response. Calls onStatus for each status event and
// returns the final { type: "result" | "error" } event (or null if the stream ended without one).
async function readEvents(res, onStatus) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final = null;

  const handle = (block) => {
    const json = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!json) return;
    const event = JSON.parse(json);
    if (event.type === "status") onStatus(event);
    else if (event.type === "result" || event.type === "error") final = event;
  };

  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      handle(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
    }
    if (done) break;
  }
  if (buffer.trim()) handle(buffer);
  return final;
}

// ---------- Rendering ----------

function renderResult(data) {
  const body = els.resultBody;
  body.replaceChildren();

  const nothing = !data.summary && SECTIONS.every((s) => !data[s.key].length);

  const summary = section("Summary");
  const p = document.createElement("p");
  if (nothing) {
    p.className = "empty";
    p.textContent = "Nothing intelligible came through. Try recording again.";
  } else {
    p.textContent = data.summary;
  }
  summary.append(p);
  body.append(summary);

  for (const { key, title } of SECTIONS) {
    const items = data[key];
    if (!items.length) continue;
    const sec = section(title);
    const ul = document.createElement("ul");
    ul.className = "items";
    for (const item of items) {
      const li = document.createElement("li");
      li.append(document.createTextNode(item.text));
      if (item.project) li.append(tag(item.project));
      if (item.due) li.append(tag(`due: ${item.due}`, "tag--due"));
      ul.append(li);
    }
    sec.append(ul);
    body.append(sec);
  }

  els.transcript.textContent = data.transcript || "(empty)";
  els.transcriptBox.open = false;

  const modelInfo = $("modelInfo");
  modelInfo.textContent = data.model ? `Organized by ${data.model}` : "";
  modelInfo.hidden = !data.model;
}

function section(title) {
  const sec = document.createElement("section");
  sec.className = "section";
  const h = document.createElement("h2");
  h.textContent = title;
  sec.append(h);
  return sec;
}

function tag(text, extraClass) {
  const span = document.createElement("span");
  span.className = extraClass ? `tag ${extraClass}` : "tag";
  span.textContent = text;
  return span;
}

function resultAsText(data) {
  const lines = ["SUMMARY", data.summary || "(none)"];
  for (const { key, title } of SECTIONS) {
    const items = data[key];
    if (!items.length) continue;
    lines.push("", title.toUpperCase());
    for (const item of items) {
      let line = `- ${item.text}`;
      if (item.project) line += ` [${item.project}]`;
      if (item.due) line += ` (due: ${item.due})`;
      lines.push(line);
    }
  }
  return lines.join("\n");
}

async function copyAll() {
  if (!lastResult) return;
  const text = resultAsText(lastResult);
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
  }
  els.copyBtn.textContent = ok ? "Copied!" : "Copy failed";
  setTimeout(() => { els.copyBtn.textContent = "Copy all"; }, 1800);
}

// ---------- View state ----------

function setView(view, statusText) {
  const recording = view === "recording";
  const processing = view === "processing";

  els.recorder.classList.toggle("is-recording", recording);
  els.recordBtn.disabled = processing;
  els.recordBtn.setAttribute("aria-label", recording ? "Stop recording" : "Start recording");
  els.recordBtn.hidden = view === "result";
  els.timer.hidden = !recording;
  els.spinner.hidden = !processing;

  els.status.hidden = view === "result";
  els.status.textContent =
    recording ? "Recording — tap to stop" :
    processing ? (statusText || "Processing…") :
    "Tap to record";

  els.error.hidden = view !== "error";
  els.result.hidden = view !== "result";
  els.logoutBtn.disabled = recording || processing;
}

function showError(message, canRetry) {
  els.errorMessage.textContent = message;
  els.retryBtn.hidden = !(canRetry && pending);
  els.discardBtn.textContent = pending ? "Discard & record again" : "Dismiss";
  setView("error");
  els.recordBtn.hidden = !!pending; // with a recording waiting, Retry/Discard are the choices
  els.status.hidden = !!pending;
}

function formatTime(total) {
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// ---------- Password gate ----------
// The password is kept in localStorage so it's only asked once per device.
// Every /api request sends it as `Authorization: Bearer <password>`; any 401 clears it.

const PASSWORD_KEY = "braindump.password";
let memoryPassword = null; // used when localStorage is unavailable (e.g. some private modes)

function getPassword() {
  try { return localStorage.getItem(PASSWORD_KEY) || memoryPassword; } catch { return memoryPassword; }
}

function setPassword(value) {
  memoryPassword = value;
  try {
    if (value === null) localStorage.removeItem(PASSWORD_KEY);
    else localStorage.setItem(PASSWORD_KEY, value);
  } catch { /* memory copy still works for this visit */ }
}

function authHeader() {
  const password = getPassword();
  return password ? { Authorization: `Bearer ${password}` } : {};
}

function showLogin(message) {
  els.appContent.hidden = true;
  els.logoutBtn.hidden = true;
  els.login.hidden = false;
  els.loginError.textContent = message || "";
  els.loginError.hidden = !message;
  els.passwordInput.value = "";
  els.passwordInput.focus();
}

function showApp() {
  els.login.hidden = true;
  els.appContent.hidden = false;
  els.logoutBtn.hidden = false;
}

function handleUnauthorized() {
  setPassword(null);
  showLogin("Your password was rejected. Please enter it again.");
}

async function submitLogin(event) {
  event.preventDefault();
  const password = els.passwordInput.value;
  const fail = (message) => {
    els.loginError.textContent = message;
    els.loginError.hidden = false;
  };

  if (!password) return fail("Enter the password.");
  // HTTP headers can only carry plain ASCII, so a password with Hebrew letters or emoji can't be sent.
  if (!/^[\x20-\x7E]+$/.test(password)) {
    return fail("The password can only contain English letters, numbers and standard symbols.");
  }

  els.loginBtn.disabled = true;
  els.loginError.hidden = true;
  try {
    const res = await fetch("/api/auth", { headers: { Authorization: `Bearer ${password}` } });
    if (res.status === 401) return fail("Wrong password.");
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return fail((body && body.error) || `Server error (HTTP ${res.status}).`);
    }
    setPassword(password);
    showApp();
    if (pending) send(); // a recording was waiting when the password was rejected
  } catch {
    fail("Network error — couldn't reach the server. Check your connection and try again.");
  } finally {
    els.loginBtn.disabled = false;
  }
}

function logOut() {
  setPassword(null);
  pending = null;
  lastResult = null;
  setView("idle");
  showLogin();
}

// ---------- Events ----------

els.login.addEventListener("submit", submitLogin);
els.logoutBtn.addEventListener("click", logOut);
els.recordBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
  else startRecording();
});
els.retryBtn.addEventListener("click", send);
els.discardBtn.addEventListener("click", () => { pending = null; setView("idle"); });
els.copyBtn.addEventListener("click", copyAll);
els.newBtn.addEventListener("click", () => { lastResult = null; setView("idle"); });

setView("idle");
if (getPassword()) showApp();
else showLogin();
