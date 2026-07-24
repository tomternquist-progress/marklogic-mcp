/**
 * Shape tests for the canned query recipes. The time_bounded_events tests are
 * a regression net for a bug where the recipe emitted a single
 * range-constraint-query (which requires named search options ml_search never
 * defines) with GE over [start, end] — multiple values in one range-query are
 * ORed, so the upper bound was never applied.
 */

import { describe, it, expect } from "vitest";
import {
  findRecipe,
  QUERY_RECIPES,
  listRecipeSummaries,
  MAX_SEARCH_PAGE_LENGTH,
} from "../../src/utils/recipes.js";

describe("time_bounded_events recipe", () => {
  const args = {
    collection: "events",
    date_field: "occurredAt",
    start_date: "2024-01-01T00:00:00Z",
    end_date: "2024-12-31T23:59:59Z",
  };

  function buildQueries(extra: Record<string, unknown> = {}) {
    const invocation = findRecipe("time_bounded_events")!.build({ ...args, ...extra });
    const sq = invocation.params.structured_query as {
      "and-query": { queries: Array<Record<string, Record<string, unknown>>> };
    };
    return { invocation, queries: sq["and-query"].queries };
  }

  it("emits an and-query of two range-queries bounding both ends", () => {
    const { queries } = buildQueries();
    expect(queries).toHaveLength(2);

    const [lower, upper] = queries.map((q) => q["range-query"]);
    expect(lower).toMatchObject({
      "json-property": "occurredAt",
      "range-operator": "GE",
      value: [args.start_date],
    });
    expect(upper).toMatchObject({
      "json-property": "occurredAt",
      "range-operator": "LE",
      value: [args.end_date],
    });
  });

  it("does not use range-constraint-query (requires named options ml_search never defines)", () => {
    const { invocation } = buildQueries();
    expect(JSON.stringify(invocation.params)).not.toContain("range-constraint-query");
  });

  it("defaults the index type to xs:dateTime and honours date_type override", () => {
    const { queries } = buildQueries();
    expect(queries[0]["range-query"].type).toBe("xs:dateTime");

    const { queries: dateQueries } = buildQueries({ date_type: "xs:date" });
    expect(dateQueries[0]["range-query"].type).toBe("xs:date");
    expect(dateQueries[1]["range-query"].type).toBe("xs:date");
  });

  it("states the range-index prerequisite in description and explanation", () => {
    const def = findRecipe("time_bounded_events")!;
    expect(def.description).toMatch(/range index/i);
    const { invocation } = buildQueries();
    expect(invocation.explanation).toMatch(/range index/i);
  });
});

describe("recipe registry", () => {
  it("every recipe builds with its required params present", () => {
    const sampleArgs: Record<string, unknown> = {
      collection: "c",
      type_field: "type",
      type_value: "x",
      field: "f",
      date_field: "d",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      q: "term",
    };
    for (const def of QUERY_RECIPES) {
      const invocation = def.build(sampleArgs);
      expect(invocation.tool, def.name).toBeTruthy();
      expect(invocation.params, def.name).toBeTruthy();
      expect(invocation.explanation, def.name).toBeTruthy();
    }
  });

  it("summaries cover every recipe", () => {
    expect(listRecipeSummaries().map((r) => r.name)).toEqual(QUERY_RECIPES.map((r) => r.name));
  });
});

/**
 * A recipe's whole contract is "a fully-formed invocation you can run
 * verbatim". ml_search declares page_length as
 * z.number().int().positive().max(200), so any page_length above that ceiling
 * makes the returned invocation un-runnable — top_n_by_field shipped a default
 * of 500, which Zod rejected the moment an agent copied it into ml_search.
 */
describe("recipe page_length stays runnable against ml_search", () => {
  const sampleArgs: Record<string, unknown> = {
    collection: "c",
    type_field: "type",
    type_value: "x",
    field: "f",
    date_field: "d",
    start_date: "2024-01-01",
    end_date: "2024-12-31",
    q: "term",
  };

  it("no recipe's default page_length exceeds ml_search's max", () => {
    for (const def of QUERY_RECIPES) {
      const pageLength = def.build(sampleArgs).params.page_length as number | undefined;
      if (pageLength === undefined) continue;
      expect(pageLength, def.name).toBeLessThanOrEqual(MAX_SEARCH_PAGE_LENGTH);
      expect(Number.isInteger(pageLength), def.name).toBe(true);
      expect(pageLength, def.name).toBeGreaterThan(0);
    }
  });

  it("clamps an oversized caller-supplied sample size instead of passing it through", () => {
    const invocation = findRecipe("top_n_by_field")!.build({ ...sampleArgs, sample_size: 5000 });
    expect(invocation.params.page_length).toBe(MAX_SEARCH_PAGE_LENGTH);
    // The explanation must not promise a sample the invocation cannot take.
    expect(invocation.explanation).toContain(String(MAX_SEARCH_PAGE_LENGTH));
    expect(invocation.explanation).not.toContain("5000");
  });

  it("clamps oversized limits on every recipe that accepts one", () => {
    for (const def of QUERY_RECIPES) {
      const pageLength = def.build({ ...sampleArgs, limit: 9999, sample_size: 9999 })
        .params.page_length as number | undefined;
      if (pageLength === undefined) continue;
      expect(pageLength, def.name).toBe(MAX_SEARCH_PAGE_LENGTH);
    }
  });

  it("keeps a caller-supplied value that is already within range", () => {
    const invocation = findRecipe("top_n_by_field")!.build({ ...sampleArgs, sample_size: 25 });
    expect(invocation.params.page_length).toBe(25);
  });

  it("falls back to the default for a nonsensical value", () => {
    const invocation = findRecipe("entities_mentioning_term")!.build({ ...sampleArgs, limit: -1 });
    expect(invocation.params.page_length).toBe(25);
  });
});
