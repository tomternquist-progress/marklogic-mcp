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
import {
  closestKnownValue,
  stripFiller,
  titleCase,
  valueCandidates,
} from "../utils/value-normalize.js";
import { getCapability, TOOL_CAPABILITIES } from "../utils/capabilities.js";

export function registerAnswerTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_answer_query",
    "ONE-SHOT QUESTION ANSWERING. Takes a natural-language question + a collection and returns a " +
    "concise answer with the rows that backed it, plus an audit trace (CTS shape, fields used, " +
    "filters applied, confidence/assumptions).\n\n" +
    "INTERNAL FLOW:\n" +
    "  1. Sample the collection: schema + observed values per field.\n" +
    "  2. Parse the question against an alias dictionary (synonyms → field paths). Strip filler.\n" +
    "  3. Normalize each filter phrase against observed values (case + plural + closest match).\n" +
    "  4. Build a structured value-query and execute. Residual filler is suppressed by default.\n" +
    "  5. On zero hits: retry with word-query, then with rescue (closest-value substitution).\n" +
    "  6. Project the most useful fields inline and return — with a query plan card.\n\n" +
    "ANSWER MODES:\n" +
    "  • rows          — return the matching rows with projected fields (default).\n" +
    "  • count         — return just the total count.\n" +
    "  • group(field)  — group matched rows by the named (or auto-picked) field.\n" +
    "  • distinct(field) — return distinct values of the named (or auto-picked) field + counts.\n\n" +
    "TRANSLATION-ONLY MODE (translation_only=true): build and return the CTS, normalized values, " +
    "confidence, and runnable ml_search example — WITHOUT executing. Useful for inspecting how the " +
    "translator interprets a question before committing to a query.\n\n" +
    "Use this for English questions over a known collection. For multi-step exploration or unknown " +
    "intents, call ml_suggest_approach first.",
    {
      question: z.string().describe("Natural-language question, e.g. 'which disasters involved hurricanes?'"),
      collection: z.string().optional().describe(
        "Collection URI to search. If omitted, ml_answer_query searches the whole content DB; supplying " +
        "a collection greatly improves alias resolution and reduces noise."
      ),
      answer_mode: z.enum(["rows", "count", "group", "distinct"]).optional().describe(
        "Shape of the answer to return (default: rows)."
      ),
      group_by: z.string().optional().describe(
        "Field to group/distinct by when answer_mode is 'group' or 'distinct'. If omitted the tool picks " +
        "the strongest filter field."
      ),
      database: z.string().optional().describe(
        "Database to search. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."
      ),
      max_results: z.number().int().positive().max(500).optional().describe(
        "Cap the number of documents sampled for the answer (default: 50 for rows/count, 250 for group/distinct)."
      ),
      include_residual: z.boolean().optional().describe(
        "When true, leftover non-alias words ('which disasters') are passed as a free-text q alongside the " +
        "structured filter. Default false — suppressing the residual avoids accidental zero-results from " +
        "question filler over-constraining the query."
      ),
      translation_only: z.boolean().optional().describe(
        "If true, build and return the CTS query + normalization trace + runnable example WITHOUT executing. " +
        "Use this to inspect the translator before running it."
      ),
    },
    async ({
      question,
      collection,
      answer_mode,
      group_by,
      database,
      max_results,
      include_residual,
      translation_only,
    }) => {
      const mode = answer_mode ?? "rows";
      const sampleSize = max_results ?? (mode === "group" || mode === "distinct" ? 250 : 50);
      const includeResidual = include_residual === true;
      const translationOnly = translation_only === true;

      const trace: Record<string, unknown> = {
        question,
        collection,
        answer_mode: mode,
      };

      try {
        // Step 1 — discover fields. Sample a few docs and remember each
        // top-level field's observed values so we can normalize.
        const { inferredFields, observedValuesByField } = await sampleScope(
          clients,
          collection,
          database
        );
        trace.inferredFields = inferredFields.slice(0, 25);

        // Step 2 — NL parsing. Drop filler ("which", "show me") from residual.
        const parsed = parseQuestionWithAliases(question, collection);
        const rawResidual = parsed.residual;
        const cleanedResidual = stripFiller(rawResidual);
        const droppedFiller = wordsRemoved(rawResidual, cleanedResidual);
        trace.parsedFilters = parsed.fieldFilters;
        trace.residualRaw = rawResidual || undefined;
        trace.residualCleaned = cleanedResidual || undefined;
        trace.droppedFillerWords = droppedFiller;

        // Step 3 — normalize each filter phrase against observed values so
        // case/plural mismatches don't blow up exact value-query.
        const normalizedFilters = parsed.fieldFilters.map((f) => {
          const observed = observedValuesByField.get(f.field) ?? [];
          const candidates = valueCandidates(f.phrase);
          let matched: { value: string; via: string } | undefined;
          if (observed.length) {
            for (const c of candidates) {
              const m = closestKnownValue(c, observed);
              if (m) {
                matched = m;
                break;
              }
            }
          }
          const finalValues = matched ? [matched.value] : candidates;
          const confidence = matched
            ? matched.via === "exact" || matched.via === "singular" ? "high" : "medium"
            : observed.length ? "low" : "medium";
          return {
            field: f.field,
            originalPhrase: f.phrase,
            matchedAlias: f.matchedAlias,
            normalizedValues: finalValues,
            matchedValue: matched?.value,
            matchedVia: matched?.via,
            observedSample: observed.slice(0, 5),
            confidence,
          };
        });
        trace.normalizedFilters = normalizedFilters;

        // Step 4 — build the structured value-query.
        const subQueries = normalizedFilters.map((f) => ({
          "value-query": {
            "json-property": f.field,
            text: f.normalizedValues,
          },
        }));
        let structuredQuery: Record<string, unknown> | undefined;
        if (subQueries.length) {
          structuredQuery = subQueries.length === 1
            ? (subQueries[0] as Record<string, unknown>)
            : { "and-query": { queries: subQueries } };
        }
        trace.cts = structuredQuery ?? null;
        trace.ctsKind = subQueries.length ? "value-query" : null;

        // Suppress residual filler by default. If structured filters fired,
        // we trust them — the residual is usually question scaffolding
        // ("which disasters") that over-constrains via the universal index.
        const useResidual = includeResidual || (subQueries.length === 0 && cleanedResidual.length > 0);
        const effectiveQ = useResidual ? cleanedResidual || undefined : undefined;
        trace.residualApplied = useResidual ? effectiveQ : null;

        // Choose projection fields.
        const candidateFields = pickProjectionFields(parsed, inferredFields);
        trace.projectionFields = candidateFields;

        const overallConfidence = computeConfidence(normalizedFilters);
        trace.confidence = overallConfidence;

        // Translation-only short-circuit — we don't hit /v1/search.
        if (translationOnly) {
          const card = buildPlanCard({
            cts: structuredQuery,
            q: effectiveQ,
            collection,
            candidateFields,
            normalizedFilters,
            includeResidual: useResidual,
          });
          const payload = {
            translation_only: true,
            answer: "Translation produced — query NOT executed.",
            confidence: overallConfidence,
            normalizedFilters,
            cts: structuredQuery ?? null,
            ctsKind: subQueries.length ? "value-query" : null,
            residualApplied: useResidual ? effectiveQ : null,
            droppedFillerWords: droppedFiller,
            queryPlanCard: card,
            trace,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        // Step 5 — execute.
        let search = await clients.search.search({
          q: effectiveQ,
          structuredQuery,
          collection,
          database,
          pageLength: sampleSize,
        });

        const assumptions: string[] = [];
        for (const f of normalizedFilters) {
          if (f.matchedValue && f.matchedValue.toLowerCase() !== f.originalPhrase.toLowerCase()) {
            assumptions.push(
              `Normalized "${f.originalPhrase}" → ${f.field}="${f.matchedValue}" (via ${f.matchedVia}).`
            );
          }
          if (!inferredFields.includes(f.field)) {
            assumptions.push(
              `Field "${f.field}" came from the alias dictionary; sampled documents did not surface it. ` +
              `Verify with ml_schema_discover.`
            );
          }
        }
        if (droppedFiller.length) {
          assumptions.push(`Dropped filler from residual: [${droppedFiller.join(", ")}].`);
        }
        if (subQueries.length === 0 && !effectiveQ) {
          assumptions.push("Question did not yield any filters; matching all documents in the scope.");
        }

        // Auto-rescue layer 1: word-query on the original phrase.
        if (search.total === 0 && subQueries.length) {
          const wordSubQueries = parsed.fieldFilters.map((f) => ({
            "word-query": {
              text: [f.phrase],
              "json-property": f.field,
            },
          }));
          const wordStructured: Record<string, unknown> = wordSubQueries.length === 1
            ? (wordSubQueries[0] as Record<string, unknown>)
            : { "and-query": { queries: wordSubQueries } };
          const retry = await clients.search.search({
            q: effectiveQ,
            structuredQuery: wordStructured,
            collection,
            database,
            pageLength: sampleSize,
          });
          if (retry.total > 0) {
            search = retry;
            structuredQuery = wordStructured;
            trace.cts = wordStructured;
            trace.ctsKind = "word-query";
            assumptions.push(
              "Primary value-query returned 0; rescued with tokenised word-query for looser matching."
            );
          }
        }

        // Auto-rescue layer 2: if still zero AND residual was originally
        // suppressed, retry with the cleaned residual to widen the search.
        if (search.total === 0 && !useResidual && cleanedResidual.length) {
          const retry = await clients.search.search({
            q: cleanedResidual,
            structuredQuery,
            collection,
            database,
            pageLength: sampleSize,
          });
          if (retry.total > 0) {
            search = retry;
            trace.residualApplied = cleanedResidual;
            assumptions.push(
              `No structured match; rescued with free-text q="${cleanedResidual}".`
            );
          }
        }

        const planCard = buildPlanCard({
          cts: structuredQuery,
          q: trace.residualApplied as string | undefined,
          collection,
          candidateFields,
          normalizedFilters,
          includeResidual: useResidual,
        });

        if (search.total === 0) {
          const rescue = await buildRescue(parsed, candidateFields, collection, database, clients);
          const payload = {
            answer: "No matching documents.",
            total: 0,
            confidence: overallConfidence,
            trace,
            rescue,
            assumptions,
            queryPlanCard: planCard,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        if (mode === "count") {
          const payload = {
            answer: `${search.total} matching documents`,
            total: search.total,
            confidence: overallConfidence,
            assumptions,
            queryPlanCard: planCard,
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
          const aggField =
            group_by ??
            (parsed.fieldFilters[0]?.field as string | undefined) ??
            candidateFields[0];
          if (!aggField) {
            return {
              content: [{ type: "text", text: "No aggregation field could be inferred from the question." }],
              isError: true,
            };
          }
          // Re-project rows that include the agg field if it isn't already there.
          const aggFields = candidateFields.includes(aggField)
            ? candidateFields
            : [...candidateFields, aggField];
          const aggRows: ProjectedRow[] = search.results.map((r) =>
            projectRow(r.uri, docs.get(r.uri), aggFields, {
              normalizeWhitespace: true,
              score: r.score,
            })
          );
          const values = aggregateByField(aggRows, aggField, { normalizeWhitespace: true });
          (trace as Record<string, unknown>).aggregationField = aggField;
          const payload = {
            answer: `${values.length} distinct ${aggField} values across ${aggRows.length} matched documents`,
            total: search.total,
            sampled: aggRows.length,
            field: aggField,
            values,
            confidence: overallConfidence,
            assumptions,
            queryPlanCard: planCard,
            trace,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        const payload = {
          answer: rows.length === search.total
            ? `${rows.length} matches`
            : `Showing first ${rows.length} of ${search.total} matches`,
          total: search.total,
          rows,
          confidence: overallConfidence,
          assumptions,
          queryPlanCard: planCard,
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
    "ml_capabilities",
    "RUNTIME CAPABILITY INTROSPECTION. Returns, per tool, the parameters this build actually supports. " +
    "Use this to avoid trial-and-error when documentation and runtime drift apart: if a parameter is not " +
    "listed here, this build does not accept it.\n\n" +
    "Call with no arguments to enumerate every introspected tool, or pass tool='<name>' to inspect one. " +
    "Currently covers the high-frequency NL/search/answer tools where contract drift has caused friction.",
    {
      tool: z.string().optional().describe("Tool name to inspect. Omit to list every introspected tool."),
    },
    async ({ tool }) => {
      if (tool) {
        const cap = getCapability(tool);
        if (!cap) {
          return {
            content: [{
              type: "text",
              text: `No capability manifest for "${tool}". Available: ${TOOL_CAPABILITIES.map((c) => c.name).join(", ")}.`,
            }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(cap, null, 2) }] };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ tools: TOOL_CAPABILITIES }, null, 2),
        }],
      };
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

interface PlanCardInput {
  cts: Record<string, unknown> | undefined;
  q: string | undefined;
  collection: string | undefined;
  candidateFields: string[];
  normalizedFilters: Array<{ field: string; normalizedValues: string[] }>;
  includeResidual: boolean;
}

function buildPlanCard(input: PlanCardInput): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (input.q) params.q = input.q;
  if (input.cts) params.structured_query = input.cts;
  if (input.collection) params.collection = input.collection;
  if (input.candidateFields.length) params.select_fields = input.candidateFields;
  params.page_length = 50;
  params.normalize_whitespace = true;

  const runnable = {
    tool: "ml_search",
    params,
  };

  const alternatives: Array<{ description: string; tool: string; params: Record<string, unknown> }> = [];
  for (const f of input.normalizedFilters) {
    alternatives.push({
      description: `Group by ${f.field} to see how matches break down`,
      tool: "ml_search",
      params: {
        ...params,
        group_by: f.field,
        count: true,
      },
    });
    alternatives.push({
      description: `Distinct values of ${f.field}`,
      tool: "ml_search",
      params: {
        collection: input.collection,
        distinct: f.field,
        page_length: 200,
      },
    });
  }
  if (input.cts && !input.includeResidual && input.q) {
    alternatives.push({
      description: "Re-run with residual free-text included (looser scope)",
      tool: "ml_answer_query",
      params: {
        question: "<same question>",
        collection: input.collection,
        include_residual: true,
      },
    });
  }

  return {
    runnable,
    alternatives: alternatives.slice(0, 3),
  };
}

async function sampleScope(
  clients: MarkLogicClients,
  collection: string | undefined,
  database: string | undefined
): Promise<{ inferredFields: string[]; observedValuesByField: Map<string, string[]> }> {
  let inferredFields: string[] = [];
  const observedValuesByField = new Map<string, string[]>();
  try {
    const schema = await clients.schema.discoverSchema({
      collection,
      sampleSize: 10,
      database,
    });
    inferredFields = schema.inferredFields
      .filter((f) => f.type === "string" || f.type === "date" || f.type === "number")
      .map((f) => f.path);
    for (const f of schema.inferredFields) {
      if (!f.exampleValues?.length) continue;
      const values = f.exampleValues
        .filter((v) => typeof v === "string" || typeof v === "number")
        .map((v) => String(v));
      if (values.length) observedValuesByField.set(f.path, Array.from(new Set(values)));
    }
  } catch {
    // discovery is best-effort
  }
  return { inferredFields, observedValuesByField };
}

function wordsRemoved(before: string, after: string): string[] {
  const beforeWords = before
    .replace(/[?!.,;:]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const afterSet = new Set(after.toLowerCase().split(/\s+/).filter(Boolean));
  return beforeWords.filter((w) => !afterSet.has(w.toLowerCase()));
}

function computeConfidence(
  filters: Array<{ confidence: string; matchedValue?: string }>
): "high" | "medium" | "low" {
  if (filters.length === 0) return "low";
  const allMatched = filters.every((f) => f.matchedValue !== undefined);
  if (allMatched) return "high";
  const anyHigh = filters.some((f) => f.confidence === "high");
  return anyHigh ? "medium" : "low";
}

function pickProjectionFields(
  parsed: ReturnType<typeof parseQuestionWithAliases>,
  inferred: string[]
): string[] {
  const priority: string[] = [];
  for (const f of parsed.fieldFilters) {
    if (!priority.includes(f.field)) priority.push(f.field);
  }
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
  for (const f of inferred) {
    if (priority.length >= 6) break;
    if (!priority.includes(f) && !f.includes(".")) priority.push(f);
  }
  return priority.slice(0, 6);
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
export { projectField, titleCase };
