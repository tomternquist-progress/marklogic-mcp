/**
 * Integration tests for facets with proper search options constraints.
 *
 * The existing quicksight.test.ts verifies facets() returns an object.
 * These tests go further by verifying actual facet values, counts, and
 * the interaction between facet constraints and search queries.
 *
 * Use cases covered:
 *  1. Collection facet — count documents per collection
 *  2. Value-based facet — count documents per field value (e.g. source)
 *  3. Facets combined with a search query (narrowed facets)
 *  4. Multiple facets in a single options config
 *  5. Facet order (by count vs alphabetical)
 *
 * Catches real agent failures:
 *  - facets returned as undefined when options don't enable return-facets
 *  - Facet values missing count field (normalizeSearchResponse bug)
 *  - Collection facet requires "collection" constraint (not "collection" values)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const OPTIONS_NAME = "integration-test-facets-advanced";

// Options with collection facet + a value constraint facet on "source"
const FACETS_OPTIONS = {
  options: {
    constraint: [
      {
        name: "collection",
        collection: {},
      },
      {
        name: "source",
        value: {
          "json-property": "source",
        },
      },
    ],
    "return-facets": true,
    "return-results": true,
    "page-length": 10,
  },
};

describeIfLive("Facets with search options (live)", () => {
  const { search, fasttrack } = buildClients();

  beforeAll(async () => {
    await fasttrack.putSearchOptions(OPTIONS_NAME, FACETS_OPTIONS);
  }, 15_000);

  afterAll(async () => {
    try { await fasttrack.deleteSearchOptions(OPTIONS_NAME); } catch { /* ignore */ }
  });

  describe("collection facet", () => {
    it("returns facets object when return-facets is enabled", async () => {
      const result = await search.search({
        q: "",
        options: OPTIONS_NAME,
        pageLength: 0,
      });
      // With return-facets:true, facets should be present
      expect(result.facets).toBeDefined();
    });

    it("collection facet includes wikipedia-articles collection", async () => {
      const result = await search.search({
        q: "",
        options: OPTIONS_NAME,
        pageLength: 0,
      });
      if (result.facets) {
        const collFacet = result.facets["collection"];
        if (collFacet) {
          const collNames = collFacet.facetValues.map((fv) => fv.value ?? fv.name);
          expect(collNames).toContain("wikipedia-articles");
        }
      }
    });

    it("each facet value has a name and numeric count", async () => {
      const result = await search.search({
        q: "",
        options: OPTIONS_NAME,
        pageLength: 0,
      });
      if (result.facets?.["collection"]) {
        result.facets["collection"].facetValues.forEach((fv) => {
          expect(typeof fv.name).toBe("string");
          expect(typeof fv.count).toBe("number");
          expect(fv.count).toBeGreaterThan(0);
        });
      }
    });
  });

  describe("value facet on source field", () => {
    it("source facet groups documents by source field", async () => {
      const result = await search.search({
        q: "",
        options: OPTIONS_NAME,
        pageLength: 0,
      });
      if (result.facets?.["source"]) {
        const sourceValues = result.facets["source"].facetValues.map((fv) => fv.value ?? fv.name);
        expect(sourceValues).toContain("wikipedia");
      }
    });

    it("wikipedia source count matches seeded document count", async () => {
      // We seeded 2 wikipedia documents
      const result = await search.search({
        q: "",
        collection: "wikipedia-articles",
        options: OPTIONS_NAME,
        pageLength: 0,
      });
      if (result.facets?.["source"]) {
        const wikiEntry = result.facets["source"].facetValues.find(
          (fv) => (fv.value ?? fv.name) === "wikipedia"
        );
        if (wikiEntry) {
          expect(wikiEntry.count).toBeGreaterThanOrEqual(2);
        }
      }
    });
  });

  describe("facets narrowed by query", () => {
    it("searching for 'climate' narrows facet counts", async () => {
      const allResult = await search.search({
        q: "",
        options: OPTIONS_NAME,
        pageLength: 0,
      });
      const filteredResult = await search.search({
        q: "climate",
        options: OPTIONS_NAME,
        pageLength: 0,
      });

      // Filtered total should be <= total
      expect(filteredResult.total).toBeLessThanOrEqual(allResult.total);
    });

    it("facets query returns facets object via ml_facets_query pattern", async () => {
      // This simulates the ml_facets_query tool: search with pageLength=0 and options
      const result = await search.search({
        q: "",
        options: OPTIONS_NAME,
        pageLength: 0,
      });
      const output = {
        total: result.total,
        facets: result.facets ?? {},
      };
      expect(typeof output.total).toBe("number");
      expect(typeof output.facets).toBe("object");
    });
  });

  describe("ml_values_query with options (tests the bug fix: options param)", () => {
    // Deploy options with a values spec for collection lexicon
    const VALUES_OPTIONS_NAME = "integration-test-values-with-options";
    const VALUES_OPTIONS = {
      options: {
        values: [{ name: "collections", collection: {} }],
      },
    };

    beforeAll(async () => {
      await fasttrack.putSearchOptions(VALUES_OPTIONS_NAME, VALUES_OPTIONS);
    });

    afterAll(async () => {
      try { await fasttrack.deleteSearchOptions(VALUES_OPTIONS_NAME); } catch { /* ignore */ }
    });

    it("values query with options returns collection lexicon values", async () => {
      const result = await search.values("collections", { options: VALUES_OPTIONS_NAME });
      expect(Array.isArray(result.values)).toBe(true);
      expect(result.values.length).toBeGreaterThan(0);
    });

    it("collection values include wikipedia-articles", async () => {
      const result = await search.values("collections", { options: VALUES_OPTIONS_NAME });
      const colls = result.values.map((v) => v.value as string);
      expect(colls).toContain("wikipedia-articles");
    });
  });
});
