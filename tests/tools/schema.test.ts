import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerSchemaTools } from "../../src/tools/schema.js";
import { MarkLogicError } from "../../src/utils/errors.js";

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
    schema: {
      discoverSchema: vi.fn(),
      getTdeSchemas: vi.fn(),
      validateTde: vi.fn(),
      listIndexes: vi.fn(),
      listCollections: vi.fn(),
      listNamespaces: vi.fn(),
    },
  };
}

// ─── Tool registration ─────────────────────────────────────────────────────

describe("registerSchemaTools – tool registration", () => {
  it("registers all 6 schema tools", () => {
    const { server, tools } = createMockServer();
    registerSchemaTools(server as never, createMockClients() as never);

    expect(tools.has("ml_schema_discover")).toBe(true);
    expect(tools.has("ml_schema_get_tde")).toBe(true);
    expect(tools.has("ml_tde_validate")).toBe(true);
    expect(tools.has("ml_indexes_list")).toBe(true);
    expect(tools.has("ml_collections_list")).toBe(true);
    expect(tools.has("ml_namespaces_list")).toBe(true);
    expect(tools.size).toBe(6);
  });
});

// ─── ml_schema_discover ─────────────────────────────────────────────────────

describe("ml_schema_discover handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns schema discovery results", async () => {
    const schema = { fields: [{ name: "id", type: "number" }] };
    clients.schema.discoverSchema.mockResolvedValue(schema);

    const result = await tools.get("ml_schema_discover")!({ collection: "orders" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(schema);
  });

  it("passes sample_size as sampleSize to client", async () => {
    clients.schema.discoverSchema.mockResolvedValue({});
    await tools.get("ml_schema_discover")!({
      collection: "test",
      sample_size: 20,
      database: "MyDB",
    });

    expect(clients.schema.discoverSchema).toHaveBeenCalledWith({
      collection: "test",
      sampleSize: 20,
      database: "MyDB",
    });
  });

  it("sets isError on failure", async () => {
    clients.schema.discoverSchema.mockRejectedValue(new MarkLogicError("error", 500));
    const result = await tools.get("ml_schema_discover")!({});

    expect(result.isError).toBe(true);
  });
});

// ─── ml_schema_get_tde ──────────────────────────────────────────────────────

describe("ml_schema_get_tde handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("lists TDE URIs when no schema_name given", async () => {
    const uris = ["/tde/events.json", "/tde/users.json"];
    clients.schema.getTdeSchemas.mockResolvedValue(uris);

    const result = await tools.get("ml_schema_get_tde")!({});

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(uris);
    expect(clients.schema.getTdeSchemas).toHaveBeenCalledWith(undefined, undefined);
  });

  it("retrieves specific TDE when schema_name given", async () => {
    const tde = { template: { rows: [] } };
    clients.schema.getTdeSchemas.mockResolvedValue(tde);

    await tools.get("ml_schema_get_tde")!({
      schema_name: "/tde/events.json",
      database: "Schemas",
    });

    expect(clients.schema.getTdeSchemas).toHaveBeenCalledWith("Schemas", "/tde/events.json");
  });
});

// ─── ml_tde_validate ────────────────────────────────────────────────────────

describe("ml_tde_validate handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns validation results on success", async () => {
    const validation = { rowCount: 10, docCount: 5, rows: [] };
    clients.schema.validateTde.mockResolvedValue(validation);

    const result = await tools.get("ml_tde_validate")!({
      tde_uri: "/tde/events.json",
      collection: "events",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(validation);
  });

  it("returns REINDEXING_IN_PROGRESS message on reindexing error", async () => {
    clients.schema.validateTde.mockRejectedValue(
      new MarkLogicError("SQL-TABLEREINDEXING: table is reindexing", 500)
    );

    const result = await tools.get("ml_tde_validate")!({
      tde_uri: "/tde/events.json",
      collection: "events",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("REINDEXING_IN_PROGRESS");
    expect(result.content[0].text).toContain("ml_reindex_status");
  });

  it("returns generic error for non-reindexing failures", async () => {
    clients.schema.validateTde.mockRejectedValue(
      new MarkLogicError("SQL-TABLENOTFOUND", 400)
    );

    const result = await tools.get("ml_tde_validate")!({
      tde_uri: "/tde/events.json",
      collection: "events",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("REINDEXING_IN_PROGRESS");
  });

  it("passes sampleSize to client", async () => {
    clients.schema.validateTde.mockResolvedValue({});
    await tools.get("ml_tde_validate")!({
      tde_uri: "/tde/test.json",
      collection: "test",
      sample_size: 10,
    });

    expect(clients.schema.validateTde).toHaveBeenCalledWith({
      tdeUri: "/tde/test.json",
      collection: "test",
      sampleSize: 10,
    });
  });
});

// ─── ml_indexes_list ────────────────────────────────────────────────────────

describe("ml_indexes_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns all indexes when no filter", async () => {
    const indexes = [
      { type: "range-element", name: "date" },
      { type: "geospatial-element-pair", name: "location" },
    ];
    clients.schema.listIndexes.mockResolvedValue(indexes);

    const result = await tools.get("ml_indexes_list")!({ database: "Documents" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(indexes);
  });

  it("filters to geospatial indexes", async () => {
    const indexes = [
      { type: "range-element", name: "date" },
      { type: "geospatial-element-pair", name: "location" },
      { type: "geospatial-path", name: "coordinates" },
    ];
    clients.schema.listIndexes.mockResolvedValue(indexes);

    const result = await tools.get("ml_indexes_list")!({
      database: "Documents",
      index_type: "geospatial",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((i: { type: string }) => i.type.startsWith("geospatial-"))).toBe(true);
  });

  it("filters by specific index type", async () => {
    const indexes = [
      { type: "range-element", name: "date" },
      { type: "range-path", name: "path" },
    ];
    clients.schema.listIndexes.mockResolvedValue(indexes);

    const result = await tools.get("ml_indexes_list")!({
      database: "Documents",
      index_type: "range-element",
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe("range-element");
  });

  it("returns all indexes when index_type is 'all'", async () => {
    const indexes = [{ type: "range-element", name: "x" }];
    clients.schema.listIndexes.mockResolvedValue(indexes);

    const result = await tools.get("ml_indexes_list")!({
      database: "Documents",
      index_type: "all",
    });

    expect(JSON.parse(result.content[0].text)).toEqual(indexes);
  });
});

// ─── ml_collections_list ────────────────────────────────────────────────────

describe("ml_collections_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("uses default limit of 50", async () => {
    clients.schema.listCollections.mockResolvedValue([]);
    await tools.get("ml_collections_list")!({});

    expect(clients.schema.listCollections).toHaveBeenCalledWith(undefined, 50);
  });

  it("passes custom limit", async () => {
    clients.schema.listCollections.mockResolvedValue([]);
    await tools.get("ml_collections_list")!({ limit: 100, database: "TestDB" });

    expect(clients.schema.listCollections).toHaveBeenCalledWith("TestDB", 100);
  });
});

// ─── ml_namespaces_list ─────────────────────────────────────────────────────

describe("ml_namespaces_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns namespaces", async () => {
    const ns = [{ prefix: "sem", uri: "http://marklogic.com/semantics" }];
    clients.schema.listNamespaces.mockResolvedValue(ns);

    const result = await tools.get("ml_namespaces_list")!({ database: "Documents" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(ns);
  });
});
