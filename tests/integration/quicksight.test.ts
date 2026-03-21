/**
 * Integration tests for QuickSight-adjacent tools:
 *  - ml_aggregate_query  — uses search.values() with a collection lexicon spec
 *  - ml_facets_query     — uses search with facets via SearchClient.facets()
 *  - ml_export_tabular   — paginates search + fetch, returns CSV/tabular shape
 *  - ml_timeseries_query — buckets date values via values API
 *
 * These test the underlying client methods that the MCP tools call.
 * The tools themselves add parameter parsing on top but the client is the critical path.
 *
 * Prerequisites:
 *  - wikipedia-articles collection seeded (by scripts/integration-seed.mjs)
 *  - A named search options config with a collection lexicon values spec
 *    (deployed in beforeAll, cleaned up in afterAll)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const OPTIONS_NAME = "integration-test-quicksight-options";

// Search options with collection lexicon + a facet spec using the word-query facet
const QUICKSIGHT_OPTIONS = {
  options: {
    values: [
      {
        name: "collections",
        collection: {},
      },
    ],
    constraint: [
      {
        name: "collection",
        collection: {},
      },
    ],
    "return-facets": true,
  },
};

describeIfLive("QuickSight tools (live)", () => {
  const { search, fasttrack, documents } = buildClients();

  beforeAll(async () => {
    await fasttrack.putSearchOptions(OPTIONS_NAME, QUICKSIGHT_OPTIONS);
  }, 15_000);

  afterAll(async () => {
    try { await fasttrack.deleteSearchOptions(OPTIONS_NAME); } catch { /* ignore */ }
  });

  describe("aggregate_query (ml_aggregate_query via search.values)", () => {
    it("returns distinct collection values with frequencies", async () => {
      const result = await search.values("collections", { options: OPTIONS_NAME });
      expect(Array.isArray(result.values)).toBe(true);
      expect(result.values.length).toBeGreaterThan(0);
    });

    it("includes wikipedia-articles in the collection values", async () => {
      const result = await search.values("collections", { options: OPTIONS_NAME });
      const vals = result.values.map((v) => v.value as string);
      expect(vals).toContain("wikipedia-articles");
    });

    it("each value has a numeric frequency greater than 0", async () => {
      const result = await search.values("collections", { options: OPTIONS_NAME });
      result.values.forEach((v) => {
        expect(typeof v.frequency).toBe("number");
        expect(v.frequency).toBeGreaterThan(0);
      });
    });

    it("respects the limit parameter", async () => {
      const result = await search.values("collections", { options: OPTIONS_NAME, limit: 1 });
      expect(result.values.length).toBeLessThanOrEqual(1);
    });

    it("returns the total count of distinct values", async () => {
      const result = await search.values("collections", { options: OPTIONS_NAME });
      expect(typeof result.total).toBe("number");
      expect(result.total).toBeGreaterThan(0);
    });
  });

  describe("facets_query (ml_facets_query via search.facets)", () => {
    it("returns facets object from a search (may be empty without facet options)", async () => {
      const facets = await search.facets("", [], undefined);
      expect(typeof facets).toBe("object");
    });

    it("search with options returns a valid response", async () => {
      const result = await search.search({ q: "climate", options: OPTIONS_NAME, pageLength: 5 });
      expect(typeof result.total).toBe("number");
      expect(Array.isArray(result.results)).toBe(true);
    });
  });

  describe("export_tabular (ml_export_tabular — document sampling)", () => {
    it("can fetch a page of documents from the wikipedia-articles collection", async () => {
      const result = await search.search({
        q: "",
        collection: "wikipedia-articles",
        pageLength: 5,
        start: 1,
      });
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results.length).toBeGreaterThan(0);
      // Fetch content for the first result — this is what export_tabular does
      const firstUri = result.results[0].uri;
      const doc = await documents.get(firstUri);
      expect(doc.content).not.toBeNull();
      expect(doc.uri).toBe(firstUri);
    });

    it("can paginate search results", async () => {
      const page1 = await search.search({ q: "", collection: "wikipedia-articles", pageLength: 1, start: 1 });
      const page2 = await search.search({ q: "", collection: "wikipedia-articles", pageLength: 1, start: 2 });
      // URIs on different pages should be different (assuming > 1 document)
      if (page1.results.length > 0 && page2.results.length > 0) {
        expect(page1.results[0].uri).not.toBe(page2.results[0].uri);
      }
    });
  });

  describe("timeseries_query (ml_timeseries_query)", () => {
    // ml_timeseries_query is implemented in tools/quicksight.ts as an Optic query with
    // date bucketing. The underlying client is search.values() + Optic.
    // We test the constituent parts that the tool uses.
    it("search returns total count for the seeded collection", async () => {
      const result = await search.search({ q: "", collection: "wikipedia-articles", pageLength: 0 });
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it("values query with direction returns ordered results", async () => {
      const result = await search.values("collections", {
        options: OPTIONS_NAME,
        direction: "descending",
      });
      expect(Array.isArray(result.values)).toBe(true);
      // Values should be sorted by frequency descending (if multiple collections)
      if (result.values.length >= 2) {
        expect(result.values[0].frequency).toBeGreaterThanOrEqual(result.values[1].frequency);
      }
    });
  });
});
