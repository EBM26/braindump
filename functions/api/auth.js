// GET /api/auth — lightweight password check for the login screen.
// The real check happens in _middleware.js; if a request gets here, the password was right.

export function onRequest({ request }) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Only GET is allowed." }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Allow: "GET" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
