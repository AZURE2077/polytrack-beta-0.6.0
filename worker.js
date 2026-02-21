/**
 * PolyTrack Backend — Cloudflare Workers + D1 + Durable Objects
 *
 * Endpoints:
 *   GET  /v6/leaderboard
 *   POST /v6/leaderboard
 *   GET  /v6/user
 *   POST /v6/user
 *   WS   /v6/multiplayer  (via Durable Object)
 */

// ─── HTTP Router ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    // Route WebSocket upgrades to Durable Object
    if (request.headers.get("Upgrade") === "websocket") {
      const roomId = url.searchParams.get("roomId") || "global";
      const id = env.MULTIPLAYER_ROOM.idFromName(roomId);
      const room = env.MULTIPLAYER_ROOM.get(id);
      return room.fetch(request);
    }

    const path = url.pathname.replace(/^\/v\d+/, ""); // strip /v6 etc.

    try {
      if (path === "/leaderboard" && request.method === "GET") {
        return cors(await handleGetLeaderboard(request, env));
      }
      if (path === "/leaderboard" && request.method === "POST") {
        return cors(await handlePostLeaderboard(request, env));
      }
      if (path === "/user" && request.method === "GET") {
        return cors(await handleGetUser(request, env));
      }
      if (path === "/user" && request.method === "POST") {
        return cors(await handlePostUser(request, env));
      }
      return cors(new Response("Not found", { status: 404 }));
    } catch (err) {
      console.error(err);
      return cors(new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }));
    }
  },
};

// ─── Leaderboard ─────────────────────────────────────────────────────────────

async function handleGetLeaderboard(request, env) {
  const url = new URL(request.url);
  const trackId = url.searchParams.get("trackId");
  const skip = parseInt(url.searchParams.get("skip") || "0");
  const amount = parseInt(url.searchParams.get("amount") || "20");
  const onlyVerified = url.searchParams.get("onlyVerified") === "true";
  const userTokenHash = url.searchParams.get("userTokenHash");

  if (!trackId) return jsonResp({ error: "Missing trackId" }, 400);

  const verifiedClause = onlyVerified ? "AND verified = 1" : "";

  const { results } = await env.DB.prepare(`
    SELECT e.id, e.user_token_hash as userId, u.nickname as name,
           e.frames, u.car_colors as carColors
    FROM leaderboard_entries e
    JOIN users u ON u.token_hash = e.user_token_hash
    WHERE e.track_id = ? ${verifiedClause}
    ORDER BY e.frames ASC
    LIMIT ? OFFSET ?
  `).bind(trackId, amount, skip).all();

  const { results: countResult } = await env.DB.prepare(`
    SELECT COUNT(*) as total FROM leaderboard_entries
    WHERE track_id = ? ${verifiedClause}
  `).bind(trackId).all();

  const total = countResult[0]?.total || 0;

  let userEntry = null;
  if (userTokenHash) {
    const { results: userRows } = await env.DB.prepare(`
      SELECT id, frames,
        (SELECT COUNT(*) FROM leaderboard_entries
         WHERE track_id = ? ${verifiedClause} AND frames <= e.frames) - 1 as position
      FROM leaderboard_entries e
      WHERE track_id = ? AND user_token_hash = ?
      ORDER BY frames ASC LIMIT 1
    `).bind(trackId, trackId, userTokenHash).all();

    if (userRows.length > 0) {
      userEntry = {
        id: userRows[0].id,
        frames: userRows[0].frames,
        position: userRows[0].position,
      };
    }
  }

  return jsonResp({ total, entries: results, userEntry });
}

async function handlePostLeaderboard(request, env) {
  const body = await parseFormBody(request);
  const { userToken, name, carColors, trackId, frames, recording } = body;

  if (!userToken || !trackId || !frames || !recording) {
    return jsonResp({ error: "Missing required fields" }, 400);
  }

  const tokenHash = await sha256(userToken);
  const framesInt = parseInt(frames);

  // Upsert user
  await env.DB.prepare(`
    INSERT INTO users (token_hash, nickname, car_colors)
    VALUES (?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET
      nickname = excluded.nickname,
      car_colors = excluded.car_colors
  `).bind(tokenHash, name || "Anonymous", carColors || "").run();

  // Check if user already has a better time
  const { results: existing } = await env.DB.prepare(`
    SELECT id, frames FROM leaderboard_entries
    WHERE track_id = ? AND user_token_hash = ?
    ORDER BY frames ASC LIMIT 1
  `).bind(trackId, tokenHash).all();

  let uploadId;
  let previousPosition = null;
  let newPosition = null;

  if (existing.length > 0 && existing[0].frames <= framesInt) {
    // Existing time is better — still return their entry id
    return jsonResp({ uploadId: existing[0].id, previousPosition: null, newPosition: null });
  }

  if (existing.length > 0) {
    // Update existing entry
    await env.DB.prepare(`
      UPDATE leaderboard_entries
      SET frames = ?, recording = ?, verified = 0
      WHERE id = ?
    `).bind(framesInt, recording, existing[0].id).run();
    uploadId = existing[0].id;
  } else {
    // Insert new entry
    const { meta } = await env.DB.prepare(`
      INSERT INTO leaderboard_entries (track_id, user_token_hash, frames, recording, verified)
      VALUES (?, ?, ?, ?, 0)
    `).bind(trackId, tokenHash, framesInt, recording).run();
    uploadId = meta.last_row_id;
  }

  // Calculate new position
  const { results: posResult } = await env.DB.prepare(`
    SELECT COUNT(*) as pos FROM leaderboard_entries
    WHERE track_id = ? AND frames < ?
  `).bind(trackId, framesInt).all();

  newPosition = posResult[0]?.pos ?? null;

  return jsonResp({ uploadId, previousPosition, newPosition });
}

// ─── User ─────────────────────────────────────────────────────────────────────

async function handleGetUser(request, env) {
  const url = new URL(request.url);
  const userToken = url.searchParams.get("userToken");
  if (!userToken) return jsonResp(null);

  const tokenHash = await sha256(userToken);
  const { results } = await env.DB.prepare(`
    SELECT nickname as name, car_colors as carColors
    FROM users WHERE token_hash = ?
  `).bind(tokenHash).all();

  if (results.length === 0) return jsonResp(null);
  return jsonResp({ ...results[0], isVerifier: false });
}

async function handlePostUser(request, env) {
  const body = await parseFormBody(request);
  const { userToken, name, carColors } = body;
  if (!userToken) return jsonResp({ error: "Missing userToken" }, 400);

  const tokenHash = await sha256(userToken);

  await env.DB.prepare(`
    INSERT INTO users (token_hash, nickname, car_colors)
    VALUES (?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET
      nickname = excluded.nickname,
      car_colors = excluded.car_colors
  `).bind(tokenHash, name || "Anonymous", carColors || "").run();

  return new Response("", { status: 200 });
}

// ─── Durable Object: Multiplayer Room ────────────────────────────────────────

export class MultiplayerRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // sessionId -> { ws, playerInfo }
    this.nextId = 1;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    const sessionId = this.nextId++;

    server.accept();

    this.sessions.set(sessionId, { ws: server, playerInfo: null });

    server.addEventListener("message", (event) => {
      this.handleMessage(sessionId, event.data);
    });

    server.addEventListener("close", () => {
      this.handleDisconnect(sessionId);
    });

    server.addEventListener("error", () => {
      this.handleDisconnect(sessionId);
    });

    // Send current players to new joiner
    const players = [...this.sessions.entries()]
      .filter(([id]) => id !== sessionId)
      .map(([id, s]) => ({ id, playerInfo: s.playerInfo }))
      .filter((p) => p.playerInfo !== null);

    server.send(JSON.stringify({ type: "init", sessionId, players }));

    return new Response(null, { status: 101, webSocket: client });
  }

  handleMessage(sessionId, data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (msg.type) {
      case "join":
        session.playerInfo = msg.playerInfo || {};
        this.broadcast({ type: "playerJoined", id: sessionId, playerInfo: session.playerInfo }, sessionId);
        break;

      case "update":
        // Player position/state update — relay to all others
        this.broadcast({ type: "playerUpdate", id: sessionId, state: msg.state }, sessionId);
        break;

      case "finish":
        this.broadcast({ type: "playerFinished", id: sessionId, frames: msg.frames }, sessionId);
        break;

      case "chat":
        const text = String(msg.text || "").slice(0, 200);
        this.broadcast({ type: "chat", id: sessionId, text }, sessionId);
        break;

      default:
        // Unknown message type — ignore
        break;
    }
  }

  handleDisconnect(sessionId) {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.delete(sessionId);
    this.broadcast({ type: "playerLeft", id: sessionId });
  }

  broadcast(msg, excludeId = null) {
    const json = JSON.stringify(msg);
    for (const [id, session] of this.sessions.entries()) {
      if (id === excludeId) continue;
      try {
        session.ws.send(json);
      } catch {
        // Session died — clean up
        this.sessions.delete(id);
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function parseFormBody(request) {
  const text = await request.text();
  const params = new URLSearchParams(text);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cors(response) {
  const h = new Headers(response.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { status: response.status, headers: h });
}
