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
    documents: {
      put: vi.fn(),
    },
    fasttrack: {
      listSearchOptions: vi.fn(),
    },
  };
}

// ─── Tool registration ─────────────────────────────────────────────────────

describe("registerSchemaTools – tool registration", () => {
  it("registers all 8 schema tools", () => {
    const { server, tools } = createMockServer();
    registerSchemaTools(server as never, createMockClients() as never);

    expect(tools.has("ml_schema_discover")).toBe(true);
    expect(tools.has("ml_schema_get_tde")).toBe(true);
    expect(tools.has("ml_tde_validate")).toBe(true);
    expect(tools.has("ml_tde_install")).toBe(true);
    expect(tools.has("ml_indexes_list")).toBe(true);
    expect(tools.has("ml_collections_list")).toBe(true);
    expect(tools.has("ml_namespaces_list")).toBe(true);
    expect(tools.has("ml_search_surface")).toBe(true);
    expect(tools.size).toBe(8);
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
    expect(result.content[0].text).toContain("TABLEREINDEXING");
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

  it("sets isError on failure", async () => {
    clients.schema.listNamespaces.mockRejectedValue(new MarkLogicError("db error", 500));
    const result = await tools.get("ml_namespaces_list")!({});
    expect(result.isError).toBe(true);
  });
});

// ─── ml_tde_validate – TDE-INVALIDTEMPLATEPROPNODE hint ────────────────────

describe("ml_tde_validate – INVALIDTEMPLATEPROPNODE hint", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns INVALIDTEMPLATEPROPNODE hint on that error", async () => {
    clients.schema.validateTde.mockRejectedValue(
      new MarkLogicError("TDE-INVALIDTEMPLATEPROPNODE: invalid property 'column' in triple", 400)
    );

    const result = await tools.get("ml_tde_validate")!({
      tde_uri: "/tde/bad.json",
      collection: "test",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("INVALIDTEMPLATEPROPNODE");
    expect(result.content[0].text).toContain('{ "val":');
    expect(result.content[0].text).toContain("fn:root()");
  });
});

// ─── ml_tde_install ────────────────────────────────────────────────────────

describe("ml_tde_install handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("installs TDE to Schemas database with correct collection", async () => {
    clients.documents.put.mockResolvedValue(undefined);

    const result = await tools.get("ml_tde_install")!({
      uri: "/tde/my-template.json",
      content: '{"template":{"rows":[]}}',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("TDE TEMPLATE INSTALLED");
    expect(result.content[0].text).toContain("/tde/my-template.json");
    expect(result.content[0].text).toContain("Schemas");
    expect(clients.documents.put).toHaveBeenCalledWith(
      "/tde/my-template.json",
      '{"template":{"rows":[]}}',
      "application/json",
      {
        collections: ["http://marklogic.com/xdmp/tde"],
        database: "Schemas",
      }
    );
  });

  it("passes content_type when specified", async () => {
    clients.documents.put.mockResolvedValue(undefined);

    await tools.get("ml_tde_install")!({
      uri: "/tde/my-template.xml",
      content: "<template/>",
      content_type: "application/xml",
    });

    expect(clients.documents.put).toHaveBeenCalledWith(
      "/tde/my-template.xml",
      "<template/>",
      "application/xml",
      expect.objectContaining({ database: "Schemas" })
    );
  });

  it("sets isError on failure", async () => {
    clients.documents.put.mockRejectedValue(new MarkLogicError("permission denied", 403));

    const result = await tools.get("ml_tde_install")!({
      uri: "/tde/test.json",
      content: "{}",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("403");
  });
});

// ─── ml_schema_get_tde – error path ────────────────────────────────────────

describe("ml_schema_get_tde – error handling", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("sets isError on failure", async () => {
    clients.schema.getTdeSchemas.mockRejectedValue(new MarkLogicError("not found", 404));
    const result = await tools.get("ml_schema_get_tde")!({ schema_name: "/tde/missing.json" });
    expect(result.isError).toBe(true);
  });
});

// ─── ml_indexes_list – error path ──────────────────────────────────────────

describe("ml_indexes_list – error handling", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("sets isError on failure", async () => {
    clients.schema.listIndexes.mockRejectedValue(new MarkLogicError("db error", 500));
    const result = await tools.get("ml_indexes_list")!({ database: "Documents" });
    expect(result.isError).toBe(true);
  });
});

// ─── ml_collections_list – error path ──────────────────────────────────────

describe("ml_collections_list – error handling", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("sets isError on failure", async () => {
    clients.schema.listCollections.mockRejectedValue(new MarkLogicError("error", 500));
    const result = await tools.get("ml_collections_list")!({});
    expect(result.isError).toBe(true);
  });
});

// ─── ml_search_surface ─────────────────────────────────────────────────────

describe("ml_search_surface handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSchemaTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("aggregates discovery + options-list and builds suggestedBindings", async () => {
    clients.schema.discoverSchema.mockResolvedValue({
      documentCount: 42,
      inferredFields: [
        { path: "state", type: "string", nullable: false, cardinality: "single", exampleValues: ["TX"], hasRangeIndex: false },
        { path: "age",   type: "number", nullable: false, cardinality: "single", exampleValues: [70],   hasRangeIndex: true  },
      ],
      rangeIndexes: [
        { type: "range-element", localname: "age", scalarType: "int" },
      ],
      tdeSchemas: [],
    });
    clients.fasttrack.listSearchOptions.mockResolvedValue([{ name: "customers-opts" }]);

    const result = await tools.get("ml_search_surface")!({ collection: "customers", database: "MyDB" });

    expect(result.isError).toBeUndefined();
    const surface = JSON.parse(result.content[0].text);

    expect(surface.documentCount).toBe(42);
    expect(surface.searchOptionsNames).toEqual(["customers-opts"]);
    // Range-indexed 'age' should pick the typed range binding
    expect(surface.suggestedBindings.age).toEqual({ type: "element-range", name: "age", scalar_type: "int" });
    // Non-indexed 'state' must NOT appear in suggestedBindings (cts.parse SJS needs a range index)
    expect(surface.suggestedBindings.state).toBeUndefined();
    // …but it should be advertised as a bareword search candidate
    expect(surface.barewordFields).toEqual(["state"]);
    // nextSteps is present and references the new pipeline
    expect(surface.nextSteps.join(" ")).toContain("ml_parse_query");
  });

  it("survives listSearchOptions failure and returns empty searchOptionsNames", async () => {
    clients.schema.discoverSchema.mockResolvedValue({
      documentCount: 0,
      inferredFields: [],
      rangeIndexes: [],
      tdeSchemas: [],
    });
    clients.fasttrack.listSearchOptions.mockRejectedValue(new Error("403 forbidden"));

    const result = await tools.get("ml_search_surface")!({ database: "MyDB" });

    expect(result.isError).toBeUndefined();
    const surface = JSON.parse(result.content[0].text);
    expect(surface.searchOptionsNames).toEqual([]);
  });

  it("sets isError when discovery itself fails", async () => {
    clients.schema.discoverSchema.mockRejectedValue(new MarkLogicError("db unreachable", 500));
    const result = await tools.get("ml_search_surface")!({ collection: "x" });
    expect(result.isError).toBe(true);
  });

  it("derives a path-range binding using the leaf path step as the tag name", async () => {
    clients.schema.discoverSchema.mockResolvedValue({
      documentCount: 5,
      inferredFields: [],
      // Path range index — leaf is "ageYears"
      rangeIndexes: [
        { type: "range-path", pathExpression: "/customer/profile/ageYears", scalarType: "int" },
      ],
      tdeSchemas: [],
    });
    clients.fasttrack.listSearchOptions.mockResolvedValue([]);

    const result = await tools.get("ml_search_surface")!({ collection: "customers" });
    const surface = JSON.parse(result.content[0].text);

    expect(surface.suggestedBindings.ageYears).toEqual({
      type: "path-range",
      name: "/customer/profile/ageYears",
      scalar_type: "int",
    });
  });

  it("derives a field-range binding from a range-field index", async () => {
    clients.schema.discoverSchema.mockResolvedValue({
      documentCount: 0,
      inferredFields: [],
      rangeIndexes: [
        { type: "range-field", localname: "fullText", scalarType: "string" },
      ],
      tdeSchemas: [],
    });
    clients.fasttrack.listSearchOptions.mockResolvedValue([]);

    const result = await tools.get("ml_search_surface")!({});
    const surface = JSON.parse(result.content[0].text);

    expect(surface.suggestedBindings.fullText).toEqual({
      type: "field-range",
      name: "fullText",
      scalar_type: "string",
    });
  });

  it("range-indexed field gets a suggestedBinding and is NOT also in barewordFields", async () => {
    clients.schema.discoverSchema.mockResolvedValue({
      documentCount: 1,
      inferredFields: [
        { path: "age", type: "number", nullable: false, cardinality: "single", exampleValues: [70], hasRangeIndex: true },
      ],
      rangeIndexes: [
        { type: "range-element", localname: "age", scalarType: "int" },
      ],
      tdeSchemas: [],
    });
    clients.fasttrack.listSearchOptions.mockResolvedValue([]);

    const surface = JSON.parse((await tools.get("ml_search_surface")!({})).content[0].text);
    expect(surface.suggestedBindings.age.type).toBe("element-range");
    expect(surface.suggestedBindings.age.scalar_type).toBe("int");
    // 'age' is range-indexed → not in barewordFields (it's tag-bindable instead)
    expect(surface.barewordFields).not.toContain("age");
  });

  it("non-indexed top-level fields land in barewordFields; nested paths are skipped entirely", async () => {
    clients.schema.discoverSchema.mockResolvedValue({
      documentCount: 1,
      inferredFields: [
        { path: "state", type: "string", nullable: false, cardinality: "single", exampleValues: ["TX"], hasRangeIndex: false },
        { path: "classification/topCategory/label", type: "string", nullable: false, cardinality: "single", exampleValues: ["health"], hasRangeIndex: false },
      ],
      rangeIndexes: [],
      tdeSchemas: [],
    });
    clients.fasttrack.listSearchOptions.mockResolvedValue([]);

    const surface = JSON.parse((await tools.get("ml_search_surface")!({})).content[0].text);
    // Top-level non-indexed "state" is a bareword-search candidate
    expect(surface.barewordFields).toEqual(["state"]);
    // No tag binding for an unindexed field — cts.parse SJS would fail
    expect(surface.suggestedBindings.state).toBeUndefined();
    // Nested path skipped from barewordFields too (only top-level fields surface here)
    expect(surface.barewordFields).not.toContain("classification/topCategory/label");
  });

  it("returns a surface even when collection is omitted (whole-database mode)", async () => {
    clients.schema.discoverSchema.mockResolvedValue({
      documentCount: 100,
      inferredFields: [{ path: "id", type: "string", nullable: false, cardinality: "single", exampleValues: ["abc"], hasRangeIndex: false }],
      rangeIndexes: [],
      tdeSchemas: [],
    });
    clients.fasttrack.listSearchOptions.mockResolvedValue([{ name: "default" }]);

    const result = await tools.get("ml_search_surface")!({ database: "Documents" });
    expect(result.isError).toBeUndefined();
    const surface = JSON.parse(result.content[0].text);
    expect(surface.collection).toBeNull();
    expect(surface.database).toBe("Documents");
    expect(surface.searchOptionsNames).toEqual(["default"]);
  });

  it("normalises plain-string option entries into searchOptionsNames", async () => {
    clients.schema.discoverSchema.mockResolvedValue({
      documentCount: 0, inferredFields: [], rangeIndexes: [], tdeSchemas: [],
    });
    // Some FastTrack listings return [{name}], others bare strings — handle both.
    clients.fasttrack.listSearchOptions.mockResolvedValue(["customers-opts", { name: "products-opts" }] as never);

    const surface = JSON.parse((await tools.get("ml_search_surface")!({})).content[0].text);
    expect(surface.searchOptionsNames).toEqual(["customers-opts", "products-opts"]);
  });
});
