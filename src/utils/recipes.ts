// Named recipe templates for common analytical questions. Each recipe takes
// minimal parameters (collection, field names, optional bounds) and returns
// a fully-formed ml_search invocation so callers don't have to hand-build
// structured queries or aggregations.

/**
 * Upper bound on page_length accepted by the ml_search tool's Zod schema
 * (`page_length: z.number().int().positive().max(200)`). Recipes return
 * invocations that callers are expected to run verbatim, so every page_length
 * a recipe emits is clamped to this — an invocation the tool would reject is
 * worse than a smaller sample. Keep in sync with src/tools/search.ts.
 */
export const MAX_SEARCH_PAGE_LENGTH = 200;

/** Clamp a caller-supplied page size into ml_search's accepted range. */
function clampPageLength(value: unknown, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_SEARCH_PAGE_LENGTH);
}

export interface RecipeInvocation {
  tool: "ml_search" | "ml_optic_query" | "ml_values_query";
  params: Record<string, unknown>;
  explanation: string;
}

export interface RecipeDefinition {
  name: string;
  description: string;
  requiredParams: string[];
  build: (args: Record<string, unknown>) => RecipeInvocation;
}

export const QUERY_RECIPES: RecipeDefinition[] = [
  {
    name: "find_entities_by_type",
    description:
      "Find documents in a collection whose type/category field exactly equals a given value. " +
      "Uses a structured value-query against the JSON property value index (no range index required) — " +
      "more precise than bareword full-text matching, which can over-match across other fields. " +
      "Returns flat rows with the requested fields.",
    requiredParams: ["collection", "type_field", "type_value"],
    build: (args) => ({
      tool: "ml_search",
      params: {
        collection: args.collection,
        structured_query: {
          "value-query": {
            "json-property": args.type_field,
            text: [args.type_value],
          },
        },
        select_fields: args.select_fields ?? [args.type_field],
        page_length: clampPageLength(args.limit, 50),
        normalize_whitespace: true,
      },
      explanation:
        `Exact-match value-query on ${args.type_field}="${args.type_value}" in collection ` +
        `"${args.collection}". JSON property value indexes are on by default, so this works without ` +
        `adding a range index.`,
    }),
  },
  {
    name: "distinct_values_with_count",
    description:
      "Return distinct values of a field with their document count for the matched documents. " +
      "Useful for answering 'how many X by Y?' without scanning every document.",
    requiredParams: ["collection", "field"],
    build: (args) => ({
      tool: "ml_search",
      params: {
        collection: args.collection,
        q: args.q ?? "",
        distinct: args.field,
        page_length: clampPageLength(args.sample_size, 200),
        normalize_whitespace: true,
      },
      explanation:
        `Samples up to ${clampPageLength(args.sample_size, 200)} matching documents from "${args.collection}" ` +
        `and groups by distinct values of "${args.field}".`,
    }),
  },
  {
    name: "top_n_by_field",
    description:
      "Return the top N most-frequent values of a field within a collection (and optional free-text query).",
    requiredParams: ["collection", "field"],
    build: (args) => ({
      tool: "ml_search",
      params: {
        collection: args.collection,
        q: args.q ?? "",
        group_by: args.field,
        count: true,
        // Capped at ml_search's page_length ceiling (max 200). The invocation
        // this recipe returns is meant to be runnable verbatim, so it must not
        // exceed the limit the tool's own Zod schema enforces.
        page_length: clampPageLength(args.sample_size, 200),
        normalize_whitespace: true,
      },
      explanation:
        `Counts occurrences of "${args.field}" values across up to ` +
        `${clampPageLength(args.sample_size, 200)} ` +
        `matched documents and returns them sorted by frequency.`,
    }),
  },
  {
    name: "time_bounded_events",
    description:
      "Find documents in a date range and project the requested fields. " +
      "REQUIRES a range index of the matching type on the date field (verify with " +
      "ml_indexes_list first). Optional date_type selects the index type " +
      "(default xs:dateTime; use xs:date for date-only indexes).",
    requiredParams: ["collection", "date_field", "start_date", "end_date"],
    build: (args) => {
      const dateType = args.date_type ?? "xs:dateTime";
      // A bounded range needs TWO range-queries ANDed together: a single
      // range-query with multiple values ORs them, so GE [start, end] would
      // degenerate to ">= start" and never apply the upper bound.
      const rangeQuery = (operator: "GE" | "LE", value: unknown) => ({
        "range-query": {
          type: dateType,
          "json-property": args.date_field,
          value: [value],
          "range-operator": operator,
        },
      });
      return {
        tool: "ml_search",
        params: {
          collection: args.collection,
          structured_query: {
            "and-query": {
              queries: [
                rangeQuery("GE", args.start_date),
                rangeQuery("LE", args.end_date),
              ],
            },
          },
          select_fields: args.select_fields ?? [args.date_field],
          page_length: clampPageLength(args.limit, 50),
          normalize_whitespace: true,
        },
        explanation:
          `Returns documents in "${args.collection}" with ${args.date_field} between ` +
          `${args.start_date} and ${args.end_date} (inclusive). Requires a ${dateType} ` +
          `range index on ${args.date_field}.`,
      };
    },
  },
  {
    name: "entities_mentioning_term",
    description:
      "Full-text scan that returns the top fields for each matching document — combines content scoping with " +
      "field projection so the caller gets readable rows in a single round trip.",
    requiredParams: ["collection", "q"],
    build: (args) => ({
      tool: "ml_search",
      params: {
        collection: args.collection,
        q: args.q,
        select_fields: args.select_fields ?? [],
        page_length: clampPageLength(args.limit, 25),
        normalize_whitespace: true,
      },
      explanation:
        `Full-text search for "${args.q}" in collection "${args.collection}", returning the ` +
        `requested fields inline.`,
    }),
  },
];

export function findRecipe(name: string): RecipeDefinition | undefined {
  return QUERY_RECIPES.find((r) => r.name === name);
}

export function listRecipeSummaries(): Array<{ name: string; description: string; requiredParams: string[] }> {
  return QUERY_RECIPES.map(({ name, description, requiredParams }) => ({
    name,
    description,
    requiredParams,
  }));
}
