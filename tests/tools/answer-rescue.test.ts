/**
 * Regression tests for ml_answer_query's auto-rescue stack — specifically
 * Layer 3, the "fall back to the universal index" step.
 *
 * The bug this locks: Layer 3 re-sent the structured query alongside the
 * free-text `q`. The REST API ANDs a string query with a structured query, so
 * re-sending the filter that had just matched zero documents guaranteed zero
 * again. Layer 3 was unreachable by construction — its guard
 * (`!useResidual && cleanedResidual.length`) can only be true when a structured
 * filter exists, so the structured query was never undefined at that point.
 *
 * The fake below encodes the real AND semantics: any request carrying a
 * structured query matches nothing, while a bare free-text query matches. That
 * makes the test fail against the old behaviour and pass only when the
 * structured filter is genuinely dropped.
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
    tool: (name: string, _d: string, _s: Record<string, unknown>, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  return { server, tools };
}

const MEMO_DOCS = [
  { uri: "/m/1.json", memoType: "Internal", title: "Quarterly memos on quasarium supply", body: "quasarium" },
  { uri: "/m/2.json", memoType: "External", title: "Partner memos", body: "quasarium logistics" },
];

/**
 * Fake search client encoding MarkLogic's combined-query semantics:
 *   structured query present → intersected with q; our filter matches nothing,
 *                              so the whole request matches nothing.
 *   q only                   → free-text hit across the corpus.
 * The `q: ""` probes issued by the rescue/sampling helpers must still return
 * the corpus, since those are unfiltered scope samples rather than searches.
 */
function makeClients() {
  const search = vi.fn(async (params: Record<string, unknown>) => {
    const hasStructured = params.structuredQuery != null;
    const q = typeof params.q === "string" ? params.q : "";

    let matched: typeof MEMO_DOCS = [];
    if (hasStructured) {
      matched = []; // the parsed filter grounds to a value no document carries
    } else if (q === "") {
      matched = MEMO_DOCS; // unfiltered scope sample
    } else {
      matched = MEMO_DOCS.filter((d) =>
        Object.values(d).some(
          (v) => typeof v === "string" && v.toLowerCase().includes(q.toLowerCase())
        )
      );
    }

    return {
      total: matched.length,
      start: 1,
      pageLength: (params.pageLength as number) ?? 10,
      results: matched.map((d) => ({ uri: d.uri, score: 1 })),
    };
  });

  return {
    schema: {
      discoverSchema: vi.fn(async () => ({
        collection: "memos",
        documentCount: MEMO_DOCS.length,
        inferredFields: [
          { path: "memoType", type: "string", nullable: false, cardinality: "single", exampleValues: ["Internal", "External"], hasRangeIndex: false },
          { path: "title", type: "string", nullable: false, cardinality: "single", exampleValues: ["Partner memos"], hasRangeIndex: false },
          { path: "body", type: "string", nullable: false, cardinality: "single", exampleValues: ["quasarium"], hasRangeIndex: false },
        ],
        rangeIndexes: [],
        tdeSchemas: [],
      })),
      listCollections: vi.fn(async () => [{ name: "memos", count: 2 }]),
    },
    search: {
      search,
      fetchDocs: vi.fn(async (uris: string[]) => {
        const out = new Map<string, unknown>();
        for (const uri of uris) out.set(uri, MEMO_DOCS.find((d) => d.uri === uri) ?? null);
        return out;
      }),
    },
    fasttrack: { listSearchOptions: vi.fn(async () => []) },
  };
}

async function answer(args: Record<string, unknown>) {
  const { server, tools } = createMockServer();
  const clients = makeClients();
  registerAnswerTools(server as never, clients as never);
  const result = await tools.get("ml_answer_query")!(args);
  expect(result.isError).not.toBe(true);
  return { payload: JSON.parse(result.content[0].text), clients };
}

describe("ml_answer_query free-text rescue (Layer 3)", () => {
  const QUESTION = "which memos about quasarium";

  it("recovers rows when only the universal index can match", async () => {
    const { payload } = await answer({ question: QUESTION, collection: "memos" });

    // Setup sanity: the structured filter really did ground and really did miss.
    expect(payload.trace.normalizedFilters?.[0]?.field).toBe("memoType");

    expect(payload.total).toBeGreaterThan(0);
    expect(payload.rows.length).toBeGreaterThan(0);
  });

  it("issues the free-text retry with NO structured query attached", async () => {
    const { clients } = await answer({ question: QUESTION, collection: "memos" });

    const calls = (clients.search.search as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    const freeText = calls.filter(
      ([p]) => typeof p.q === "string" && p.q.length > 0 && p.collection === "memos"
    );
    expect(freeText.length).toBeGreaterThan(0);
    for (const [params] of freeText) {
      expect(params.structuredQuery).toBeUndefined();
    }
  });

  it("records the rescue in the audit trace and clears the unused CTS", async () => {
    const { payload } = await answer({ question: QUESTION, collection: "memos" });

    const attempt = payload.trace.attempts.find((a: { step: string }) => a.step === "rescue:free-text");
    expect(attempt).toBeDefined();
    expect(attempt.cts).toBeNull();
    expect(attempt.count).toBeGreaterThan(0);

    // The reported CTS must reflect what actually produced the rows.
    expect(payload.trace.cts).toBeNull();
    expect(payload.trace.ctsKind).toBe("free-text");
    expect(payload.trace.residualApplied).toBe("memos");
  });

  it("warns that the returned rows are no longer field-scoped", async () => {
    const { payload } = await answer({ question: QUESTION, collection: "memos" });
    expect(payload.assumptions.join(" ")).toMatch(/NOT field-scoped/i);
  });

  it("next_actions reproduce the free-text query that actually ran", async () => {
    const { payload } = await answer({ question: QUESTION, collection: "memos" });

    const rerun = payload.next_actions.find(
      (a: { label: string }) => a.label === "Run this query as-is in ml_search"
    );
    expect(rerun).toBeDefined();
    expect(rerun.params.q).toBe("memos");
    expect(rerun.params.structured_query).toBeUndefined();
  });
});
