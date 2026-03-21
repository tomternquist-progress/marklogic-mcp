/**
 * Integration tests for SchemaClient against a live MarkLogic instance.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - listCollections() had 3 bugs: wrong XQuery constructor (object-node{}),
 *    wrong estimate function (xdmp:estimate vs cts:estimate), and silent catch
 *    hiding all errors so the tool always returned [] (all fixed)
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

describeIfLive("SchemaClient (live)", () => {
  const { schema } = buildClients();

  describe("listCollections", () => {
    it("returns a non-empty array (not always [])", async () => {
      // Regression: three bugs caused this to always return [] silently.
      const collections = await schema.listCollections();
      expect(Array.isArray(collections)).toBe(true);
      expect(collections.length).toBeGreaterThan(0);
    });

    it("each collection has a name (string) and count (number)", async () => {
      const collections = await schema.listCollections();
      for (const c of collections) {
        expect(typeof c.name).toBe("string");
        expect(c.name.length).toBeGreaterThan(0);
        expect(typeof c.count).toBe("number");
        expect(c.count).toBeGreaterThanOrEqual(0);
      }
    });

    it("collections are sorted descending by count", async () => {
      const collections = await schema.listCollections();
      for (let i = 1; i < collections.length; i++) {
        expect(collections[i - 1].count).toBeGreaterThanOrEqual(collections[i].count);
      }
    });
  });

  describe("getTdeSchemas", () => {
    it("returns an array of TDE URIs", async () => {
      const tdes = await schema.getTdeSchemas();
      expect(Array.isArray(tdes)).toBe(true);
    });
  });

  describe("listIndexes", () => {
    it("returns an array without error", async () => {
      const indexes = await schema.listIndexes("Documents");
      expect(Array.isArray(indexes)).toBe(true);
    });
  });
});
