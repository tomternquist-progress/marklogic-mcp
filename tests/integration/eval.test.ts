/**
 * Integration tests for EvalClient against a live MarkLogic instance.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - vars serialization: ML /v1/eval requires vars as a single JSON object,
 *    not individual URL params — vars were silently ignored before this fix
 *  - multipart/mixed parsing: EvalResult[] shape was wrong for some XQuery types
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

describeIfLive("EvalClient (live)", () => {
  const { eval: evalClient } = buildClients();

  describe("evalXQuery", () => {
    it("evaluates a simple arithmetic expression", async () => {
      const results = await evalClient.evalXQuery("1 + 1");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].value).toBe(2);
    });

    it("evaluates a string expression", async () => {
      const results = await evalClient.evalXQuery('"hello"');
      expect(results[0].value).toBe("hello");
    });

    it("passes external variables correctly", async () => {
      // Regression: vars were passed as individual URL params (silently ignored).
      // Now serialized as a single vars={"x":5} param which ML accepts.
      const results = await evalClient.evalXQuery(
        "declare variable $x as xs:integer external; $x * 2",
        { x: 5 }
      );
      expect(results[0].value).toBe(10);
    });

    it("returns multiple values for a sequence", async () => {
      const results = await evalClient.evalXQuery("(1, 2, 3)");
      expect(results.length).toBe(3);
      expect(results.map((r) => r.value)).toEqual([1, 2, 3]);
    });

    it("each result has a value and primitive field", async () => {
      const results = await evalClient.evalXQuery("42");
      expect(results[0]).toHaveProperty("value");
      expect(results[0]).toHaveProperty("primitive");
    });
  });

  describe("evalJavaScript", () => {
    it("evaluates a simple arithmetic expression", async () => {
      const results = await evalClient.evalJavaScript("1 + 1");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].value).toBe(2);
    });

    it("passes external variables correctly", async () => {
      // Regression: same vars serialization bug as XQuery.
      // In ML SJS eval, external vars are available as top-level identifiers.
      const results = await evalClient.evalJavaScript(
        "x * 3",
        { x: 7 }
      );
      expect(results[0].value).toBe(21);
    });

    it("can query the document store", async () => {
      const results = await evalClient.evalJavaScript(
        'cts.uriMatch("/wikipedia/*.json")'
      );
      expect(results.length).toBeGreaterThanOrEqual(2);
      const values = results.map((r) => r.value as string);
      expect(values).toContain("/wikipedia/climate-change.json");
    });
  });
});
