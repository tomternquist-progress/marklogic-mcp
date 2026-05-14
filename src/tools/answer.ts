import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";
import {
  aggregateByField,
  parseQuestionWithAliases,
  projectField,
  projectRow,
  resolveFilters,
  type ProjectedRow,
  type ResolvedFilter,
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
import { routeToCollection } from "../utils/collection-routing.js";
import { closestMatch, makeToolError, newCorrelationId } from "../utils/tool-error.js";

interface SearchAttempt {
  step: string;
  cts: Record<string, unknown> | null;
  q: string | undefined;
  count: number;
  elapsedMs: number;
  decisionReason: string;
}

import {
  ML_ANSWER_QUERY_SHAPE,
  ML_CAPABILITIES_SHAPE,
  ML_QUERY_RECIPE_SHAPE,
} from "./answer-shapes.js";
// Re-export for callers (and tests) that referenced the old answer.ts location.
export { ML_ANSWER_QUERY_SHAPE, ML_CAPABILITIES_SHAPE, ML_QUERY_RECIPE_SHAPE };

export function registerAnswerTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_answer_query",
    "ONE-SHOT QUESTION ANSWERING. Takes a natural-language question and returns a concise answer with " +
    "rows, an audit trace (CTS shape, normalized values, fields used, per-stage confidence), and a " +
    "set of one-click next_actions.\n\n" +
    "INTERNAL FLOW:\n" +
    "  1. Route to a collection if not specified (score by name + field-overlap with the question).\n" +
    "  2. Sample the collection: schema + observed values per field.\n" +
    "  3. Parse the question against an alias dictionary. Strip filler.\n" +
    "  4. Normalize each filter phrase against observed values (case + plural + closest match).\n" +
    "  5. Build a structured value-query and execute. Residual filler is suppressed by default.\n" +
    "  6. On zero hits: rewrite filters using closest observed values, then word-query, then residual.\n" +
    "  7. Project the most useful fields inline, optionally dedupe, and return — with a plan card.\n\n" +
    "ANSWER MODES:\n" +
    "  • rows               — matching rows with projected fields (default).\n" +
    "  • rows_deduped       — rows collapsed by rows_unique_by (or a built-in preset).\n" +
    "  • rows_plus_rollup   — rows + raw_count/unique_count rollup in one call.\n" +
    "  • count              — total document count only.\n" +
    "  • group(field)       — group matched rows by the named (or auto-picked) field.\n" +
    "  • distinct(field)    — distinct values of the named (or auto-picked) field + counts.\n\n" +
    "TRANSLATION-ONLY MODE (translation_only=true): build and return the CTS, normalized values, " +
    "stage confidence, and runnable next_actions WITHOUT executing.\n\n" +
    "Use this for English questions over a known dataset. For unknown intents call ml_suggest_approach first.",
    ML_ANSWER_QUERY_SHAPE,
    async ({
      question,
      collection,
      answer_mode,
      mode: strategyMode,
      group_by,
      rows_unique_by,
      database,
      max_results,
      include_residual,
      translation_only,
    }) => {
      const mode = answer_mode ?? "rows";
      const strategy: "strict" | "balanced" | "broad" = strategyMode ?? "balanced";
      const sampleSize = max_results ?? (mode === "group" || mode === "distinct" || mode === "titles" ? 250 : 50);
      const includeResidual = include_residual === true;
      const translationOnly = translation_only === true;
      const attempts: SearchAttempt[] = [];

      const correlationId = newCorrelationId();
      const startedAt = Date.now();
      const timings: Record<string, number> = {};

      const trace: Record<string, unknown> = {
        question,
        answer_mode: mode,
        correlationId,
      };
      const stageConfidence: Record<string, "high" | "medium" | "low"> = {
        collection: collection ? "high" : "low",
        fieldMapping: "low",
        valueGrounding: "low",
      };
      const assumptions: string[] = [];

      try {
        // ── Stage 0: collection routing ──────────────────────────────────────
        let resolvedCollection = collection;
        let routingCandidates: Array<{ name: string; totalScore: number; documentCount: number }> = [];
        if (!resolvedCollection) {
          const routeStart = Date.now();
          const parsedForRouting = parseQuestionWithAliases(question, undefined);
          const route = await routeToCollection(clients, {
            question,
            parsedTags: parsedForRouting.fieldFilters.map((f) => f.tag),
            database,
          });
          timings.routeMs = Date.now() - routeStart;
          routingCandidates = route.candidates.map((c) => ({
            name: c.name,
            totalScore: c.totalScore,
            documentCount: c.documentCount,
          }));
          trace.routing = {
            confidence: route.confidence,
            reason: route.reason,
            candidates: routingCandidates,
          };
          stageConfidence.collection = route.confidence;
          if (route.picked) {
            resolvedCollection = route.picked.name;
            assumptions.push(`Auto-routed to collection "${resolvedCollection}" (${route.confidence} confidence).`);
          } else {
            assumptions.push(route.reason);
          }
        }
        trace.collection = resolvedCollection ?? null;

        // ── Stage 1: schema + observed values ────────────────────────────────
        const discoverStart = Date.now();
        const { inferredFields, observedValuesByField } = await sampleScope(
          clients,
          resolvedCollection,
          database
        );
        timings.discoverMs = Date.now() - discoverStart;
        trace.inferredFields = inferredFields.slice(0, 25);

        // ── Stage 2: NL parsing + tag resolution + filler strip ──────────────
        const parseStart = Date.now();
        const parsed = parseQuestionWithAliases(question, resolvedCollection);
        const resolved = resolveFilters(parsed, inferredFields);
        timings.parseMs = Date.now() - parseStart;
        const rawResidual = parsed.residual;
        const cleanedResidual = stripFiller(rawResidual);
        const droppedFiller = wordsRemoved(rawResidual, cleanedResidual);
        trace.parsedFilters = resolved;
        trace.residualRaw = rawResidual || undefined;
        trace.residualCleaned = cleanedResidual || undefined;
        trace.droppedFillerWords = droppedFiller;

        // Field-mapping confidence: did every tag resolve to an actual field?
        if (resolved.length === 0) {
          stageConfidence.fieldMapping = "low";
        } else {
          const allResolved = resolved.every((f) => f.field !== undefined);
          stageConfidence.fieldMapping = allResolved ? "high" : resolved.some((f) => f.field) ? "medium" : "low";
        }

        // ── Stage 3: value normalization (in-collection) ─────────────────────
        // Drop filters whose tag did not resolve to a field — the caller is
        // notified via stageConfidence and assumptions; falling back to
        // bareword is handled by the rescue layers.
        const groundedFilters = resolved.filter((f): f is ResolvedFilter & { field: string } => !!f.field);
        for (const f of resolved) {
          if (!f.field) {
            assumptions.push(
              `Could not ground semantic tag "${f.tag}" against any inferred field in this collection. ` +
              `Inferred fields: [${inferredFields.slice(0, 10).join(", ")}].`
            );
          }
        }
        const normalizedFilters = groundedFilters.map((f) => {
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
          const confidence: "high" | "medium" | "low" = matched
            ? matched.via === "exact" || matched.via === "singular" ? "high" : "medium"
            : observed.length ? "low" : "medium";
          return {
            tag: f.tag,
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

        if (normalizedFilters.length) {
          const anyHigh = normalizedFilters.some((f) => f.confidence === "high");
          const allHigh = normalizedFilters.every((f) => f.confidence === "high");
          stageConfidence.valueGrounding = allHigh ? "high" : anyHigh ? "medium" : "low";
        }

        // ── Stage 4: build CTS — strategy-aware ──────────────────────────────
        const titleField = inferTitleField(inferredFields);
        const valueSubQueries = normalizedFilters.map((f) => ({
          "value-query": {
            "json-property": f.field,
            text: f.normalizedValues,
          },
        }));
        let structuredQuery: Record<string, unknown> | undefined;
        let ctsKind: string | null = null;
        if (valueSubQueries.length) {
          const valueRoot = valueSubQueries.length === 1
            ? (valueSubQueries[0] as Record<string, unknown>)
            : { "and-query": { queries: valueSubQueries } };

          if (strategy === "strict") {
            structuredQuery = valueRoot;
            ctsKind = "value-query";
          } else {
            // balanced + broad: union value-query with word-query on the
            // title field for each parsed phrase, so a user's noun ("X")
            // matches both a categorical field whose value is "X" AND
            // titles that mention "X". Use the union of the normalised
            // values + the original phrase so the word-query catches both
            // forms without depending on MarkLogic's stemming rules.
            const titleClauses: Array<Record<string, unknown>> = [];
            if (titleField) {
              for (const f of normalizedFilters) {
                const phrases = Array.from(new Set([
                  f.originalPhrase,
                  ...f.normalizedValues,
                ]));
                titleClauses.push({
                  "word-query": {
                    "json-property": titleField,
                    text: phrases,
                  },
                });
              }
            }
            const branches: Array<Record<string, unknown>> = [valueRoot, ...titleClauses];
            if (strategy === "broad" && cleanedResidual.length) {
              branches.push({ "word-query": { text: [cleanedResidual] } });
            }
            structuredQuery = branches.length > 1
              ? { "or-query": { queries: branches } }
              : valueRoot;
            ctsKind = branches.length > 1 ? `or(${strategy})` : "value-query";
          }
        }
        trace.cts = structuredQuery ?? null;
        trace.ctsKind = ctsKind;
        trace.strategy = strategy;
        trace.titleField = titleField;

        const useResidual = includeResidual || (valueSubQueries.length === 0 && cleanedResidual.length > 0);
        const effectiveQ = useResidual ? cleanedResidual || undefined : undefined;
        trace.residualApplied = useResidual ? effectiveQ : null;

        const candidateFields = pickProjectionFields(
          normalizedFilters.map((f) => f.field),
          inferredFields
        );
        trace.projectionFields = candidateFields;

        // Wrapper that records every search call into trace.attempts[] so
        // operators can audit the full chain in one response. Returns the
        // same SearchResponse shape as clients.search.search().
        const runSearch = async (
          step: string,
          decisionReason: string,
          params: { q?: string; structuredQuery?: unknown; pageLength?: number }
        ) => {
          const t0 = Date.now();
          const res = await clients.search.search({
            q: params.q,
            structuredQuery: params.structuredQuery,
            collection: resolvedCollection,
            database,
            pageLength: params.pageLength ?? sampleSize,
          });
          attempts.push({
            step,
            cts: (params.structuredQuery as Record<string, unknown> | undefined) ?? null,
            q: params.q,
            count: res.total,
            elapsedMs: Date.now() - t0,
            decisionReason,
          });
          return res;
        };

        const overallConfidence = combineStageConfidence(stageConfidence);
        trace.confidence = overallConfidence;
        trace.stageConfidence = stageConfidence;

        // Pre-build next_actions used by both translation-only and execution paths.
        const buildActions = (): RunnableAction[] =>
          buildNextActions({
            cts: structuredQuery,
            q: effectiveQ,
            collection: resolvedCollection,
            normalizedFilters,
            projectionFields: candidateFields,
            routingCandidates,
            stageConfidence,
            question,
          });

        // ── Translation-only short-circuit ───────────────────────────────────
        if (translationOnly) {
          timings.totalMs = Date.now() - startedAt;
          trace.attempts = attempts;
          trace.timings = timings;
          const payload = {
            translation_only: true,
            answer: "Translation produced — query NOT executed.",
            confidence: overallConfidence,
            stageConfidence,
            collection: resolvedCollection ?? null,
            correlation_id: correlationId,
            timings,
            normalizedFilters,
            cts: structuredQuery ?? null,
            ctsKind,
            strategy,
            titleField,
            residualApplied: useResidual ? effectiveQ : null,
            droppedFillerWords: droppedFiller,
            next_actions: buildActions(),
            trace,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        // ── Stage 5: execute ─────────────────────────────────────────────────
        const executeStart = Date.now();
        let search = await runSearch(
          `primary:${strategy}`,
          ctsKind ? `${strategy} strategy with ${ctsKind} root` : "no structured filter (full-scope)",
          { q: effectiveQ, structuredQuery }
        );

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
        if (valueSubQueries.length === 0 && !effectiveQ) {
          assumptions.push("Question did not yield any filters; matching all documents in the scope.");
        }

        // ── Auto-rescue stack ────────────────────────────────────────────────
        // Layer 1: rewrite using closest-observed-value from the rescue sample.
        let rewroteUsingClosest = false;
        if (search.total === 0 && normalizedFilters.length) {
          const rescueValues = await collectScopeValues(
            clients,
            normalizedFilters.map((f) => f.field),
            resolvedCollection,
            database
          );
          const rewrittenFilters = normalizedFilters.map((f) => {
            const observed = rescueValues.get(f.field) ?? [];
            if (!observed.length) return f;
            for (const c of valueCandidates(f.originalPhrase)) {
              const m = closestKnownValue(c, observed);
              if (m) {
                rewroteUsingClosest = true;
                return {
                  ...f,
                  normalizedValues: [m.value],
                  matchedValue: m.value,
                  matchedVia: `rescue:${m.via}`,
                };
              }
            }
            return f;
          });
          if (rewroteUsingClosest) {
            const rewrittenSubQueries = rewrittenFilters.map((f) => ({
              "value-query": {
                "json-property": f.field,
                text: f.normalizedValues,
              },
            }));
            const rewrittenStructured: Record<string, unknown> = rewrittenSubQueries.length === 1
              ? (rewrittenSubQueries[0] as Record<string, unknown>)
              : { "and-query": { queries: rewrittenSubQueries } };
            const retry = await runSearch(
              "rescue:closestValues",
              `Rewriting filters from observed values: ${rewrittenFilters.map((rf) => `${rf.field}="${rf.matchedValue}"`).join(", ")}`,
              { q: effectiveQ, structuredQuery: rewrittenStructured }
            );
            (trace as Record<string, unknown>).originalCts = structuredQuery;
            (trace as Record<string, unknown>).rewrittenCts = rewrittenStructured;
            if (retry.total > 0) {
              search = retry;
              structuredQuery = rewrittenStructured;
              trace.cts = rewrittenStructured;
              trace.normalizedFilters = rewrittenFilters;
              const changes = rewrittenFilters
                .filter((rf, i) => rf.matchedValue !== normalizedFilters[i].matchedValue)
                .map((rf) => `${rf.field}="${rf.matchedValue}"`)
                .join(", ");
              assumptions.push(
                `Primary returned 0; rescued by rewriting filters from closestValues (${changes}).`
              );
            }
          }
        }

        // Layer 2: word-query on the original phrase against the filter field.
        if (search.total === 0 && valueSubQueries.length) {
          const wordSubQueries = normalizedFilters.map((f) => ({
            "word-query": {
              text: [f.originalPhrase],
              "json-property": f.field,
            },
          }));
          const wordStructured: Record<string, unknown> = wordSubQueries.length === 1
            ? (wordSubQueries[0] as Record<string, unknown>)
            : { "and-query": { queries: wordSubQueries } };
          const retry = await runSearch(
            "rescue:word-query",
            "Falling back to tokenised word-query on the parsed filter fields",
            { q: effectiveQ, structuredQuery: wordStructured }
          );
          if (retry.total > 0) {
            search = retry;
            structuredQuery = wordStructured;
            trace.cts = wordStructured;
            trace.ctsKind = "word-query";
            assumptions.push("Rescued with tokenised word-query for looser matching.");
          }
        }

        // Layer 3: residual as free-text (universal index).
        if (search.total === 0 && !useResidual && cleanedResidual.length) {
          const retry = await runSearch(
            "rescue:free-text",
            `Falling back to universal-index q="${cleanedResidual}"`,
            { q: cleanedResidual, structuredQuery }
          );
          if (retry.total > 0) {
            search = retry;
            trace.residualApplied = cleanedResidual;
            assumptions.push(`Rescued with free-text q="${cleanedResidual}".`);
          }
        }

        timings.executeMs = Date.now() - executeStart;
        timings.totalMs = Date.now() - startedAt;
        trace.attempts = attempts;
        trace.timings = timings;
        // Concise summary of the rescue ladder — same data as attempts[]
        // but reduced to (step, count, elapsedMs) so callers can see at a
        // glance which stage produced the final result without parsing the
        // full attempts log.
        trace.rescueLadder = attempts.map((a) => ({
          step: a.step,
          count: a.count,
          elapsedMs: a.elapsedMs,
        }));
        trace.successfulStep = attempts.find((a) => a.count > 0)?.step ?? null;

        const nextActions = buildActions();

        if (search.total === 0) {
          const rescue = await buildRescue(
            normalizedFilters,
            cleanedResidual.length > 0,
            candidateFields,
            resolvedCollection,
            database,
            clients
          );
          timings.totalMs = Date.now() - startedAt;
          trace.timings = timings;
          const payload = {
            answer: "No matching documents.",
            total: 0,
            returned: 0,
            has_more: false,
            confidence: overallConfidence,
            stageConfidence,
            collection: resolvedCollection ?? null,
            correlation_id: correlationId,
            timings,
            trace,
            rescue,
            assumptions,
            next_actions: nextActions,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        if (mode === "count") {
          const payload = {
            answer: `${search.total} matching documents`,
            total: search.total,
            returned: 0,
            has_more: search.total > 0,
            confidence: overallConfidence,
            stageConfidence,
            collection: resolvedCollection ?? null,
            correlation_id: correlationId,
            timings,
            assumptions,
            next_actions: nextActions,
            trace,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        // Project rows.
        const uris = search.results.map((r) => r.uri);
        const docs = await clients.search.fetchDocs(uris, database);

        // For dedupe modes we need projection fields to include the dedupe keys.
        const dedupeKeys = resolveDedupeKeys(rows_unique_by, mode);

        if (mode === "group" || mode === "distinct" || mode === "titles") {
          const aggField = mode === "titles"
            ? (titleField ?? group_by ?? candidateFields[0])
            : group_by ?? (normalizedFilters[0]?.field as string | undefined) ?? candidateFields[0];
          if (!aggField) {
            return makeToolError({
              code: "INVALID_PARAMETER",
              class: "user_input",
              message: "No aggregation field could be inferred from the question.",
              hint: `Pass group_by=<field>. Discovered fields: [${inferredFields.slice(0, 8).join(", ")}].`,
              exampleValid: {
                question,
                collection: resolvedCollection,
                answer_mode: mode,
                group_by: inferredFields[0] ?? "<field>",
              },
              correlationId,
            });
          }
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
            answer: mode === "titles"
              ? `${values.length} distinct ${aggField} values matched`
              : `${values.length} distinct ${aggField} values across ${aggRows.length} matched documents`,
            total: search.total,
            total_documents: search.total,
            returned: values.length,
            has_more: false,
            sampled: aggRows.length,
            field: aggField,
            values,
            distinct_titles: mode === "titles" ? values.map((v) => v.value) : undefined,
            confidence: overallConfidence,
            stageConfidence,
            collection: resolvedCollection ?? null,
            correlation_id: correlationId,
            timings,
            assumptions,
            next_actions: nextActions,
            trace,
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        const rowFields = dedupeKeys
          ? Array.from(new Set([...candidateFields, ...dedupeKeys]))
          : candidateFields;
        const rows: ProjectedRow[] = search.results.map((r) =>
          projectRow(r.uri, docs.get(r.uri), rowFields, {
            normalizeWhitespace: true,
            score: r.score,
          })
        );

        if (mode === "rows_deduped" || mode === "rows_plus_rollup") {
          if (!dedupeKeys || !dedupeKeys.length) {
            const sampleKey = inferredFields.length ? inferredFields.slice(0, 2) : ["<id>", "<discriminator>"];
            return makeToolError({
              code: "MISSING_PARAMETER",
              class: "user_input",
              message: `${mode} requires rows_unique_by — the tool does not infer business keys per dataset.`,
              hint:
                `Pick keys whose combination uniquely identifies an entity in this collection. ` +
                (inferredFields.length
                  ? `Discovered fields: [${inferredFields.slice(0, 8).join(", ")}].`
                  : `Call ml_search_surface to discover field names first.`),
              exampleValid: {
                question,
                collection: resolvedCollection,
                answer_mode: mode,
                rows_unique_by: sampleKey,
              },
              correlationId,
            });
          }
          const { unique, uniqueCount } = dedupeRows(rows, dedupeKeys);
          const payload: Record<string, unknown> = {
            answer: `${uniqueCount} unique entities across ${rows.length} matched rows`,
            total: search.total,
            returned: unique.length,
            has_more: rows.length < search.total,
            raw_count: rows.length,
            unique_count: uniqueCount,
            dedupe_keys: dedupeKeys,
            rows: unique,
            confidence: overallConfidence,
            stageConfidence,
            collection: resolvedCollection ?? null,
            correlation_id: correlationId,
            timings,
            assumptions,
            next_actions: nextActions,
            trace,
          };
          if (mode === "rows_plus_rollup") {
            payload.rollup = {
              raw_count: rows.length,
              unique_count: uniqueCount,
              dedupe_keys: dedupeKeys,
            };
          }
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        // For datasets with a known title field, surface distinct_titles inline
        // so callers get the "name list" they typically want without a second call.
        let distinctTitlesInline: unknown[] | undefined;
        if (titleField && rows.length) {
          const titleAgg = aggregateByField(rows, titleField, { normalizeWhitespace: true, limit: 25 });
          distinctTitlesInline = titleAgg.map((t) => t.value);
        }

        const payload = {
          answer: rows.length === search.total
            ? `${rows.length} matches`
            : `Showing first ${rows.length} of ${search.total} matches`,
          total: search.total,
          total_documents: search.total,
          returned: rows.length,
          has_more: rows.length < search.total,
          rows,
          distinct_titles: distinctTitlesInline,
          confidence: overallConfidence,
          stageConfidence,
          collection: resolvedCollection ?? null,
          correlation_id: correlationId,
          timings,
          assumptions,
          next_actions: nextActions,
          trace,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return makeToolError({
          code: "UPSTREAM_FAILURE",
          class: "upstream",
          message: toToolError(err),
          hint: "ml_answer_query relies on ml_search + schema discovery. Retry with an explicit `collection` and `database`, or call ml_search_surface first to verify the scope is reachable.",
          correlationId,
        });
      }
    }
  );

  server.tool(
    "ml_capabilities",
    "RUNTIME CAPABILITY INTROSPECTION. Two modes:\n\n" +
    "  1. Inspect mode: ml_capabilities tool='<name>' → returns the parameter manifest for that tool.\n" +
    "     ml_capabilities (no args) → returns every introspected tool's manifest.\n\n" +
    "  2. Payload-check mode: ml_capabilities tool='<name>' payload={...} → strips keys the tool does\n" +
    "     not accept, suggests the closest accepted name for each dropped key, and returns the cleaned\n" +
    "     payload + a warnings block. Useful for previewing a request before hitting strict Zod\n" +
    "     validation errors — common when the same client targets multiple tool versions or when an\n" +
    "     agent generates a superset payload from incomplete docs.\n\n" +
    "If a parameter is not listed in this tool's output, this build does not accept it. Currently " +
    "covers the high-frequency NL/search/answer tools where contract drift has caused friction.",
    ML_CAPABILITIES_SHAPE,
    async ({ tool, payload }) => {
      if (tool) {
        const cap = getCapability(tool);
        if (!cap) {
          const allNames = TOOL_CAPABILITIES.map((c) => c.name);
          const closest = closestMatch(tool, allNames);
          return makeToolError({
            code: "UNKNOWN_NAME",
            class: "user_input",
            message: `No capability manifest for "${tool}".`,
            hint: closest
              ? `Did you mean "${closest}"? Otherwise: ${allNames.join(", ")}.`
              : `Available tools: ${allNames.join(", ")}.`,
            details: { available: allNames, closest },
            exampleValid: closest ? { tool: closest } : { tool: allNames[0] },
          });
        }

        // Payload-check mode: strip + warn + suggest closest names for drops.
        if (payload && typeof payload === "object") {
          const acceptedNames = new Set(cap.params.map((p) => p.name));
          const cleanedPayload: Record<string, unknown> = {};
          const droppedKeys: Array<{ key: string; closest?: string; reason: string }> = [];
          for (const [k, v] of Object.entries(payload)) {
            if (acceptedNames.has(k)) {
              cleanedPayload[k] = v;
              continue;
            }
            const closest = closestMatch(k, Array.from(acceptedNames));
            droppedKeys.push({
              key: k,
              closest,
              reason: closest
                ? `Not accepted by ${tool}. Closest accepted name: "${closest}".`
                : `Not accepted by ${tool}. Accepted: [${Array.from(acceptedNames).join(", ")}].`,
            });
          }
          const warnings = droppedKeys.map(
            (d) => `Dropped "${d.key}" — ${d.reason}`
          );
          const ready = droppedKeys.length === 0;
          const result = {
            tool,
            mode: "payload_check" as const,
            ready,
            cleaned_payload: cleanedPayload,
            dropped_keys: droppedKeys,
            warnings,
            note: ready
              ? `Payload is valid for ${tool}. Submit cleaned_payload to that tool to execute.`
              : `${droppedKeys.length} key(s) were dropped. Submit cleaned_payload to ${tool} to execute, ` +
                `or correct the dropped keys (see closest/reason) and re-check.`,
            capability: cap,
          };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
    ML_QUERY_RECIPE_SHAPE,
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
        const names = QUERY_RECIPES.map((r) => r.name);
        const closest = closestMatch(recipe, names);
        return makeToolError({
          code: "UNKNOWN_NAME",
          class: "user_input",
          message: `Unknown recipe "${recipe}".`,
          hint: closest
            ? `Did you mean "${closest}"? Otherwise call recipe='list' to enumerate.`
            : `Call recipe='list' to see available templates.`,
          details: { available: names, closest },
          exampleValid: closest ? { recipe: closest, params: {} } : { recipe: "list" },
        });
      }

      const merged = { ...(params ?? {}) };
      const missing = def.requiredParams.filter((p) => merged[p] == null);
      if (missing.length) {
        const example: Record<string, unknown> = { recipe: def.name, params: {} };
        for (const p of def.requiredParams) {
          (example.params as Record<string, unknown>)[p] = `<${p}>`;
        }
        return makeToolError({
          code: "MISSING_PARAMETER",
          class: "user_input",
          message: `Recipe "${recipe}" is missing required parameter(s): ${missing.join(", ")}.`,
          hint: `Required: ${def.requiredParams.join(", ")}. Provided: ${Object.keys(merged).join(", ") || "<none>"}.`,
          details: { missing, required: def.requiredParams },
          exampleValid: example,
        });
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

interface RunnableAction {
  label: string;
  tool: string;
  params: Record<string, unknown>;
  hint?: string;
}

interface NextActionsInput {
  cts: Record<string, unknown> | undefined;
  q: string | undefined;
  collection: string | undefined;
  normalizedFilters: Array<{ field: string; matchedValue?: string; originalPhrase: string }>;
  projectionFields: string[];
  routingCandidates: Array<{ name: string; totalScore: number; documentCount: number }>;
  stageConfidence: Record<string, "high" | "medium" | "low">;
  question: string;
}

function buildNextActions(input: NextActionsInput): RunnableAction[] {
  const actions: RunnableAction[] = [];
  const baseSearchParams: Record<string, unknown> = {};
  if (input.q) baseSearchParams.q = input.q;
  if (input.cts) baseSearchParams.structured_query = input.cts;
  if (input.collection) baseSearchParams.collection = input.collection;
  if (input.projectionFields.length) baseSearchParams.select_fields = input.projectionFields;
  baseSearchParams.page_length = 50;
  baseSearchParams.normalize_whitespace = true;

  actions.push({
    label: "Run this query as-is in ml_search",
    tool: "ml_search",
    params: baseSearchParams,
  });

  // Did-you-mean: re-run with a different collection from the routing pool.
  if (input.stageConfidence.collection !== "high" && input.routingCandidates.length > 1) {
    for (const c of input.routingCandidates.slice(0, 3)) {
      if (c.name === input.collection) continue;
      actions.push({
        label: `Re-run scoped to collection "${c.name}"`,
        tool: "ml_answer_query",
        params: {
          question: input.question,
          collection: c.name,
        },
        hint: `Routing candidate (score ${c.totalScore}, ${c.documentCount} docs).`,
      });
      if (actions.length >= 4) break;
    }
  }

  // Did-you-mean: re-run with a different normalized value.
  for (const f of input.normalizedFilters) {
    if (!f.matchedValue) continue;
    if (f.matchedValue.toLowerCase() === f.originalPhrase.toLowerCase()) continue;
    actions.push({
      label: `Confirm rewrite: ${f.field}="${f.matchedValue}" (you asked about "${f.originalPhrase}")`,
      tool: "ml_search",
      params: {
        collection: input.collection,
        structured_query: {
          "value-query": {
            "json-property": f.field,
            text: [f.matchedValue],
          },
        },
        select_fields: input.projectionFields,
        page_length: 50,
      },
    });
  }

  // Aggregation shortcuts.
  for (const f of input.normalizedFilters.slice(0, 2)) {
    actions.push({
      label: `Distinct values of ${f.field} in this collection`,
      tool: "ml_search",
      params: {
        collection: input.collection,
        distinct: f.field,
        page_length: 200,
      },
    });
  }

  return actions.slice(0, 5);
}

function resolveDedupeKeys(
  explicit: string[] | undefined,
  mode: string
): string[] | undefined {
  if (mode !== "rows_deduped" && mode !== "rows_plus_rollup") return undefined;
  if (explicit?.length) return explicit;
  return undefined;
}

/**
 * Best-effort title-field inference. Looks for conventional "title" / "name"
 * / "*Title" / "*Name" patterns in the discovered fields. Used for the
 * balanced-mode word-query union and for the `titles` answer mode.
 */
function inferTitleField(inferred: string[]): string | undefined {
  const priorities = ["title", "name", "displayName", "label"];
  for (const p of priorities) {
    if (inferred.includes(p)) return p;
  }
  return inferred.find((f) => /title$|name$/i.test(f));
}

function dedupeRows(rows: ProjectedRow[], keys: string[]): { unique: ProjectedRow[]; uniqueCount: number } {
  const seen = new Map<string, ProjectedRow>();
  for (const r of rows) {
    const key = keys
      .map((k) => {
        const v = r[k];
        return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      })
      .join("|");
    if (!seen.has(key)) seen.set(key, r);
  }
  return { unique: Array.from(seen.values()), uniqueCount: seen.size };
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

/**
 * Pull distinct values for a list of fields by sampling a broader slice of
 * the scope than the initial schema-discovery sample. Used by the auto-rescue
 * pass to build a fresh closestValues set for the fields we care about.
 */
async function collectScopeValues(
  clients: MarkLogicClients,
  fields: string[],
  collection: string | undefined,
  database: string | undefined
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!fields.length) return out;
  const sample = await clients.search.search({
    q: "",
    collection,
    database,
    pageLength: 30,
  }).catch(() => null);
  if (!sample || !sample.results.length) return out;
  const uris = sample.results.map((r) => r.uri);
  const docs = await clients.search.fetchDocs(uris, database);
  for (const field of fields) {
    const rows: ProjectedRow[] = sample.results.map((r) =>
      projectRow(r.uri, docs.get(r.uri), [field], { normalizeWhitespace: true })
    );
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row[field];
      if (v == null) continue;
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      if (s.length) seen.add(s);
    }
    if (seen.size) out.set(field, Array.from(seen));
  }
  return out;
}

function wordsRemoved(before: string, after: string): string[] {
  const beforeWords = before
    .replace(/[?!.,;:]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const afterSet = new Set(after.toLowerCase().split(/\s+/).filter(Boolean));
  return beforeWords.filter((w) => !afterSet.has(w.toLowerCase()));
}

function combineStageConfidence(
  stages: Record<string, "high" | "medium" | "low">
): "high" | "medium" | "low" {
  const values = Object.values(stages);
  if (values.every((v) => v === "high")) return "high";
  if (values.some((v) => v === "low")) return "low";
  return "medium";
}

function pickProjectionFields(
  filterFields: string[],
  inferred: string[]
): string[] {
  const priority: string[] = [];
  // 1. Resolved filter fields the question targeted — always relevant.
  for (const f of filterFields) {
    if (f && !priority.includes(f)) priority.push(f);
  }
  // 2. Generic headline-style fields (title/name/identifier) — common across
  //    most datasets and useful for chat-scale display when present.
  for (const f of inferred) {
    if (priority.length >= 8) break;
    if (priority.includes(f)) continue;
    if (/title$|name$|^id$|Id$|Number$|Date$/i.test(f)) priority.push(f);
  }
  // 3. Round out with whatever else the collection exposes.
  for (const f of inferred) {
    if (priority.length >= 8) break;
    if (!priority.includes(f) && !f.includes(".")) priority.push(f);
  }
  return priority.slice(0, 8);
}

interface RescuePayload {
  totalAtScope: number;
  closestValues: Array<{ field: string; value: unknown; count: number }>;
  suggestedReformulations: string[];
  candidateFields: string[];
}

async function buildRescue(
  normalizedFilters: Array<{ field: string; originalPhrase: string }>,
  hasResidual: boolean,
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
  if (normalizedFilters.length) {
    const f = normalizedFilters[0];
    suggestions.push(`Try matching on actual ${f.field} values — see closestValues above.`);
    suggestions.push(`Loosen the filter: ml_search q="${f.originalPhrase}" collection="${collection ?? '<scope>'}"`);
  } else if (hasResidual) {
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
