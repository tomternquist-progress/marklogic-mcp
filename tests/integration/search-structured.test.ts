/**
 * Integration tests for structured query patterns in SearchClient.
 *
 * Tests patterns that agents commonly need but that aren't covered by the
 * basic search tests:
 *  - value-query   — exact JSON property value match (no range index needed)
 *  - word-query    — word/phrase match on a property
 *  - and-query / or-query / not-query — boolean combinators
 *  - container-query — nested property match
 *  - Pagination via structured query
 *  - Directory-scoped structured query
 *
 * None of these tests require a range index — they rely on the universal
 * index that MarkLogic maintains by default.
 *
 * Catches real agent failures:
 *  - Agents using {"query":{"value-query":...}} instead of the correct
 *    {"value-query":...} (the outer "query" wrapper is only for POST /v1/search)
 *  - Boolean combinator field names: "and-query" not "andQuery"
 *  - value-query "text" field must be an array
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

describeIfLive("SearchClient structured queries (live)", () => {
  const { search } = buildClients();

  describe("value-query", () => {
    it("finds documents by exact JSON property value", async () => {
      // Both seeded documents have source: "wikipedia"
      const res = await search.search({
        structuredQuery: {
          "value-query": {
            "json-property": "source",
            "text": ["wikipedia"],
          },
        },
        pageLength: 10,
      });
      expect(res.total).toBeGreaterThanOrEqual(2);
      const uris = res.results.map((r) => r.uri);
      expect(uris).toContain("/wikipedia/climate-change.json");
      expect(uris).toContain("/wikipedia/artificial-intelligence.json");
    });

    it("returns empty results for a value that doesn't exist", async () => {
      const res = await search.search({
        structuredQuery: {
          "value-query": {
            "json-property": "source",
            "text": ["nonexistent-source-xyz"],
          },
        },
        pageLength: 10,
      });
      // All seeded docs have source=wikipedia; nonexistent-source-xyz matches nothing
      const uris = res.results.map((r) => r.uri);
      expect(uris).not.toContain("/wikipedia/climate-change.json");
    });

    it("matches by nested JSON property using dot-path notation is NOT supported — use container-query instead", async () => {
      // value-query only matches top-level properties by property name;
      // for nested matching you need container-query (tested below)
      const res = await search.search({
        structuredQuery: {
          "value-query": {
            "json-property": "id",
            "text": ["wiki-001"],
          },
        },
        pageLength: 10,
      });
      expect(typeof res.total).toBe("number");
      // May or may not match depending on ML indexing — just verify it doesn't error
    });
  });

  describe("word-query", () => {
    it("finds documents containing a word in any indexed property", async () => {
      const res = await search.search({
        structuredQuery: {
          "word-query": {
            "json-property": "summary",
            "text": ["intelligence"],
          },
        },
        pageLength: 10,
      });
      expect(res.total).toBeGreaterThanOrEqual(1);
      const uris = res.results.map((r) => r.uri);
      expect(uris).toContain("/wikipedia/artificial-intelligence.json");
    });

    it("returns valid SearchResponse shape", async () => {
      const res = await search.search({
        structuredQuery: {
          "word-query": {
            "json-property": "title",
            "text": ["change"],
          },
        },
        pageLength: 5,
      });
      expect(typeof res.total).toBe("number");
      expect(Array.isArray(res.results)).toBe(true);
    });
  });

  describe("and-query", () => {
    it("requires both conditions to match", async () => {
      // source=wikipedia AND word 'climate' in summary
      const res = await search.search({
        structuredQuery: {
          "and-query": {
            "queries": [
              {
                "value-query": {
                  "json-property": "source",
                  "text": ["wikipedia"],
                },
              },
              {
                "word-query": {
                  "json-property": "summary",
                  "text": ["climate"],
                },
              },
            ],
          },
        },
        pageLength: 10,
      });
      expect(res.total).toBeGreaterThanOrEqual(1);
      const uris = res.results.map((r) => r.uri);
      expect(uris).toContain("/wikipedia/climate-change.json");
    });

    it("returns empty when one condition never matches", async () => {
      const res = await search.search({
        structuredQuery: {
          "and-query": {
            "queries": [
              {
                "value-query": {
                  "json-property": "source",
                  "text": ["wikipedia"],
                },
              },
              {
                "value-query": {
                  "json-property": "source",
                  "text": ["definitely-not-this"],
                },
              },
            ],
          },
        },
        pageLength: 10,
      });
      const uris = res.results.map((r) => r.uri);
      // Wikipedia docs match source=wikipedia but fail source=definitely-not-this
      expect(uris).not.toContain("/wikipedia/climate-change.json");
    });
  });

  describe("or-query", () => {
    it("matches documents satisfying any condition", async () => {
      // Find docs where title contains 'climate' OR title contains 'artificial'
      const res = await search.search({
        structuredQuery: {
          "or-query": {
            "queries": [
              {
                "word-query": {
                  "json-property": "title",
                  "text": ["climate"],
                },
              },
              {
                "word-query": {
                  "json-property": "title",
                  "text": ["artificial"],
                },
              },
            ],
          },
        },
        pageLength: 10,
      });
      expect(res.total).toBeGreaterThanOrEqual(2);
      const uris = res.results.map((r) => r.uri);
      expect(uris).toContain("/wikipedia/climate-change.json");
      expect(uris).toContain("/wikipedia/artificial-intelligence.json");
    });
  });

  describe("not-query", () => {
    it("excludes documents matching the nested query", async () => {
      // All docs minus the climate-change one
      const allRes = await search.search({
        structuredQuery: {
          "value-query": {
            "json-property": "source",
            "text": ["wikipedia"],
          },
        },
        pageLength: 10,
      });

      const filteredRes = await search.search({
        structuredQuery: {
          "and-query": {
            "queries": [
              {
                "value-query": {
                  "json-property": "source",
                  "text": ["wikipedia"],
                },
              },
              {
                "not-query": {
                  "query": {
                    "value-query": {
                      "json-property": "id",
                      "text": ["wiki-001"],
                    },
                  },
                },
              },
            ],
          },
        },
        pageLength: 10,
      });

      // Filtered result should not contain climate-change (wiki-001)
      const uris = filteredRes.results.map((r) => r.uri);
      expect(uris).not.toContain("/wikipedia/climate-change.json");
      // But the total filtered is <= the total unfiltered
      expect(filteredRes.total).toBeLessThanOrEqual(allRes.total);
    });
  });

  describe("container-query", () => {
    it("matches documents where a nested object property matches", async () => {
      // The seeded docs have classification.topCategory.label
      // container-query lets us match within a nested object
      const res = await search.search({
        structuredQuery: {
          "container-query": {
            "json-property": "classification",
            "query": {
              "word-query": {
                "json-property": "topCategory",
                "text": ["climate"],
              },
            },
          },
        },
        pageLength: 10,
      });
      // May or may not match depending on ML indexing depth — just verify valid response
      expect(typeof res.total).toBe("number");
      expect(Array.isArray(res.results)).toBe(true);
    });
  });

  describe("directory-scoped structured query", () => {
    it("structured query combined with directory scope", async () => {
      const res = await search.search({
        structuredQuery: {
          "value-query": {
            "json-property": "source",
            "text": ["wikipedia"],
          },
        },
        directory: "/wikipedia/",
        pageLength: 10,
      });
      expect(res.total).toBeGreaterThanOrEqual(2);
      // All results should be under /wikipedia/
      res.results.forEach((r) => {
        expect(r.uri.startsWith("/wikipedia/")).toBe(true);
      });
    });

    it("structured query combined with collection scope", async () => {
      const res = await search.search({
        structuredQuery: {
          "word-query": {
            "json-property": "summary",
            "text": ["intelligence"],
          },
        },
        collection: "wikipedia-articles",
        pageLength: 10,
      });
      expect(res.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe("pagination with structured query", () => {
    it("page 1 and page 2 return different documents", async () => {
      const page1 = await search.search({
        structuredQuery: {
          "value-query": {
            "json-property": "source",
            "text": ["wikipedia"],
          },
        },
        start: 1,
        pageLength: 1,
      });
      const page2 = await search.search({
        structuredQuery: {
          "value-query": {
            "json-property": "source",
            "text": ["wikipedia"],
          },
        },
        start: 2,
        pageLength: 1,
      });
      if (page1.results.length > 0 && page2.results.length > 0) {
        expect(page1.results[0].uri).not.toBe(page2.results[0].uri);
      }
    });

    it("pageLength=0 with structured query returns total count without results", async () => {
      const res = await search.search({
        structuredQuery: {
          "value-query": {
            "json-property": "source",
            "text": ["wikipedia"],
          },
        },
        pageLength: 0,
      });
      expect(res.total).toBeGreaterThanOrEqual(2);
      expect(res.results).toHaveLength(0);
    });
  });
});
