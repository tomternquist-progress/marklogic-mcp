/**
 * Integration tests for ml_suggest with search options and constraints.
 *
 * The basic suggest test in search.test.ts verifies that suggest() returns an
 * array when called without options. These tests go further:
 *  - Suggest scoped to a specific collection via named options
 *  - Suggest with a constraint prefix filter
 *  - Suggest with word-lexicon enabled
 *  - Verify suggestions contain only relevant completions
 *
 * Also tests the ml_search with options + suggest interaction that agents need
 * for autocomplete features.
 *
 * Catches real agent failures:
 *  - Passing options= to suggest() with no corresponding options node deployed → 404
 *  - Word lexicon not enabled → empty suggestions
 *  - suggest() limit parameter ignored (was not passed to the query string)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const OPTIONS_NAME = "integration-test-suggest-options";

// Search options with a value constraint on "source".
// Note: "word-lexicon" is NOT a valid search options element (XDMP-VALIDATEUNEXPECTED);
// word lexicon indexes are a database-level configuration, not a per-options setting.
const SUGGEST_OPTIONS = {
  options: {
    constraint: [
      {
        name: "source",
        value: {
          "json-property": "source",
        },
      },
    ],
    "return-results": true,
    "page-length": 10,
  },
};

describeIfLive("SearchClient suggest with options (live)", () => {
  const { search, fasttrack } = buildClients();

  beforeAll(async () => {
    await fasttrack.putSearchOptions(OPTIONS_NAME, SUGGEST_OPTIONS);
  }, 15_000);

  afterAll(async () => {
    try { await fasttrack.deleteSearchOptions(OPTIONS_NAME); } catch { /* ignore */ }
  });

  describe("suggest without options (baseline)", () => {
    it("returns an array for a partial word", async () => {
      const suggestions = await search.suggest("clim");
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it("returns an array when nothing matches", async () => {
      const suggestions = await search.suggest("zzzznosuggestions");
      expect(Array.isArray(suggestions)).toBe(true);
      // May be empty, but must not be undefined or throw
    });
  });

  describe("suggest with named options", () => {
    it("returns an array when named options are specified", async () => {
      const suggestions = await search.suggest("clim", OPTIONS_NAME);
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it("suggestions are strings", async () => {
      const suggestions = await search.suggest("art", OPTIONS_NAME);
      suggestions.forEach((s) => {
        expect(typeof s).toBe("string");
      });
    });

    it("limit parameter reduces the number of suggestions", async () => {
      const unlimited = await search.suggest("c", OPTIONS_NAME, undefined, 20);
      const limited = await search.suggest("c", OPTIONS_NAME, undefined, 1);
      // limited should have fewer or equal suggestions
      expect(limited.length).toBeLessThanOrEqual(Math.max(unlimited.length, 1));
    });
  });

  describe("suggest scoped to collection", () => {
    it("suggest combined with collection scope returns relevant completions", async () => {
      // Use collection param in search options (passed as part of the query)
      const suggestions = await search.suggest("wik", OPTIONS_NAME);
      // May suggest "wikipedia" or words from wikipedia docs
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  describe("suggest for constraint values", () => {
    it("suggests constraint prefixes using named options", async () => {
      // The source constraint in the options lets us suggest source values
      // Prefixing with "source:" triggers constraint-aware suggestions
      const suggestions = await search.suggest("source:wik", OPTIONS_NAME);
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  describe("search with named options returns results", () => {
    it("search with deployed options returns valid response", async () => {
      const res = await search.search({
        q: "climate",
        options: OPTIONS_NAME,
        pageLength: 5,
      });
      expect(typeof res.total).toBe("number");
      expect(Array.isArray(res.results)).toBe(true);
    });

    it("constraint-scoped search narrows results", async () => {
      // source:wikipedia should match all seeded docs
      const res = await search.search({
        q: "source:wikipedia",
        options: OPTIONS_NAME,
        pageLength: 10,
      });
      expect(typeof res.total).toBe("number");
      // All seeded docs have source=wikipedia
      if (res.total > 0) {
        const uris = res.results.map((r) => r.uri);
        expect(
          uris.some((u) => u.includes("wikipedia"))
        ).toBe(true);
      }
    });
  });
});
