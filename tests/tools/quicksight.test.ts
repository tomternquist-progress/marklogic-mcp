import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerQuickSightTools } from "../../src/tools/quicksight.js";
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
      values: vi.fn(),
    },
    documents: {
      get: vi.fn(),
    },
  };
}

// ─── Tool registration ─────────────────────────────────────────────────────

describe("registerQuickSightTools – tool registration", () => {
  it("registers all 4 quicksight tools", () => {
    const { server, tools } = createMockServer();
    registerQuickSightTools(server as never, createMockClients() as never);

    expect(tools.has("ml_aggregate_query")).toBe(true);
    expect(tools.has("ml_timeseries_query")).toBe(true);
    expect(tools.has("ml_export_tabular")).toBe(true);
    expect(tools.has("ml_facets_query")).toBe(true);
    expect(tools.size).toBe(4);
  });
});

// ─── ml_aggregate_query ─────────────────────────────────────────────────────

describe("ml_aggregate_query handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerQuickSightTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns document count without metrics", async () => {
    clients.search.search.mockResolvedValue({ total: 100, results: [] });

    const result = await tools.get("ml_aggregate_query")!({ collection: "orders" });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.documentCount).toBe(100);
  });

  it("computes metrics via values API", async () => {
    clients.search.search.mockResolvedValue({ total: 50, results: [] });
    clients.search.values.mockResolvedValue({
      name: "amount",
      total: 50,
      values: [],
      aggregate: { sum: 1500 },
    });

    const result = await tools.get("ml_aggregate_query")!({
      metrics: [{ values_name: "amount", aggregate: "sum", alias: "total_amount" }],
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.documentCount).toBe(50);
    expect(parsed.metrics).toHaveLength(1);
  });

  it("handles metric failures gracefully (Promise.allSettled)", async () => {
    clients.search.search.mockResolvedValue({ total: 10, results: [] });
    clients.search.values
      .mockResolvedValueOnce({ name: "a", total: 1, values: [] })
      .mockRejectedValueOnce(new Error("no index"));

    const result = await tools.get("ml_aggregate_query")!({
      metrics: [
        { values_name: "a", aggregate: "count" },
        { values_name: "b", aggregate: "sum" },
      ],
    });

    const parsed = JSON.parse(result.content[0].text);
    // Only the fulfilled metric should appear
    expect(parsed.metrics).toHaveLength(1);
  });

  it("sets isError on failure", async () => {
    clients.search.search.mockRejectedValue(new MarkLogicError("error", 500));
    const result = await tools.get("ml_aggregate_query")!({});

    expect(result.isError).toBe(true);
  });
});

// ─── ml_timeseries_query ────────────────────────────────────────────────────

describe("ml_timeseries_query handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerQuickSightTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns time series data", async () => {
    clients.search.values.mockResolvedValue({
      name: "created_date",
      total: 5,
      values: [
        { value: "2024-01-01", frequency: 10 },
        { value: "2024-01-02", frequency: 15 },
      ],
    });

    const result = await tools.get("ml_timeseries_query")!({
      time_values_name: "created_date",
      collection: "orders",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.timeField).toBe("created_date");
    expect(parsed.points).toHaveLength(2);
  });

  it("sets isError on failure", async () => {
    clients.search.values.mockRejectedValue(new Error("no range index"));
    const result = await tools.get("ml_timeseries_query")!({
      time_values_name: "missing_field",
    });

    expect(result.isError).toBe(true);
  });
});

// ─── ml_export_tabular ──────────────────────────────────────────────────────

describe("ml_export_tabular handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerQuickSightTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("exports JSON rows by default", async () => {
    clients.search.search.mockResolvedValue({
      total: 1,
      results: [{ uri: "/doc.json" }],
    });
    clients.documents.get.mockResolvedValue({
      content: { name: "Alice", age: 30 },
    });

    const result = await tools.get("ml_export_tabular")!({
      fields: ["name", "age"],
      max_rows: 10,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].name).toBe("Alice");
    expect(parsed.rows[0].age).toBe(30);
    expect(parsed.rows[0]._uri).toBe("/doc.json");
  });

  it("exports CSV format", async () => {
    clients.search.search.mockResolvedValue({
      total: 1,
      results: [{ uri: "/doc.json" }],
    });
    clients.documents.get.mockResolvedValue({
      content: { name: "Bob", score: 95 },
    });

    const result = await tools.get("ml_export_tabular")!({
      fields: ["name", "score"],
      format: "csv",
    });

    expect(result.content[0].text).toContain("_uri,name,score");
    expect(result.content[0].text).toContain("Bob");
  });

  it("handles nested field paths", async () => {
    clients.search.search.mockResolvedValue({
      total: 1,
      results: [{ uri: "/doc.json" }],
    });
    clients.documents.get.mockResolvedValue({
      content: { customer: { name: "Carol" } },
    });

    const result = await tools.get("ml_export_tabular")!({
      fields: ["customer.name"],
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.rows[0]["customer.name"]).toBe("Carol");
  });

  it("stops when max_rows reached", async () => {
    clients.search.search.mockResolvedValue({
      total: 100,
      results: [{ uri: "/d1.json" }, { uri: "/d2.json" }, { uri: "/d3.json" }],
    });
    clients.documents.get.mockResolvedValue({ content: { x: 1 } });

    const result = await tools.get("ml_export_tabular")!({
      fields: ["x"],
      max_rows: 2,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.rows).toHaveLength(2);
  });

  it("skips inaccessible documents", async () => {
    clients.search.search.mockResolvedValue({
      total: 2,
      results: [{ uri: "/a.json" }, { uri: "/b.json" }],
    });
    clients.documents.get
      .mockRejectedValueOnce(new Error("forbidden"))
      .mockResolvedValueOnce({ content: { x: 1 } });

    const result = await tools.get("ml_export_tabular")!({
      fields: ["x"],
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.rows).toHaveLength(1);
  });

  it("CSV escapes values with commas and quotes", async () => {
    clients.search.search.mockResolvedValue({
      total: 1,
      results: [{ uri: "/doc.json" }],
    });
    clients.documents.get.mockResolvedValue({
      content: { text: 'hello, "world"' },
    });

    const result = await tools.get("ml_export_tabular")!({
      fields: ["text"],
      format: "csv",
    });

    // CSV should properly escape the value
    expect(result.content[0].text).toContain('""world""');
  });

  it("sets isError on failure", async () => {
    clients.search.search.mockRejectedValue(new MarkLogicError("error", 500));
    const result = await tools.get("ml_export_tabular")!({ fields: ["x"] });

    expect(result.isError).toBe(true);
  });
});

// ─── ml_facets_query ────────────────────────────────────────────────────────

describe("ml_facets_query handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerQuickSightTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns facets and total", async () => {
    clients.search.search.mockResolvedValue({
      total: 100,
      results: [],
      facets: {
        category: {
          name: "category",
          facetValues: [{ name: "A", count: 50 }, { name: "B", count: 50 }],
        },
      },
    });

    const result = await tools.get("ml_facets_query")!({
      collection: "products",
      options: "product-options",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total).toBe(100);
    expect(parsed.facets.category).toBeDefined();
  });

  it("returns empty facets when none available", async () => {
    clients.search.search.mockResolvedValue({ total: 10, results: [] });

    const result = await tools.get("ml_facets_query")!({});

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.facets).toEqual({});
  });

  it("sets isError on failure", async () => {
    clients.search.search.mockRejectedValue(new Error("timeout"));
    const result = await tools.get("ml_facets_query")!({});

    expect(result.isError).toBe(true);
  });
});
