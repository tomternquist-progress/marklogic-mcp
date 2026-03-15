import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Server } from "http";
import { startHttpTransport } from "../../src/transport/http.js";

// The HTTP transport logs on listen and on session events; mock the logger so
// tests don't require initLogger() to be called first.
vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  initLogger: vi.fn(),
  getLogger: vi.fn(),
}));

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Bind to port 0 to get an OS-assigned free port, then close immediately. */
async function freePort(): Promise<number> {
  const { createServer } = await import("net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") return reject(new Error("no address"));
      srv.close(() => resolve(addr.port));
    });
  });
}

/** Minimal McpServer stub whose connect() is a no-op. */
function stubMcpServer() {
  return { connect: vi.fn(async () => {}), setRequestHandler: vi.fn() } as never;
}

// ─── Test lifecycle ────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

async function startServer(apiKey?: string) {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = await startHttpTransport(() => stubMcpServer(), {
    port,
    host: "127.0.0.1",
    apiKey,
  });
}

async function stopServer() {
  if (!server) return;
  // closeAllConnections() is available from Node 18.2; force-close keep-alive sockets.
  if (typeof (server as Server & { closeAllConnections?: () => void }).closeAllConnections === "function") {
    (server as Server & { closeAllConnections: () => void }).closeAllConnections();
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
}

// ─── /health ──────────────────────────────────────────────────────────────

describe("GET /health", () => {
  beforeEach(() => startServer());
  afterEach(() => stopServer());

  it("returns { status: 'ok', sessions: 0 }", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; sessions: number };
    expect(body.status).toBe("ok");
    expect(body.sessions).toBe(0);
  });
});

// ─── Session routes (no MCP protocol exchange needed) ─────────────────────

describe("MCP session routing", () => {
  beforeEach(() => startServer());
  afterEach(() => stopServer());

  it("GET /mcp with unknown session ID returns 404", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { "mcp-session-id": "does-not-exist" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/session not found/i);
  });

  it("DELETE /mcp with unknown session returns 200 (idempotent)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": "does-not-exist" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("DELETE /mcp without session ID returns 200", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});

// ─── Bearer token authentication ───────────────────────────────────────────

describe("Bearer token auth – apiKey configured", () => {
  beforeEach(() => startServer("my-secret-api-key"));
  afterEach(() => stopServer());

  it("rejects request with no Authorization header (401)", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(401);
  });

  it("rejects request with wrong token (401)", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects Basic auth scheme (401)", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  it("allows request with correct Bearer token (200)", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: "Bearer my-secret-api-key" },
    });
    expect(res.status).toBe(200);
  });

  it("returns JSON { error: 'Unauthorized' } body on rejected request", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unauthorized/i);
  });
});

describe("No auth – apiKey not configured", () => {
  beforeEach(() => startServer(/* no apiKey */));
  afterEach(() => stopServer());

  it("allows unauthenticated GET /health", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it("allows request with any Authorization header when no apiKey is set", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: "Bearer any-random-value" },
    });
    expect(res.status).toBe(200);
  });
});
