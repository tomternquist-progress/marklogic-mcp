import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";
import {
  aggregateByField,
  parseQuestionWithAliases,
  projectField,
  projectRow,
  type ProjectedRow,
} from "../utils/projection.js";
import {
  findRecipe,
  listRecipeSummaries,
  QUERY_RECIPES,
} from "../utils/recipes.js";

export function registerAnswerTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_answer_query",
    "ONE-SHOT QUESTION ANSWERING. Takes a natural-language question + a collection and returns a " +
    "concise answer with the rows that backed it, plus an audit trace (CTS shape, fields used, " +
    "filters applied, confidence/assumptions).\n\n" +
    "INTERNAL FLOW:\n" +
    "  1. Sample documents from the collection to discover field shape.\n" +
    "  2. Parse the question against an alias dictionary (synonyms → field paths).\n" +
    "  3. Build a structured CTS query from the matched aliases + residual free-text.\n" +
    "  4. Execute the search and project the most useful fields inline.\n" +
    "  5. Optionally aggregate (count/group_by) based on the chosen answer_mode.\n" +
    "  6. Return the answer with an explainability trace.\n\n" +
    "ANSWER MODES:\n" +
    "  • rows    — return the matching rows with projected fields (default).\n" +
    "  • count   — return just the total count.\n" +
    "  • group   — group matched rows by the most relevant field (auto-picked).\n" +
    "  • distinct— return distinct values of the most relevant field with their counts.\n\n" +
    "Use this when the user asks an English question against a known collection. For multi-step " +
    "exploration or unknown intents, call ml_suggest_approach first.",
    {
      question: z.string().describe("Natural-language question, e.g. 'which disasters involved hurricanes?'"),
      collection: z.string().optional().describe(
        "Collection URI to search. If omitted, ml_answer_query searches the whole content DB; supplying " +
        "a collection greatly improves alias resolution and reduces noise."
      ),
      answer_mode: z.enum(["rows", "count", "group", "distinct"]).optional().describe(
        "Shape of the answer to return (default: rows)."
      ),
      database: z.string().optional().describe(
        "Database to search. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."
      ),
      max_results: z.number().int().positive().max(500).optional().describe(
        "Cap the number of documents sampled for the answer (default: 50 for rows/count, 250 for group/distinct)."
      ),
    },
    async ({ question, collection, answer_mode, database, max_results }) => {
      const mode = answer_mode ?? "rows";
      const sampleSize = max_results ?? (mode === "group" || mode === "distinct" ? 250 : 50);

      const trace: Record<string, unknown> = {
        question,
        collection,
        answer_mode: mode,
      };

      try {
        // Step 1 — discover field shape so we can pick projection fields.
        let inferredFields: string[] = [];
        try {
          const schema = await clients.schema.discoverSchema({
            collection,
            sampleSize: 5,
            database,
          });
          inferredFields = schema.inferredFields
            .filter((f) => f.type === "string" || f.type === "date" || f.type === "number")
            .map((f) => f.path);
        } catch {
          // discovery is best-effort; aliases below still let us proceed.
        }
        trace.inferredFields = inferredFields.slice(0, 25);

        // Step 2 — NL parsing.
        const parsed = parseQuestionWithAliases(question, collection);
        trace.parsedFilters = parsed.fieldFilters;
        trace.residualQuery = parsed.residual;

        // Step 3 — build a CTS structured query.
        const subQueries: unknown[] = [];
        for (const f of parsed.fieldFilters) {
          subQueries.push({
            "word-query": {
              text: [f.phrase],
              "json-property": f.field,
            },
          });
        }
        let structuredQuery: Record<string, unknown> | undefined;
        if (subQueries.length) {
          structuredQuery = subQueries.length === 1
            ? (subQueries[0] as Record<string, unknown>)
            : { "and-query": { queries: subQueries } };
        }
        trace.cts = structuredQuery ?? null;
        trace.freeTextQuery = parsed.residual || undefined;

        // Step 4 — choose projection fields.
        const candidateFields = pickProjectionFields(parsed, inferredFields);
        trace.projectionFields = candidateFields;

        // Step 5 — execute the search.
        const search = await clients.search.search({
          q: parsed.residual || undefined,
          structuredQuery,
          collection,
          database,
          pageLength: sampleSize,
        });

        const assumptions: string[] = [];
        if (!structuredQuery && !parsed.residual) {
          assumptions.push("Question did not yield any filters; matching all documents in the scope.");
        }
        if (parsed.fieldFilters.length === 0 && parsed.residual) {
          assumptions.push("Falling back to full-text matching on the universal index.");
        }
        for (const f of parsed.fieldFilters) {
          if (!inferredFields.includes(f.field)) {
            assumptions.push(
              `Field "${f.field}" was inferred from the alias dictionary; the sampled documents did not surface it. ` +
              `Run ml_schema_discover to verify it exists on this collection.`
            );
          }
        }

        if (search.total === 0) {
          const rescue = await buildRescue(parsed, candidateFields, collection, database, clients);
          const payload = {
            answer: "No matching documents.",
            total: 0,
            trace,
            rescue,
            assumptions,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        if (mode === "count") {
          const payload = {
            answer: `${search.total} matching documents`,
            total: search.total,
            confidence: parsed.fieldFilters.length > 0 ? "high" : "medium",
            assumptions,
            trace,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        // Project rows.
        const uris = search.results.map((r) => r.uri);
        const docs = await clients.search.fetchDocs(uris, database);
        const rows: ProjectedRow[] = search.results.map((r) =>
          projectRow(r.uri, docs.get(r.uri), candidateFields, {
            normalizeWhitespace: true,
            score: r.score,
          })
        );

        if (mode === "group" || mode === "distinct") {
          const aggField = pickAggregationField(parsed, candidateFields);
          if (!aggField) {
            return {
              content: [{ type: "text", text: "No aggregation field could be inferred from the question." }],
              isError: true,
            };
          }
          const values = aggregateByField(rows, aggField, { normalizeWhitespace: true });
          (trace as Record<string, unknown>).aggregationField = aggField;
          const payload = {
            answer: `${values.length} distinct ${aggField} values across ${rows.length} matched documents`,
            total: search.total,
            sampled: rows.length,
            field: aggField,
            values,
            confidence: parsed.fieldFilters.length > 0 ? "high" : "medium",
            assumptions,
            trace,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        // Rows mode.
        const payload = {
          answer: rows.length === search.total
            ? `${rows.length} matches`
            : `Showing first ${rows.length} of ${search.total} matches`,
          total: search.total,
          rows,
          confidence: parsed.fieldFilters.length > 0 ? "high" : "medium",
          assumptions,
          trace,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: toToolError(err) +
              "\nHint: ml_answer_query relies on ml_search + schema discovery. " +
              "If discovery fails, retry with an explicit `collection` and `database` parameter.",
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "ml_query_recipe",
    "REUSABLE QUERY TEMPLATES. Call by name with minimal parameters to execute a pre-validated query " +
    "without hand-building structured queries. Useful for common analytics tasks where the structure " +
    "is standard but the parameters vary.\n\n" +
    "AVAILABLE RECIPES:\n" +
    QUERY_RECIPES.map((r) => `  • ${r.name} — ${r.description} (params: ${r.requiredParams.join(", ")})`).join("\n") +
    "\n\nCall with recipe='list' to enumerate without executing.",
    {
      recipe: z.string().describe("Name of the recipe (or 'list' to enumerate available recipes)"),
      params: z.record(z.unknown()).optional().describe("Parameters for the recipe; check `requiredParams` in the catalog."),
      execute: z.boolean().optional().describe(
        "If true (default), execute the recipe immediately. If false, return only the constructed invocation for review."
      ),
      database: z.string().optional().describe("Database name passed through to the underlying tool."),
    },
    async ({ recipe, params, execute, database }) => {
      if (recipe === "list" || !recipe) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ recipes: listRecipeSummaries() }, null, 2),
          }],
        };
      }

      const def = findRecipe(recipe);
      if (!def) {
        return {
          content: [{
            type: "text",
            text: `Unknown recipe "${recipe}". Call with recipe='list' to see available templates.`,
          }],
          isError: true,
        };
      }

      const merged = { ...(params ?? {}) };
      const missing = def.requiredParams.filter((p) => merged[p] == null);
      if (missing.length) {
        return {
          content: [{
            type: "text",
            text: `Recipe "${recipe}" requires: ${missing.join(", ")}. ` +
              `Provided: ${Object.keys(merged).join(", ") || "<none>"}.`,
          }],
          isError: true,
        };
      }

      const invocation = def.build(merged);
      if (database) (invocation.params as Record<string, unknown>).database = database;
      const shouldExecute = execute !== false;

      if (!shouldExecute) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              recipe: def.name,
              invocation,
              executed: false,
            }, null, 2),
          }],
        };
      }

      try {
        const result = await executeRecipe(invocation, clients);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              recipe: def.name,
              invocation,
              executed: true,
              result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: toToolError(err) + `\nRecipe invocation: ${JSON.stringify(invocation)}`,
          }],
          isError: true,
        };
      }
    }
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function pickProjectionFields(
  parsed: ReturnType<typeof parseQuestionWithAliases>,
  inferred: string[]
): string[] {
  const priority: string[] = [];
  // Always show the filter fields the question targeted.
  for (const f of parsed.fieldFilters) {
    if (!priority.includes(f.field)) priority.push(f.field);
  }
  // Common headline fields for event/incident-style datasets.
  for (const f of [
    "declarationTitle",
    "title",
    "name",
    "incidentType",
    "state",
    "designatedArea",
    "declarationDate",
    "incidentBeginDate",
  ]) {
    if (!priority.includes(f) && (inferred.length === 0 || inferred.includes(f))) {
      priority.push(f);
    }
  }
  // Top-level inferred fields rounded out the projection.
  for (const f of inferred) {
    if (priority.length >= 6) break;
    if (!priority.includes(f) && !f.includes(".")) priority.push(f);
  }
  return priority.slice(0, 6);
}

function pickAggregationField(
  parsed: ReturnType<typeof parseQuestionWithAliases>,
  projection: string[]
): string | undefined {
  // Prefer the most specific filter field — the user asked about that dimension.
  if (parsed.fieldFilters.length) return parsed.fieldFilters[0].field;
  // Otherwise the first projection field is the best fallback.
  return projection[0];
}

interface RescuePayload {
  totalAtScope: number;
  closestValues: Array<{ field: string; value: unknown; count: number }>;
  suggestedReformulations: string[];
  candidateFields: string[];
}

async function buildRescue(
  parsed: ReturnType<typeof parseQuestionWithAliases>,
  candidateFields: string[],
  collection: string | undefined,
  database: string | undefined,
  clients: MarkLogicClients
): Promise<RescuePayload> {
  // Pull a sample of the scope (no filters) so we can show what real values look like.
  const sample = await clients.search.search({
    q: "",
    collection,
    database,
    pageLength: 30,
  }).catch(() => null);

  const closest: Array<{ field: string; value: unknown; count: number }> = [];
  if (sample && sample.results.length) {
    const uris = sample.results.map((r) => r.uri);
    const docs = await clients.search.fetchDocs(uris, database);
    for (const field of candidateFields.slice(0, 3)) {
      const rows: ProjectedRow[] = sample.results.map((r) =>
        projectRow(r.uri, docs.get(r.uri), [field], { normalizeWhitespace: true })
      );
      const top = aggregateByField(rows, field, { normalizeWhitespace: true, limit: 5 });
      for (const t of top) closest.push({ field, value: t.value, count: t.count });
    }
  }

  const suggestions: string[] = [];
  if (parsed.fieldFilters.length) {
    const f = parsed.fieldFilters[0];
    suggestions.push(`Try matching on actual ${f.field} values — see closestValues above.`);
    suggestions.push(`Loosen the filter: ml_search q="${f.phrase}" collection="${collection ?? '<scope>'}"`);
  } else if (parsed.residual) {
    suggestions.push(`No alias matched. Pick a field from candidateFields and call ml_search with select_fields=['<field>'].`);
  } else {
    suggestions.push("Question parsed to no filters and no free text. Restate with specific terms.");
  }

  return {
    totalAtScope: sample?.total ?? 0,
    closestValues: closest,
    suggestedReformulations: suggestions,
    candidateFields,
  };
}

async function executeRecipe(
  invocation: ReturnType<(typeof QUERY_RECIPES)[number]["build"]>,
  clients: MarkLogicClients
): Promise<unknown> {
  if (invocation.tool === "ml_search") {
    const p = invocation.params as Record<string, unknown>;
    const searchResp = await clients.search.search({
      q: p.q as string | undefined,
      structuredQuery: p.structured_query as unknown,
      collection: p.collection as string | undefined,
      pageLength: p.page_length as number | undefined,
      database: p.database as string | undefined,
    });

    const selectFields = (p.select_fields as string[] | undefined) ?? [];
    const distinct = p.distinct as string | undefined;
    const groupBy = p.group_by as string | undefined;
    const aggField = distinct ?? groupBy;
    const fields = new Set<string>(selectFields);
    if (aggField) fields.add(aggField);

    if (fields.size === 0) return searchResp;

    const uris = searchResp.results.map((r) => r.uri);
    const docs = await clients.search.fetchDocs(uris, p.database as string | undefined);
    const rows: ProjectedRow[] = searchResp.results.map((r) =>
      projectRow(r.uri, docs.get(r.uri), Array.from(fields), {
        normalizeWhitespace: p.normalize_whitespace as boolean | undefined,
        score: r.score,
      })
    );

    if (aggField) {
      const values = aggregateByField(rows, aggField, {
        normalizeWhitespace: p.normalize_whitespace as boolean | undefined,
      });
      return {
        total: searchResp.total,
        sampled: rows.length,
        field: aggField,
        values,
      };
    }
    return { total: searchResp.total, rows };
  }
  throw new Error(`Recipe tool "${invocation.tool}" is not yet supported in ml_query_recipe.`);
}

// Re-export for explainability use elsewhere.
export { projectField };
