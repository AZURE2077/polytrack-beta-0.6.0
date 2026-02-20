/**
 * PolyTrack API Proxy Worker
 * Proxies all requests from vps.kodub.com to this worker,
 * forwarding them to the real backend and returning responses.
 *
 * Deploy with: wrangler deploy
 */

const UPSTREAM = "https://vps.kodub.com";

// Endpoints the game uses
const ALLOWED_PATHS = [
  "/leaderboard",
  "/recordings",
  "/user",
  "/verifyRecordings",
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // Only proxy known API paths
    const path = url.pathname;
    if (!ALLOWED_PATHS.some((p) => path === p || path.startsWith(p + "?"))) {
      return corsResponse(new Response("Not found", { status: 404 }));
    }

    // Build upstream URL
    const upstreamUrl = new URL(path + url.search, UPSTREAM);

    // Forward the request
    const upstreamRequest = new Request(upstreamUrl.toString(), {
      method: request.method,
      headers: forwardHeaders(request.headers),
      body:
        request.method === "POST" || request.method === "PUT"
          ? request.body
          : undefined,
    });

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamRequest);
    } catch (err) {
      return corsResponse(
        new Response(JSON.stringify({ error: "Upstream unreachable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })
      );
    }

    // Clone and forward the response with CORS headers
    const responseBody = await upstreamResponse.arrayBuffer();
    const response = new Response(responseBody, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    });

    return corsResponse(response);
  },

  // WebSocket support for multiplayer
  async connect(request, env, ctx) {
    const url = new URL(request.url);
    const upstreamUrl =
      "wss://vps.kodub.com" + url.pathname + url.search;

    const [client, server] = Object.values(new WebSocketPair());

    const upstream = await fetch(upstreamUrl, {
      headers: request.headers,
      cf: { websocket: true },
    });

    const upstreamWs = upstream.webSocket;
    if (!upstreamWs) {
      return new Response("Upstream WebSocket failed", { status: 502 });
    }

    server.accept();
    upstreamWs.accept();

    // Pipe client -> upstream
    server.addEventListener("message", (event) => {
      upstreamWs.send(event.data);
    });

    server.addEventListener("close", (event) => {
      upstreamWs.close(event.code, event.reason);
    });

    // Pipe upstream -> client
    upstreamWs.addEventListener("message", (event) => {
      server.send(event.data);
    });

    upstreamWs.addEventListener("close", (event) => {
      server.close(event.code, event.reason);
    });

    upstreamWs.addEventListener("error", () => {
      server.close(1011, "Upstream error");
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  },
};

function forwardHeaders(incoming) {
  const headers = new Headers();
  for (const [key, value] of incoming.entries()) {
    // Skip headers that cause issues when forwarding
    const skip = [
      "host",
      "cf-connecting-ip",
      "cf-ipcountry",
      "cf-ray",
      "cf-visitor",
      "x-forwarded-for",
      "x-forwarded-proto",
      "x-real-ip",
    ];
    if (!skip.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  // Tell upstream who we are
  headers.set("Host", "vps.kodub.com");
  return headers;
}

function corsResponse(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  newHeaders.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  newHeaders.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  newHeaders.set("Access-Control-Max-Age", "86400");

  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}
