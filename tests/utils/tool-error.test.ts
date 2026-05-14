import { describe, it, expect } from "vitest";
import {
  closestMatch,
  editDistance,
  makeToolError,
  newCorrelationId,
} from "../../src/utils/tool-error.js";

describe("editDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(editDistance("hurricane", "hurricane")).toBe(0);
  });
  it("counts substitutions", () => {
    expect(editDistance("hurricane", "huxxicane")).toBe(2);
  });
  it("counts insertions/deletions", () => {
    expect(editDistance("hurricane", "huricane")).toBe(1);
  });
  it("counts adjacent transpositions as a single edit", () => {
    expect(editDistance("hurricane", "hurricaen")).toBe(1);
  });
});

describe("closestMatch", () => {
  const names = ["ml_search", "ml_answer_query", "ml_query_recipe", "ml_capabilities"];

  it("returns the closest tool name for a typo", () => {
    expect(closestMatch("ml_caplabilities", names)).toBe("ml_capabilities");
  });
  it("returns the exact match when present", () => {
    expect(closestMatch("ml_search", names)).toBe("ml_search");
  });
  it("returns undefined when nothing is close", () => {
    expect(closestMatch("totally_unrelated_name", names)).toBeUndefined();
  });
  it("respects the optional maxDistance override", () => {
    expect(closestMatch("zzzz", ["abcd", "efgh"], 1)).toBeUndefined();
  });
});

describe("makeToolError", () => {
  it("produces an isError envelope with structured JSON", () => {
    const err = makeToolError({
      code: "UNKNOWN_NAME",
      class: "user_input",
      message: "Unknown recipe",
      hint: "Did you mean foo?",
      details: { closest: "foo" },
      exampleValid: { recipe: "foo" },
    });
    expect(err.isError).toBe(true);
    const parsed = JSON.parse(err.content[0].text);
    expect(parsed.error.code).toBe("UNKNOWN_NAME");
    expect(parsed.error.class).toBe("user_input");
    expect(parsed.error.hint).toContain("Did you mean");
    expect(parsed.error.exampleValid).toEqual({ recipe: "foo" });
  });

  it("carries the correlation ID when present", () => {
    const err = makeToolError({
      code: "INTERNAL",
      class: "internal",
      message: "boom",
      hint: "retry",
      correlationId: "mlq_abc",
    });
    const parsed = JSON.parse(err.content[0].text);
    expect(parsed.error.correlationId).toBe("mlq_abc");
  });
});

describe("newCorrelationId", () => {
  it("returns a non-empty string each call", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).toMatch(/^mlq_/);
    expect(b).toMatch(/^mlq_/);
    expect(a).not.toBe(b);
  });
});
