import { describe, it, expect } from "vitest";
import {
  aggregateByField,
  coerceCell,
  parseQuestionWithAliases,
  projectField,
  projectRow,
} from "../../src/utils/projection.js";

describe("projectField", () => {
  it("walks dot-separated paths", () => {
    const doc = { envelope: { instance: { id: "abc" } } };
    expect(projectField(doc, "envelope.instance.id")).toBe("abc");
  });

  it("returns undefined for missing paths", () => {
    expect(projectField({ a: 1 }, "b.c")).toBeUndefined();
  });

  it("supports recursive wildcard search", () => {
    const doc = { a: { b: { declarationTitle: "Hurricane Ian" } } };
    expect(projectField(doc, "*.declarationTitle")).toBe("Hurricane Ian");
  });

  it("handles arrays of objects by picking first non-empty match", () => {
    const doc = { rows: [{ name: undefined }, { name: "Alice" }] };
    expect(projectField(doc, "rows.name")).toBe("Alice");
  });

  it("returns undefined for null input", () => {
    expect(projectField(null, "a")).toBeUndefined();
  });
});

describe("coerceCell", () => {
  it("returns null for nullish values", () => {
    expect(coerceCell(undefined)).toBeNull();
    expect(coerceCell(null)).toBeNull();
  });

  it("preserves primitives", () => {
    expect(coerceCell(42)).toBe(42);
    expect(coerceCell(false)).toBe(false);
    expect(coerceCell("hi")).toBe("hi");
  });

  it("normalizes whitespace when requested", () => {
    expect(coerceCell("  foo   bar  ", true)).toBe("foo bar");
  });

  it("flattens primitive arrays to a comma list", () => {
    expect(coerceCell(["a", "b", null, "c"])).toBe("a, b, c");
  });
});

describe("projectRow", () => {
  it("includes the URI and projected fields", () => {
    const doc = { title: "Hurricane Ian", state: "FL" };
    const row = projectRow("/d/1.json", doc, ["title", "state"]);
    expect(row).toEqual({ uri: "/d/1.json", title: "Hurricane Ian", state: "FL" });
  });

  it("fills missing fields with null", () => {
    const row = projectRow("/d/2.json", { title: "A" }, ["title", "incidentType"]);
    expect(row).toEqual({ uri: "/d/2.json", title: "A", incidentType: null });
  });

  it("applies the alias map when projecting", () => {
    const doc = { incidentType: "Hurricane" };
    const row = projectRow("/d/3.json", doc, ["type"], { aliases: { type: "incidentType" } });
    expect(row.type).toBe("Hurricane");
  });

  it("includes score when provided", () => {
    const row = projectRow("/d/4.json", { title: "X" }, ["title"], { score: 0.9 });
    expect(row.score).toBe(0.9);
  });
});

describe("aggregateByField", () => {
  const rows = [
    { uri: "/1", type: "Hurricane" },
    { uri: "/2", type: "Hurricane" },
    { uri: "/3", type: "Flood" },
    { uri: "/4", type: null },
    { uri: "/5", type: "Tornado" },
  ];

  it("returns descending counts", () => {
    const agg = aggregateByField(rows, "type");
    expect(agg[0]).toEqual({ value: "Hurricane", count: 2 });
    expect(agg.map((r) => r.value)).toEqual(["Hurricane", "Flood", "Tornado"]);
  });

  it("respects the limit option", () => {
    const agg = aggregateByField(rows, "type", { limit: 1 });
    expect(agg).toHaveLength(1);
  });

  it("drops null/empty values", () => {
    const agg = aggregateByField(rows, "type");
    expect(agg.find((r) => r.value === null)).toBeUndefined();
  });
});

describe("parseQuestionWithAliases", () => {
  it("maps 'involved hurricanes' to incidentType", () => {
    const parsed = parseQuestionWithAliases("which disasters involved hurricanes?");
    expect(parsed.fieldFilters).toContainEqual(
      expect.objectContaining({ field: "incidentType", phrase: "hurricanes" })
    );
  });

  it("returns residual text after consuming aliases", () => {
    const parsed = parseQuestionWithAliases("show me disasters in state Florida");
    // "state Florida" → field=state phrase=florida (state alias)
    expect(parsed.fieldFilters.length).toBeGreaterThan(0);
  });

  it("returns no filters when nothing matches", () => {
    const parsed = parseQuestionWithAliases("hello world");
    expect(parsed.fieldFilters).toHaveLength(0);
    expect(parsed.residual).toBe("hello world");
  });
});
