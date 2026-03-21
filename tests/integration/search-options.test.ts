/**
 * Integration tests for FastTrackClient (search options) against a live MarkLogic instance.
 *
 * Tests the full lifecycle: list → put → get → delete.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - listSearchOptions() had two response shape fallbacks; verifies the right one
 *    is selected for ML 12
 *  - putSearchOptions() Content-Type or body format rejected by ML
 *  - getSearchOptions() returned wrong shape after put
 */

import { describe, it, expect, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const OPTIONS_NAME = "integration-test-options";

// Minimal valid search options document
const TEST_OPTIONS = {
  options: {
    "return-results": true,
    "page-length": 10,
  },
};

describeIfLive("FastTrackClient / search options (live)", () => {
  const { fasttrack } = buildClients();

  afterAll(async () => {
    try { await fasttrack.deleteSearchOptions(OPTIONS_NAME); } catch { /* ignore */ }
  });

  describe("listSearchOptions", () => {
    it("returns an array (never undefined)", async () => {
      const opts = await fasttrack.listSearchOptions();
      expect(Array.isArray(opts)).toBe(true);
    });

    it("each entry has name and uri fields", async () => {
      const opts = await fasttrack.listSearchOptions();
      opts.forEach((o) => {
        expect(typeof o.name).toBe("string");
        expect(typeof o.uri).toBe("string");
      });
    });
  });

  describe("putSearchOptions", () => {
    it("deploys search options without error", async () => {
      await expect(
        fasttrack.putSearchOptions(OPTIONS_NAME, TEST_OPTIONS)
      ).resolves.not.toThrow();
    });
  });

  describe("getSearchOptions", () => {
    it("retrieves deployed options as an object", async () => {
      await fasttrack.putSearchOptions(OPTIONS_NAME, TEST_OPTIONS);
      const result = await fasttrack.getSearchOptions(OPTIONS_NAME);
      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
    });
  });

  describe("listSearchOptions (after deploy)", () => {
    it("includes the deployed options by name", async () => {
      await fasttrack.putSearchOptions(OPTIONS_NAME, TEST_OPTIONS);
      const opts = await fasttrack.listSearchOptions();
      const names = opts.map((o) => o.name);
      expect(names).toContain(OPTIONS_NAME);
    });
  });

  describe("deleteSearchOptions", () => {
    it("removes search options without error", async () => {
      await fasttrack.putSearchOptions(OPTIONS_NAME, TEST_OPTIONS);
      await expect(
        fasttrack.deleteSearchOptions(OPTIONS_NAME)
      ).resolves.not.toThrow();
    });

    it("is no longer listed after deletion", async () => {
      await fasttrack.putSearchOptions(OPTIONS_NAME, TEST_OPTIONS);
      await fasttrack.deleteSearchOptions(OPTIONS_NAME);
      const opts = await fasttrack.listSearchOptions();
      const names = opts.map((o) => o.name);
      expect(names).not.toContain(OPTIONS_NAME);
    });
  });
});
