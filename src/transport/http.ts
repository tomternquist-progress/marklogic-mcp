import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HttpConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export async function startHttpTransport(serverFactory: () => McpServer, config: HttpConfig): Promise<import("http").Server> {
  const app = express();
  app.use(express.json());
  app.use(cors());
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
  const sessions = new Map<string, StreamableHTTPServerTransport>();

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
    let transport = sessions.get(sessionId);

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });
      sessions.set(sessionId, transport);

      // Each session gets its own McpServer instance — the SDK forbids sharing one server
      // across multiple transports (throws "Already connected to a transport").
      const server = serverFactory();
      await server.connect(transport);

      // Clean up on close
      transport.onclose = () => {
        sessions.delete(sessionId);
        logger.debug("MCP session closed", { sessionId });
      };
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await sessions.get(sessionId)!.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.close();
      sessions.delete(sessionId);
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
