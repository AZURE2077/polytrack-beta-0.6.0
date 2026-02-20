/**
 * PolyTrack API Proxy Worker
 * Proxies all requests to vps.kodub.com:43274
 * Handles /v6/ path prefix and port that Cloudflare workers can't bind to.
 *
 * Deploy with: wrangler deploy
 */

const UPSTREAM = "https://vps.kodub.com:43274";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // Strip versioned path prefix e.g. /v6/leaderboard -> /leaderboard
    const cleanPath = url.pathname.replace(/^\/v\d+/, "");

    // Only proxy known API paths
    const ALLOWED_PATHS = ["/leaderboard", "/recordings", "/user", "/verifyRecordings"];
    if (!ALLOWED_PATHS.includes(cleanPath)) {
      return corsResponse(new Response("Not found", { status: 404 }));
    }

    // Build upstream URL with correct port
    const upstreamUrl = new URL(cleanPath + url.search, UPSTREAM);

    const upstreamRequest = new Request(upstreamUrl.toString(), {
      method: request.method,
      headers: forwardHeaders(request.headers),
      body: request.method === "POST" || request.method === "PUT" ? request.body : undefined,
    });

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamRequest);
    } catch (err) {
      return corsResponse(
        new Response(JSON.stringify({ error: "Upstream unreachable: " + err.message }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    const responseBody = await upstreamResponse.arrayBuffer();
    const response = new Response(responseBody, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    });

    return corsResponse(response);
  },
};

function forwardHeaders(incoming) {
  const headers = new Headers();
  const skip = ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto", "x-real-ip"];
  for (const [key, value] of incoming.entries()) {
    if (!skip.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  headers.set("Host", "vps.kodub.com");
  return headers;
}

function corsResponse(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  newHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  newHeaders.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}
