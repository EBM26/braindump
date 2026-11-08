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
  { key: "tasks", type: "task", title: "Tasks" },
  { key: "ideas", type: "idea", title: "Ideas" },
  { key: "open_questions", type: "open_question", title: "Open questions" },
  { key: "notes", type: "note", title: "Notes" },
];
const KEY_FOR_TYPE = Object.fromEntries(SECTIONS.map((s) => [s.type, s.key]));
const TYPE_LABELS = { task: "Task", idea: "Idea", open_question: "Open question", note: "Note" };
const TYPE_WITH_ARTICLE = { task: "a task", idea: "an idea", open_question: "an open question", note: "a note" };

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
  saveStatus: $("saveStatus"),
  tabButtons: [...document.querySelectorAll(".tabbar__btn")],
  views: { record: $("view-record"), tasks: $("view-tasks"), notes: $("view-notes"), history: $("view-history") },
  noteChips: [...document.querySelectorAll("#view-notes .chip")],
  notesMessage: $("notesMessage"),
  notesList: $("notesList"),
  editDialog: $("editDialog"),
  editForm: $("editForm"),
  editText: $("editText"),
  editType: $("editType"),
  editTypeHint: $("editTypeHint"),
  editProject: $("editProject"),
  editNewProject: $("editNewProject"),
  editDueField: $("editDueField"),
  editDue: $("editDue"),
  editClearDue: $("editClearDue"),
  editDueHint: $("editDueHint"),
  editError: $("editError"),
  editSaveBtn: $("editSaveBtn"),
  editCancelBtn: $("editCancelBtn"),
  editDeleteBtn: $("editDeleteBtn"),
  editDeleteConfirm: $("editDeleteConfirm"),
  editDeleteYesBtn: $("editDeleteYesBtn"),
  editDeleteNoBtn: $("editDeleteNoBtn"),
  showCompleted: $("showCompleted"),
  tasksMessage: $("tasksMessage"),
  tasksList: $("tasksList"),
  historyListView: $("historyListView"),
  historyMessage: $("historyMessage"),
  historyList: $("historyList"),
  loadMoreBtn: $("loadMoreBtn"),
  dumpDetail: $("dumpDetail"),
  backBtn: $("backBtn"),
  detailMeta: $("detailMeta"),
  detailMessage: $("detailMessage"),
  detailBody: $("detailBody"),
  detailTranscript: $("detailTranscript"),
  detailTranscriptBox: $("detailTranscriptBox"),
  deleteBtn: $("deleteBtn"),
  deleteConfirm: $("deleteConfirm"),
  deleteConfirmText: $("deleteConfirmText"),
  deleteYesBtn: $("deleteYesBtn"),
  deleteNoBtn: $("deleteNoBtn"),
  modelInfo: $("modelInfo"),
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
let pending = null; // { blob, mimeType, durationSec } kept until a successful result, for Retry
let lastResult = null;
let micStarting = false;

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

  // The mic can take a few seconds to start (permission prompt, first use). Ignore taps meanwhile,
  // otherwise a second tap would start a second recording instead of stopping this one.
  if (micStarting) return;
  micStarting = true;
  els.recordBtn.disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    showError(denied
      ? "Microphone access was blocked. Allow it in your browser settings and try again."
      : `Couldn't start the microphone: ${err && err.message ? err.message : err}`, false);
    return;
  } finally {
    micStarting = false;
    els.recordBtn.disabled = false;
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
  const durationSec = Math.min(MAX_SECONDS, Math.round((Date.now() - startedAt) / 1000));
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
    pending = { ...(await prepareUpload(blob, recordedType)), durationSec };
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
    res = await fetch(`/api/dump?duration_sec=${pending.durationSec}`, {
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
  renderSections(els.resultBody, data);
  els.transcript.textContent = data.transcript || "(empty)";
  els.transcriptBox.open = false;

  els.modelInfo.textContent = data.model ? `Organized by ${data.model}` : "";
  els.modelInfo.hidden = !data.model;

  // Saved to the database? (Gemini can succeed while saving fails; the result is still shown.)
  els.saveStatus.hidden = false;
  if (data.saved) {
    els.saveStatus.className = "save-status save-status--ok";
    els.saveStatus.textContent = "✓ Saved";
  } else {
    els.saveStatus.className = "save-status save-status--warn";
    els.saveStatus.textContent = `Not saved${data.save_error ? ` (${data.save_error})` : ""}. Use Copy all to keep it.`;
  }
}

// Summary + Tasks/Ideas/Open questions/Notes for a dump. Used by Record results and History.
// With `editorFor(item)` (dump detail), each item opens the editor when tapped.
function renderSections(container, data, editorFor = null) {
  container.replaceChildren();
  const nothing = !data.summary && SECTIONS.every((s) => !data[s.key].length);

  const summary = section("Summary");
  const p = document.createElement("p");
  if (nothing) {
    p.className = "empty";
    p.textContent = "Nothing intelligible came through.";
  } else {
    p.dir = "auto";
    p.textContent = data.summary;
  }
  summary.append(p);
  container.append(summary);

  for (const { key, title } of SECTIONS) {
    const items = data[key];
    if (!items.length) continue;
    const sec = section(title);
    const ul = document.createElement("ul");
    ul.className = "items";
    for (const item of items) {
      const li = document.createElement("li");
      if (item.done) li.className = "task--done";
      const content = itemContent(item);
      li.append(editorFor ? editButton(item, content, editorFor(item)) : content);
      ul.append(li);
    }
    sec.append(ul);
    container.append(sec);
  }
}

// An item's text and tags. dir="auto" so Hebrew items read right-to-left.
function itemContent(item, { today = "", showProject = true, showType = false, showDate = false } = {}) {
  const content = document.createElement("span");
  content.className = "item__content";
  content.dir = "auto";
  const text = document.createElement("span");
  text.className = "task__body";
  text.textContent = item.text;
  content.append(text);

  if (showType) content.append(tag(TYPE_LABELS[item.type], "tag--type"));
  if (showProject && item.project) content.append(tag(item.project));
  const due = dueLabel(item);
  if (due) {
    const overdue = !item.done && item.due_date && today && item.due_date < today;
    const dueTag = tag(overdue ? `Overdue · ${due}` : due, overdue ? "tag--due tag--overdue" : "tag--due");
    if (item.due_date && item.due_text) dueTag.title = item.due_text; // what was actually said
    content.append(dueTag);
  }
  if (showDate && item.dump_created_at) {
    const date = document.createElement("span");
    date.className = "item__date";
    date.textContent = formatShortDate(item.dump_created_at);
    content.append(date);
  }
  return content;
}

// Wraps item content in a button that opens the editor.
function editButton(item, content, handlers) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "item-edit";
  const hint = document.createElement("span");
  hint.className = "item-edit__hint";
  hint.setAttribute("aria-hidden", "true");
  hint.textContent = "✎";
  const label = document.createElement("span");
  label.className = "visually-hidden";
  label.textContent = " (edit)";
  btn.append(content, label, hint);
  btn.addEventListener("click", () => openEditor(item, handlers));
  return btn;
}

function formatShortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// "Fri, Nov 6" when a date was resolved, otherwise the spoken wording ("soon").
function dueLabel(item) {
  if (item.due_date) return formatDay(item.due_date);
  return item.due_text || "";
}

function formatDay(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
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
      if (item.due_text || item.due_date) {
        line += ` (due: ${[item.due_text, item.due_date].filter(Boolean).join(" → ")})`;
      }
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

// ---------- API helper (JSON endpoints) ----------

class AuthError extends Error {}

// Calls a JSON API endpoint with the password. Throws Error(readable message) on failure,
// or AuthError after a 401 (the password screen is already showing by then).
async function api(path, options = {}) {
  const headers = { ...authHeader(), ...(options.body ? { "Content-Type": "application/json" } : {}) };
  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch {
    throw new Error("Network error — couldn't reach the server.");
  }
  if (res.status === 401) {
    handleUnauthorized();
    throw new AuthError("Password rejected");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error) || `Server error (HTTP ${res.status}).`);
  return body;
}

function setMessage(el, text, isError = false) {
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("view-message--error", isError);
}

// ---------- Tabs ----------

function showTab(name) {
  for (const btn of els.tabButtons) {
    if (btn.dataset.tab === name) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  for (const [key, view] of Object.entries(els.views)) view.hidden = key !== name;
  window.scrollTo(0, 0);

  // Always reload, so a dump recorded a moment ago shows up right away.
  if (name !== "record") refreshProjects(); // so the editor's project picker is ready when opened
  if (name === "tasks") loadTasks();
  if (name === "notes") loadNotes();
  if (name === "history") {
    showHistoryList();
    loadHistory(true);
  }
}

// ---------- Tasks view ----------

let tasksState = { tasks: [], today: "" };
let tasksRequestId = 0;

async function loadTasks() {
  const requestId = ++tasksRequestId;
  if (!tasksState.tasks.length) setMessage(els.tasksMessage, "Loading…");
  try {
    const status = els.showCompleted.checked ? "all" : "open";
    const data = await api(`/api/tasks?status=${status}`);
    if (requestId !== tasksRequestId) return; // a newer load replaced this one
    tasksState = data;
    renderTasks();
  } catch (err) {
    if (err instanceof AuthError || requestId !== tasksRequestId) return;
    setMessage(els.tasksMessage, `Couldn't load tasks: ${err.message}`, true);
  }
}

// Grouped by project (alphabetical), with tasks that have no project in "Other" at the end.
function renderTasks() {
  const { tasks, today } = tasksState;
  els.tasksList.replaceChildren();
  if (!tasks.length) {
    setMessage(els.tasksMessage, els.showCompleted.checked ? "No tasks yet." : "No open tasks.");
    return;
  }
  setMessage(els.tasksMessage, null);

  for (const [name, groupTasks] of groupByProject(tasks)) {
    const group = document.createElement("section");
    group.className = "section task-group";
    const heading = document.createElement("h3");
    heading.dir = "auto";
    heading.textContent = name || "Other";
    group.append(heading);
    for (const task of groupTasks) group.append(taskRow(task, today));
    els.tasksList.append(group);
  }
}

function taskRow(task, today) {
  const row = document.createElement("div");
  row.className = task.done ? "task task--done" : "task";

  // The checkbox has its own (larger) tap area; tapping the text opens the editor.
  const check = document.createElement("label");
  check.className = "task__check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = task.done;
  box.setAttribute("aria-label", `Done: ${task.text}`);
  check.append(box);

  // Optimistic: update the row immediately, revert if the server says no.
  box.addEventListener("change", async () => {
    const done = box.checked;
    row.classList.toggle("task--done", done);
    box.disabled = true;
    try {
      const updated = await api(`/api/items/${task.id}`, { method: "PATCH", body: JSON.stringify({ done }) });
      Object.assign(task, updated);
      setMessage(els.tasksMessage, null);
    } catch (err) {
      box.checked = !done;
      row.classList.toggle("task--done", !done);
      if (!(err instanceof AuthError)) setMessage(els.tasksMessage, `Couldn't update the task: ${err.message}`, true);
    } finally {
      box.disabled = false;
    }
  });

  const content = itemContent(task, { today, showProject: false });
  row.append(check, editButton(task, content, {
    onSaved(updated) {
      const list = tasksState.tasks;
      const i = list.indexOf(task);
      if (i === -1) return;
      const moved = updated.type !== "task";
      if (moved) list.splice(i, 1);
      else list[i] = { dump_created_at: task.dump_created_at, ...updated };
      sortTasks(list);
      renderTasks();
      if (moved) setMessage(els.tasksMessage, `Changed to ${TYPE_WITH_ARTICLE[updated.type]}. It's in the Notes tab now.`);
    },
    onDeleted() {
      tasksState.tasks = tasksState.tasks.filter((t) => t !== task);
      renderTasks();
    },
  }));
  return row;
}

// Same order as the server: tasks with a due date first (soonest first); otherwise unchanged.
function sortTasks(list) {
  list.sort((a, b) => (a.due_date === null) - (b.due_date === null) || (a.due_date || "").localeCompare(b.due_date || ""));
}

// ---------- Notes view (ideas, open questions, notes) ----------

let notesState = { notes: [], filter: "all" };
let notesRequestId = 0;

async function loadNotes() {
  const requestId = ++notesRequestId;
  if (!notesState.notes.length) setMessage(els.notesMessage, "Loading…");
  try {
    const data = await api("/api/notes");
    if (requestId !== notesRequestId) return;
    notesState.notes = data.notes;
    renderNotes();
  } catch (err) {
    if (err instanceof AuthError || requestId !== notesRequestId) return;
    setMessage(els.notesMessage, `Couldn't load notes: ${err.message}`, true);
  }
}

function setNotesFilter(filter) {
  notesState.filter = filter;
  for (const chip of els.noteChips) chip.setAttribute("aria-pressed", String(chip.dataset.filter === filter));
  renderNotes();
}

// Newest first, grouped by project like Tasks (alphabetical, "Other" last).
function renderNotes() {
  const { filter } = notesState;
  const notes = notesState.notes.filter((n) => filter === "all" || n.type === filter);
  els.notesList.replaceChildren();
  if (!notes.length) {
    const empty = { all: "No ideas, open questions or notes yet.", idea: "No ideas yet.",
      open_question: "No open questions yet.", note: "No notes yet." };
    setMessage(els.notesMessage, empty[filter]);
    return;
  }
  setMessage(els.notesMessage, null);

  for (const [name, group] of groupByProject(notes)) {
    const sec = document.createElement("section");
    sec.className = "section task-group";
    const heading = document.createElement("h3");
    heading.dir = "auto";
    heading.textContent = name || "Other";
    const ul = document.createElement("ul");
    ul.className = "items";
    for (const note of group) {
      const li = document.createElement("li");
      const content = itemContent(note, { showProject: false, showType: filter === "all", showDate: true });
      li.append(editButton(note, content, noteEditHandlers(note)));
      ul.append(li);
    }
    sec.append(heading, ul);
    els.notesList.append(sec);
  }
}

function noteEditHandlers(note) {
  return {
    onSaved(updated) {
      const list = notesState.notes;
      const i = list.indexOf(note);
      if (i === -1) return;
      const moved = updated.type === "task";
      if (moved) list.splice(i, 1);
      else list[i] = { dump_created_at: note.dump_created_at, ...updated };
      renderNotes();
      if (moved) setMessage(els.notesMessage, "Changed to a task. It's in the Tasks tab now.");
    },
    onDeleted() {
      notesState.notes = notesState.notes.filter((n) => n !== note);
      renderNotes();
    },
  };
}

// [[projectName, items], …] alphabetical, with items that have no project ("") last.
function groupByProject(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.project || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const names = [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (groups.has("")) names.push("");
  return names.map((name) => [name, groups.get(name)]);
}

// ---------- History view ----------

const HISTORY_PAGE_SIZE = 20;
let history = { dumps: [], nextCursor: null, loading: false, requestId: 0 };
let currentDump = null;

async function loadHistory(reset) {
  if (history.loading && !reset) return;
  const requestId = ++history.requestId;
  history.loading = true;
  if (reset) {
    history.dumps = [];
    history.nextCursor = null;
    els.historyList.replaceChildren();
    els.loadMoreBtn.hidden = true;
    setMessage(els.historyMessage, "Loading…");
  }
  els.loadMoreBtn.disabled = true;

  try {
    const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
    if (!reset && history.nextCursor) query.set("cursor", history.nextCursor);
    const data = await api(`/api/dumps?${query}`);
    if (requestId !== history.requestId) return;
    history.dumps.push(...data.dumps);
    history.nextCursor = data.next_cursor;
    for (const dump of data.dumps) els.historyList.append(historyRow(dump));
    setMessage(els.historyMessage, history.dumps.length ? null : "No dumps yet. Record one!");
  } catch (err) {
    if (err instanceof AuthError || requestId !== history.requestId) return;
    setMessage(els.historyMessage, `Couldn't load history: ${err.message}`, true);
  } finally {
    if (requestId === history.requestId) {
      history.loading = false;
      els.loadMoreBtn.disabled = false;
      els.loadMoreBtn.hidden = !history.nextCursor;
    }
  }
}

function historyRow(dump) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "history-item";

  const date = document.createElement("div");
  date.className = "history-item__date";
  date.textContent = formatDateTime(dump.created_at);

  const summary = document.createElement("p");
  summary.className = "history-item__summary";
  summary.dir = "auto";
  summary.textContent = dump.summary || "(no summary)";

  const counts = document.createElement("div");
  counts.className = "history-item__counts";
  counts.textContent = countsText(dump.counts);

  btn.append(date, summary, counts);
  btn.addEventListener("click", () => openDump(dump.id));
  li.append(btn);
  return li;
}

function countsText(counts) {
  const part = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : null);
  const parts = [
    part(counts.tasks, "task", "tasks"),
    part(counts.ideas, "idea", "ideas"),
    part(counts.open_questions, "open question", "open questions"),
    part(counts.notes, "note", "notes"),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No items";
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function showHistoryList() {
  currentDump = null;
  els.dumpDetail.hidden = true;
  els.historyListView.hidden = false;
}

async function openDump(id) {
  els.historyListView.hidden = true;
  els.dumpDetail.hidden = false;
  els.detailBody.replaceChildren();
  els.detailMeta.textContent = "";
  els.detailTranscript.textContent = "";
  els.detailTranscriptBox.hidden = true;
  els.deleteBtn.hidden = true;
  els.deleteConfirm.hidden = true;
  setMessage(els.detailMessage, "Loading…");
  window.scrollTo(0, 0);

  try {
    const dump = await api(`/api/dumps/${id}`);
    currentDump = dump;
    setMessage(els.detailMessage, null);
    els.detailMeta.textContent = [
      formatDateTime(dump.created_at),
      dump.duration_sec != null ? formatTime(dump.duration_sec) : null,
      dump.model,
    ].filter(Boolean).join(" · ");
    renderSections(els.detailBody, dump, detailEditHandlers);
    els.detailTranscript.textContent = dump.transcript || "(empty)";
    els.detailTranscriptBox.open = false;
    els.detailTranscriptBox.hidden = false;
    els.deleteBtn.hidden = false;
  } catch (err) {
    if (err instanceof AuthError) return;
    setMessage(els.detailMessage, `Couldn't open this dump: ${err.message}`, true);
  }
}

function detailEditHandlers(item) {
  const dump = currentDump;
  const refresh = () => { if (currentDump === dump) renderSections(els.detailBody, dump, detailEditHandlers); };
  return {
    onSaved(updated) {
      const from = dump[KEY_FOR_TYPE[item.type]];
      const i = from.indexOf(item);
      if (i === -1) return;
      if (updated.type === item.type) from[i] = updated;
      else {
        from.splice(i, 1);
        dump[KEY_FOR_TYPE[updated.type]].push(updated);
      }
      refresh();
    },
    onDeleted() {
      const from = dump[KEY_FOR_TYPE[item.type]];
      const i = from.indexOf(item);
      if (i !== -1) from.splice(i, 1);
      refresh();
    },
  };
}

function askDelete() {
  if (!currentDump) return;
  const itemCount = SECTIONS.reduce((n, s) => n + currentDump[s.key].length, 0);
  els.deleteConfirmText.textContent =
    `Delete this dump and its ${itemCount} item${itemCount === 1 ? "" : "s"} (including its tasks)? This can't be undone.`;
  els.deleteBtn.hidden = true;
  els.deleteConfirm.hidden = false;
}

async function confirmDelete() {
  if (!currentDump) return;
  els.deleteYesBtn.disabled = true;
  try {
    await api(`/api/dumps/${currentDump.id}`, { method: "DELETE" });
    showHistoryList();
    loadHistory(true);
  } catch (err) {
    if (err instanceof AuthError) return;
    setMessage(els.detailMessage, `Couldn't delete: ${err.message}`, true);
  } finally {
    els.deleteYesBtn.disabled = false;
  }
}

function cancelDelete() {
  els.deleteConfirm.hidden = true;
  els.deleteBtn.hidden = false;
}

// ---------- Item editor ----------
// One dialog shared by Tasks, Notes and the dump detail. Each caller passes handlers
// { onSaved(updatedItem), onDeleted() } to update its own list after the server confirms.

const NEW_PROJECT = " new"; // projects are trimmed, so no real project starts with a space
let editState = null; // { item, handlers, dueTouched }
let projectsCache = [];

function openEditor(item, handlers) {
  editState = { item, handlers, dueTouched: false };
  els.editText.value = item.text;
  els.editType.value = item.type;
  fillProjectSelect(item.project || "");
  els.editNewProject.value = "";
  els.editNewProject.hidden = true;
  els.editDue.value = item.due_date || "";
  els.editDueHint.textContent = item.due_text ? `You said: “${item.due_text}”` : "";
  els.editDueHint.hidden = !item.due_text;
  updateEditorForType();
  setMessage(els.editError, null);
  els.editDeleteConfirm.hidden = true;
  els.editDeleteBtn.hidden = false;
  setEditorBusy(false);
  els.editDialog.showModal();
  refreshProjects();
}

function closeEditor() {
  if (els.editDialog.open) els.editDialog.close();
  editState = null;
}

function fillProjectSelect(selected) {
  const names = [...projectsCache];
  if (selected && !names.includes(selected)) names.push(selected);
  names.sort((a, b) => a.localeCompare(b));
  const option = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  };
  els.editProject.replaceChildren(
    option("", "No project"),
    ...names.map((name) => option(name, name)),
    option(NEW_PROJECT, "New project…"),
  );
  els.editProject.value = selected;
}

// Refresh the project list in the background; the current choice stays selected.
async function refreshProjects() {
  try {
    const data = await api("/api/projects");
    projectsCache = data.projects;
    if (editState && els.editProject.value !== NEW_PROJECT) fillProjectSelect(els.editProject.value);
  } catch { /* the cached list is good enough */ }
}

function updateEditorForType() {
  if (!editState) return;
  const isTask = els.editType.value === "task";
  els.editDueField.hidden = !isTask;
  els.editTypeHint.hidden = !(editState.item.type === "task" && !isTask);
}

function onEditProjectChange() {
  const isNew = els.editProject.value === NEW_PROJECT;
  els.editNewProject.hidden = !isNew;
  if (isNew) els.editNewProject.focus();
}

function onEditDueChange() {
  if (!editState) return;
  editState.dueTouched = true;
  els.editDueHint.hidden = true; // a picked date replaces what was said
}

function setEditorBusy(busy) {
  for (const el of [els.editSaveBtn, els.editCancelBtn, els.editDeleteBtn, els.editDeleteYesBtn, els.editDeleteNoBtn]) {
    el.disabled = busy;
  }
}

async function saveEdit(event) {
  event.preventDefault();
  if (!editState) return;
  const { item, handlers } = editState;

  const text = els.editText.value.trim();
  if (!text) return setMessage(els.editError, "The text can't be empty.", true);
  let project = els.editProject.value;
  if (project === NEW_PROJECT) {
    project = els.editNewProject.value.trim();
    if (!project) return setMessage(els.editError, "Type a name for the new project.", true);
  }
  const type = els.editType.value;

  // Send only what changed.
  const patch = {};
  if (text !== item.text) patch.text = text;
  if (type !== item.type) patch.type = type;
  if (project !== (item.project || "")) patch.project = project || null;
  if (type === "task" && editState.dueTouched) {
    const due = els.editDue.value || null;
    if (due !== (item.due_date || null) || item.due_text) patch.due_date = due; // also clears due_text
  }
  if (!Object.keys(patch).length) return closeEditor();

  setEditorBusy(true);
  els.editSaveBtn.textContent = "Saving…";
  try {
    const updated = await api(`/api/items/${item.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    closeEditor();
    handlers.onSaved(updated);
  } catch (err) {
    if (!(err instanceof AuthError)) setMessage(els.editError, `Couldn't save: ${err.message}`, true);
  } finally {
    setEditorBusy(false);
    els.editSaveBtn.textContent = "Save";
  }
}

function askDeleteItem() {
  els.editDeleteBtn.hidden = true;
  els.editDeleteConfirm.hidden = false;
}

function cancelDeleteItem() {
  els.editDeleteConfirm.hidden = true;
  els.editDeleteBtn.hidden = false;
}

async function confirmDeleteItem() {
  if (!editState) return;
  const { item, handlers } = editState;
  setEditorBusy(true);
  try {
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    closeEditor();
    handlers.onDeleted();
  } catch (err) {
    if (!(err instanceof AuthError)) setMessage(els.editError, `Couldn't delete: ${err.message}`, true);
  } finally {
    setEditorBusy(false);
  }
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
  closeEditor();
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
  // Don't leave saved data on screen after logging out.
  closeEditor();
  tasksState = { tasks: [], today: "" };
  els.tasksList.replaceChildren();
  notesState = { notes: [], filter: "all" };
  setNotesFilter("all");
  projectsCache = [];
  els.historyList.replaceChildren();
  els.detailBody.replaceChildren();
  els.detailTranscript.textContent = "";
  showTab("record");
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
for (const btn of els.tabButtons) btn.addEventListener("click", () => showTab(btn.dataset.tab));
els.showCompleted.addEventListener("change", loadTasks);
els.loadMoreBtn.addEventListener("click", () => loadHistory(false));
els.backBtn.addEventListener("click", showHistoryList);
els.deleteBtn.addEventListener("click", askDelete);
els.deleteYesBtn.addEventListener("click", confirmDelete);
els.deleteNoBtn.addEventListener("click", cancelDelete);
for (const chip of els.noteChips) chip.addEventListener("click", () => setNotesFilter(chip.dataset.filter));
els.editForm.addEventListener("submit", saveEdit);
els.editCancelBtn.addEventListener("click", closeEditor);
els.editType.addEventListener("change", updateEditorForType);
els.editProject.addEventListener("change", onEditProjectChange);
els.editDue.addEventListener("input", onEditDueChange);
els.editDue.addEventListener("change", onEditDueChange);
els.editClearDue.addEventListener("click", () => {
  els.editDue.value = "";
  onEditDueChange();
});
els.editDeleteBtn.addEventListener("click", askDeleteItem);
els.editDeleteYesBtn.addEventListener("click", confirmDeleteItem);
els.editDeleteNoBtn.addEventListener("click", cancelDeleteItem);
els.editDialog.addEventListener("close", () => { editState = null; }); // also covers Escape
// Tapping the backdrop closes the editor (the dialog itself has no padding, so only the backdrop hits it).
els.editDialog.addEventListener("click", (e) => { if (e.target === els.editDialog) closeEditor(); });

// Load the next History page automatically when "Load more" scrolls into view.
if ("IntersectionObserver" in window) {
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && !els.loadMoreBtn.hidden && !els.historyListView.hidden) {
      loadHistory(false);
    }
  }).observe(els.loadMoreBtn);
}

setView("idle");
if (getPassword()) showApp();
else showLogin();
