import { describe, it, expect } from "vitest";
import {
  closestKnownValue,
  singularize,
  stripFiller,
  titleCase,
  valueCandidates,
} from "../../src/utils/value-normalize.js";

describe("singularize", () => {
  it("strips trailing s", () => {
    expect(singularize("hurricanes")).toBe("hurricane");
  });
  it("handles -ies → -y", () => {
    expect(singularize("families")).toBe("family");
  });
  it("handles -ches/-shes", () => {
    expect(singularize("matches")).toBe("match");
  });
  it("leaves words ending in -ss alone", () => {
    expect(singularize("class")).toBe("class");
  });
  it("leaves short words alone", () => {
    expect(singularize("is")).toBe("is");
  });
});

describe("titleCase", () => {
  it("capitalizes each word", () => {
    expect(titleCase("hurricane damage")).toBe("Hurricane Damage");
  });
  it("lowercases existing capitals first", () => {
    expect(titleCase("HURRICANE")).toBe("Hurricane");
  });
});

describe("valueCandidates", () => {
  it("produces a stable set of variants", () => {
    const out = valueCandidates("hurricanes");
    expect(out).toContain("Hurricane");
    expect(out).toContain("hurricane");
    expect(out).toContain("Hurricanes");
    expect(out).toContain("hurricanes");
  });
  it("returns empty for empty input", () => {
    expect(valueCandidates("")).toEqual([]);
  });
});

describe("closestKnownValue", () => {
  const known = ["Hurricane", "Tornado", "Flood", "Severe Storm"];

  it("returns exact match when present", () => {
    expect(closestKnownValue("Hurricane", known)).toEqual({ value: "Hurricane", via: "exact" });
  });
  it("matches case-insensitively as exact", () => {
    expect(closestKnownValue("hurricane", known)).toEqual({ value: "Hurricane", via: "exact" });
  });
  it("matches plural by singularization", () => {
    expect(closestKnownValue("hurricanes", known)).toEqual({ value: "Hurricane", via: "singular" });
  });
  it("falls through to substring", () => {
    expect(closestKnownValue("storm", known)?.value).toBe("Severe Storm");
  });
  it("returns undefined when nothing close", () => {
    expect(closestKnownValue("zzzzz", known)).toBeUndefined();
  });
  it("catches single-character typos", () => {
    expect(closestKnownValue("hurricaen", known)?.value).toBe("Hurricane");
  });
});

describe("stripFiller", () => {
  it("removes WH-words and articles", () => {
    expect(stripFiller("which disasters in florida")).toBe("disasters in florida");
  });
  it("removes question marks and trailing punctuation", () => {
    expect(stripFiller("show me the rows?")).toBe("rows");
  });
  it("returns an empty string when only filler remains", () => {
    expect(stripFiller("what are the")).toBe("");
  });
  it("preserves meaningful content words", () => {
    expect(stripFiller("hurricane damage in Texas")).toBe("hurricane damage in Texas");
  });
});
