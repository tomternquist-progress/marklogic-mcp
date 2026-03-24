import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerExtensionTools } from "../../src/tools/extensions.js";
import { MarkLogicError } from "../../src/utils/errors.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(_name, handler);
    }),
  };
  return { server, tools };
}

function createMockClients() {
  return {
    extensions: {
      listExtensions: vi.fn(),
      getExtension: vi.fn(),
      callExtension: vi.fn(),
      putExtension: vi.fn(),
      deleteExtension: vi.fn(),
    },
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("registerExtensionTools – registration", () => {
  it("registers read + write tools when readonly=false", () => {
    const { server, tools } = createMockServer();
    registerExtensionTools(server as never, createMockClients() as never, false);
    expect(tools.has("ml_extension_list")).toBe(true);
    expect(tools.has("ml_extension_get")).toBe(true);
    expect(tools.has("ml_extension_call")).toBe(true);
    expect(tools.has("ml_extension_put")).toBe(true);
    expect(tools.has("ml_extension_delete")).toBe(true);
    expect(tools.size).toBe(5);
  });

  it("registers only read tools when readonly=true", () => {
    const { server, tools } = createMockServer();
    registerExtensionTools(server as never, createMockClients() as never, true);
    expect(tools.has("ml_extension_list")).toBe(true);
    expect(tools.has("ml_extension_get")).toBe(true);
    expect(tools.has("ml_extension_call")).toBe(true);
    expect(tools.has("ml_extension_put")).toBe(false);
    expect(tools.has("ml_extension_delete")).toBe(false);
    expect(tools.size).toBe(3);
  });
});

// ── ml_extension_list ─────────────────────────────────────────────────────────

describe("ml_extension_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerExtensionTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  it("returns JSON list of extensions", async () => {
    const exts = [{ name: "my-ext", language: "javascript" }];
    clients.extensions.listExtensions.mockResolvedValue(exts);
    const result = await tools.get("ml_extension_list")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("my-ext");
  });

  it("returns a message when no extensions are deployed", async () => {
    clients.extensions.listExtensions.mockResolvedValue([]);
    const result = await tools.get("ml_extension_list")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No REST extensions deployed");
  });

  it("returns isError on failure", async () => {
    clients.extensions.listExtensions.mockRejectedValue(new MarkLogicError("boom", 500));
    const result = await tools.get("ml_extension_list")!({});
    expect(result.isError).toBe(true);
  });
});

// ── ml_extension_get ──────────────────────────────────────────────────────────

describe("ml_extension_get handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerExtensionTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  it("returns source code for the named extension", async () => {
    clients.extensions.getExtension.mockResolvedValue("'use strict'; exports.GET = function() {};");
    const result = await tools.get("ml_extension_get")!({ name: "my-ext" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("exports.GET");
    expect(clients.extensions.getExtension).toHaveBeenCalledWith("my-ext");
  });

  it("returns isError on failure", async () => {
    clients.extensions.getExtension.mockRejectedValue(new MarkLogicError("not found", 404));
    const result = await tools.get("ml_extension_get")!({ name: "missing" });
    expect(result.isError).toBe(true);
  });
});

// ── ml_extension_call ─────────────────────────────────────────────────────────

describe("ml_extension_call handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerExtensionTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  it("calls extension with GET and params", async () => {
    clients.extensions.callExtension.mockResolvedValue({ results: [] });
    const result = await tools.get("ml_extension_call")!({
      name: "emp-search",
      method: "GET",
      params: { department: "Engineering" },
    });
    expect(result.isError).toBeUndefined();
    expect(clients.extensions.callExtension).toHaveBeenCalledWith(
      "emp-search", "GET", { department: "Engineering" }, undefined
    );
  });

  it("calls extension with POST and body", async () => {
    clients.extensions.callExtension.mockResolvedValue({ ok: true });
    const result = await tools.get("ml_extension_call")!({
      name: "my-writer",
      method: "POST",
      body: { data: "value" },
    });
    expect(result.isError).toBeUndefined();
    expect(clients.extensions.callExtension).toHaveBeenCalledWith(
      "my-writer", "POST", {}, { data: "value" }
    );
  });

  it("uses default GET when method is not provided", async () => {
    clients.extensions.callExtension.mockResolvedValue({});
    await tools.get("ml_extension_call")!({ name: "ext", method: "GET" });
    expect(clients.extensions.callExtension).toHaveBeenCalledWith("ext", "GET", {}, undefined);
  });

  it("returns isError with hint on failure", async () => {
    clients.extensions.callExtension.mockRejectedValue(new MarkLogicError("XDMP-NOTFOUND", 404));
    const result = await tools.get("ml_extension_call")!({ name: "bad-ext", method: "GET" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Hint");
  });
});

// ── ml_extension_put ──────────────────────────────────────────────────────────

describe("ml_extension_put handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerExtensionTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  it("deploys an extension successfully", async () => {
    clients.extensions.putExtension.mockResolvedValue(undefined);
    const result = await tools.get("ml_extension_put")!({
      name: "my-ext",
      code: "'use strict'; exports.GET = function() {};",
      language: "javascript",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("deployed successfully");
    expect(clients.extensions.putExtension).toHaveBeenCalledWith(
      "my-ext",
      "'use strict'; exports.GET = function() {};",
      "javascript"
    );
  });

  it("defaults language to javascript", async () => {
    clients.extensions.putExtension.mockResolvedValue(undefined);
    await tools.get("ml_extension_put")!({ name: "ext", code: "code", language: "javascript" });
    expect(clients.extensions.putExtension).toHaveBeenCalledWith("ext", "code", "javascript");
  });

  it("returns isError with hint on failure", async () => {
    clients.extensions.putExtension.mockRejectedValue(new MarkLogicError("XDMP-MODNOTFOUND", 400));
    const result = await tools.get("ml_extension_put")!({ name: "bad", code: "bad code" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Hint");
  });
});

// ── ml_extension_delete ───────────────────────────────────────────────────────

describe("ml_extension_delete handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerExtensionTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  it("deletes an extension successfully", async () => {
    clients.extensions.deleteExtension.mockResolvedValue(undefined);
    const result = await tools.get("ml_extension_delete")!({ name: "my-ext" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("deleted");
    expect(clients.extensions.deleteExtension).toHaveBeenCalledWith("my-ext");
  });

  it("returns isError on failure", async () => {
    clients.extensions.deleteExtension.mockRejectedValue(new MarkLogicError("error", 500));
    const result = await tools.get("ml_extension_delete")!({ name: "ext" });
    expect(result.isError).toBe(true);
  });
});
