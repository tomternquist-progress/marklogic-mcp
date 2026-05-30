import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerOpticTools } from "../../src/tools/optic.js";
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
    optic: {
      query: vi.fn(),
    },
    schema: {
      listViews: vi.fn(),
    },
  };
}

// ─── Tool registration ─────────────────────────────────────────────────────

describe("registerOpticTools – tool registration", () => {
  it("registers all 3 optic tools", () => {
    const { server, tools } = createMockServer();
    registerOpticTools(server as never, createMockClients() as never);

    expect(tools.has("ml_optic_query")).toBe(true);
    expect(tools.has("ml_vector_search")).toBe(true);
    expect(tools.has("ml_views_list")).toBe(true);
    expect(tools.size).toBe(3);
  });
});

// ─── ml_optic_query ─────────────────────────────────────────────────────────

describe("ml_optic_query handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerOpticTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("executes optic plan as object", async () => {
    const rows = [{ id: 1, name: "Alice" }];
    clients.optic.query.mockResolvedValue(rows);

    const plan = { $optic: { ns: "op", fn: "from-view", args: ["s", "v"] } };
    const result = await tools.get("ml_optic_query")!({ plan });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(rows);
    expect(clients.optic.query).toHaveBeenCalledWith(plan, undefined, undefined);
  });

  it("parses plan from JSON string", async () => {
    clients.optic.query.mockResolvedValue([]);

    const plan = JSON.stringify({ $optic: { ns: "op", fn: "from-view", args: ["s", "v"] } });
    const result = await tools.get("ml_optic_query")!({ plan });

    expect(result.isError).toBeUndefined();
  });

  it("returns error for invalid JSON string plan", async () => {
    const result = await tools.get("ml_optic_query")!({ plan: "not json {{{" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("could not parse");
  });

  it("passes database and strip_schema_prefix", async () => {
    clients.optic.query.mockResolvedValue([]);
    const plan = { $optic: {} };

    await tools.get("ml_optic_query")!({
      plan,
      database: "TestDB",
      strip_schema_prefix: true,
    });

    expect(clients.optic.query).toHaveBeenCalledWith(plan, "TestDB", true);
  });

  it("appends SQL-TABLENOTFOUND hint on error", async () => {
    clients.optic.query.mockRejectedValue(
      new MarkLogicError("SQL-TABLENOTFOUND: Table not found", 400)
    );

    const result = await tools.get("ml_optic_query")!({ plan: { $optic: {} } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Hint:");
    expect(result.content[0].text).toContain("Schemas database");
  });

  it("appends TABLEREINDEXING hint on error", async () => {
    clients.optic.query.mockRejectedValue(
      new MarkLogicError("TABLEREINDEXING error", 500)
    );

    const result = await tools.get("ml_optic_query")!({ plan: { $optic: {} } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ml_reindex_status");
  });

  it("appends orderBy hint on OPTIC-INVALARGS error", async () => {
    clients.optic.query.mockRejectedValue(
      new MarkLogicError("OPTIC-INVALARGS: Invalid argument for orderBy", 400)
    );

    const result = await tools.get("ml_optic_query")!({ plan: { $optic: {} } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("order-by");
  });
});

// ─── ml_vector_search ───────────────────────────────────────────────────────

describe("ml_vector_search handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerOpticTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("builds and executes vector search plan", async () => {
    const rows = [{ doc_id: 1, similarity_score: 0.95 }];
    clients.optic.query.mockResolvedValue(rows);

    const result = await tools.get("ml_vector_search")!({
      schema: "mySchema",
      view: "myView",
      vector_column: "embedding",
      query_vector: [0.1, 0.2, 0.3],
      k: 5,
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(rows);
    // Verify plan was constructed and passed with strip_schema_prefix=true
    expect(clients.optic.query).toHaveBeenCalledWith(
      expect.objectContaining({ $optic: expect.any(Object) }),
      undefined,
      true
    );
  });

  it("passes strip_schema_prefix=true by default", async () => {
    clients.optic.query.mockResolvedValue([]);

    await tools.get("ml_vector_search")!({
      schema: "mySchema",
      view: "myView",
      vector_column: "embedding",
      query_vector: [0.1, 0.2],
    });

    expect(clients.optic.query).toHaveBeenCalledWith(
      expect.objectContaining({ $optic: expect.any(Object) }),
      undefined,
      true
    );
  });

  it("honours strip_schema_prefix=false when supplied", async () => {
    clients.optic.query.mockResolvedValue([]);

    await tools.get("ml_vector_search")!({
      schema: "mySchema",
      view: "myView",
      vector_column: "embedding",
      query_vector: [0.1, 0.2],
      strip_schema_prefix: false,
    });

    expect(clients.optic.query).toHaveBeenCalledWith(
      expect.objectContaining({ $optic: expect.any(Object) }),
      undefined,
      false
    );
  });

  it("uses default score_column and k values", async () => {
    clients.optic.query.mockResolvedValue([]);

    await tools.get("ml_vector_search")!({
      schema: "s",
      view: "v",
      vector_column: "emb",
      query_vector: [1.0],
    });

    // Default k=10, default score_column=similarity_score
    const plan = clients.optic.query.mock.calls[0][0] as Record<string, unknown>;
    const planStr = JSON.stringify(plan);
    expect(planStr).toContain("similarity_score");
    expect(planStr).toContain("10"); // limit
  });

  it("appends vector hint on VEC/VECTOR errors", async () => {
    clients.optic.query.mockRejectedValue(
      new MarkLogicError("VECTOR-INVALIDTYPE: not a vector column", 400)
    );

    const result = await tools.get("ml_vector_search")!({
      schema: "s",
      view: "v",
      vector_column: "bad",
      query_vector: [0.1],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("vec:vector");
  });

  it("appends dimension hint on XDMP-ARGTYPE error", async () => {
    clients.optic.query.mockRejectedValue(
      new MarkLogicError("XDMP-ARGTYPE: dimension mismatch", 400)
    );

    const result = await tools.get("ml_vector_search")!({
      schema: "s",
      view: "v",
      vector_column: "emb",
      query_vector: [0.1, 0.2],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("dimensionality");
  });
});

// ─── ml_views_list ──────────────────────────────────────────────────────────

describe("ml_views_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerOpticTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns views list", async () => {
    const views = [{ schema: "public", view: "events", tde_uri: "/tde/events.json" }];
    clients.schema.listViews.mockResolvedValue(views);

    const result = await tools.get("ml_views_list")!({});

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(views);
  });

  it("returns helpful message when no views found", async () => {
    clients.schema.listViews.mockResolvedValue([]);

    const result = await tools.get("ml_views_list")!({});

    expect(result.content[0].text).toContain("No TDE views found");
    expect(result.content[0].text).toContain("generate_tde=true");
  });

  it("passes database parameter to listViews", async () => {
    clients.schema.listViews.mockResolvedValue([]);

    await tools.get("ml_views_list")!({ database: "Analytics" });

    expect(clients.schema.listViews).toHaveBeenCalledWith("Analytics", false);
  });

  it("passes undefined when no database supplied", async () => {
    clients.schema.listViews.mockResolvedValue([]);

    await tools.get("ml_views_list")!({});

    expect(clients.schema.listViews).toHaveBeenCalledWith(undefined, false);
  });

  it("passes verify_registered through to listViews", async () => {
    clients.schema.listViews.mockResolvedValue([]);

    await tools.get("ml_views_list")!({ verify_registered: true });

    expect(clients.schema.listViews).toHaveBeenCalledWith(undefined, true);
  });

  it("sets isError on failure", async () => {
    clients.schema.listViews.mockRejectedValue(new Error("connection error"));
    const result = await tools.get("ml_views_list")!({});

    expect(result.isError).toBe(true);
  });
});
