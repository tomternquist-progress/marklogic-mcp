import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export async function startHttpTransport(serverFactory: () => McpServer, config: HttpConfig): Promise<import("http").Server> {
  const app = express();
  app.use(express.json());
  app.use(cors(config.corsOrigin ? { origin: config.corsOrigin } : undefined));
  app.use(rateLimit({ windowMs: 60_000, max: 500 }));

  // Optional bearer token auth
  if (config.apiKey) {
    app.use((req, res, next) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${config.apiKey}`) {
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

    // If the client sends a known session ID, use the existing transport.
    // If no session ID is provided, this is a fresh connection — generate one.
    // If an unknown session ID is provided, the server likely restarted and lost
    // the session. Respond with 404 so the client knows to re-initialize cleanly.
    if (incomingSessionId && !sessions.has(incomingSessionId)) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Session not found: the server may have restarted. Please start a new session (re-initialize).",
        },
        id: null,
      });
      return;
    }

    const sessionId = incomingSessionId ?? randomUUID();
    let entry = sessions.get(sessionId);

    if (!entry) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });

      // Each session gets its own McpServer instance — the SDK forbids sharing one server
      // across multiple transports (throws "Already connected to a transport").
      const server = serverFactory();
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

      entry = { transport, lastSeen: Date.now() };
      sessions.set(sessionId, entry);

      // Clean up on close
      transport.onclose = () => {
        sessions.delete(sessionId);
        logger.debug("MCP session closed", { sessionId });
      };
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
    entry.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (entry) {
      await entry.transport.close().catch(() => undefined);
      sessions.delete(sessionId!);
    }
    res.status(200).json({ ok: true });
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", sessions: sessions.size });
  });

  return new Promise((resolve) => {
    const server = app.listen(config.port, config.host, () => {
      logger.info(`MarkLogic MCP HTTP server listening`, { host: config.host, port: config.port });
      resolve(server);
    });
  });
}
