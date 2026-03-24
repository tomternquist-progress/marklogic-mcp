import { describe, it, expect, vi, beforeEach } from "vitest";
import { DocumentsClient } from "../../src/client/documents.js";
import { NotFoundError, WriteProtectedError } from "../../src/utils/errors.js";

function createMockBase() {
  const http = {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  };
  return {
    http,
    mgmt: {},
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
  };
}

// ── get ───────────────────────────────────────────────────────────────────────

describe("DocumentsClient.get", () => {
  let base: ReturnType<typeof createMockBase>;
  let client: DocumentsClient;

  beforeEach(() => {
    base = createMockBase();
    client = new DocumentsClient(base as never, false);
  });

  it("returns parsed JSON content for a JSON document", async () => {
    base.http.get.mockResolvedValue({
      data: '{"name":"Alice"}',
      headers: { "content-type": "application/json" },
    });

    const result = await client.get("/docs/alice.json");

    expect(result.uri).toBe("/docs/alice.json");
    expect(result.content).toEqual({ name: "Alice" });
    expect(result.contentType).toBe("application/json");
  });

  it("returns raw string for non-JSON content", async () => {
    base.http.get.mockResolvedValue({
      data: "<root/>",
      headers: { "content-type": "application/xml" },
    });

    const result = await client.get("/docs/file.xml");
    expect(result.content).toBe("<root/>");
    expect(result.contentType).toBe("application/xml");
  });

  it("throws NotFoundError when server returns 404", async () => {
    base.http.get.mockRejectedValue({ statusCode: 404, message: "Not found" });

    await expect(client.get("/docs/missing.json")).rejects.toThrow(NotFoundError);
  });

  it("re-throws non-404 errors", async () => {
    base.http.get.mockRejectedValue({ statusCode: 503, message: "Service unavailable" });

    await expect(client.get("/docs/file.json")).rejects.toMatchObject({ statusCode: 503 });
  });

  it("fetches metadata when includeMetadata=true", async () => {
    base.http.get
      .mockResolvedValueOnce({
        data: '{"id":1}',
        headers: { "content-type": "application/json" },
      })
      .mockResolvedValueOnce({
        data: { collections: ["my-coll"], permissions: [], quality: 5 },
        headers: { "content-type": "application/json" },
      });

    // base.get (metadata fetch) needs to be mocked differently
    // The metadata fetch uses base.http.get again with a different URL
    const result = await client.get("/docs/doc.json", undefined, true);
    expect(result.content).toEqual({ id: 1 });
  });

  it("passes database param in query string when provided", async () => {
    base.http.get.mockResolvedValue({
      data: "{}",
      headers: { "content-type": "application/json" },
    });

    await client.get("/docs/file.json", "my-db");

    const url = base.http.get.mock.calls[0][0] as string;
    expect(url).toContain("database=my-db");
  });
});

// ── list ──────────────────────────────────────────────────────────────────────

describe("DocumentsClient.list", () => {
  let base: ReturnType<typeof createMockBase>;
  let client: DocumentsClient;

  beforeEach(() => {
    base = createMockBase();
    client = new DocumentsClient(base as never, false);
  });

  it("returns list of URIs from results", async () => {
    base.get.mockResolvedValue({
      total: 2,
      start: 1,
      "page-length": 20,
      results: [{ uri: "/docs/a.json" }, { uri: "/docs/b.json" }],
    });

    const result = await client.list({ collection: "my-coll" });

    expect(result.uris).toEqual(["/docs/a.json", "/docs/b.json"]);
    expect(result.total).toBe(2);
    expect(result.start).toBe(1);
  });

  it("returns empty list when no results", async () => {
    base.get.mockResolvedValue({ total: 0, start: 1, "page-length": 20, results: [] });

    const result = await client.list({});
    expect(result.uris).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("passes collection param", async () => {
    base.get.mockResolvedValue({ total: 0, start: 1, "page-length": 20, results: [] });

    await client.list({ collection: "test-coll" });

    const [, , opts] = base.get.mock.calls[0];
    expect(opts.params.collection).toBe("test-coll");
  });
});

// ── put ───────────────────────────────────────────────────────────────────────

describe("DocumentsClient.put", () => {
  it("throws WriteProtectedError in readonly mode", async () => {
    const base = createMockBase();
    const client = new DocumentsClient(base as never, true);

    await expect(client.put("/doc.json", "{}", "application/json")).rejects.toThrow(WriteProtectedError);
  });

  it("calls base.put with correct args in writable mode", async () => {
    const base = createMockBase();
    const client = new DocumentsClient(base as never, false);
    base.put.mockResolvedValue(undefined);

    await client.put("/doc.json", '{"x":1}', "application/json", { collections: ["col-a"] });

    expect(base.put).toHaveBeenCalled();
    const [, url] = base.put.mock.calls[0];
    expect(url).toContain("uri=%2Fdoc.json");
    expect(url).toContain("collection=col-a");
  });

  it("includes multiple collections as repeated params", async () => {
    const base = createMockBase();
    const client = new DocumentsClient(base as never, false);
    base.put.mockResolvedValue(undefined);

    await client.put("/doc.json", "{}", "application/json", { collections: ["colA", "colB"] });

    const [, url] = base.put.mock.calls[0];
    expect(url).toContain("collection=colA");
    expect(url).toContain("collection=colB");
  });
});

// ── del ───────────────────────────────────────────────────────────────────────

describe("DocumentsClient.del", () => {
  it("throws WriteProtectedError in readonly mode", async () => {
    const base = createMockBase();
    const client = new DocumentsClient(base as never, true);

    await expect(client.del("/doc.json")).rejects.toThrow(WriteProtectedError);
  });

  it("calls base.delete with uri param", async () => {
    const base = createMockBase();
    const client = new DocumentsClient(base as never, false);
    base.delete.mockResolvedValue(undefined);

    await client.del("/doc.json");

    expect(base.delete).toHaveBeenCalled();
    const [, , opts] = base.delete.mock.calls[0];
    expect(opts.params.uri).toBe("/doc.json");
  });
});

// ── patchDocument ─────────────────────────────────────────────────────────────

describe("DocumentsClient.patchDocument", () => {
  it("throws WriteProtectedError in readonly mode", async () => {
    const base = createMockBase();
    const client = new DocumentsClient(base as never, true);

    await expect(client.patchDocument("/doc.json", {})).rejects.toThrow(WriteProtectedError);
  });

  it("calls base.patch with uri param", async () => {
    const base = createMockBase();
    const client = new DocumentsClient(base as never, false);
    base.patch.mockResolvedValue(undefined);

    await client.patchDocument("/doc.json", { patch: [] });

    expect(base.patch).toHaveBeenCalled();
    const [, , , opts] = base.patch.mock.calls[0];
    expect(opts.params.uri).toBe("/doc.json");
  });
});
