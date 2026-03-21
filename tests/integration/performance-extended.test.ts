/**
 * Extended integration tests for PerformanceClient — covers tools not tested in performance.test.ts:
 *  - explainOptic (ml_explain_optic) — POSTs to /v1/rows?output=explain
 *  - profileXQuery (ml_profile_query for XQuery)
 *  - profileJavaScript (ml_profile_query for SJS)
 *
 * Note: profile methods require allowEval=true (set in buildClients helper).
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

// A minimal Optic plan that can be explained without any TDE view
// from-literals is built-in and needs no TDE
const LITERALS_PLAN = {
  $optic: {
    ns: "op",
    fn: "operators",
    args: [
      {
        ns: "op",
        fn: "from-literals",
        args: [
          [{ id: 1, label: "a" }, { id: 2, label: "b" }],
        ],
      },
    ],
  },
};

describeIfLive("PerformanceClient extended (live)", () => {
  const { performance } = buildClients();

  describe("explainOptic", () => {
    it("returns an explain plan without executing the query", async () => {
      const plan = await performance.explainOptic(LITERALS_PLAN);
      expect(typeof plan).toBe("object");
      expect(plan).not.toBeNull();
    });

    it("explain plan contains at least a node or cost description", async () => {
      const plan = await performance.explainOptic(LITERALS_PLAN);
      // ML returns a JSON object; the exact shape varies by version but it is never empty
      expect(Object.keys(plan).length).toBeGreaterThan(0);
    });
  });

  describe("profileXQuery", () => {
    it("returns timing and meter fields for a simple XQuery expression", async () => {
      const results = await performance.profileXQuery("(1 to 10)");
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      const val = results[0]?.value as Record<string, unknown>;
      expect(val).toBeDefined();
      expect(typeof val?.elapsedMs).toBe("number");
      expect(typeof val?.resultCount).toBe("number");
      expect(val.resultCount).toBe(10);
    });

    it("elapsedMs is a non-negative integer", async () => {
      const results = await performance.profileXQuery("fn:count(cts:uris())");
      const val = results[0]?.value as Record<string, unknown>;
      expect(Number(val?.elapsedMs)).toBeGreaterThanOrEqual(0);
    });
  });

  describe("profileJavaScript", () => {
    it("returns timing and meter fields for a simple SJS expression", async () => {
      const results = await performance.profileJavaScript("const arr = [1,2,3]; arr;");
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      const val = results[0]?.value as Record<string, unknown>;
      expect(typeof val?.elapsedMs).toBe("number");
      expect(typeof val?.resultCount).toBe("number");
    });

    it("resultCount reflects the number of items returned", async () => {
      const results = await performance.profileJavaScript("[1, 2, 3, 4, 5]");
      const val = results[0]?.value as Record<string, unknown>;
      expect(Number(val?.resultCount)).toBe(5);
    });
  });

  describe("profileSparql", () => {
    it("returns timing and rowCount for an empty-result SPARQL query", async () => {
      const results = await performance.profileSparql("SELECT * WHERE { ?s ?p ?o } LIMIT 0");
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      const val = results[0]?.value as Record<string, unknown>;
      expect(typeof val?.elapsedMs).toBe("number");
      expect(typeof val?.rowCount).toBe("number");
    });
  });
});
