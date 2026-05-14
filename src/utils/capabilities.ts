// Runtime capability manifest. Lists, per high-frequency tool, the
// parameters this build supports plus a one-line note. Purpose: prevent
// trial-and-error when documentation and runtime drift apart. The list
// is maintained alongside the tool registrations — if you add or remove
// a parameter from a registered tool, update the entry here.
//
// Not exhaustive — focused on the tools where contract drift caused
// real friction (ml_search, ml_answer_query, ml_search_surface,
// ml_query_recipe).

export interface ToolCapability {
  name: string;
  description: string;
  params: Array<{ name: string; type: string; description: string }>;
}

export const TOOL_CAPABILITIES: ToolCapability[] = [
  {
    name: "ml_search",
    description: "Full-text + structured search with optional inline projection and aggregation.",
    params: [
      { name: "q", type: "string?", description: "Full-text query (universal index)" },
      { name: "structured_query", type: "object?", description: "MarkLogic structured query JSON" },
      { name: "collection", type: "string?", description: "Limit to a collection URI" },
      { name: "directory", type: "string?", description: "Limit to a directory prefix" },
      { name: "start", type: "number?", description: "Pagination start (1-based)" },
      { name: "page_length", type: "number? (max 200 when select_fields used)", description: "Results per page" },
      { name: "options", type: "string?", description: "Named search-options set" },
      { name: "database", type: "string?", description: "Target database (default: content DB)" },
      { name: "select_fields", type: "string[]?", description: "Project these field paths into each row" },
      { name: "distinct", type: "string?", description: "Return distinct values of this field + counts" },
      { name: "group_by", type: "string?", description: "Group matched docs by this field" },
      { name: "count", type: "boolean?", description: "Include per-group counts" },
      { name: "normalize_whitespace", type: "boolean?", description: "Collapse whitespace in projected/grouped values" },
      { name: "response_mode", type: "'inline_summary' | 'paged' | 'full'?", description: "Render mode" },
    ],
  },
  {
    name: "ml_answer_query",
    description: "One-shot NL question → CTS → projected rows + audit trace + next_actions.",
    params: [
      { name: "question", type: "string", description: "Natural-language question" },
      { name: "collection", type: "string?", description: "Collection URI to scope to (auto-routed when omitted)" },
      {
        name: "answer_mode",
        type: "'rows' | 'rows_deduped' | 'rows_plus_rollup' | 'titles' | 'count' | 'group' | 'distinct'?",
        description: "Shape of the answer — rows (default), rows_deduped, rows_plus_rollup, titles (distinct names of the collection's title field), count, group(field), distinct(field).",
      },
      {
        name: "mode",
        type: "'strict' | 'balanced' | 'broad'?",
        description: "Query strategy — strict (value-query only), balanced (value-query OR word-query on title; default), broad (balanced + universal-index residual).",
      },
      { name: "group_by", type: "string?", description: "Field to group/distinct by (overrides auto-pick)" },
      { name: "rows_unique_by", type: "string[]?", description: "Dedupe keys for rows_deduped / rows_plus_rollup; falls back to a preset by collection" },
      { name: "database", type: "string?", description: "Target database" },
      { name: "max_results", type: "number?", description: "Cap rows sampled (default 50 / 250 for group/distinct/titles)" },
      { name: "include_residual", type: "boolean?", description: "Pass leftover filler as q (default false)" },
      { name: "translation_only", type: "boolean?", description: "Return CTS + trace WITHOUT executing" },
    ],
  },
  {
    name: "ml_search_surface",
    description: "Discovery — fields, range indexes, search-options names, value/word-queryable fields.",
    params: [
      { name: "collection", type: "string?", description: "Collection URI to inspect" },
      { name: "database", type: "string?", description: "Target database" },
      { name: "sample_size", type: "number?", description: "Documents to sample for inference (default 10)" },
    ],
  },
  {
    name: "ml_query_recipe",
    description: "Named query templates: find_entities_by_type, distinct_values_with_count, top_n_by_field, time_bounded_events, entities_mentioning_term.",
    params: [
      { name: "recipe", type: "string", description: "Recipe name (or 'list' to enumerate)" },
      { name: "params", type: "object?", description: "Recipe-specific parameters" },
      { name: "execute", type: "boolean?", description: "Execute (default true) vs return invocation only" },
      { name: "database", type: "string?", description: "Pass-through database name" },
    ],
  },
  {
    name: "ml_parse_query",
    description: "Parse string-grammar query into structured CTS without executing.",
    params: [
      { name: "qtext", type: "string", description: "String-grammar query text" },
      { name: "bindings", type: "object?", description: "Tag→reference map for range-indexed fields" },
      { name: "database", type: "string?", description: "Database context for index resolution" },
    ],
  },
  {
    name: "ml_capabilities",
    description: "Runtime capability introspection. Pass tool='<name>' for one, omit for all.",
    params: [
      { name: "tool", type: "string?", description: "Tool name to inspect; omit to list every introspected tool." },
    ],
  },
  {
    name: "ml_search_query_plan",
    description: "Debug-mode search: returns resolved CTS + estimate; emits zero-result rescue when total=0.",
    params: [
      { name: "q", type: "string?", description: "Full-text query to plan" },
      { name: "structured_query", type: "object?", description: "Structured query to plan" },
      { name: "collection", type: "string?", description: "Scope to a collection" },
      { name: "database", type: "string?", description: "Target database" },
      { name: "search_options", type: "string?", description: "Named search options set" },
    ],
  },
];

export function getCapability(name: string): ToolCapability | undefined {
  return TOOL_CAPABILITIES.find((t) => t.name === name);
}
