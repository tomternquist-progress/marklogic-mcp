import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerSearchTools } from "../../src/tools/search.js";
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
    search: {
      search: vi.fn(),
      qbe: vi.fn(),
      values: vi.fn(),
      suggest: vi.fn(),
    },
  };
}

// ─── Tool registration ─────────────────────────────────────────────────────

describe("registerSearchTools – tool registration", () => {
  it("registers all 5 search tools", () => {
    const { server, tools } = createMockServer();
    registerSearchTools(server as never, createMockClients() as never);

    expect(tools.has("ml_search")).toBe(true);
    expect(tools.has("ml_search_qbe")).toBe(true);
    expect(tools.has("ml_values_query")).toBe(true);
    expect(tools.has("ml_geospatial_search")).toBe(true);
    expect(tools.has("ml_suggest")).toBe(true);
    expect(tools.size).toBe(5);
  });
});

// ─── ml_search ──────────────────────────────────────────────────────────────

describe("ml_search handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSearchTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns JSON-formatted search results on success", async () => {
    const mockResult = { total: 1, results: [{ uri: "/doc.json" }] };
    clients.search.search.mockResolvedValue(mockResult);

    const result = await tools.get("ml_search")!({ q: "hello" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockResult);
  });

  it("passes all parameters to the client", async () => {
    clients.search.search.mockResolvedValue({ total: 0, results: [] });
    await tools.get("ml_search")!({
      q: "test",
      collection: "col1",
      directory: "/data/",
      start: 5,
      page_length: 20,
      options: "opts",
      database: "MyDB",
    });

    expect(clients.search.search).toHaveBeenCalledWith({
      q: "test",
      structuredQuery: undefined,
      collection: "col1",
      directory: "/data/",
      start: 5,
      pageLength: 20,
      options: "opts",
      database: "MyDB",
    });
  });

  it("passes structured_query to the client as structuredQuery", async () => {
    clients.search.search.mockResolvedValue({ total: 0, results: [] });
    const sq = { "word-query": { text: ["hello"] } };
    await tools.get("ml_search")!({ structured_query: sq });

    expect(clients.search.search).toHaveBeenCalledWith(
      expect.objectContaining({ structuredQuery: sq })
    );
  });

  it("sets isError on failure", async () => {
    clients.search.search.mockRejectedValue(new MarkLogicError("search failed", 500));
    const result = await tools.get("ml_search")!({ q: "broken" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("500");
  });
});

// ─── ml_search_qbe ──────────────────────────────────────────────────────────

describe("ml_search_qbe handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSearchTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns results on success", async () => {
    const mockResult = { total: 2, results: [{ uri: "/a.json" }, { uri: "/b.json" }] };
    clients.search.qbe.mockResolvedValue(mockResult);

    const result = await tools.get("ml_search_qbe")!({ qbe: { name: "Alice" } });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockResult);
  });

  it("passes parameters correctly", async () => {
    clients.search.qbe.mockResolvedValue({ total: 0, results: [] });
    await tools.get("ml_search_qbe")!({
      qbe: { type: "order" },
      start: 10,
      page_length: 25,
      database: "TestDB",
    });

    expect(clients.search.qbe).toHaveBeenCalledWith(
      { type: "order" },
      { start: 10, pageLength: 25, database: "TestDB" }
    );
  });

  it("sets isError on failure", async () => {
    clients.search.qbe.mockRejectedValue(new Error("bad query"));
    const result = await tools.get("ml_search_qbe")!({ qbe: {} });

    expect(result.isError).toBe(true);
  });
});

// ─── ml_values_query ────────────────────────────────────────────────────────

describe("ml_values_query handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSearchTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns values on success", async () => {
    const mockValues = { name: "status", total: 3, values: [{ value: "active", frequency: 10 }] };
    clients.search.values.mockResolvedValue(mockValues);

    const result = await tools.get("ml_values_query")!({ values_name: "status" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockValues);
  });

  it("passes all parameters to client", async () => {
    clients.search.values.mockResolvedValue({ name: "x", total: 0, values: [] });
    await tools.get("ml_values_query")!({
      values_name: "category",
      query: "type:A",
      limit: 50,
      direction: "ascending",
      aggregate: "count",
      database: "DB1",
    });

    expect(clients.search.values).toHaveBeenCalledWith("category", {
      query: "type:A",
      limit: 50,
      direction: "ascending",
      aggregate: "count",
      database: "DB1",
    });
  });

  it("sets isError on failure", async () => {
    clients.search.values.mockRejectedValue(new MarkLogicError("no index", 400));
    const result = await tools.get("ml_values_query")!({ values_name: "missing" });

    expect(result.isError).toBe(true);
  });
});

// ─── ml_geospatial_search ───────────────────────────────────────────────────

describe("ml_geospatial_search handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSearchTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("builds circle query and returns results", async () => {
    clients.search.search.mockResolvedValue({ total: 1, results: [{ uri: "/loc.json" }] });

    const result = await tools.get("ml_geospatial_search")!({
      region_type: "circle",
      center_lat: 40.7,
      center_lon: -74.0,
      radius_km: 10,
    });

    expect(result.isError).toBeUndefined();
    expect(clients.search.search).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredQuery: expect.objectContaining({
          "geo-json-property-pair-query": expect.objectContaining({
            circle: { radius: 10, point: [{ latitude: 40.7, longitude: -74.0 }] },
          }),
        }),
      })
    );
  });

  it("returns error when circle is missing required params", async () => {
    const result = await tools.get("ml_geospatial_search")!({
      region_type: "circle",
      center_lat: 40.7,
      // missing center_lon and radius_km
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("circle requires");
  });

  it("builds box query", async () => {
    clients.search.search.mockResolvedValue({ total: 0, results: [] });

    await tools.get("ml_geospatial_search")!({
      region_type: "box",
      south: 40.0,
      west: -74.5,
      north: 41.0,
      east: -73.5,
    });

    expect(clients.search.search).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredQuery: expect.objectContaining({
          "geo-json-property-pair-query": expect.objectContaining({
            box: [{ s: 40.0, w: -74.5, n: 41.0, e: -73.5 }],
          }),
        }),
      })
    );
  });

  it("returns error when box is missing required params", async () => {
    const result = await tools.get("ml_geospatial_search")!({
      region_type: "box",
      south: 40.0,
      // missing west, north, east
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("box requires");
  });

  it("builds polygon query", async () => {
    clients.search.search.mockResolvedValue({ total: 0, results: [] });

    await tools.get("ml_geospatial_search")!({
      region_type: "polygon",
      points: [
        { lat: 40.0, lon: -74.0 },
        { lat: 41.0, lon: -74.0 },
        { lat: 41.0, lon: -73.0 },
        { lat: 40.0, lon: -74.0 },
      ],
    });

    expect(clients.search.search).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredQuery: expect.objectContaining({
          "geo-json-property-pair-query": expect.objectContaining({
            polygon: expect.any(Array),
          }),
        }),
      })
    );
  });

  it("returns error when polygon has no points", async () => {
    const result = await tools.get("ml_geospatial_search")!({
      region_type: "polygon",
      points: [],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("polygon requires");
  });

  it("uses custom property names when provided", async () => {
    clients.search.search.mockResolvedValue({ total: 0, results: [] });

    await tools.get("ml_geospatial_search")!({
      region_type: "circle",
      center_lat: 0,
      center_lon: 0,
      radius_km: 1,
      parent_property: "geo",
      lat_property: "lat",
      lon_property: "lng",
    });

    expect(clients.search.search).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredQuery: expect.objectContaining({
          "geo-json-property-pair-query": expect.objectContaining({
            "parent-property": "geo",
            "lat-property": "lat",
            "lon-property": "lng",
          }),
        }),
      })
    );
  });

  it("wraps with collection query when collection is specified", async () => {
    clients.search.search.mockResolvedValue({ total: 0, results: [] });

    await tools.get("ml_geospatial_search")!({
      region_type: "circle",
      center_lat: 0,
      center_lon: 0,
      radius_km: 1,
      collection: "places",
    });

    expect(clients.search.search).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredQuery: expect.objectContaining({
          "and-query": expect.objectContaining({
            queries: expect.arrayContaining([
              { "collection-query": { uri: ["places"] } },
            ]),
          }),
        }),
      })
    );
  });

  it("appends geospatial hint on error", async () => {
    clients.search.search.mockRejectedValue(new MarkLogicError("no index", 400));

    const result = await tools.get("ml_geospatial_search")!({
      region_type: "circle",
      center_lat: 0,
      center_lon: 0,
      radius_km: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("geospatial element pair index");
  });
});

// ─── ml_suggest ─────────────────────────────────────────────────────────────

describe("ml_suggest handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSearchTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns suggestions on success", async () => {
    clients.search.suggest.mockResolvedValue(["apple", "application", "apply"]);

    const result = await tools.get("ml_suggest")!({ partial_q: "app" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(["apple", "application", "apply"]);
  });

  it("passes limit to the client", async () => {
    clients.search.suggest.mockResolvedValue([]);
    await tools.get("ml_suggest")!({
      partial_q: "hel",
      limit: 5,
      options: "my-options",
      database: "DB",
    });

    expect(clients.search.suggest).toHaveBeenCalledWith("hel", "my-options", "DB", 5);
  });

  it("sets isError on failure", async () => {
    clients.search.suggest.mockRejectedValue(new Error("timeout"));
    const result = await tools.get("ml_suggest")!({ partial_q: "x" });

    expect(result.isError).toBe(true);
  });
});
