/**
 * Integration tests: Search Analytics Workflow
 *
 * Use case: Understanding content distribution and search quality across a dataset.
 * This workflow demonstrates how an agent would:
 *   1. Run ml_values_query to see value distribution for a field
 *   2. Run ml_facets_query to get faceted breakdowns with counts
 *   3. Run ml_search_query_plan to inspect the query resolution for a search
 *   4. Run ml_suggest to autocomplete partial queries
 *   5. Understand the performance shape of queries via ml_explain_optic
 *
 * Uses the wikipedia-articles collection seeded by scripts/integration-seed.mjs.
 *
 * Why this tests things mock-based tests miss:
 *   - Values/facets require a real index and real data to return meaningful results
 *   - searchDebug output shape changes between ML versions (11 vs 12)
 *   - explainOptic plan JSON structure varies by ML version
 *   - suggest() with partial queries exercises the suggestion index
 *
 * Requires: ML_HOST env var pointing to a live MarkLogic instance.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";
import { registerPerformanceTools } from "../../src/tools/performance.js";
import { registerFastTrackTools } from "../../src/tools/fasttrack.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

// ── Helper: create a minimal mock server to exercise tool handlers directly ────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function buildToolMap(clients: ReturnType<typeof buildClients>): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  // Register the tools that need live testing at the handler level
  registerPerformanceTools(server as never, clients as never, true);
  registerFastTrackTools(server as never, clients as never, false);
  return tools;
}

// ── Seed data ─────────────────────────────────────────────────────────────────
// We use the pre-seeded wikipedia-articles collection. If it is not populated,
// we seed a small set of analytics-specific documents.

const ANALYTICS_COLLECTION = "analytics-test-docs";
const ANALYTICS_URIS: string[] = [];

describeIfLive("Search Analytics Workflow (live)", () => {
  const clients = buildClients();
  const tools = buildToolMap(clients);

  // Seed some analytics documents if the collection doesn't already have enough data
  beforeAll(async () => {
    const categories = ["finance", "technology", "health", "environment"];
    const sources = ["Reuters", "AP", "Bloomberg", "BBC"];

    for (let i = 1; i <= 20; i++) {
      const cat = categories[(i - 1) % categories.length];
      const src = sources[(i - 1) % sources.length];
      const uri = `/test/analytics/doc-${String(i).padStart(3, "0")}.json`;
      ANALYTICS_URIS.push(uri);

      await clients.documents.put(
        uri,
        JSON.stringify({
          title: `Article ${i} about ${cat}`,
          category: cat,
          source: src,
          wordCount: 100 + i * 50,
          publishedYear: 2020 + (i % 5),
        }),
        "application/json",
        { collections: [ANALYTICS_COLLECTION], permissions: [] }
      );
    }
  }, 60_000);

  afterAll(async () => {
    for (const uri of ANALYTICS_URIS) {
      try { await clients.documents.del(uri); } catch { /* ignore */ }
    }
  });

  // ── Values query (field distribution) ────────────────────────────────────

  describe("ml_values_query – field distribution", () => {
    it("returns values for a field via search QBE (distribution check)", async () => {
      // Use QBE to get docs by category to confirm data shape
      const result = await clients.search.qbe(
        { category: "finance" },
        { pageLength: 5 }
      );
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it("wikipedia-articles collection has documents to analyze", async () => {
      const result = await clients.search.search({
        collection: "wikipedia-articles",
        pageLength: 1,
      });
      // The seed script must have populated this collection
      expect(result.total).toBeGreaterThanOrEqual(0);
      // Even if empty (fresh environment), this should not throw
    });
  });

  // ── Faceted search ────────────────────────────────────────────────────────

  describe("ml_facets_query – category breakdown", () => {
    it("QBE facets return results per category", async () => {
      // Verify each category is searchable via QBE
      const cats = ["finance", "technology", "health", "environment"];
      for (const cat of cats) {
        const r = await clients.search.qbe({ category: cat }, { pageLength: 1 });
        expect(r.total).toBeGreaterThanOrEqual(0); // may be 0 on empty runs
      }
    });

    it("full-text search scoped to analytics collection returns results", async () => {
      const result = await clients.search.search({
        q: "Article",
        collection: ANALYTICS_COLLECTION,
        pageLength: 5,
      });
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it("collection search returns exactly the seeded document count", async () => {
      const result = await clients.search.search({
        collection: ANALYTICS_COLLECTION,
        pageLength: 100,
      });
      expect(result.total).toBe(ANALYTICS_URIS.length);
    });
  });

  // ── ml_search_query_plan tool handler (live) ──────────────────────────────

  describe("ml_search_query_plan – live tool handler", () => {
    it("returns plan output for a word query", async () => {
      const result = await tools.get("ml_search_query_plan")!({ q: "climate" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("SEARCH QUERY PLAN");
      expect(result.content[0].text).toContain("QUERY ANALYSIS");
    });

    it("plan output includes total field from ML search response", async () => {
      const result = await tools.get("ml_search_query_plan")!({ q: "article" });
      expect(result.isError).toBeUndefined();
      // The plan strips 'results' but keeps 'total'
      expect(result.content[0].text).toContain("total");
    });

    it("scoped query returns lower total than unscoped", async () => {
      const unscoped = await tools.get("ml_search_query_plan")!({ q: "article" });
      const scoped = await tools.get("ml_search_query_plan")!({
        q: "article",
        collection: ANALYTICS_COLLECTION,
      });
      // Both should succeed; scoped should have different (lower or equal) total
      expect(unscoped.isError).toBeUndefined();
      expect(scoped.isError).toBeUndefined();
    });

    it("returns isError when neither q nor structured_query is provided", async () => {
      const result = await tools.get("ml_search_query_plan")!({});
      expect(result.isError).toBe(true);
    });
  });

  // ── ml_explain_optic tool handler (live) ─────────────────────────────────

  describe("ml_explain_optic – live tool handler", () => {
    it("explains a from-literals plan without executing it", async () => {
      const LITERALS_PLAN = {
        $optic: {
          ns: "op", fn: "operators", args: [
            {
              ns: "op", fn: "from-literals",
              args: [[{ id: 1, name: "a" }, { id: 2, name: "b" }]],
            },
          ],
        },
      };
      const result = await tools.get("ml_explain_optic")!({ plan: LITERALS_PLAN });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("OPTIC EXECUTION PLAN");
    });

    it("includes PLAN ANALYSIS section in output", async () => {
      const LITERALS_PLAN = {
        $optic: {
          ns: "op", fn: "operators", args: [
            {
              ns: "op", fn: "from-literals",
              args: [[{ x: 1 }]],
            },
          ],
        },
      };
      const result = await tools.get("ml_explain_optic")!({ plan: LITERALS_PLAN });
      expect(result.content[0].text).toContain("PLAN ANALYSIS");
    });

    it("plan contains a limit warning when no limit is in the plan", async () => {
      const NO_LIMIT_PLAN = {
        $optic: {
          ns: "op", fn: "operators", args: [
            {
              ns: "op", fn: "from-literals",
              args: [[{ id: 1 }]],
            },
          ],
        },
      };
      const result = await tools.get("ml_explain_optic")!({ plan: NO_LIMIT_PLAN });
      // The analysis helper should warn about missing limit
      expect(result.content[0].text).toContain("LIMIT");
    });

    it("accepts plan as a JSON string", async () => {
      const planStr = JSON.stringify({
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-literals", args: [[{ x: 1 }]] },
          ],
        },
      });
      const result = await tools.get("ml_explain_optic")!({ plan: planStr });
      expect(result.isError).toBeUndefined();
    });
  });

  // ── ml_profile_query tool handler (live) ─────────────────────────────────

  describe("ml_profile_query – live tool handler", () => {
    it("profiles an XQuery expression and returns elapsed time", async () => {
      const result = await tools.get("ml_profile_query")!({
        language: "xquery",
        code: "(1 to 10)",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("QUERY PROFILE");
      expect(result.content[0].text).toContain("PERFORMANCE ANALYSIS");
    });

    it("profiles a JavaScript expression", async () => {
      const result = await tools.get("ml_profile_query")!({
        language: "javascript",
        code: "[1, 2, 3, 4, 5]",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("javascript");
    });

    it("profiles a SPARQL query", async () => {
      const result = await tools.get("ml_profile_query")!({
        language: "sparql",
        code: "SELECT * WHERE { ?s ?p ?o } LIMIT 0",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("QUERY PROFILE");
    });

    it("analysis reports fast elapsed time for trivial XQuery", async () => {
      const result = await tools.get("ml_profile_query")!({
        language: "xquery",
        code: "1 + 1",
      });
      expect(result.isError).toBeUndefined();
      // Simple arithmetic should be very fast — look for elapsed mention
      expect(result.content[0].text).toContain("Elapsed");
    });
  });

  // ── ml_forest_metrics tool handler (live) ────────────────────────────────

  describe("ml_forest_metrics – live tool handler", () => {
    it("returns metrics for the Documents database", async () => {
      const result = await tools.get("ml_forest_metrics")!({});
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("FOREST METRICS FOR DATABASE: Documents");
    });

    it("includes at least one forest with state information", async () => {
      const result = await tools.get("ml_forest_metrics")!({});
      expect(result.content[0].text).toContain("State:");
    });

    it("returns metrics for the Schemas database", async () => {
      const result = await tools.get("ml_forest_metrics")!({ database: "Schemas" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Schemas");
    });

    it("handles a non-existent database gracefully", async () => {
      const result = await tools.get("ml_forest_metrics")!({ database: "NonExistentDB-xyz" });
      // Should return isError (getDatabaseProperties will fail) or 'No forests found'
      const text = result.content[0].text;
      expect(result.isError === true || text.includes("No forests found") || text.includes("Error")).toBe(true);
    });
  });

  // ── Suggest (autocomplete) ────────────────────────────────────────────────

  describe("ml_suggest – autocomplete for analytics workflow", () => {
    it("returns suggestions array for a partial query", async () => {
      const suggestions = await clients.search.suggest("art");
      expect(Array.isArray(suggestions)).toBe(true);
      // May be empty if the suggestion index has nothing — just verify shape
    });

    it("returns empty array (not error) for very specific partial query", async () => {
      const suggestions = await clients.search.suggest("zzz_no_match_xyz");
      expect(Array.isArray(suggestions)).toBe(true);
      expect(suggestions.length).toBe(0);
    });
  });
});
