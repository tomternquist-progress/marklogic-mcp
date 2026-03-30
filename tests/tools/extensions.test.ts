import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerExtensionTools } from "../../src/tools/extensions.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    extensions: {
      listExtensions: vi.fn(),
      getExtension: vi.fn(),
      putExtension: vi.fn(),
      deleteExtension: vi.fn(),
      callExtension: vi.fn(),
    },
  };
}

// ─── Tool registration ─────────────────────────────────────────────────────────

describe("registerExtensionTools – registration (readonly=false)", () => {
  it("registers all 5 tools when not in readonly mode", () => {
    const { server, tools } = createMockServer();
    registerExtensionTools(server as never, createMockClients() as never, false);

    expect(tools.has("ml_extension_list")).toBe(true);
    expect(tools.has("ml_extension_get")).toBe(true);
    expect(tools.has("ml_extension_call")).toBe(true);
    expect(tools.has("ml_extension_put")).toBe(true);
    expect(tools.has("ml_extension_delete")).toBe(true);
    expect(tools.size).toBe(5);
  });

  it("registers only 3 read tools when readonly=true", () => {
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

// ─── ml_extension_list ────────────────────────────────────────────────────────

describe("ml_extension_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerExtensionTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  it("returns JSON list of extensions on success", async () => {
    const ext = [{ name: "my-ext", language: "javascript" }];
    clients.extensions.listExtensions.mockResolvedValue(ext);

    const result = await tools.get("ml_extension_list")!({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(ext);
  });

  it("returns a friendly message when no extensions are deployed", async () => {
    clients.extensions.listExtensions.mockResolvedValue([]);

    const result = await tools.get("ml_extension_list")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No REST extensions");
  });

  it("sets isError on failure", async () => {
    clients.extensions.listExtensions.mockRejectedValue(new Error("network error"));

    const result = await tools.get("ml_extension_list")!({});
    expect(result.isError).toBe(true);
  });
});

// ─── ml_extension_get ────────────────────────────────────────────────────────

describe("ml_extension_get handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerExtensionTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  it("returns extension source code on success", async () => {
    clients.extensions.getExtension.mockResolvedValue("'use strict'; exports.GET = function() {};");

    const result = await tools.get("ml_extension_get")!({ name: "my-ext" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("exports.GET");
  });

  it("passes the extension name to the client", async () => {
    clients.extensions.getExtension.mockResolvedValue("code");

    await tools.get("ml_extension_get")!({ name: "test-extension" });
    expect(clients.extensions.getExtension).toHaveBeenCalledWith("test-extension");
  });

  it("sets isError on failure", async () => {
    clients.extensions.getExtension.mockRejectedValue(new Error("404"));

    const result = await tools.get("ml_extension_get")!({ name: "missing" });
    expect(result.isError).toBe(true);
  });
});

// ─── ml_extension_call ───────────────────────────────────────────────────────

describe("ml_extension_call handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerExtensionTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  it("returns JSON result on success", async () => {
    clients.extensions.callExtension.mockResolvedValue({ employees: [] });

    const result = await tools.get("ml_extension_call")!({
      name: "emp-search",
      method: "GET",
      params: { department: "Engineering" },
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ employees: [] });
  });

  it("passes name, method, params, and body to the client", async () => {
    clients.extensions.callExtension.mockResolvedValue({});

    await tools.get("ml_extension_call")!({
      name: "my-ext",
      method: "POST",
      params: { foo: "bar" },
      body: { key: "value" },
    });

    expect(clients.extensions.callExtension).toHaveBeenCalledWith(
      "my-ext",
      "POST",
      { foo: "bar" },
      { key: "value" }
    );
  });

  it("defaults method to GET and passes empty params when omitted", async () => {
    clients.extensions.callExtension.mockResolvedValue({});

    await tools.get("ml_extension_call")!({ name: "no-params-ext", method: "GET" });

    expect(clients.extensions.callExtension).toHaveBeenCalledWith(
      "no-params-ext",
      "GET",
      {},
      undefined
    );
  });

  it("sets isError on failure and includes hint text", async () => {
    clients.extensions.callExtension.mockRejectedValue(new Error("500 Server Error"));

    const result = await tools.get("ml_extension_call")!({ name: "broken", method: "GET" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Hint:");
  });
});

// ─── ml_extension_put ────────────────────────────────────────────────────────

describe("ml_extension_put handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerExtensionTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  it("returns success message after deploying an extension", async () => {
    clients.extensions.putExtension.mockResolvedValue(undefined);

    const result = await tools.get("ml_extension_put")!({
      name: "new-ext",
      code: "'use strict'; exports.GET = function() { return {}; };",
      language: "javascript",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("deployed successfully");
    expect(result.content[0].text).toContain("new-ext");
  });

  it("passes name, code, and language to the client", async () => {
    clients.extensions.putExtension.mockResolvedValue(undefined);

    await tools.get("ml_extension_put")!({
      name: "xq-ext",
      code: "xquery version '1.0-ml'; ...",
      language: "xquery",
    });

    expect(clients.extensions.putExtension).toHaveBeenCalledWith(
      "xq-ext",
      "xquery version '1.0-ml'; ...",
      "xquery"
    );
  });

  it("sets isError on failure", async () => {
    clients.extensions.putExtension.mockRejectedValue(new Error("syntax error"));

    const result = await tools.get("ml_extension_put")!({
      name: "bad-ext",
      code: "invalid code {{{",
      language: "javascript",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Hint:");
  });
});

// ─── ml_extension_delete ─────────────────────────────────────────────────────

describe("ml_extension_delete handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerExtensionTools(mock.server as never, clients as never, false);
    tools = mock.tools;
  });

  it("returns deletion confirmation on success", async () => {
    clients.extensions.deleteExtension.mockResolvedValue(undefined);

    const result = await tools.get("ml_extension_delete")!({ name: "old-ext" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("old-ext");
    expect(result.content[0].text).toContain("deleted");
  });

  it("calls deleteExtension with the correct name", async () => {
    clients.extensions.deleteExtension.mockResolvedValue(undefined);

    await tools.get("ml_extension_delete")!({ name: "target-ext" });
    expect(clients.extensions.deleteExtension).toHaveBeenCalledWith("target-ext");
  });

  it("sets isError on failure", async () => {
    clients.extensions.deleteExtension.mockRejectedValue(new Error("not found"));

    const result = await tools.get("ml_extension_delete")!({ name: "ghost" });
    expect(result.isError).toBe(true);
  });
});
