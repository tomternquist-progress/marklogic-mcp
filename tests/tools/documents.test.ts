import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerDocumentTools } from "../../src/tools/documents.js";
import {
  WriteProtectedError,
  NotFoundError,
  MarkLogicError,
} from "../../src/utils/errors.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn(
      (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
        tools.set(_name, handler);
      }
    ),
  };
  return { server, tools };
}

function createMockClients() {
  return {
    documents: {
      get: vi.fn(),
      list: vi.fn(),
      put: vi.fn(),
      del: vi.fn(),
      patchDocument: vi.fn(),
    },
    eval: {
      staticCheckSjs: vi.fn(),
    },
  };
}

// ─── Tool registration ─────────────────────────────────────────────────────

describe("registerDocumentTools – tool registration", () => {
  it("registers only read tools (get, list) when readonly=true", () => {
    const { server, tools } = createMockServer();
    registerDocumentTools(server as never, createMockClients() as never, true);

    expect(tools.has("ml_document_get")).toBe(true);
    expect(tools.has("ml_document_list")).toBe(true);
    expect(tools.has("ml_document_put")).toBe(false);
    expect(tools.has("ml_document_delete")).toBe(false);
    expect(tools.has("ml_document_patch")).toBe(false);
  });

  it("registers all write tools when readonly=false", () => {
    const { server, tools } = createMockServer();
    registerDocumentTools(server as never, createMockClients() as never, false);

    expect(tools.has("ml_document_get")).toBe(true);
    expect(tools.has("ml_document_list")).toBe(true);
    expect(tools.has("ml_document_put")).toBe(true);
    expect(tools.has("ml_document_delete")).toBe(true);
    expect(tools.has("ml_document_patch")).toBe(true);
    expect(tools.has("ml_document_patch_batch")).toBe(true);
  });

  it("does not register ml_document_patch_batch when readonly=true", () => {
    const { server, tools } = createMockServer();
    registerDocumentTools(server as never, createMockClients() as never, true);
    expect(tools.has("ml_document_patch_batch")).toBe(false);
  });
});

// ─── ml_document_get ──────────────────────────────────────────────────────

describe("ml_document_get handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerDocumentTools(mock.server as never, clients as never, true);
    tools = mock.tools;
  });

  it("returns pretty-printed JSON for object content", async () => {
    clients.documents.get.mockResolvedValue({ content: { id: 1, name: "Alice" } });
    const result = await tools.get("ml_document_get")!({ uri: "/data/doc.json" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(
      JSON.stringify({ id: 1, name: "Alice" }, null, 2)
    );
  });

  it("passes through string content as-is", async () => {
    clients.documents.get.mockResolvedValue({ content: "<root><item>1</item></root>" });
    const result = await tools.get("ml_document_get")!({ uri: "/data/doc.xml" });

    expect(result.content[0].text).toBe("<root><item>1</item></root>");
  });

  it("sets isError and formats message on NotFoundError", async () => {
    clients.documents.get.mockRejectedValue(new NotFoundError("/data/missing.json"));
    const result = await tools.get("ml_document_get")!({ uri: "/data/missing.json" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
    expect(result.content[0].text).toContain("/data/missing.json");
  });

  it("sets isError on generic MarkLogicError", async () => {
    clients.documents.get.mockRejectedValue(new MarkLogicError("eval failed", 500));
    const result = await tools.get("ml_document_get")!({ uri: "/data/doc.json" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("500");
  });

  it("passes database parameter to the client", async () => {
    clients.documents.get.mockResolvedValue({ content: {} });
    await tools.get("ml_document_get")!({ uri: "/doc.json", database: "MyDB" });

    expect(clients.documents.get).toHaveBeenCalledWith("/doc.json", "MyDB", false);
  });

  it("passes include_metadata=true to the client", async () => {
    clients.documents.get.mockResolvedValue({ content: {} });
    await tools.get("ml_document_get")!({ uri: "/doc.json", include_metadata: true });

    expect(clients.documents.get).toHaveBeenCalledWith("/doc.json", undefined, true);
  });
});

// ─── ml_document_list ─────────────────────────────────────────────────────

describe("ml_document_list handler", () => {
  it("returns JSON-stringified list result", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    registerDocumentTools(server as never, clients as never, true);

    const mockResult = { results: ["/data/doc1.json", "/data/doc2.json"], total: 2 };
    clients.documents.list.mockResolvedValue(mockResult);

    const result = await tools.get("ml_document_list")!({ collection: "test-col" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockResult);
  });

  it("sets isError when client throws", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    registerDocumentTools(server as never, clients as never, true);

    clients.documents.list.mockRejectedValue(new MarkLogicError("db unavailable", 503));
    const result = await tools.get("ml_document_list")!({});

    expect(result.isError).toBe(true);
  });
});

// ─── ml_document_put ──────────────────────────────────────────────────────

describe("ml_document_put handler (readonly=false)", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerDocumentTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  it("returns success message on normal document put", async () => {
    clients.documents.put.mockResolvedValue(undefined);
    const result = await tools.get("ml_document_put")!({
      uri: "/data/customer.json",
      content: '{"id":1}',
      content_type: "application/json",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("/data/customer.json");
  });

  it("includes require() hint when writing .sjs to Modules database", async () => {
    clients.documents.put.mockResolvedValue(undefined);
    clients.eval.staticCheckSjs.mockResolvedValue(null);

    const result = await tools.get("ml_document_put")!({
      uri: "/lib/utils.sjs",
      content: "function greet(name) { return 'Hello ' + name; }",
      content_type: "application/javascript",
      database: "Modules",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("require('/lib/utils.sjs')");
    expect(result.content[0].text).toContain("xdmp.invoke('/lib/utils.sjs')");
  });

  it("includes static check warning when staticCheckSjs returns a warning", async () => {
    clients.documents.put.mockResolvedValue(undefined);
    clients.eval.staticCheckSjs.mockResolvedValue("SyntaxError: unexpected end of input");

    const result = await tools.get("ml_document_put")!({
      uri: "/lib/bad.sjs",
      content: "function f() {",
      content_type: "application/javascript",
      database: "Modules",
    });

    expect(result.content[0].text).toContain("STATIC CHECK WARNING");
    expect(result.content[0].text).toContain("SyntaxError");
  });

  it("silently succeeds when static check is unavailable (throws)", async () => {
    clients.documents.put.mockResolvedValue(undefined);
    clients.eval.staticCheckSjs.mockRejectedValue(new Error("eval disabled"));

    const result = await tools.get("ml_document_put")!({
      uri: "/lib/utils.sjs",
      content: "var x = 1;",
      content_type: "application/javascript",
      database: "Modules",
    });

    // Static check failure is swallowed; success message still returned
    expect(result.content[0].text).toContain("require('/lib/utils.sjs')");
    expect(result.content[0].text).not.toContain("STATIC CHECK WARNING");
  });

  it("does not include require() hint for non-SJS files in Modules database", async () => {
    clients.documents.put.mockResolvedValue(undefined);

    const result = await tools.get("ml_document_put")!({
      uri: "/lib/query.xqy",
      content: "xquery version '1.0-ml'; 1",
      content_type: "application/xquery",
      database: "Modules",
    });

    // XQuery files do get the hint but not the static-check path
    expect(result.content[0].text).toContain("require('/lib/query.xqy')");
  });

  it("does not include require() hint when database is not Modules", async () => {
    clients.documents.put.mockResolvedValue(undefined);

    const result = await tools.get("ml_document_put")!({
      uri: "/data/file.json",
      content: "{}",
      content_type: "application/json",
    });

    expect(result.content[0].text).not.toContain("require(");
  });

  it("sets isError when put fails with WriteProtectedError", async () => {
    clients.documents.put.mockRejectedValue(new WriteProtectedError());
    const result = await tools.get("ml_document_put")!({
      uri: "/data/doc.json",
      content: "{}",
      content_type: "application/json",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ML_READONLY");
  });
});

// ─── ml_document_delete ───────────────────────────────────────────────────

describe("ml_document_delete handler (readonly=false)", () => {
  it("returns success message on delete", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    registerDocumentTools(server as never, clients as never, false);
    clients.documents.del.mockResolvedValue(undefined);

    const result = await tools.get("ml_document_delete")!({ uri: "/data/old.json" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("/data/old.json");
    expect(result.content[0].text.toLowerCase()).toContain("delet");
  });

  it("sets isError when delete fails", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    registerDocumentTools(server as never, clients as never, false);
    clients.documents.del.mockRejectedValue(new NotFoundError("/data/old.json"));

    const result = await tools.get("ml_document_delete")!({ uri: "/data/old.json" });

    expect(result.isError).toBe(true);
  });
});

// ─── ml_document_patch ────────────────────────────────────────────────────

describe("ml_document_patch handler (readonly=false)", () => {
  it("returns success message on patch", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    registerDocumentTools(server as never, clients as never, false);
    clients.documents.patchDocument.mockResolvedValue(undefined);

    const patchDescriptor = { patch: [{ op: "add", path: "/name", value: "Bob" }] };
    const result = await tools.get("ml_document_patch")!({
      uri: "/data/customer.json",
      patch: patchDescriptor,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("/data/customer.json");
    expect(result.content[0].text.toLowerCase()).toContain("patch");
  });

  it("sets isError when patch fails", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    registerDocumentTools(server as never, clients as never, false);
    clients.documents.patchDocument.mockRejectedValue(new MarkLogicError("conflict", 409));

    const result = await tools.get("ml_document_patch")!({
      uri: "/data/customer.json",
      patch: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("409");
  });
});

// ─── ml_document_put content_type shorthands ──────────────────────────────

describe("ml_document_put content_type shorthand normalization", () => {
  const shorthands: Array<[string, string]> = [
    ["json", "application/json"],
    ["xml", "application/xml"],
    ["text", "text/plain"],
    ["javascript", "application/javascript"],
    ["js", "application/javascript"],
    ["xquery", "application/xquery"],
    ["xqy", "application/xquery"],
  ];

  for (const [shorthand, mime] of shorthands) {
    it(`normalises "${shorthand}" → "${mime}"`, async () => {
      const { server, tools } = createMockServer();
      const clients = createMockClients();
      registerDocumentTools(server as never, clients as never, false);
      clients.documents.put.mockResolvedValue(undefined);

      const result = await tools.get("ml_document_put")!({
        uri: "/data/doc",
        content: "{}",
        content_type: shorthand,
      });

      expect(result.isError).toBeUndefined();
      expect(clients.documents.put).toHaveBeenCalledWith(
        "/data/doc",
        "{}",
        mime,
        expect.any(Object)
      );
    });
  }
});

// ─── ml_document_patch_batch ──────────────────────────────────────────────

describe("ml_document_patch_batch handler (readonly=false)", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerDocumentTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  const patch = { patch: [{ insert: { context: "/node()", position: "last-child", content: { enriched: true } } }] };

  it("returns error when neither uris nor collection is provided", async () => {
    const result = await tools.get("ml_document_patch_batch")!({ patch });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("at least one of");
  });

  it("patches all URIs in the provided list and reports success count", async () => {
    clients.documents.patchDocument.mockResolvedValue(undefined);
    const result = await tools.get("ml_document_patch_batch")!({
      uris: ["/doc/a.json", "/doc/b.json", "/doc/c.json"],
      patch,
    });

    expect(result.isError).toBeUndefined();
    expect(clients.documents.patchDocument).toHaveBeenCalledTimes(3);
    const text = result.content[0].text;
    expect(text).toContain("Attempted: 3");
    expect(text).toContain("Succeeded: 3");
    expect(text).toContain("Failed:    0");
  });

  it("lists collection documents then patches each one", async () => {
    clients.documents.list.mockResolvedValue({ uris: ["/col/x.json", "/col/y.json"] });
    clients.documents.patchDocument.mockResolvedValue(undefined);

    const result = await tools.get("ml_document_patch_batch")!({
      collection: "my-collection",
      patch,
    });

    expect(result.isError).toBeUndefined();
    expect(clients.documents.list).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "my-collection" })
    );
    expect(clients.documents.patchDocument).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toContain("Succeeded: 2");
  });

  it("deduplicates URIs when a URI appears in both uris list and collection", async () => {
    clients.documents.list.mockResolvedValue({ uris: ["/doc/a.json", "/doc/b.json"] });
    clients.documents.patchDocument.mockResolvedValue(undefined);

    await tools.get("ml_document_patch_batch")!({
      uris: ["/doc/a.json"],
      collection: "col",
      patch,
    });

    // /doc/a.json appears in both — should only be patched once
    expect(clients.documents.patchDocument).toHaveBeenCalledTimes(2);
  });

  it("reports per-document failures without short-circuiting", async () => {
    clients.documents.patchDocument
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new MarkLogicError("not found", 404))
      .mockResolvedValueOnce(undefined);

    const result = await tools.get("ml_document_patch_batch")!({
      uris: ["/doc/a.json", "/doc/b.json", "/doc/c.json"],
      patch,
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Succeeded: 2");
    expect(text).toContain("Failed:    1");
    expect(text).toContain("/doc/b.json");
  });

  it("returns 'no documents' when collection is empty", async () => {
    clients.documents.list.mockResolvedValue({ uris: [] });
    const result = await tools.get("ml_document_patch_batch")!({
      collection: "empty-col",
      patch,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No documents found");
  });
});
