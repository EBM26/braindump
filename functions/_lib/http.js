// Small JSON response helpers shared by every function.
// (No onRequest export, so this is not a route.)

export function json(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

export function jsonError(status, message, extraHeaders) {
  return json(status, { error: message }, extraHeaders);
}

export function methodNotAllowed(allowed) {
  return jsonError(405, `Only ${allowed.join(", ")} allowed.`, { Allow: allowed.join(", ") });
}

/** Parses a JSON request body. Returns { ok: true, value } or { ok: false, response } (a 400). */
export async function readJsonBody(request) {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, response: jsonError(400, "Request body must be a JSON object.") };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, response: jsonError(400, "Request body must be valid JSON.") };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === "string" && UUID_RE.test(value);

/** A real YYYY-MM-DD calendar date (rejects 2026-02-30). */
export function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
