// CodeHedron LLM egress proxy — Cloudflare Worker.
//
// NVIDIA's gateway 504s requests from Google Cloud Run's egress IP at ~300s
// (measured: identical payload, 26s direct from a residential IP vs 303s/504
// through Cloud Run). This Worker gives NVIDIA calls a different egress while
// keeping the same request envelope as the Cloud Run proxy
// (POST /chat with { url, headers, body }).
//
// Differences from the Cloud Run proxy, on purpose:
// - allowlist pinned to NVIDIA (other providers stay on Cloud Run)
// - no header injection, no throttling (single-user; matches the fast direct
//   request shape exactly)
// - CORS: the browser calls this Worker cross-origin, so preflight and
//   response headers are required (Cloud Run got them from express cors()).

const ALLOWED_HOSTS = ['integrate.api.nvidia.com'];
const FORWARDED_HEADERS = ['authorization', 'content-type'];

function isAllowed(url) {
  try {
    return ALLOWED_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || '';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    // Requests without an Origin header (curl, server-side) are not subject
    // to CORS — only cross-origin browser calls are checked.
    if (origin && cors['Access-Control-Allow-Origin'] !== origin) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, cors);
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, cors);
    }

    let parsed;
    try {
      parsed = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Failed to parse request body', detail: e.message }, 400, cors);
    }

    const { url, headers, body } = parsed;
    if (!url || !isAllowed(url)) {
      return jsonResponse({ error: 'Invalid or disallowed URL' }, 400, cors);
    }

    const upstreamHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (FORWARDED_HEADERS.includes(k.toLowerCase()) && v) upstreamHeaders[k] = v;
    }
    if (!upstreamHeaders['Content-Type']) upstreamHeaders['Content-Type'] = 'application/json';

    let upstream;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(body),
      });
    } catch (e) {
      return jsonResponse({ error: 'Proxy request failed', detail: e.message }, 502, cors);
    }

    const responseHeaders = new Headers(cors);
    for (const name of ['content-type', 'retry-after']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    // Stream the (SSE) body straight through — pass status + Retry-After so
    // client-side rate-limit handling keeps working.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  },
};
