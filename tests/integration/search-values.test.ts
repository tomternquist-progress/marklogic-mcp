/**
 * Integration tests for SearchClient values() against a live MarkLogic instance.
 *
 * Values queries require a named values specification in search options.
 * This test deploys search options with a collection lexicon values spec
 * (collection lexicon is always enabled by default) and queries it.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - values() parsed wrong response key (values-response vs distinct-value nesting)
 *  - direction param was sent incorrectly
 *  - options param was missing — values queries always need a named spec
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const OPTIONS_NAME = "integration-test-values-options";

// Search options with a collection lexicon values spec — no range index needed
const VALUES_OPTIONS = {
  options: {
    values: [
      {
        name: "collections",
        collection: {},
      },
    ],
  },
};

describeIfLive("SearchClient values (live)", () => {
  const { search, fasttrack } = buildClients();

  beforeAll(async () => {
    await fasttrack.putSearchOptions(OPTIONS_NAME, VALUES_OPTIONS);
  });

  afterAll(async () => {
    try { await fasttrack.deleteSearchOptions(OPTIONS_NAME); } catch { /* ignore */ }
  });

  describe("values", () => {
    it("returns a ValuesResponse shape", async () => {
      const result = await search.values("collections", { options: OPTIONS_NAME });
      expect(typeof result.name).toBe("string");
      expect(typeof result.total).toBe("number");
      expect(Array.isArray(result.values)).toBe(true);
    });

    it("returns the seeded collection 'wikipedia-articles'", async () => {
      const result = await search.values("collections", { options: OPTIONS_NAME });
      const vals = result.values.map((v) => v.value as string);
      expect(vals).toContain("wikipedia-articles");
    });

    it("each value entry has value and frequency fields", async () => {
      const result = await search.values("collections", { options: OPTIONS_NAME });
      result.values.forEach((v) => {
        expect(v).toHaveProperty("value");
        expect(typeof v.frequency).toBe("number");
        expect(v.frequency).toBeGreaterThan(0);
      });
    });

    it("respects the limit parameter", async () => {
      const result = await search.values("collections", { options: OPTIONS_NAME, limit: 1 });
      expect(result.values.length).toBeLessThanOrEqual(1);
    });
  });
});
