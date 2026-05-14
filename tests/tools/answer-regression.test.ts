/**
 * Regression tests for ml_answer_query. Locks the acceptance criterion the
 * friction log keeps citing: "which disasters involved hurricanes" against a
 * FEMA-shaped dataset must return non-zero rows on the first call, with the
 * incidentType normalised to the indexed value "Hurricane" and the title
 * field surfaced inline.
 *
 * Uses a fake search/schema/documents client so we can predictably feed sample
 * data without depending on a live MarkLogic. The fake matches the response
 * shapes the real SearchClient produces.
 */

import { describe, it, expect, vi } from "vitest";
import { registerAnswerTools } from "../../src/tools/answer.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (
      name: string,
      _desc: string,
      _schema: Record<string, unknown>,
      handler: ToolHandler
    ) => {
      tools.set(name, handler);
    },
  };
  return { server, tools };
}

// Synthetic FEMA-shaped corpus. Eight rows; three are Hurricane-incidentType
// rows in FL; two are Severe Storm with a hurricane name in the title; rest
// are unrelated.
const FEMA_DOCS = [
  { uri: "/d/1.json", disasterNumber: 4673, declarationTitle: "HURRICANE IAN", incidentType: "Hurricane", state: "FL" },
  { uri: "/d/2.json", disasterNumber: 4673, declarationTitle: "HURRICANE IAN", incidentType: "Hurricane", state: "FL" },
  { uri: "/d/3.json", disasterNumber: 4699, declarationTitle: "HURRICANE IDALIA", incidentType: "Hurricane", state: "FL" },
  { uri: "/d/4.json", disasterNumber: 4759, declarationTitle: "TROPICAL STORM HELENE REMNANTS", incidentType: "Severe Storm", state: "TN" },
  { uri: "/d/5.json", disasterNumber: 4759, declarationTitle: "HURRICANE HELENE", incidentType: "Severe Storm", state: "NC" },
  { uri: "/d/6.json", disasterNumber: 4800, declarationTitle: "WILDFIRE",         incidentType: "Fire",         state: "CA" },
  { uri: "/d/7.json", disasterNumber: 4801, declarationTitle: "MISSISSIPPI FLOOD",incidentType: "Flood",        state: "MS" },
  { uri: "/d/8.json", disasterNumber: 4673, declarationTitle: "HURRICANE IAN", incidentType: "Hurricane", state: "FL" },
];

function makeClients() {
  const searchSpy = vi.fn(async (params: any) => {
    // structuredQuery filtering: walk a small subset of cts shapes we use.
    let matched = FEMA_DOCS.slice();
    if (params.structuredQuery) {
      matched = matched.filter((d) => evaluateCts(params.structuredQuery, d));
    }
    if (params.q && !params.structuredQuery) {
      // bareword universal-index — match against any string field.
      const q = String(params.q).toLowerCase();
      matched = matched.filter((d) =>
        Object.values(d).some((v) => typeof v === "string" && v.toLowerCase().includes(q))
      );
    }
    if (params.collection && params.collection !== "fema-disasters") {
      matched = [];
    }
    return {
      total: matched.length,
      start: 1,
      pageLength: params.pageLength ?? 10,
      results: matched.slice(0, params.pageLength ?? 10).map((d) => ({ uri: d.uri, score: 1 })),
    };
  });

  return {
    schema: {
      discoverSchema: vi.fn(async ({ collection }: any) => {
        if (collection && collection !== "fema-disasters") {
          return { documentCount: 0, inferredFields: [], rangeIndexes: [], tdeSchemas: [] };
        }
        return {
          collection,
          documentCount: FEMA_DOCS.length,
          inferredFields: [
            { path: "disasterNumber", type: "number", nullable: false, cardinality: "single", exampleValues: [4673, 4759], hasRangeIndex: false },
            { path: "declarationTitle", type: "string", nullable: false, cardinality: "single", exampleValues: ["HURRICANE IAN", "WILDFIRE"], hasRangeIndex: false },
            { path: "incidentType", type: "string", nullable: false, cardinality: "single", exampleValues: ["Hurricane", "Severe Storm", "Fire", "Flood"], hasRangeIndex: false },
            { path: "state", type: "string", nullable: false, cardinality: "single", exampleValues: ["FL", "CA", "TN"], hasRangeIndex: false },
          ],
          rangeIndexes: [],
          tdeSchemas: [],
        };
      }),
      listCollections: vi.fn(async () => [
        { name: "fema-disasters", count: 60_000 },
        { name: "pharma-drug-events", count: 11_000 },
        { name: "unrelated-misc", count: 200 },
      ]),
    },
    search: {
      search: searchSpy,
      fetchDocs: vi.fn(async (uris: string[]) => {
        const out = new Map<string, unknown>();
        for (const uri of uris) {
          const doc = FEMA_DOCS.find((d) => d.uri === uri);
          out.set(uri, doc ?? null);
        }
        return out;
      }),
    },
    fasttrack: { listSearchOptions: vi.fn(async () => []) },
  };
}

/** Minimal CTS evaluator: handles the shapes ml_answer_query actually emits
 *  (value-query, word-query on json-property/text, and-/or-query, free q).
 *  Returns true if the doc matches. */
function evaluateCts(cts: any, doc: Record<string, any>): boolean {
  if (!cts || typeof cts !== "object") return true;
  if (cts["value-query"]) {
    const { ["json-property"]: prop, text } = cts["value-query"] as any;
    const v = doc[prop];
    return Array.isArray(text) ? text.includes(v) : v === text;
  }
  if (cts["word-query"]) {
    const { ["json-property"]: prop, text } = cts["word-query"] as any;
    const v = doc[prop];
    if (typeof v !== "string") return false;
    const phrases = Array.isArray(text) ? text : [text];
    return phrases.some((p: string) => v.toLowerCase().includes(String(p).toLowerCase()));
  }
  if (cts["and-query"]) {
    const queries = cts["and-query"].queries as any[];
    return queries.every((q) => evaluateCts(q, doc));
  }
  if (cts["or-query"]) {
    const queries = cts["or-query"].queries as any[];
    return queries.some((q) => evaluateCts(q, doc));
  }
  return true;
}

async function callAnswerQuery(args: Record<string, unknown>): Promise<{
  payload: any;
  searchCalls: number;
}> {
  const { server, tools } = createMockServer();
  const clients = makeClients();
  registerAnswerTools(server as never, clients as never);
  const handler = tools.get("ml_answer_query");
  if (!handler) throw new Error("ml_answer_query was not registered");
  const result = await handler(args);
  if (result.isError) {
    throw new Error(`ml_answer_query returned isError: ${result.content[0]?.text}`);
  }
  const payload = JSON.parse(result.content[0].text);
  return {
    payload,
    searchCalls: (clients.search.search as any).mock.calls.length,
  };
}

describe("ml_answer_query regression — 'which disasters involved hurricanes' must return non-zero", () => {
  it("answers in one call against an explicit collection", async () => {
    const { payload } = await callAnswerQuery({
      question: "which disasters involved hurricanes",
      collection: "fema-disasters",
    });

    expect(payload.total).toBeGreaterThan(0);
    expect(Array.isArray(payload.rows)).toBe(true);
    expect(payload.rows.length).toBeGreaterThan(0);
    // The picker should normalise "hurricanes" → "Hurricane" against the observed values.
    const normalized = payload.trace.normalizedFilters?.[0];
    expect(normalized?.field).toBe("incidentType");
    expect(normalized?.matchedValue).toBe("Hurricane");
    // distinct_titles should be surfaced inline so the caller doesn't need a follow-up.
    expect(Array.isArray(payload.distinct_titles)).toBe(true);
    expect(payload.distinct_titles.length).toBeGreaterThan(0);
  });

  it("auto-routes when collection is omitted", async () => {
    const { payload } = await callAnswerQuery({
      question: "which disasters involved hurricanes",
    });

    expect(payload.collection).toBe("fema-disasters");
    expect(payload.total).toBeGreaterThan(0);
    expect(payload.stageConfidence?.collection).toBeDefined();
  });

  it("balanced mode also catches title-only hurricane mentions via or-query", async () => {
    const { payload } = await callAnswerQuery({
      question: "which disasters involved hurricanes",
      collection: "fema-disasters",
      mode: "balanced",
    });
    // Severe Storm docs whose title contains "HURRICANE" should also be found.
    const titles = payload.distinct_titles ?? [];
    const hasHelene = titles.some((t: string) => /HELENE/i.test(t));
    expect(hasHelene).toBe(true);
  });

  it("titles mode returns distinct declarationTitle names", async () => {
    const { payload } = await callAnswerQuery({
      question: "which disasters involved hurricanes",
      collection: "fema-disasters",
      answer_mode: "titles",
    });

    expect(payload.field).toBe("declarationTitle");
    expect(Array.isArray(payload.values)).toBe(true);
    expect(payload.values.length).toBeGreaterThan(0);
    expect(Array.isArray(payload.distinct_titles)).toBe(true);
  });

  it("rows_plus_rollup requires explicit rows_unique_by and returns raw_count + unique_count", async () => {
    const { payload } = await callAnswerQuery({
      question: "which disasters involved hurricanes",
      collection: "fema-disasters",
      answer_mode: "rows_plus_rollup",
      rows_unique_by: ["disasterNumber", "state", "declarationTitle"],
    });

    expect(payload.raw_count).toBeGreaterThan(0);
    expect(payload.unique_count).toBeLessThanOrEqual(payload.raw_count);
    expect(payload.rollup?.dedupe_keys).toEqual(["disasterNumber", "state", "declarationTitle"]);
  });

  it("rows_plus_rollup without rows_unique_by returns a structured MISSING_PARAMETER error", async () => {
    const { server, tools } = (() => {
      const tools = new Map<string, ToolHandler>();
      const server = {
        tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
          tools.set(name, handler);
        },
      };
      return { server, tools };
    })();
    const clients = makeClients();
    registerAnswerTools(server as never, clients as never);
    const result = await tools.get("ml_answer_query")!({
      question: "which disasters involved hurricanes",
      collection: "fema-disasters",
      answer_mode: "rows_plus_rollup",
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("MISSING_PARAMETER");
    expect(parsed.error.class).toBe("user_input");
    expect(Array.isArray(parsed.error.exampleValid?.rows_unique_by)).toBe(true);
    expect(parsed.error.correlationId).toMatch(/^mlq_/);
  });

  it("translation_only returns CTS without executing", async () => {
    const { payload, searchCalls } = await callAnswerQuery({
      question: "which disasters involved hurricanes",
      collection: "fema-disasters",
      translation_only: true,
    });

    expect(payload.translation_only).toBe(true);
    expect(payload.cts).toBeTruthy();
    expect(payload.next_actions?.length).toBeGreaterThan(0);
    // We allow the schema-discovery + listCollections to fire, but no execution searches.
    // The schema-discovery sample does run via search.search internally — only assert
    // that the executor produced no "primary:*" attempts.
    const attempts = payload.trace.attempts ?? [];
    expect(attempts.length).toBe(0);
    expect(searchCalls).toBeLessThanOrEqual(2);
  });

  it("tag→field resolution adapts to a non-FEMA dataset (drug events)", async () => {
    // Synthetic drug-event corpus: tag "type" should resolve to drugType, not
    // incidentType, demonstrating that the alias dictionary is dataset-neutral.
    const DRUG_DOCS = [
      { uri: "/d/1.json", reportNumber: 1001, drugName: "Aspirin", drugType: "OTC", country: "US" },
      { uri: "/d/2.json", reportNumber: 1002, drugName: "Lipitor", drugType: "Prescription", country: "US" },
      { uri: "/d/3.json", reportNumber: 1003, drugName: "Tylenol", drugType: "OTC", country: "CA" },
    ];
    const tools = new Map<string, ToolHandler>();
    const server = {
      tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
        tools.set(name, handler);
      },
    };
    const clients: any = {
      schema: {
        discoverSchema: vi.fn(async () => ({
          documentCount: DRUG_DOCS.length,
          inferredFields: [
            { path: "reportNumber", type: "number", nullable: false, cardinality: "single", exampleValues: [1001, 1002], hasRangeIndex: false },
            { path: "drugName", type: "string", nullable: false, cardinality: "single", exampleValues: ["Aspirin", "Lipitor", "Tylenol"], hasRangeIndex: false },
            { path: "drugType", type: "string", nullable: false, cardinality: "single", exampleValues: ["OTC", "Prescription"], hasRangeIndex: false },
            { path: "country", type: "string", nullable: false, cardinality: "single", exampleValues: ["US", "CA"], hasRangeIndex: false },
          ],
          rangeIndexes: [],
          tdeSchemas: [],
        })),
        listCollections: vi.fn(async () => [{ name: "drug-events", count: 1000 }]),
      },
      search: {
        search: vi.fn(async (params: any) => {
          let matched = DRUG_DOCS.slice();
          if (params.structuredQuery) matched = matched.filter((d) => evaluateCts(params.structuredQuery, d));
          return {
            total: matched.length,
            start: 1,
            pageLength: params.pageLength ?? 10,
            results: matched.slice(0, params.pageLength ?? 10).map((d) => ({ uri: d.uri, score: 1 })),
          };
        }),
        fetchDocs: vi.fn(async (uris: string[]) => {
          const out = new Map<string, unknown>();
          for (const uri of uris) out.set(uri, DRUG_DOCS.find((d) => d.uri === uri) ?? null);
          return out;
        }),
      },
      fasttrack: { listSearchOptions: vi.fn(async () => []) },
    };
    registerAnswerTools(server as never, clients);
    const result = await tools.get("ml_answer_query")!({
      question: "which records involved OTC",
      collection: "drug-events",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.total).toBeGreaterThan(0);
    const normalized = payload.trace.normalizedFilters[0];
    // tag=type resolved to drugType (suffix match, no FEMA hard-coding)
    expect(normalized.tag).toBe("type");
    expect(normalized.field).toBe("drugType");
    expect(normalized.matchedValue).toBe("OTC");
  });

  it("surfaces correlation_id, timings, returned, has_more on rows responses", async () => {
    const { payload } = await callAnswerQuery({
      question: "which disasters involved hurricanes",
      collection: "fema-disasters",
    });
    expect(typeof payload.correlation_id).toBe("string");
    expect(payload.correlation_id).toMatch(/^mlq_/);
    expect(payload.timings).toBeTruthy();
    expect(typeof payload.timings.totalMs).toBe("number");
    expect(typeof payload.timings.executeMs).toBe("number");
    expect(typeof payload.returned).toBe("number");
    expect(typeof payload.has_more).toBe("boolean");
  });

  it("records every search attempt in trace.attempts[]", async () => {
    const { payload } = await callAnswerQuery({
      question: "which disasters involved hurricanes",
      collection: "fema-disasters",
    });

    const attempts = payload.trace.attempts as any[];
    expect(Array.isArray(attempts)).toBe(true);
    expect(attempts.length).toBeGreaterThan(0);
    const primary = attempts[0];
    expect(primary.step).toMatch(/primary:/);
    expect(primary).toHaveProperty("count");
    expect(primary).toHaveProperty("elapsedMs");
    expect(primary).toHaveProperty("decisionReason");
  });
});
