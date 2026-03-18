import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

// The base client calls logger.debug() on non-401 errors; mock it so tests
// don't require the logger to be initialized.
vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  initLogger: vi.fn(),
  getLogger: vi.fn(),
}));
import nock from "nock";
import { MarkLogicBaseClient } from "../../src/client/base.js";
import { AuthenticationError, MarkLogicError } from "../../src/utils/errors.js";
import type { ConnectionConfig } from "../../src/config/schema.js";

const HOST = "marklogic-test.local";
const BASE_URL = `http://${HOST}:8000`;

const digestConfig: ConnectionConfig = {
  host: HOST,
  port: 8000,
  managementPort: 8002,
  username: "admin",
  password: "admin",
  database: "Documents",
  ssl: false,
  rejectUnauthorized: true,
  authType: "digest",
  timeoutMs: 5000,
};

const basicConfig: ConnectionConfig = {
  ...digestConfig,
  authType: "basic",
};

beforeAll(() => {
  nock.disableNetConnect();
});

afterAll(() => {
  nock.enableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

// ─── Error mapping (basic auth – no digest retry to interfere) ─────────────

describe("MarkLogicBaseClient – error mapping (basic auth)", () => {
  it("maps HTTP 401 to AuthenticationError", async () => {
    nock(BASE_URL).get("/v1/test").reply(401);

    const client = new MarkLogicBaseClient(basicConfig);
    await expect(client.get(client.http, "/v1/test")).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("maps HTTP 403 to MarkLogicError with statusCode 403", async () => {
    nock(BASE_URL).get("/v1/test").reply(403, { message: "Forbidden" });

    const client = new MarkLogicBaseClient(basicConfig);
    const err = await client.get(client.http, "/v1/test").catch((e) => e);
    expect(err).toBeInstanceOf(MarkLogicError);
    expect((err as MarkLogicError).statusCode).toBe(403);
  });

  it("extracts message from error-response body shape", async () => {
    nock(BASE_URL)
      .get("/v1/test")
      .reply(400, { "error-response": { message: "bad query", "status-code": "ML-XDMP-BADVAL" } });

    const client = new MarkLogicBaseClient(basicConfig);
    const err = await client.get(client.http, "/v1/test").catch((e) => e);
    expect(err).toBeInstanceOf(MarkLogicError);
    expect((err as MarkLogicError).message).toBe("bad query");
    expect((err as MarkLogicError).mlCode).toBe("ML-XDMP-BADVAL");
    expect((err as MarkLogicError).statusCode).toBe(400);
  });

  it("extracts message from errorResponse body shape (alternate camel-case format)", async () => {
    nock(BASE_URL)
      .get("/v1/test")
      .reply(500, { errorResponse: { message: "internal error", messageCode: "ML-500" } });

    const client = new MarkLogicBaseClient(basicConfig);
    const err = await client.get(client.http, "/v1/test").catch((e) => e);
    expect(err).toBeInstanceOf(MarkLogicError);
    expect((err as MarkLogicError).message).toBe("internal error");
    expect((err as MarkLogicError).mlCode).toBe("ML-500");
  });

  it("falls back to HTTP error message when body is a plain string", async () => {
    nock(BASE_URL).get("/v1/test").reply(503, "Service Unavailable");

    const client = new MarkLogicBaseClient(basicConfig);
    const err = await client.get(client.http, "/v1/test").catch((e) => e);
    expect(err).toBeInstanceOf(MarkLogicError);
    expect((err as MarkLogicError).statusCode).toBe(503);
  });

  it("includes body content (up to 300 chars) in fallback message", async () => {
    const longBody = { detail: "x".repeat(500) };
    nock(BASE_URL).get("/v1/test").reply(400, longBody);

    const client = new MarkLogicBaseClient(basicConfig);
    const err = await client.get(client.http, "/v1/test").catch((e) => e);
    expect(err).toBeInstanceOf(MarkLogicError);
    // The body is truncated to 300 chars in the error message
    const message = (err as MarkLogicError).message;
    const bodyRef = message.match(/body: (.+)/)?.[1] ?? "";
    expect(bodyRef.length).toBeLessThanOrEqual(600);
  });
});

// ─── Digest auth interceptor ───────────────────────────────────────────────

describe("MarkLogicBaseClient – digest auth interceptor", () => {
  const digestChallenge = `Digest realm="MarkLogic", nonce="abc123nonce456789"`;

  it("retries request with Digest Authorization header on first 401", async () => {
    // First call: server challenges with 401 + Digest WWW-Authenticate
    nock(BASE_URL)
      .get("/v1/documents")
      .reply(401, "", { "WWW-Authenticate": digestChallenge });

    // Second call (retry): accepts any Authorization header starting with "Digest"
    nock(BASE_URL)
      .get("/v1/documents")
      .matchHeader("Authorization", /^Digest /)
      .reply(200, { uri: "/data/doc.json" });

    const client = new MarkLogicBaseClient(digestConfig);
    const result = await client.get(client.http, "/v1/documents");
    expect(result).toEqual({ uri: "/data/doc.json" });
  });

  it("throws AuthenticationError when challenge is Basic (not Digest)", async () => {
    nock(BASE_URL)
      .get("/v1/documents")
      .reply(401, "", { "WWW-Authenticate": 'Basic realm="MarkLogic"' });

    const client = new MarkLogicBaseClient(digestConfig);
    await expect(client.get(client.http, "/v1/documents")).rejects.toBeInstanceOf(
      AuthenticationError
    );
  });

  it("throws AuthenticationError when Digest retry also returns 401 (wrong credentials)", async () => {
    // Both the initial request and the retry are rejected
    nock(BASE_URL)
      .get("/v1/documents")
      .reply(401, "", { "WWW-Authenticate": digestChallenge });

    nock(BASE_URL)
      .get("/v1/documents")
      .reply(401, "", { "WWW-Authenticate": digestChallenge });

    const client = new MarkLogicBaseClient(digestConfig);
    await expect(client.get(client.http, "/v1/documents")).rejects.toBeInstanceOf(
      AuthenticationError
    );
  });

  it("throws AuthenticationError when WWW-Authenticate header is absent on 401", async () => {
    nock(BASE_URL).get("/v1/documents").reply(401, "");

    const client = new MarkLogicBaseClient(digestConfig);
    await expect(client.get(client.http, "/v1/documents")).rejects.toBeInstanceOf(
      AuthenticationError
    );
  });
});

// ─── HTTP methods ──────────────────────────────────────────────────────────

describe("MarkLogicBaseClient – HTTP methods", () => {
  it("GET returns response data", async () => {
    nock(BASE_URL).get("/v1/ping").reply(200, { pong: true });

    const client = new MarkLogicBaseClient(basicConfig);
    const data = await client.get<{ pong: boolean }>(client.http, "/v1/ping");
    expect(data).toEqual({ pong: true });
  });

  it("POST returns response data", async () => {
    nock(BASE_URL)
      .post("/v1/search", { q: "test" })
      .reply(200, { results: [] });

    const client = new MarkLogicBaseClient(basicConfig);
    const data = await client.post(client.http, "/v1/search", { q: "test" });
    expect(data).toEqual({ results: [] });
  });

  it("PUT resolves without error on 204", async () => {
    nock(BASE_URL).put("/v1/documents").reply(204);

    const client = new MarkLogicBaseClient(basicConfig);
    await expect(client.put(client.http, "/v1/documents")).resolves.toBeUndefined();
  });

  it("DELETE resolves without error on 204", async () => {
    nock(BASE_URL).delete("/v1/documents").reply(204);

    const client = new MarkLogicBaseClient(basicConfig);
    await expect(client.delete(client.http, "/v1/documents")).resolves.toBeUndefined();
  });

  it("PATCH returns response data", async () => {
    nock(BASE_URL).patch("/v1/documents").reply(200, { patched: true });

    const client = new MarkLogicBaseClient(basicConfig);
    const data = await client.patch(client.http, "/v1/documents");
    expect(data).toEqual({ patched: true });
  });

  it("mgmt instance uses management port 8002", async () => {
    nock(`http://${HOST}:8002`).get("/manage/v2/databases").reply(200, { databases: [] });

    const client = new MarkLogicBaseClient(basicConfig);
    const data = await client.get(client.mgmt, "/manage/v2/databases");
    expect(data).toEqual({ databases: [] });
  });
});
