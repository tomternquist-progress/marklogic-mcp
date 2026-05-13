/**
 * Unit-level integration test for the chat → MarkLogic translation pipeline.
 *
 * This test simulates the four-stage flow documented in the
 * CHAT → MARKLOGIC TRANSLATION PIPELINE section of marklogic://instructions:
 *
 *   STAGE 1  ml_search_surface       → discovers fields, range indexes, options names, bindings
 *   STAGE 2  (LLM via nl_to_search_query) → produces a string-grammar query + bindings
 *   STAGE 3  ml_parse_query           → validates the grammar without executing
 *   STAGE 4  ml_search                → executes via either q= or structured_query=
 *
 * Stage 2 is exercised by hand-writing the query an LLM would produce; the real
 * prompt template is verified by registration tests in prompts.test.ts (if any)
 * and by manual evaluation. The contract this file enforces is the wiring:
 *  - The surface output is shaped so the parse step can consume its suggestedBindings.
 *  - The parse output is shaped so ml_search can consume it via structured_query.
 *  - ml_search accepts either the raw string query or the parsed JSON.
 *
 * If any of these break, the chat → MarkLogic pipeline silently breaks too — these
 * tests are the regression net.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerSchemaTools } from "../../src/tools/schema.js";
import { registerSearchTools } from "../../src/tools/search.js";

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
    documents: { put: vi.fn() },
    fasttrack: { listSearchOptions: vi.fn() },
    search: {
      search: vi.fn(),
      qbe: vi.fn(),
      values: vi.fn(),
      suggest: vi.fn(),
    },
    eval: {
      parseCtsQuery: vi.fn(),
    },
  };
}

describe("chat → MarkLogic translation pipeline (end-to-end, mocked)", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    // Register BOTH tool groups so the same `tools` map can serve all 4 stages.
    registerSchemaTools(mock.server as never, clients as never);
    registerSearchTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("runs the full surface → parse → search flow for a typical chat query", async () => {
    // STAGE 1 — Discovery: ml_search_surface returns a customer-collection profile.
    clients.schema.discoverSchema.mockResolvedValue({
      documentCount: 1234,
      inferredFields: [
        { path: "state",  type: "string", nullable: false, cardinality: "single", exampleValues: ["TX"], hasRangeIndex: false },
        { path: "age",    type: "number", nullable: false, cardinality: "single", exampleValues: [70],   hasRangeIndex: true  },
        { path: "notes",  type: "string", nullable: true,  cardinality: "single", exampleValues: ["…diabetes…"], hasRangeIndex: false },
      ],
      rangeIndexes: [{ type: "range-element", localname: "age", scalarType: "int" }],
      tdeSchemas: [],
    });
    clients.fasttrack.listSearchOptions.mockResolvedValue([{ name: "customers-opts" }]);

    const surfaceResp = await tools.get("ml_search_surface")!({ collection: "customers", database: "MyDB" });
    expect(surfaceResp.isError).toBeUndefined();
    const surface = JSON.parse(surfaceResp.content[0].text);

    // The surface must hand the agent exactly what it needs to construct a parse call.
    expect(surface.suggestedBindings.age).toEqual({ type: "element-range", name: "age", scalar_type: "int" });
    expect(surface.suggestedBindings.state).toEqual({ type: "json-property", name: "state" });
    expect(surface.searchOptionsNames).toContain("customers-opts");

    // STAGE 2 — Translation: an LLM produces this from the user's question
    //   "show me customers in Texas over 65 who mentioned diabetes"
    const llmQuery = "diabetes AND state:TX AND age:GE:65";
    const llmBindings = {
      state: surface.suggestedBindings.state,
      age:   surface.suggestedBindings.age,
    };

    // STAGE 3 — Validation: ml_parse_query routes to the eval client, which
    // returns the cts.parse JSON form (and-query of three children).
    const parsedQuery = {
      "and-query": {
        queries: [
          { "word-query": { text: ["diabetes"] } },
          { "json-property-value-query": { "property-name": "state", value: ["TX"] } },
          { "element-range-query": { element: ["age"], operator: ">=", value: ["65"] } },
        ],
      },
    };
    clients.eval.parseCtsQuery.mockResolvedValue([{ primitive: "object-node()", value: parsedQuery }]);

    const parseResp = await tools.get("ml_parse_query")!({ qtext: llmQuery, bindings: llmBindings, database: "MyDB" });
    expect(parseResp.isError).toBeUndefined();
    const parsed = JSON.parse(parseResp.content[0].text);

    // The structured-query JSON returned by ml_parse_query is the SAME shape ml_search expects.
    expect(parsed).toEqual(parsedQuery);
    expect(clients.eval.parseCtsQuery).toHaveBeenCalledWith(llmQuery, llmBindings, "MyDB");

    // STAGE 4a — Execute via string grammar.
    const stringHits = { total: 7, results: [{ uri: "/customers/42.json", score: 1.0 }] };
    clients.search.search.mockResolvedValueOnce(stringHits);

    const execStringResp = await tools.get("ml_search")!({
      q: llmQuery, options: "customers-opts", collection: "customers", database: "MyDB",
    });
    expect(execStringResp.isError).toBeUndefined();
    expect(JSON.parse(execStringResp.content[0].text)).toEqual(stringHits);
    expect(clients.search.search).toHaveBeenLastCalledWith(expect.objectContaining({
      q: llmQuery, options: "customers-opts", collection: "customers", database: "MyDB",
    }));

    // STAGE 4b — Execute via the JSON returned by ml_parse_query.
    // CRITICAL: ml_parse_query's output must be directly accepted as structured_query —
    // this is what makes the pipeline composable.
    clients.search.search.mockResolvedValueOnce(stringHits);
    const execStructuredResp = await tools.get("ml_search")!({
      structured_query: parsed, collection: "customers", database: "MyDB",
    });
    expect(execStructuredResp.isError).toBeUndefined();
    expect(clients.search.search).toHaveBeenLastCalledWith(expect.objectContaining({
      structuredQuery: parsed,
    }));
  });

  it("pipeline error containment: a parse error does NOT execute against MarkLogic", async () => {
    // Discovery succeeds
    clients.schema.discoverSchema.mockResolvedValue({
      documentCount: 0, inferredFields: [], rangeIndexes: [], tdeSchemas: [],
    });
    clients.fasttrack.listSearchOptions.mockResolvedValue([]);
    await tools.get("ml_search_surface")!({ collection: "anything" });

    // The user's question contains an unmatched quote — cts.parse rejects it.
    clients.eval.parseCtsQuery.mockRejectedValue(new Error('XDMP-QUERY: unmatched "'));

    const parseResp = await tools.get("ml_parse_query")!({ qtext: '"oops' });
    expect(parseResp.isError).toBe(true);

    // Critical regression: agent must observe the error BEFORE issuing ml_search.
    // We assert by demonstrating ml_search was never invoked (mock has no calls).
    expect(clients.search.search).not.toHaveBeenCalled();
  });

  it("supports a query that uses only the universal index (no bindings, no options)", async () => {
    // A simpler chat use case: "what do we have about ai" — pure bareword.
    clients.eval.parseCtsQuery.mockResolvedValue([{ primitive: "object-node()", value: { "word-query": { text: ["ai"] } } }]);
    const parseResp = await tools.get("ml_parse_query")!({ qtext: "ai" });
    expect(parseResp.isError).toBeUndefined();
    expect(clients.eval.parseCtsQuery).toHaveBeenCalledWith("ai", undefined, undefined);

    clients.search.search.mockResolvedValue({ total: 3, results: [] });
    const exec = await tools.get("ml_search")!({ q: "ai" });
    expect(exec.isError).toBeUndefined();
  });

  it("supports the structured-query fallback path emitted by nl_to_search_query for geo or complex precedence", async () => {
    // When the LLM emits a structured-query JSON directly (no string grammar), ml_search must accept it.
    const geoQuery = {
      "geo-json-property-pair-query": {
        "parent-property": "location",
        "lat-property": "latitude",
        "lon-property": "longitude",
        circle: { radius: 10, point: [{ latitude: 30, longitude: -97 }] },
      },
    };
    clients.search.search.mockResolvedValue({ total: 2, results: [{ uri: "/c/1.json" }, { uri: "/c/2.json" }] });

    const exec = await tools.get("ml_search")!({ structured_query: geoQuery, collection: "customers" });
    expect(exec.isError).toBeUndefined();
    expect(clients.search.search).toHaveBeenCalledWith(expect.objectContaining({ structuredQuery: geoQuery }));
  });
});
