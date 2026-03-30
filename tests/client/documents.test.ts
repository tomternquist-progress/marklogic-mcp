import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  initLogger: vi.fn(),
  getLogger: vi.fn(),
}));

import nock from "nock";
import { MarkLogicBaseClient } from "../../src/client/base.js";
import { DocumentsClient } from "../../src/client/documents.js";
import { NotFoundError, WriteProtectedError } from "../../src/utils/errors.js";
import type { ConnectionConfig } from "../../src/config/schema.js";

const HOST = "ml-docs-test.local";
const BASE_URL = `http://${HOST}:8000`;

const config: ConnectionConfig = {
  host: HOST,
  port: 8000,
  managementPort: 8002,
  username: "admin",
  password: "admin",
  database: "Documents",
  ssl: false,
  rejectUnauthorized: true,
  authType: "basic",
  timeoutMs: 5000,
};

function makeClient(readonly = false) {
  const base = new MarkLogicBaseClient(config);
  return new DocumentsClient(base, readonly);
}

beforeAll(() => { nock.disableNetConnect(); });
afterAll(() => { nock.enableNetConnect(); });
afterEach(() => { nock.cleanAll(); });

// ─── get ───────────────────────────────────────────────────────────────────────

describe("DocumentsClient.get", () => {
  it("fetches a document and parses JSON content", async () => {
    nock(BASE_URL)
      .get("/v1/documents")
      .query({ uri: "/data/doc.json" })
      .reply(200, '{"key":"value"}', { "content-type": "application/json" });

    const result = await makeClient().get("/data/doc.json");
    expect(result.uri).toBe("/data/doc.json");
    expect(result.content).toEqual({ key: "value" });
    expect(result.contentType).toContain("application/json");
  });

  it("returns raw string content when body is not valid JSON", async () => {
    nock(BASE_URL)
      .get("/v1/documents")
      .query({ uri: "/data/plain.txt" })
      .reply(200, "hello world", { "content-type": "text/plain" });

    const result = await makeClient().get("/data/plain.txt");
    expect(result.content).toBe("hello world");
  });

  it("passes the database parameter in the query string", async () => {
    nock(BASE_URL)
      .get("/v1/documents")
      .query({ uri: "/data/doc.json", database: "MyDB" })
      .reply(200, "{}", { "content-type": "application/json" });

    await expect(makeClient().get("/data/doc.json", "MyDB")).resolves.toBeDefined();
  });

  it("throws NotFoundError on 404", async () => {
    nock(BASE_URL)
      .get("/v1/documents")
      .query({ uri: "/missing.json" })
      .reply(404, { "error-response": { message: "Not found", "status-code": "404" } });

    await expect(makeClient().get("/missing.json")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("fetches metadata when includeMetadata=true", async () => {
    // Content fetch
    nock(BASE_URL)
      .get("/v1/documents")
      .query({ uri: "/data/doc.json" })
      .reply(200, '{"x":1}', { "content-type": "application/json" });

    // Metadata fetch
    nock(BASE_URL)
      .get("/v1/documents")
      .query({ uri: "/data/doc.json", category: "metadata", format: "json" })
      .reply(200, {
        collections: ["my-collection"],
        permissions: [],
        properties: {},
        quality: 10,
      });

    const result = await makeClient().get("/data/doc.json", undefined, true);
    expect(result.metadata?.collections).toEqual(["my-collection"]);
    expect(result.metadata?.quality).toBe(10);
  });
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe("DocumentsClient.list", () => {
  it("returns URIs from a collection search", async () => {
    nock(BASE_URL)
      .get("/v1/search")
      .query(true)
      .reply(200, {
        total: 2,
        start: 1,
        "page-length": 20,
        results: [{ uri: "/a.json" }, { uri: "/b.json" }],
      });

    const result = await makeClient().list({ collection: "my-col" });
    expect(result.uris).toEqual(["/a.json", "/b.json"]);
    expect(result.total).toBe(2);
  });

  it("returns empty URIs when results is missing", async () => {
    nock(BASE_URL)
      .get("/v1/search")
      .query(true)
      .reply(200, { total: 0, start: 1, "page-length": 20, results: [] });

    const result = await makeClient().list({ directory: "/data/" });
    expect(result.uris).toEqual([]);
    expect(result.total).toBe(0);
  });
});

// ─── put ──────────────────────────────────────────────────────────────────────

describe("DocumentsClient.put", () => {
  it("PUTs document content to the correct URL", async () => {
    nock(BASE_URL)
      .put(/\/v1\/documents/)
      .reply(204);

    await expect(
      makeClient().put("/data/new.json", '{"x":1}', "application/json", { collections: ["col1"] })
    ).resolves.toBeUndefined();
  });

  it("throws WriteProtectedError in readonly mode", async () => {
    await expect(
      makeClient(true).put("/data/doc.json", "{}", "application/json")
    ).rejects.toBeInstanceOf(WriteProtectedError);
  });
});

// ─── del ──────────────────────────────────────────────────────────────────────

describe("DocumentsClient.del", () => {
  it("sends DELETE request for the given URI", async () => {
    nock(BASE_URL)
      .delete("/v1/documents")
      .query({ uri: "/data/old.json" })
      .reply(204);

    await expect(makeClient().del("/data/old.json")).resolves.toBeUndefined();
  });

  it("throws WriteProtectedError in readonly mode", async () => {
    await expect(makeClient(true).del("/data/doc.json")).rejects.toBeInstanceOf(WriteProtectedError);
  });
});

// ─── patchDocument ────────────────────────────────────────────────────────────

describe("DocumentsClient.patchDocument", () => {
  it("sends PATCH request with the patch body", async () => {
    nock(BASE_URL)
      .patch("/v1/documents")
      .query({ uri: "/data/doc.json" })
      .reply(200, { updated: true });

    await expect(
      makeClient().patchDocument("/data/doc.json", { replace: "/name", value: "Alice" })
    ).resolves.toBeUndefined();
  });

  it("throws WriteProtectedError in readonly mode", async () => {
    await expect(
      makeClient(true).patchDocument("/data/doc.json", {})
    ).rejects.toBeInstanceOf(WriteProtectedError);
  });
});
