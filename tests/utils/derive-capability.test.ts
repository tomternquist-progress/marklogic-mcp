import { describe, it, expect } from "vitest";
import { z } from "zod";
import { deriveCapability, knownParamKeys } from "../../src/utils/derive-capability.js";

describe("deriveCapability", () => {
  it("derives name, description, and params from a Zod shape", () => {
    const shape = {
      question: z.string().describe("the question"),
      collection: z.string().optional().describe("optional scope"),
    };
    const cap = deriveCapability("ml_test", "Test tool", shape);
    expect(cap.name).toBe("ml_test");
    expect(cap.description).toBe("Test tool");
    expect(cap.params).toHaveLength(2);
    const q = cap.params.find((p) => p.name === "question");
    expect(q?.type).toBe("string");
    expect(q?.description).toBe("the question");
  });

  it("marks optional params with ?", () => {
    const cap = deriveCapability("t", "d", { x: z.string().optional() });
    expect(cap.params[0].type).toBe("string?");
  });

  it("renders enum types as a union of literals", () => {
    const cap = deriveCapability("t", "d", {
      mode: z.enum(["strict", "balanced", "broad"]).optional(),
    });
    expect(cap.params[0].type).toBe("'strict' | 'balanced' | 'broad'?");
  });

  it("renders arrays with [] suffix", () => {
    const cap = deriveCapability("t", "d", {
      tags: z.array(z.string()).optional(),
    });
    expect(cap.params[0].type).toBe("string[]?");
  });

  it("renders records/objects as 'object'", () => {
    const cap = deriveCapability("t", "d", { payload: z.record(z.unknown()) });
    expect(cap.params[0].type).toBe("object");
  });

  it("extracts descriptions through optional/default wrappers", () => {
    const cap = deriveCapability("t", "d", {
      limit: z.number().optional().describe("Cap rows sampled"),
    });
    expect(cap.params[0].description).toBe("Cap rows sampled");
  });
});

describe("knownParamKeys", () => {
  it("returns the keys of the schema as a Set", () => {
    const keys = knownParamKeys({ a: z.string(), b: z.number().optional() });
    expect(keys.has("a")).toBe(true);
    expect(keys.has("b")).toBe(true);
    expect(keys.has("c")).toBe(false);
    expect(keys.size).toBe(2);
  });
});
