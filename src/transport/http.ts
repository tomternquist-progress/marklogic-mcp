import express, { type Request } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID, createHash } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  /** SHA-256 hash of the Bearer token used when this session was created (oauth mode only). */
  tokenHash: string | undefined;
}

function extractBearerToken(req: Pick<Request, "headers">): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return undefined;
}

/**
 * Returns true when the request's Bearer token matches the token that created
 * the session. Sessions created without a token (non-oauth deployments) have an
 * undefined tokenHash and always match — token binding only applies in oauth mode.
 *
 * Exported for unit testing; not part of the transport's public API.
 */
export function sessionTokenMatches(entry: Pick<SessionEntry, "tokenHash">, req: Pick<Request, "headers">): boolean {
  if (!entry.tokenHash) return true;
  const token = extractBearerToken(req);
  if (!token) return false;
  const incomingHash = createHash("sha256").update(token).digest("hex");
  return incomingHash === entry.tokenHash;
}

/**
 * Install a session-cleanup callback on a transport WITHOUT clobbering the
 * handler the MCP SDK installed during server.connect().
 *
 * The SDK's Protocol.connect() sets transport.onclose to its own _onclose —
 * which aborts in-flight request handlers and clears the response/progress
 * handler maps. A plain `transport.onclose = cleanup` replaces it, so that
 * teardown silently stops running and long tool calls (Flux jobs, large Optic
 * queries) keep going after their session is gone.
 *
 * Exported for unit testing; not part of the transport's public API.
 */
export function chainOnClose(
  transport: Pick<StreamableHTTPServerTransport, "onclose">,
  cleanup: () => void
): void {
  const existing = transport.onclose;
  transport.onclose = () => {
    existing?.();
    cleanup();
  };
}

export async function startHttpTransport(
  serverFactory: (oauthToken?: string) => McpServer,
  config: HttpConfig,
  connectionAuthType: "digest" | "basic" | "oauth" = "digest"
): Promise<import("http").Server> {
  const app = express();
  // Trust proxy must be set BEFORE rate-limit middleware so req.ip resolves to the
  // real client IP rather than the proxy's. Without this, express-rate-limit logs
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR when X-Forwarded-For is present.
  if (config.trustProxy !== undefined) {
    app.set("trust proxy", config.trustProxy);
    logger.info("Express trust proxy enabled", { trustProxy: config.trustProxy });
  }
  // Eval scripts, flux jobs, and document writes can carry payloads well over
  // Express's 100 KB default (ml_eval_javascript documents vars up to ~1–2 MB).
  // Raise the JSON body limit so the HTTP transport doesn't 413 before the
  // request reaches a tool handler.
  app.use(express.json({ limit: "16mb" }));
  app.use(cors(config.corsOrigin ? { origin: config.corsOrigin } : undefined));
  app.use(rateLimit({ windowMs: 60_000, max: 500 }));

  // Optional gateway API key.
  // In oauth mode: read from X-MCP-Api-Key to avoid conflicting with the per-user
  //   Authorization: Bearer header that carries the MarkLogic OAuth token.
  // In non-oauth mode: fall back to Authorization: Bearer for backward compatibility.
  if (config.apiKey) {
    app.use((req, res, next) => {
      const xKey = req.headers["x-mcp-api-key"] as string | undefined;
      let providedKey: string | undefined;
      if (xKey) {
        providedKey = xKey;
      } else if (connectionAuthType !== "oauth") {
        // Backward compat: non-oauth deployments may send MCP_API_KEY in Authorization header
        const auth = req.headers.authorization;
        providedKey = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
      }
      if (providedKey !== config.apiKey) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });
  }

  // Session map: one transport per client session
  const sessions = new Map<string, SessionEntry>();

  // Periodically evict sessions that have been idle longer than SESSION_TTL_MS
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeen > SESSION_TTL_MS) {
        entry.transport.close().catch(() => undefined);
        sessions.delete(id);
        logger.debug("MCP session evicted (TTL)", { sessionId: id });
      }
    }
  }, SESSION_CLEANUP_INTERVAL_MS);
  // Don't prevent the process from exiting
  cleanupInterval.unref();

  app.post("/mcp", async (req, res) => {
    const incomingSessionId = req.headers["mcp-session-id"] as string | undefined;

    // In oauth mode, extract the per-user Bearer token before any session logic.
    const oauthToken = connectionAuthType === "oauth" ? extractBearerToken(req) : undefined;

    if (connectionAuthType === "oauth" && !oauthToken) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "ML_AUTH_TYPE=oauth is active but no Bearer token was found in the Authorization header. " +
            "Include 'Authorization: Bearer <your-token>' in every request.",
        },
        id: null,
      });
      return;
    }

    // If the client sends a known session ID, use the existing transport.
    // If no session ID is provided, this is a fresh connection — generate one.
    // If an unknown session ID is provided, the server likely restarted and lost
    // the session. Respond with 404 so the client knows to re-initialize cleanly.
    //
    // MCP HTTP SESSION PROTOCOL NOTE:
    //   After POST /mcp { initialize } you receive an mcp-session-id header.
    //   The notifications/initialized step is OPTIONAL for HTTP transports — you
    //   can call tools directly after initialize without sending notifications/initialized.
    //   This is important for stateless HTTP clients (PowerShell, curl, HttpClient) that
    //   drop TCP connections between requests: skipping notifications/initialized avoids
    //   session state confusion since the server ties the session to the connection only
    //   during the initialize handshake, not afterwards.
    //   Correct sequence:
    //     POST /mcp  { "method": "initialize", ... }   → get mcp-session-id header
    //     POST /mcp  { "method": "tools/call", ... }   → works immediately (skip notifications/initialized)
    if (incomingSessionId && !sessions.has(incomingSessionId)) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Session not found: the server may have restarted or the session expired (TTL: 30 min). " +
            "Start a new session: POST /mcp with {\"method\": \"initialize\", ...} to get a new mcp-session-id. " +
            "NOTE: notifications/initialized is optional for HTTP transports — you can call tools directly after initialize.",
        },
        id: null,
      });
      return;
    }

    const sessionId = incomingSessionId ?? randomUUID();
    let entry = sessions.get(sessionId);

    // In oauth mode, verify the incoming token matches the one that created the session.
    // This prevents a different user from hijacking a session by guessing its ID.
    if (entry && oauthToken) {
      if (!sessionTokenMatches(entry, req)) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message:
              "OAuth token mismatch for this session. " +
              "The Bearer token does not match the one used to create this session. " +
              "Start a new session (omit mcp-session-id) with your current token.",
          },
          id: null,
        });
        return;
      }
    }

    if (!entry) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });

      // Each session gets its own McpServer instance — the SDK forbids sharing one server
      // across multiple transports (throws "Already connected to a transport").
      const server = serverFactory(oauthToken);
      try {
        await server.connect(transport);
      } catch (err) {
        logger.error("Failed to connect MCP server to transport", { sessionId, err });
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error: failed to initialise MCP session." },
          id: null,
        });
        return;
      }

      const tokenHash = oauthToken
        ? createHash("sha256").update(oauthToken).digest("hex")
        : undefined;
      entry = { transport, lastSeen: Date.now(), tokenHash };
      sessions.set(sessionId, entry);

      // Clean up on close — chained, never assigned over. See chainOnClose().
      chainOnClose(transport, () => {
        sessions.delete(sessionId);
        logger.debug("MCP session closed", { sessionId });
      });
    }

    entry.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    // Token binding applies to the SSE channel too — without this, a caller who
    // learns a session ID could attach to another user's server→client stream
    // in oauth mode. No-op for non-oauth sessions (tokenHash undefined).
    if (!sessionTokenMatches(entry, req)) {
      res.status(401).json({ error: "OAuth token mismatch for this session" });
      return;
    }
    entry.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    // Only the token that created the session may tear it down — otherwise a
    // guessed session ID is a denial-of-service vector in oauth mode. Deleting a
    // non-existent session stays idempotent (200).
    if (entry && !sessionTokenMatches(entry, req)) {
      res.status(401).json({ error: "OAuth token mismatch for this session" });
      return;
    }
    if (entry) {
      await entry.transport.close().catch(() => undefined);
      sessions.delete(sessionId!);
    }
    res.status(200).json({ ok: true });
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      sessions: sessions.size,
      commit: process.env.GIT_COMMIT ?? "dev",
      buildTime: process.env.BUILD_TIME ?? "local",
    });
  });

  return new Promise((resolve) => {
    const server = app.listen(config.port, config.host, () => {
      logger.info(`MarkLogic MCP HTTP server listening`, { host: config.host, port: config.port });
      resolve(server);
    });
  });
}
