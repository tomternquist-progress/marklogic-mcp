// Parameter schemas for the answer-domain tools. Lives in its own file to
// avoid a circular import between src/tools/answer.ts and
// src/utils/capabilities.ts (capabilities.ts derives the manifest from
// these shapes; answer.ts also imports them for server.tool() registration).

import { z } from "zod";

export const ML_ANSWER_QUERY_SHAPE = {
  question: z.string().describe("Natural-language question, e.g. 'which items had type X?', 'which records mentioned Y?'"),
  collection: z.string().optional().describe(
    "Collection URI to search. If omitted, ml_answer_query routes to the best-matching collection " +
    "(scored by name and field overlap with the question). Pass explicitly to skip routing."
  ),
  answer_mode: z.enum([
    "rows",
    "rows_deduped",
    "rows_plus_rollup",
    "titles",
    "count",
    "group",
    "distinct",
  ]).optional().describe(
    "Shape of the answer to return (default: rows). Modes: rows, rows_deduped, rows_plus_rollup, titles, count, group, distinct."
  ),
  mode: z.enum(["strict", "balanced", "broad"]).optional().describe(
    "Query strategy (default: balanced). strict=value-query only, balanced=value-query OR word-query on title, broad=balanced + universal-index residual."
  ),
  group_by: z.string().optional().describe(
    "Field to group/distinct by when answer_mode is 'group' or 'distinct'. If omitted the tool picks the strongest filter field."
  ),
  rows_unique_by: z.array(z.string()).optional().describe(
    "Field paths to dedupe rows on. REQUIRED when answer_mode is rows_deduped or rows_plus_rollup — the tool does not infer business keys per dataset."
  ),
  database: z.string().optional().describe(
    "Database to search. Default: server's content DB. Projects have their own DBs — run ml_databases_list to discover them."
  ),
  max_results: z.number().int().positive().max(500).optional().describe(
    "Cap the number of documents sampled for the answer (default: 50 for rows/count, 250 for group/distinct)."
  ),
  include_residual: z.boolean().optional().describe(
    "When true, leftover non-alias words are passed as a free-text q alongside the structured filter. Default false."
  ),
  translation_only: z.boolean().optional().describe(
    "If true, build and return the CTS query + normalization trace + runnable example WITHOUT executing."
  ),
};

export const ML_CAPABILITIES_SHAPE = {
  tool: z.string().optional().describe("Tool name to inspect. Omit to list every introspected tool."),
  payload: z.record(z.unknown()).optional().describe(
    "Optional candidate payload. When provided, ml_capabilities runs a payload check: " +
    "it strips keys that the target tool does not accept, suggests the closest accepted name for each " +
    "dropped key, and returns a cleaned payload + warnings — letting callers preview a request before " +
    "hitting strict Zod validation errors. Requires `tool` to also be set."
  ),
};

export const ML_QUERY_RECIPE_SHAPE = {
  recipe: z.string().describe("Name of the recipe (or 'list' to enumerate available recipes)"),
  params: z.record(z.unknown()).optional().describe("Parameters for the recipe; check requiredParams in the catalog."),
  execute: z.boolean().optional().describe("If true (default), execute the recipe immediately. If false, return only the constructed invocation for review."),
  database: z.string().optional().describe("Database name passed through to the underlying tool."),
};
