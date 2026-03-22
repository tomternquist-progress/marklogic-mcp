/**
 * Unit tests for FastTrack tool handlers:
 *   ml_search_options_list   — list all stored search-options configurations
 *   ml_search_options_get    — retrieve a named search-options configuration
 *   ml_search_options_put    — create/replace a search-options configuration (readonly=false only)
 *   ml_search_options_delete — delete a search-options configuration (readonly=false only)
 *
 * All client calls are mocked — no live MarkLogic required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerFastTrackTools } from "../../src/tools/fasttrack.js";
import { MarkLogicError } from "../../src/utils/errors.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(_name, handler);
    },
  };
  return { server, tools };
}

function createMockClients() {
  return {
    fasttrack: {
      listSearchOptions: vi.fn(),
      getSearchOptions: vi.fn(),
      putSearchOptions: vi.fn(),
      deleteSearchOptions: vi.fn(),
    },
  };
}

// ─── Registration ──────────────────────────────────────────────────────────────

describe("registerFastTrackTools – registration", () => {
  it("registers 2 read-only tools in readonly mode", () => {
    const { server, tools } = createMockServer();
    registerFastTrackTools(server as never, createMockClients() as never, true);
    expect(tools.has("ml_search_options_list")).toBe(true);
    expect(tools.has("ml_search_options_get")).toBe(true);
    expect(tools.has("ml_search_options_put")).toBe(false);
    expect(tools.has("ml_search_options_delete")).toBe(false);
    expect(tools.size).toBe(2);
  });

  it("registers all 4 tools in read-write mode", () => {
    const { server, tools } = createMockServer();
    registerFastTrackTools(server as never, createMockClients() as never, false);
    expect(tools.has("ml_search_options_list")).toBe(true);
    expect(tools.has("ml_search_options_get")).toBe(true);
    expect(tools.has("ml_search_options_put")).toBe(true);
    expect(tools.has("ml_search_options_delete")).toBe(true);
    expect(tools.size).toBe(4);
  });
});

// ─── ml_search_options_list ───────────────────────────────────────────────────

describe("ml_search_options_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerFastTrackTools(server as never, clients as never, false);
    tools = t;
  });

  it("returns JSON list of option names on success", async () => {
    const mockList = { options: ["default", "article-search", "product-facets"] };
    clients.fasttrack.listSearchOptions.mockResolvedValue(mockList);

    const result = await tools.get("ml_search_options_list")!({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockList);
  });

  it("passes database parameter to client", async () => {
    clients.fasttrack.listSearchOptions.mockResolvedValue([]);
    await tools.get("ml_search_options_list")!({ database: "ContentDB" });
    expect(clients.fasttrack.listSearchOptions).toHaveBeenCalledWith("ContentDB");
  });

  it("passes undefined when database is omitted", async () => {
    clients.fasttrack.listSearchOptions.mockResolvedValue([]);
    await tools.get("ml_search_options_list")!({});
    expect(clients.fasttrack.listSearchOptions).toHaveBeenCalledWith(undefined);
  });

  it("returns isError on failure", async () => {
    clients.fasttrack.listSearchOptions.mockRejectedValue(new MarkLogicError("server error", 500));
    const result = await tools.get("ml_search_options_list")!({});
    expect(result.isError).toBe(true);
  });
});

// ─── ml_search_options_get ────────────────────────────────────────────────────

describe("ml_search_options_get handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  const SAMPLE_OPTIONS = {
    options: {
      "return-facets": true,
      constraint: [{ name: "category", range: { type: "xs:string" } }],
    },
  };

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerFastTrackTools(server as never, clients as never, false);
    tools = t;
  });

  it("returns options JSON on success", async () => {
    clients.fasttrack.getSearchOptions.mockResolvedValue(SAMPLE_OPTIONS);
    const result = await tools.get("ml_search_options_get")!({ name: "article-search" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(SAMPLE_OPTIONS);
  });

  it("passes name and database to client", async () => {
    clients.fasttrack.getSearchOptions.mockResolvedValue(SAMPLE_OPTIONS);
    await tools.get("ml_search_options_get")!({ name: "my-opts", database: "DB1" });
    expect(clients.fasttrack.getSearchOptions).toHaveBeenCalledWith("my-opts", "DB1");
  });

  it("passes undefined database when omitted", async () => {
    clients.fasttrack.getSearchOptions.mockResolvedValue(SAMPLE_OPTIONS);
    await tools.get("ml_search_options_get")!({ name: "my-opts" });
    expect(clients.fasttrack.getSearchOptions).toHaveBeenCalledWith("my-opts", undefined);
  });

  it("returns isError on 404 (options set not found)", async () => {
    clients.fasttrack.getSearchOptions.mockRejectedValue(new MarkLogicError("not found", 404));
    const result = await tools.get("ml_search_options_get")!({ name: "nonexistent" });
    expect(result.isError).toBe(true);
  });
});

// ─── ml_search_options_put ────────────────────────────────────────────────────

describe("ml_search_options_put handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  const VALID_OPTIONS = {
    options: {
      "return-facets": true,
      constraint: [{ name: "dept", range: { type: "xs:string", "json-property": "department" } }],
    },
  };

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerFastTrackTools(server as never, clients as never, false);
    tools = t;
  });

  it("returns success message with verify hint", async () => {
    clients.fasttrack.putSearchOptions.mockResolvedValue(undefined);
    const result = await tools.get("ml_search_options_put")!({
      name: "my-search",
      options: VALID_OPTIONS,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("saved successfully");
    expect(result.content[0].text).toContain("my-search");
    expect(result.content[0].text).toContain("ml_search");
  });

  it("passes name, options, and database to client", async () => {
    clients.fasttrack.putSearchOptions.mockResolvedValue(undefined);
    await tools.get("ml_search_options_put")!({
      name: "opts-name",
      options: VALID_OPTIONS,
      database: "ContentDB",
    });
    expect(clients.fasttrack.putSearchOptions).toHaveBeenCalledWith(
      "opts-name",
      VALID_OPTIONS,
      "ContentDB"
    );
  });

  it("passes undefined database when omitted", async () => {
    clients.fasttrack.putSearchOptions.mockResolvedValue(undefined);
    await tools.get("ml_search_options_put")!({ name: "opts", options: VALID_OPTIONS });
    expect(clients.fasttrack.putSearchOptions).toHaveBeenCalledWith("opts", VALID_OPTIONS, undefined);
  });

  it("returns isError on validation failure (e.g. bad options XML)", async () => {
    clients.fasttrack.putSearchOptions.mockRejectedValue(
      new MarkLogicError("XDMP-VALIDATEMISSINGATTR: missing 'name' on bucket", 400)
    );
    const result = await tools.get("ml_search_options_put")!({
      name: "bad-opts",
      options: { options: { constraint: [{ name: "x", range: { bucket: [{ lt: "100" }] } }] } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("XDMP-VALIDATEMISSINGATTR");
  });
});

// ─── ml_search_options_delete ─────────────────────────────────────────────────

describe("ml_search_options_delete handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerFastTrackTools(server as never, clients as never, false);
    tools = t;
  });

  it("returns deletion confirmation message", async () => {
    clients.fasttrack.deleteSearchOptions.mockResolvedValue(undefined);
    const result = await tools.get("ml_search_options_delete")!({ name: "old-opts" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("deleted");
    expect(result.content[0].text).toContain("old-opts");
  });

  it("passes name and database to client", async () => {
    clients.fasttrack.deleteSearchOptions.mockResolvedValue(undefined);
    await tools.get("ml_search_options_delete")!({ name: "my-opts", database: "DB1" });
    expect(clients.fasttrack.deleteSearchOptions).toHaveBeenCalledWith("my-opts", "DB1");
  });

  it("passes undefined database when omitted", async () => {
    clients.fasttrack.deleteSearchOptions.mockResolvedValue(undefined);
    await tools.get("ml_search_options_delete")!({ name: "opts" });
    expect(clients.fasttrack.deleteSearchOptions).toHaveBeenCalledWith("opts", undefined);
  });

  it("returns isError when options set does not exist", async () => {
    clients.fasttrack.deleteSearchOptions.mockRejectedValue(new MarkLogicError("not found", 404));
    const result = await tools.get("ml_search_options_delete")!({ name: "ghost" });
    expect(result.isError).toBe(true);
  });
});
