/**
 * Integration tests for SearchClient against a live MarkLogic instance.
 *
 * Relies on seed data inserted by scripts/integration-seed.mjs:
 *  - /wikipedia/climate-change.json       in collection "wikipedia-articles"
 *  - /wikipedia/artificial-intelligence.json in collection "wikipedia-articles"
 *
 * Catches bugs that mock-based unit tests miss:
 *  - search() normalizeSearchResponse had wrong field names (page-length vs pageLength)
 *  - qbe() Accept header mismatch caused HTTP 406
 *  - suggest() returned undefined instead of [] when ML returned no suggestions key
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

describeIfLive("SearchClient (live)", () => {
  const { search } = buildClients();

  describe("search", () => {
    it("returns a SearchResponse shape for an empty query", async () => {
      const res = await search.search({ pageLength: 1 });
      expect(typeof res.total).toBe("number");
      expect(typeof res.start).toBe("number");
      expect(typeof res.pageLength).toBe("number");
      expect(Array.isArray(res.results)).toBe(true);
    });

    it("finds seeded documents by collection", async () => {
      const res = await search.search({ collection: "wikipedia-articles", pageLength: 10 });
      expect(res.total).toBeGreaterThanOrEqual(2);
      const uris = res.results.map((r) => r.uri);
      expect(uris).toContain("/wikipedia/climate-change.json");
      expect(uris).toContain("/wikipedia/artificial-intelligence.json");
    });

    it("each result has a string uri", async () => {
      const res = await search.search({ collection: "wikipedia-articles", pageLength: 10 });
      res.results.forEach((r) => {
        expect(typeof r.uri).toBe("string");
        expect(r.uri.length).toBeGreaterThan(0);
      });
    });

    it("keyword search narrows results", async () => {
      const res = await search.search({ q: "climate", pageLength: 10 });
      expect(res.total).toBeGreaterThanOrEqual(1);
      const uris = res.results.map((r) => r.uri);
      expect(uris).toContain("/wikipedia/climate-change.json");
    });

    it("pageLength=0 returns total without results", async () => {
      const res = await search.search({ collection: "wikipedia-articles", pageLength: 0 });
      expect(res.total).toBeGreaterThanOrEqual(2);
      expect(res.results).toHaveLength(0);
    });
  });

  describe("qbe", () => {
    it("finds a document by exact field value", async () => {
      // Regression: qbe() Accept header mismatch caused HTTP 406 on some ML versions
      const res = await search.qbe({ title: "Climate change" });
      expect(res.total).toBeGreaterThanOrEqual(1);
      const uris = res.results.map((r) => r.uri);
      expect(uris).toContain("/wikipedia/climate-change.json");
    });

    it("returns a valid SearchResponse shape", async () => {
      const res = await search.qbe({ source: "wikipedia" });
      expect(typeof res.total).toBe("number");
      expect(Array.isArray(res.results)).toBe(true);
    });
  });

  describe("suggest", () => {
    it("returns an array (never undefined)", async () => {
      // Regression: returned undefined when ML omitted the suggestions key
      const suggestions = await search.suggest("clim");
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });
});
