/**
 * Unit tests for performance tool handlers:
 *   ml_explain_optic   — POSTs plan to /v1/rows?output=explain
 *   ml_search_query_plan — calls searchDebug()
 *   ml_forest_metrics  — calls getDatabaseProperties() + getForestStatus() + getForestCounts()
 *   ml_profile_query   — calls profileXQuery / profileJavaScript / profileSparql (eval-gated)
 *
 * All client calls are mocked — no live MarkLogic required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerPerformanceTools } from "../../src/tools/performance.js";
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

function createMockClients(overrides: Partial<{
  performance: Partial<ReturnType<typeof defaultPerformanceMock>>;
  admin: Partial<ReturnType<typeof defaultAdminMock>>;
}> = {}) {
  return {
    performance: { ...defaultPerformanceMock(), ...overrides.performance },
    admin: { ...defaultAdminMock(), ...overrides.admin },
  };
}

function defaultPerformanceMock() {
  return {
    explainOptic: vi.fn(),
    searchDebug: vi.fn(),
    getForestStatus: vi.fn(),
    getForestCounts: vi.fn(),
    forceMerge: vi.fn(),
    profileXQuery: vi.fn(),
    profileJavaScript: vi.fn(),
    profileSparql: vi.fn(),
  };
}

function defaultAdminMock() {
  return {
    getDatabaseProperties: vi.fn(),
  };
}

// ─── Registration ──────────────────────────────────────────────────────────────

describe("registerPerformanceTools – registration", () => {
  it("registers 3 tools without eval", () => {
    const { server, tools } = createMockServer();
    registerPerformanceTools(server as never, createMockClients() as never, false);
    expect(tools.has("ml_explain_optic")).toBe(true);
    expect(tools.has("ml_search_query_plan")).toBe(true);
    expect(tools.has("ml_forest_metrics")).toBe(true);
    expect(tools.has("ml_force_merge")).toBe(false);
    expect(tools.has("ml_profile_query")).toBe(false);
    expect(tools.size).toBe(3);
  });

  it("registers 5 tools with allowEval=true", () => {
    const { server, tools } = createMockServer();
    registerPerformanceTools(server as never, createMockClients() as never, true);
    expect(tools.has("ml_force_merge")).toBe(true);
    expect(tools.has("ml_profile_query")).toBe(true);
    expect(tools.size).toBe(5);
  });
});

// ─── ml_explain_optic ─────────────────────────────────────────────────────────

describe("ml_explain_optic handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerPerformanceTools(server as never, clients as never, false);
    tools = t;
  });

  it("returns plan output and analysis section", async () => {
    clients.performance.explainOptic.mockResolvedValue({ node: "from-view", estimatedCount: 100 });
    const result = await tools.get("ml_explain_optic")!({ plan: { $optic: {} } });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("OPTIC EXECUTION PLAN");
    expect(result.content[0].text).toContain("PLAN ANALYSIS");
  });

  it("accepts a JSON string as the plan parameter", async () => {
    clients.performance.explainOptic.mockResolvedValue({ ok: true });
    const result = await tools.get("ml_explain_optic")!({ plan: '{"$optic":{}}' });
    expect(result.isError).toBeUndefined();
    expect(clients.performance.explainOptic).toHaveBeenCalledWith({ "$optic": {} }, undefined);
  });

  it("returns isError for invalid JSON string plan", async () => {
    const result = await tools.get("ml_explain_optic")!({ plan: "not valid json {" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid plan");
  });

  it("passes database parameter to client", async () => {
    clients.performance.explainOptic.mockResolvedValue({});
    await tools.get("ml_explain_optic")!({ plan: {}, database: "MyDB" });
    expect(clients.performance.explainOptic).toHaveBeenCalledWith({}, "MyDB");
  });

  it("returns isError on client failure", async () => {
    clients.performance.explainOptic.mockRejectedValue(new MarkLogicError("plan failed", 400));
    const result = await tools.get("ml_explain_optic")!({ plan: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("400");
  });

  it("analysis detects index-only plan (no 'document' node)", async () => {
    clients.performance.explainOptic.mockResolvedValue({ lexiconPlan: { kind: "lexicon" } });
    const result = await tools.get("ml_explain_optic")!({ plan: {} });
    expect(result.content[0].text).toContain("index-only");
  });

  it("analysis warns when plan has no limit", async () => {
    clients.performance.explainOptic.mockResolvedValue({ someNode: "whatever" });
    const result = await tools.get("ml_explain_optic")!({ plan: {} });
    expect(result.content[0].text).toContain("LIMIT");
  });

  it("analysis notes document expansion", async () => {
    clients.performance.explainOptic.mockResolvedValue({ plan: { kind: "document", limit: true } });
    const result = await tools.get("ml_explain_optic")!({ plan: {} });
    expect(result.content[0].text).toContain("document expansion");
  });

  it("analysis notes join in plan", async () => {
    clients.performance.explainOptic.mockResolvedValue({ plan: { kind: "join-inner", lexicon: true, limit: true } });
    const result = await tools.get("ml_explain_optic")!({ plan: {} });
    expect(result.content[0].text).toContain("join");
  });

  it("analysis notes order-by in plan", async () => {
    clients.performance.explainOptic.mockResolvedValue({ plan: { "order-by": "date", lexicon: true, limit: true } });
    const result = await tools.get("ml_explain_optic")!({ plan: {} });
    expect(result.content[0].text).toContain("ORDER BY");
  });
});

// ─── ml_search_query_plan ─────────────────────────────────────────────────────

describe("ml_search_query_plan handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerPerformanceTools(server as never, clients as never, false);
    tools = t;
  });

  it("returns query plan and analysis when q is provided", async () => {
    clients.performance.searchDebug.mockResolvedValue({ total: 42, qtext: "climate" });
    const result = await tools.get("ml_search_query_plan")!({ q: "climate" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("SEARCH QUERY PLAN");
    expect(result.content[0].text).toContain("QUERY ANALYSIS");
  });

  it("returns isError when neither q nor structured_query is provided", async () => {
    const result = await tools.get("ml_search_query_plan")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("q");
    expect(result.content[0].text).toContain("structured_query");
  });

  it("passes all parameters to searchDebug", async () => {
    clients.performance.searchDebug.mockResolvedValue({ total: 0 });
    await tools.get("ml_search_query_plan")!({
      q: "test",
      collection: "col1",
      database: "DB1",
      search_options: "my-opts",
    });
    expect(clients.performance.searchDebug).toHaveBeenCalledWith({
      q: "test",
      structuredQuery: undefined,
      collection: "col1",
      database: "DB1",
      searchOptions: "my-opts",
    });
  });

  it("passes structured_query when provided", async () => {
    clients.performance.searchDebug.mockResolvedValue({ total: 5 });
    const sq = { "word-query": { text: ["test"] } };
    await tools.get("ml_search_query_plan")!({ structured_query: sq });
    expect(clients.performance.searchDebug).toHaveBeenCalledWith(
      expect.objectContaining({ structuredQuery: sq })
    );
  });

  it("analysis includes candidate count when total > 0", async () => {
    clients.performance.searchDebug.mockResolvedValue({ total: 50000 });
    const result = await tools.get("ml_search_query_plan")!({ q: "test" });
    expect(result.content[0].text).toContain("50,000");
  });

  it("analysis warns on high candidate count (>100k)", async () => {
    clients.performance.searchDebug.mockResolvedValue({ total: 150_000 });
    const result = await tools.get("ml_search_query_plan")!({ q: "broad" });
    expect(result.content[0].text).toContain("HIGH CANDIDATE COUNT");
  });

  it("analysis notes zero results", async () => {
    clients.performance.searchDebug.mockResolvedValue({ total: 0 });
    const result = await tools.get("ml_search_query_plan")!({ q: "notfound" });
    expect(result.content[0].text).toMatch(/count.*0|0.*count/i);
  });

  it("strips result snippets from output (metadata only)", async () => {
    clients.performance.searchDebug.mockResolvedValue({
      total: 1,
      results: [{ uri: "/secret.json", snippet: "big payload" }],
    });
    const result = await tools.get("ml_search_query_plan")!({ q: "test" });
    // results key should be stripped
    expect(result.content[0].text).not.toContain("snippet");
  });

  it("returns isError on client failure", async () => {
    clients.performance.searchDebug.mockRejectedValue(new MarkLogicError("bad request", 400));
    const result = await tools.get("ml_search_query_plan")!({ q: "broken" });
    expect(result.isError).toBe(true);
  });
});

// ─── ml_forest_metrics ────────────────────────────────────────────────────────

describe("ml_forest_metrics handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  const HEALTHY_FOREST_STATUS = {
    "forest-status": {
      "status-properties": {
        state: { value: "open" },
        "merge-in-progress": { value: false },
      },
    },
  };

  const HEALTHY_COUNTS = { active: 1000, deleted: 50, standCount: 3, docCount: 950 };

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerPerformanceTools(server as never, clients as never, true);
    tools = t;
  });

  it("returns metrics for all forests in the database", async () => {
    clients.admin.getDatabaseProperties.mockResolvedValue({ forest: ["Forest1", "Forest2"] });
    clients.performance.getForestStatus.mockResolvedValue(HEALTHY_FOREST_STATUS);
    clients.performance.getForestCounts.mockResolvedValue(HEALTHY_COUNTS);

    const result = await tools.get("ml_forest_metrics")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("FOREST METRICS");
    expect(result.content[0].text).toContain("Forest1");
    expect(result.content[0].text).toContain("Forest2");
  });

  it("defaults to Documents database when no database param given", async () => {
    clients.admin.getDatabaseProperties.mockResolvedValue({ forest: ["Docs-Forest"] });
    clients.performance.getForestStatus.mockResolvedValue(HEALTHY_FOREST_STATUS);
    clients.performance.getForestCounts.mockResolvedValue(HEALTHY_COUNTS);

    await tools.get("ml_forest_metrics")!({});
    expect(clients.admin.getDatabaseProperties).toHaveBeenCalledWith("Documents");
  });

  it("uses specified database when provided", async () => {
    clients.admin.getDatabaseProperties.mockResolvedValue({ forest: ["Schema-Forest"] });
    clients.performance.getForestStatus.mockResolvedValue(HEALTHY_FOREST_STATUS);
    clients.performance.getForestCounts.mockResolvedValue(HEALTHY_COUNTS);

    await tools.get("ml_forest_metrics")!({ database: "Schemas" });
    expect(clients.admin.getDatabaseProperties).toHaveBeenCalledWith("Schemas");
  });

  it("returns message when no forests found", async () => {
    clients.admin.getDatabaseProperties.mockResolvedValue({ forest: [] });

    const result = await tools.get("ml_forest_metrics")!({ database: "Empty" });
    expect(result.content[0].text).toContain("No forests found");
  });

  it("skips getForestCounts when allowEval is false", async () => {
    // Re-register with allowEval=false
    const { server, tools: t2 } = createMockServer();
    const c2 = createMockClients();
    registerPerformanceTools(server as never, c2 as never, false);
    c2.admin.getDatabaseProperties.mockResolvedValue({ forest: ["F1"] });
    c2.performance.getForestStatus.mockResolvedValue(HEALTHY_FOREST_STATUS);

    await t2.get("ml_forest_metrics")!({});
    expect(c2.performance.getForestCounts).not.toHaveBeenCalled();
  });

  it("includes getForestCounts when allowEval is true", async () => {
    clients.admin.getDatabaseProperties.mockResolvedValue({ forest: ["F1"] });
    clients.performance.getForestStatus.mockResolvedValue(HEALTHY_FOREST_STATUS);
    clients.performance.getForestCounts.mockResolvedValue(HEALTHY_COUNTS);

    await tools.get("ml_forest_metrics")!({});
    expect(clients.performance.getForestCounts).toHaveBeenCalledWith("F1");
  });

  it("returns isError when getDatabaseProperties fails", async () => {
    clients.admin.getDatabaseProperties.mockRejectedValue(new MarkLogicError("db not found", 404));
    const result = await tools.get("ml_forest_metrics")!({ database: "Missing" });
    expect(result.isError).toBe(true);
  });

  it("continues and shows ERROR for individual forest failures", async () => {
    clients.admin.getDatabaseProperties.mockResolvedValue({ forest: ["GoodForest", "BrokenForest"] });
    clients.performance.getForestStatus
      .mockResolvedValueOnce(HEALTHY_FOREST_STATUS)
      .mockRejectedValueOnce(new MarkLogicError("offline", 503));
    clients.performance.getForestCounts.mockResolvedValue(HEALTHY_COUNTS);

    const result = await tools.get("ml_forest_metrics")!({});
    expect(result.isError).toBeUndefined(); // tool itself doesn't fail
    expect(result.content[0].text).toContain("GoodForest");
    expect(result.content[0].text).toContain("BrokenForest");
    expect(result.content[0].text).toContain("ERROR");
  });

  it("shows ALERTS when stand count is high", async () => {
    const highStandStatus = {
      "forest-status": {
        "status-properties": {
          state: { value: "open" },
          "merge-in-progress": { value: false },
        },
      },
    };
    clients.admin.getDatabaseProperties.mockResolvedValue({ forest: ["F1"] });
    clients.performance.getForestStatus.mockResolvedValue(highStandStatus);
    clients.performance.getForestCounts.mockResolvedValue({
      active: 1000, deleted: 50, standCount: 55, docCount: 950,
    });

    const result = await tools.get("ml_forest_metrics")!({});
    expect(result.content[0].text).toContain("ALERTS");
    expect(result.content[0].text).toContain("stand");
  });
});

// ─── ml_force_merge ──────────────────────────────────────────────────────────

describe("ml_force_merge handler (allowEval=true)", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerPerformanceTools(server as never, clients as never, true);
    tools = t;
  });

  it("triggers merge and returns forest names", async () => {
    clients.performance.forceMerge.mockResolvedValue({ merged: ["Forest1", "Forest2"] });
    const result = await tools.get("ml_force_merge")!({ database: "Documents" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Merge triggered");
    expect(result.content[0].text).toContain("Documents");
    expect(result.content[0].text).toContain("Forest1");
    expect(result.content[0].text).toContain("Forest2");
    expect(result.content[0].text).toContain("2 forest(s)");
    expect(clients.performance.forceMerge).toHaveBeenCalledWith("Documents");
  });

  it("handles empty forest list gracefully", async () => {
    clients.performance.forceMerge.mockResolvedValue({ merged: [] });
    const result = await tools.get("ml_force_merge")!({ database: "EmptyDB" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("0 forest(s)");
  });

  it("returns isError on client failure", async () => {
    clients.performance.forceMerge.mockRejectedValue(new MarkLogicError("db not found", 404));
    const result = await tools.get("ml_force_merge")!({ database: "Missing" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
  });

  it("is not registered when allowEval is false", () => {
    const { server, tools: t } = createMockServer();
    registerPerformanceTools(server as never, createMockClients() as never, false);
    expect(t.has("ml_force_merge")).toBe(false);
  });
});

// ─── ml_profile_query ─────────────────────────────────────────────────────────

describe("ml_profile_query handler (allowEval=true)", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  const PROFILE_RESULT = [{
    value: {
      elapsedMs: 5,
      resultCount: 10,
      filterMisses: 0,
      filterHits: 0,
      listCacheMisses: 0,
      expandedTreeCacheMisses: 0,
    },
  }];

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerPerformanceTools(server as never, clients as never, true);
    tools = t;
  });

  it("calls profileXQuery for language=xquery", async () => {
    clients.performance.profileXQuery.mockResolvedValue(PROFILE_RESULT);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "(1 to 10)" });
    expect(result.isError).toBeUndefined();
    expect(clients.performance.profileXQuery).toHaveBeenCalledWith("(1 to 10)", undefined);
    expect(result.content[0].text).toContain("QUERY PROFILE");
  });

  it("calls profileJavaScript for language=javascript", async () => {
    clients.performance.profileJavaScript.mockResolvedValue(PROFILE_RESULT);
    const result = await tools.get("ml_profile_query")!({ language: "javascript", code: "1 + 1" });
    expect(result.isError).toBeUndefined();
    expect(clients.performance.profileJavaScript).toHaveBeenCalledWith("1 + 1", undefined);
  });

  it("calls profileSparql for language=sparql", async () => {
    const sparqlResult = [{ value: { elapsedMs: 20, rowCount: 5 } }];
    clients.performance.profileSparql.mockResolvedValue(sparqlResult);
    const result = await tools.get("ml_profile_query")!({
      language: "sparql",
      code: "SELECT * WHERE { ?s ?p ?o } LIMIT 5",
    });
    expect(result.isError).toBeUndefined();
    expect(clients.performance.profileSparql).toHaveBeenCalled();
  });

  it("passes database parameter to profile methods", async () => {
    clients.performance.profileXQuery.mockResolvedValue(PROFILE_RESULT);
    await tools.get("ml_profile_query")!({ language: "xquery", code: "1", database: "MyDB" });
    expect(clients.performance.profileXQuery).toHaveBeenCalledWith("1", "MyDB");
  });

  it("returns 'No profiling data' when result is empty", async () => {
    clients.performance.profileXQuery.mockResolvedValue([]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "1" });
    expect(result.content[0].text).toContain("No profiling data");
  });

  it("analysis flags filter misses in performance output", async () => {
    clients.performance.profileXQuery.mockResolvedValue([{
      value: { elapsedMs: 500, resultCount: 5, filterMisses: 50, filterHits: 10 },
    }]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "test" });
    expect(result.content[0].text).toContain("FILTERED SEARCH");
  });

  it("analysis flags slow elapsed time", async () => {
    clients.performance.profileXQuery.mockResolvedValue([{
      value: { elapsedMs: 2000, resultCount: 1, filterMisses: 0, filterHits: 0 },
    }]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "test" });
    expect(result.content[0].text).toContain("SLOW");
  });

  it("analysis flags fast elapsed time positively", async () => {
    clients.performance.profileXQuery.mockResolvedValue([{
      value: { elapsedMs: 3, resultCount: 100, filterMisses: 0, filterHits: 0 },
    }]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "test" });
    expect(result.content[0].text).toContain("very fast");
  });

  it("appends privilege hint on XDMP-NOPERMISSION error", async () => {
    clients.performance.profileXQuery.mockRejectedValue(
      new Error("XDMP-NOPERMISSION: missing privilege")
    );
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("privilege");
  });

  it("returns isError on client failure", async () => {
    clients.performance.profileXQuery.mockRejectedValue(new MarkLogicError("eval error", 500));
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "bad" });
    expect(result.isError).toBe(true);
  });

  it("truncates documents[] to 5 entries when more than 5 URIs are present", async () => {
    const manyDocs = Array.from({ length: 20 }, (_, i) => ({
      uri: `/doc/${i}.json`,
      expandedTreeCacheMisses: 1,
    }));
    clients.performance.profileXQuery.mockResolvedValue([{
      value: {
        elapsedMs: 50,
        resultCount: 20,
        filterMisses: 0,
        filterHits: 20,
        documents: manyDocs,
      },
    }]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "test" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    // Should include only 5 URIs and a truncation notice
    expect(text).toContain("/doc/0.json");
    expect(text).toContain("/doc/4.json");
    expect(text).not.toContain("/doc/5.json");
    expect(text).toContain("truncated for readability");
    expect(text).toContain("15 more");
  });

  it("does not truncate documents[] when 5 or fewer entries are present", async () => {
    const fewDocs = Array.from({ length: 3 }, (_, i) => ({
      uri: `/doc/${i}.json`,
      expandedTreeCacheMisses: 1,
    }));
    clients.performance.profileXQuery.mockResolvedValue([{
      value: { elapsedMs: 5, resultCount: 3, filterMisses: 0, filterHits: 3, documents: fewDocs },
    }]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "test" });
    const text = result.content[0].text;
    expect(text).toContain("/doc/0.json");
    expect(text).toContain("/doc/2.json");
    expect(text).not.toContain("truncated");
  });

  it("analysis flags list cache misses", async () => {
    clients.performance.profileXQuery.mockResolvedValue([{
      value: { elapsedMs: 200, resultCount: 50, filterMisses: 0, filterHits: 0, listCacheMisses: 100 },
    }]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "test" });
    expect(result.content[0].text).toContain("LIST CACHE");
    expect(result.content[0].text).toContain("100");
  });

  it("analysis flags expanded tree cache misses", async () => {
    clients.performance.profileXQuery.mockResolvedValue([{
      value: { elapsedMs: 300, resultCount: 10, filterMisses: 0, filterHits: 0, expandedTreeCacheMisses: 25 },
    }]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "test" });
    expect(result.content[0].text).toContain("EXPANDED TREE CACHE");
    expect(result.content[0].text).toContain("25");
  });

  it("analysis shows SPARQL slow hint for sparql language with high elapsed", async () => {
    clients.performance.profileSparql.mockResolvedValue([{
      value: { elapsedMs: 1500, rowCount: 100 },
    }]);
    const result = await tools.get("ml_profile_query")!({
      language: "sparql",
      code: "SELECT * WHERE { ?s ?p ?o }",
    });
    expect(result.content[0].text).toContain("SPARQL NOTE");
    expect(result.content[0].text).toContain("E-node");
  });

  it("analysis shows healthy fallback when no standard metrics present", async () => {
    // Provide metrics with no elapsedMs, no filter info, no cache info — triggers empty hints fallback
    clients.performance.profileXQuery.mockResolvedValue([{
      value: { resultCount: 1 },
    }]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "1" });
    expect(result.content[0].text).toContain("healthy");
    expect(result.content[0].text).toContain("xdmp:plan");
  });

  it("analysis shows filtered search with zero false positives as GOOD", async () => {
    clients.performance.profileXQuery.mockResolvedValue([{
      value: { elapsedMs: 10, resultCount: 5, filterMisses: 0, filterHits: 5 },
    }]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "test" });
    expect(result.content[0].text).toContain("GOOD");
    expect(result.content[0].text).toContain("0 false positives");
  });

  it("handles raw string value when JSON parsing fails", async () => {
    clients.performance.profileXQuery.mockResolvedValue([{
      value: "raw text output that is not JSON",
    }]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "test" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("raw text output");
  });

  it("truncates fragments[] array alongside documents[]", async () => {
    const manyFragments = Array.from({ length: 10 }, (_, i) => ({ uri: `/frag/${i}` }));
    clients.performance.profileXQuery.mockResolvedValue([{
      value: {
        elapsedMs: 10,
        resultCount: 10,
        filterMisses: 0,
        filterHits: 10,
        fragments: manyFragments,
        documents: [],
      },
    }]);
    const result = await tools.get("ml_profile_query")!({ language: "xquery", code: "test" });
    const text = result.content[0].text;
    expect(text).toContain("/frag/0");
    expect(text).toContain("/frag/4");
    expect(text).not.toContain("/frag/5");
    expect(text).toContain("5 more");
  });
});
