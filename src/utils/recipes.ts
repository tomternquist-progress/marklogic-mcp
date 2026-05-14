// Named recipe templates for common analytical questions. Each recipe takes
// minimal parameters (collection, field names, optional bounds) and returns
// a fully-formed ml_search invocation so callers don't have to hand-build
// structured queries or aggregations.

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
      "Find documents in a collection whose type/category field matches a given phrase. " +
      "Returns flat rows with the requested fields.",
    requiredParams: ["collection", "type_field", "type_value"],
    build: (args) => ({
      tool: "ml_search",
      params: {
        collection: args.collection,
        structured_query: {
          "and-query": {
            queries: [
              {
                "value-query": {
                  type: "string",
                  json_property: args.type_field,
                  text: [args.type_value],
                },
              },
            ],
          },
        },
        select_fields: args.select_fields ?? [args.type_field],
        page_length: args.limit ?? 50,
        normalize_whitespace: true,
      },
      explanation:
        `Looks for documents where ${args.type_field} == "${args.type_value}" in collection ` +
        `"${args.collection}", projecting the requested fields inline.`,
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
        page_length: args.sample_size ?? 200,
        normalize_whitespace: true,
      },
      explanation:
        `Samples up to ${args.sample_size ?? 200} matching documents from "${args.collection}" ` +
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
        page_length: args.sample_size ?? 500,
        normalize_whitespace: true,
      },
      explanation:
        `Counts occurrences of "${args.field}" values across up to ${args.sample_size ?? 500} ` +
        `matched documents and returns them sorted by frequency.`,
    }),
  },
  {
    name: "time_bounded_events",
    description:
      "Find documents in a date range and project the requested fields. " +
      "Requires the date field to exist on each document (range index recommended for large sets).",
    requiredParams: ["collection", "date_field", "start_date", "end_date"],
    build: (args) => ({
      tool: "ml_search",
      params: {
        collection: args.collection,
        structured_query: {
          "and-query": {
            queries: [
              {
                "range-constraint-query": {
                  "constraint-name": args.date_field,
                  value: [args.start_date, args.end_date],
                  "range-operator": "GE",
                },
              },
            ],
          },
        },
        select_fields: args.select_fields ?? [args.date_field],
        page_length: args.limit ?? 50,
        normalize_whitespace: true,
      },
      explanation:
        `Returns documents in "${args.collection}" with ${args.date_field} between ` +
        `${args.start_date} and ${args.end_date}.`,
    }),
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
        page_length: args.limit ?? 25,
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
