// Runtime capability manifest. Lists, per high-frequency tool, the
// parameters this build supports plus a one-line note. Purpose: prevent
// trial-and-error when documentation and runtime drift apart.
//
// Two tiers of entries:
//
//   1. AUTO-DERIVED (preferred). For tools where the Zod parameter shape is
//      exported from the tool file (see ML_ANSWER_QUERY_SHAPE in
//      src/tools/answer.ts), the manifest entry is produced by
//      deriveCapability() from the SAME Zod definition that server.tool()
//      uses to register. Drift between docs and runtime is structurally
//      impossible.
//
//   2. HAND-CURATED. For tools that still have inline Zod schemas, the
//      manifest entry is maintained here. capabilities-parity.test.ts
//      runs as a CI safety net for these entries.
//
// New tools should follow tier 1: export the shape from the tool file and
// add a deriveCapability() line below.

import { deriveCapability } from "./derive-capability.js";
import {
  ML_ANSWER_QUERY_SHAPE,
  ML_CAPABILITIES_SHAPE,
  ML_QUERY_RECIPE_SHAPE,
} from "../tools/answer-shapes.js";

export interface ToolCapability {
  name: string;
  description: string;
  params: Array<{ name: string; type: string; description: string }>;
}

export const TOOL_CAPABILITIES: ToolCapability[] = [
  // ── Hand-curated entries (tier 2). Move these to tier 1 by extracting
  //    their Zod shape into a module-level constant in the tool file and
  //    calling deriveCapability() here. ────────────────────────────────────
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
    name: "ml_search_surface",
    description: "Discovery — fields, range indexes, search-options names, value/word-queryable fields.",
    params: [
      { name: "collection", type: "string?", description: "Collection URI to inspect" },
      { name: "database", type: "string?", description: "Target database" },
      { name: "sample_size", type: "number?", description: "Documents to sample for inference (default 10)" },
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

  // ── Auto-derived entries (tier 1). These are produced from the EXACT
  //    Zod shape that server.tool() registers, so drift is impossible. ────
  deriveCapability(
    "ml_answer_query",
    "One-shot NL question → CTS → projected rows + audit trace + next_actions. Auto-routes to a collection, value-normalises against observed values, 4-layer rescue on zero hits.",
    ML_ANSWER_QUERY_SHAPE
  ),
  deriveCapability(
    "ml_capabilities",
    "Runtime capability introspection. Pass tool='<name>' for one, omit for all.",
    ML_CAPABILITIES_SHAPE
  ),
  deriveCapability(
    "ml_query_recipe",
    "Named query templates: find_entities_by_type, distinct_values_with_count, top_n_by_field, time_bounded_events, entities_mentioning_term.",
    ML_QUERY_RECIPE_SHAPE
  ),
];

export function getCapability(name: string): ToolCapability | undefined {
  return TOOL_CAPABILITIES.find((t) => t.name === name);
}
