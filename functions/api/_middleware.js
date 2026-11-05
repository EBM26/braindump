// Password gate for every /api/* route. Pages Functions runs this before any
// handler under functions/api/, so new endpoints are protected automatically.
//
// The browser sends:  Authorization: Bearer <APP_PASSWORD>
// Fails closed: if APP_PASSWORD isn't set, every API request is refused.

export async function onRequest({ request, env, next }) {
  const expected = env.APP_PASSWORD;
  if (typeof expected !== "string" || expected.trim() === "") {
    return jsonError(
      503,
      "The server has no APP_PASSWORD set, so all API requests are refused. Add it to .dev.vars (local) or as a Secret in the Pages project settings, then redeploy."
    );
  }

  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match || !(await passwordsMatch(match[1], expected))) {
    return jsonError(401, "Wrong or missing password.", { "WWW-Authenticate": 'Bearer realm="braindump"' });
  }

  return next();
}

// Constant-time comparison. Hashing first gives two equal-length buffers
// (timingSafeEqual requires that), so the password's length isn't revealed either.
async function passwordsMatch(given, expected) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function jsonError(status, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}
