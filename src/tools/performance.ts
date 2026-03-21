import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerPerformanceTools(
  server: McpServer,
  clients: MarkLogicClients,
  allowEval: boolean
): void {
  // ── ml_explain_optic ─────────────────────────────────────────────────────────

  server.tool(
    "ml_explain_optic",
    "Get the execution plan for an Optic query without running it. Shows join strategy, " +
    "which indexes are used, and whether document expansion is required. Use BEFORE running " +
    "a slow or large Optic query to verify the plan is efficient.\n\n" +
    "KEY PLAN NODES TO LOOK FOR:\n" +
    "• 'lexicon' or 'TemplateLexiconPlan' = index-only (fast, no document loading)\n" +
    "• 'document' = document expansion required (slower; acceptable when needed)\n" +
    "• 'join' = join between two plan sources (ensure both sides have TDE views)\n" +
    "• 'limit' = result cap in place (good; prevents full scans)\n" +
    "• 'order-by' = sorting (needs a range index on the sort column to be efficient)\n\n" +
    "PREREQUISITE: A valid $optic plan. Use ml_views_list to discover available views.",
    {
      plan: z.union([z.record(z.unknown()), z.string()]).describe(
        "Serialized Optic plan as a JSON object or JSON string (same format as ml_optic_query)"
      ),
      database: z.string().optional().describe("Target database (uses server default if omitted)"),
    },
    async ({ plan, database }) => {
      let planObj: Record<string, unknown>;
      if (typeof plan === "string") {
        try {
          planObj = JSON.parse(plan) as Record<string, unknown>;
        } catch {
          return {
            content: [{ type: "text", text: "Invalid plan: could not parse as JSON." }],
            isError: true,
          };
        }
      } else {
        planObj = plan;
      }

      try {
        const result = await clients.performance.explainOptic(planObj, database);
        const hints = analyzeOpticPlan(result);
        const output = [
          "=== OPTIC EXECUTION PLAN ===",
          JSON.stringify(result, null, 2),
          "",
          "=== PLAN ANALYSIS ===",
          ...hints,
        ].join("\n");
        return { content: [{ type: "text", text: output }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── ml_search_query_plan ─────────────────────────────────────────────────────

  server.tool(
    "ml_search_query_plan",
    "Run a search in debug mode to see the resolved CTS query structure and estimate. " +
    "Use to verify that a query resolves correctly (correct cts: query type, correct indexes " +
    "targeted) and to see how many candidates it produces BEFORE filtering.\n\n" +
    "KEY THINGS TO CHECK IN OUTPUT:\n" +
    "• 'total' — estimated result count from index resolution\n" +
    "• 'plan' or 'qtext' — the resolved CTS query that was executed\n" +
    "• If the query returns far more results than expected, the index resolution is too broad\n" +
    "  → add a more specific range constraint or narrow the collection scope\n" +
    "• For large collections with field-level filters: add range indexes and use\n" +
    "  structured_query with range-constraint-query rather than a word search\n\n" +
    "NO EVAL REQUIRED. For runtime profiling (cache misses, filter activity), use ml_profile_query.",
    {
      q: z.string().optional().describe("Full-text search string"),
      structured_query: z.record(z.unknown()).optional().describe(
        "Structured query object (same format as ml_search). Used for precise field-level filtering."
      ),
      collection: z.string().optional().describe("Scope search to this collection"),
      database: z.string().optional().describe("Target database (uses server default if omitted)"),
      search_options: z.string().optional().describe("Named search options set stored in MarkLogic"),
    },
    async ({ q, structured_query, collection, database, search_options }) => {
      if (!q && !structured_query) {
        return {
          content: [{ type: "text", text: "Provide either q (full-text string) or structured_query." }],
          isError: true,
        };
      }
      try {
        const raw = await clients.performance.searchDebug({
          q,
          structuredQuery: structured_query,
          collection,
          database,
          searchOptions: search_options,
        });

        // Strip actual result snippets to keep output concise — keep metadata and plan
        const { results: _results, ...metadata } = raw as Record<string, unknown> & { results?: unknown };
        const hints = analyzeSearchDebug(raw);

        const output = [
          "=== SEARCH QUERY PLAN (debug=true) ===",
          JSON.stringify(metadata, null, 2),
          "",
          "=== QUERY ANALYSIS ===",
          ...hints,
        ].join("\n");
        return { content: [{ type: "text", text: output }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── ml_forest_metrics ─────────────────────────────────────────────────────────

  server.tool(
    "ml_forest_metrics",
    "Get per-forest health metrics for ingest and indexing diagnosis. Reports fragment counts, " +
    "stand counts, deleted-fragment ratio (fragmentation), and whether a merge is in progress.\n\n" +
    "WHAT TO LOOK FOR:\n" +
    "• Stand count approaching 64 → merge urgently needed (forest unavailable at 64 stands)\n" +
    "• Fragment count approaching 96 million → add forests and rebalance\n" +
    "• deletedFragmentPct > 20% → significant fragmentation; background merge will reclaim space\n" +
    "• mergeInProgress = true → normal background activity; heavy I/O is expected\n" +
    "• XDMP-INMMTREEFULL / XDMP-INMMLISTFULL in error log → increase in-memory stand settings\n\n" +
    "NO EVAL REQUIRED. Uses the Management API (port 8002).",
    {
      database: z.string().optional().describe(
        "Database name to inspect (uses 'Documents' if omitted). " +
        "Looks up forest names via database properties, then queries each forest's status."
      ),
    },
    async ({ database }) => {
      const dbName = database ?? "Documents";
      try {
        // Get the forest names associated with this database
        const dbProps = await clients.admin.getDatabaseProperties(dbName);
        const forestNames = (dbProps["forest"] as string[] | undefined) ?? [];
        if (forestNames.length === 0) {
          return {
            content: [{ type: "text", text: `No forests found for database '${dbName}'.` }],
          };
        }

        const forestResults: string[] = [`=== FOREST METRICS FOR DATABASE: ${dbName} ===`, ""];

        for (const forestName of forestNames) {
          try {
            const status = await clients.performance.getForestStatus(forestName);
            const { summary, hints } = analyzeForestStatus(forestName, status);
            forestResults.push(`--- Forest: ${forestName} ---`);
            forestResults.push(summary);
            if (hints.length > 0) {
              forestResults.push("ALERTS:");
              hints.forEach((h) => forestResults.push(`  ⚠ ${h}`));
            }
            forestResults.push("");
          } catch (forestErr) {
            forestResults.push(`--- Forest: ${forestName} --- ERROR: ${toToolError(forestErr)}`);
            forestResults.push("");
          }
        }

        return { content: [{ type: "text", text: forestResults.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── ml_profile_query (eval-gated) ─────────────────────────────────────────────

  if (allowEval) {
    server.tool(
      "ml_profile_query",
      "Profile XQuery, SJS, or SPARQL code to measure elapsed time and query resource consumption " +
      "(cache hits/misses, filter activity). Returns metrics from xdmp:query-meters / xdmp.queryMeters.\n\n" +
      "LANGUAGE OPTIONS:\n" +
      "• 'xquery'     — wrap an XQuery expression in a timing + query-meters block.\n" +
      "                 Code must be a single expression, not a full module with prolog.\n" +
      "                 Example: cts:search(fn:collection(), cts:word-query(\"hello\")) => fn:count()\n" +
      "• 'javascript' — wrap SJS code in a timing + xdmp.queryMeters block.\n" +
      "                 Code runs inside an IIFE; return statements work as expected.\n" +
      "• 'sparql'     — provide a SPARQL SELECT/CONSTRUCT string; executed via sem.sparql().\n\n" +
      "INTERPRETING RESULTS:\n" +
      "• elapsedMs high + filterMisses > 0 → filtered search; add range index or use 'unfiltered'\n" +
      "• elapsedMs high + listCacheMisses > 0 → index term lists read from disk\n" +
      "  (expected on first cold run; problem if persists on warm runs)\n" +
      "• expandedTreeCacheMisses > 0 → document trees not cached (E-node pressure or cold)\n" +
      "• filterMisses / (filterHits + filterMisses) = false-positive rate for filtered search\n" +
      "• To get the query PLAN (not runtime metrics) use: xdmp:plan(your_search_expr) in code\n" +
      "• To see unsearchable XPath steps: add xdmp:query-trace(true()) before your code\n\n" +
      "REQUIRES ML_ALLOW_EVAL=true.",
      {
        language: z.enum(["xquery", "javascript", "sparql"]).describe(
          "Code language: 'xquery' or 'javascript' for arbitrary code, 'sparql' for SPARQL SELECT/CONSTRUCT"
        ),
        code: z.string().describe(
          "The code or query to profile. " +
          "For 'xquery': a single expression (e.g. cts:search(...)). " +
          "For 'javascript': an expression or IIFE body — result of last expression is captured. " +
          "For 'sparql': a SPARQL query string (SELECT, CONSTRUCT, or ASK)."
        ),
        database: z.string().optional().describe("Target database (uses server default if omitted)"),
      },
      async ({ language, code, database }) => {
        try {
          let results;
          if (language === "xquery") {
            results = await clients.performance.profileXQuery(code, database);
          } else if (language === "sparql") {
            results = await clients.performance.profileSparql(code, database);
          } else {
            results = await clients.performance.profileJavaScript(code, database);
          }

          if (!results || results.length === 0) {
            return { content: [{ type: "text", text: "No profiling data returned." }] };
          }

          // Parse the metrics from the first result
          const rawValue = results[0]?.value;
          let metrics: Record<string, unknown> | null = null;
          try {
            metrics = typeof rawValue === "string" ? JSON.parse(rawValue) : (rawValue as Record<string, unknown>);
          } catch {
            // Fall back to raw display
          }

          const hints = metrics ? interpretQueryMetrics(metrics, language) : [];

          const output = [
            `=== QUERY PROFILE (${language}) ===`,
            metrics ? JSON.stringify(metrics, null, 2) : String(rawValue),
            "",
            "=== PERFORMANCE ANALYSIS ===",
            ...hints,
          ].join("\n");

          return { content: [{ type: "text", text: output }] };
        } catch (err) {
          const msg = toToolError(err);
          let annotated = msg;
          if (msg.includes("XDMP-NOPERMISSION") || msg.includes("privilege")) {
            annotated +=
              "\nHint: Profiling requires the 'http://marklogic.com/xdmp/privileges/xdmp-eval' " +
              "privilege and ML_ALLOW_EVAL=true. The user running the MCP server may lack this privilege.";
          }
          return { content: [{ type: "text", text: annotated }], isError: true };
        }
      }
    );
  }
}

// ── Analysis helpers ─────────────────────────────────────────────────────────

/** Scan the Optic explain plan JSON for common performance patterns. */
function analyzeOpticPlan(plan: Record<string, unknown>): string[] {
  const hints: string[] = [];
  const planStr = JSON.stringify(plan).toLowerCase();

  // Check for lexicon (index-only) vs document (expansion needed)
  const hasLexicon = planStr.includes("lexicon");
  const hasDocument = planStr.includes('"document"');
  if (hasLexicon && !hasDocument) {
    hints.push("GOOD: Plan is index-only (lexicon nodes) — no document expansion required. This will be fast.");
  } else if (hasDocument) {
    hints.push(
      "NOTE: Plan includes document expansion. Results require loading document bodies from disk. " +
      "This is acceptable when returning document fields not in a TDE view column, but ensure you " +
      "have a limit() to avoid expanding the full collection."
    );
  }

  // Check for limit
  const hasLimit = planStr.includes('"limit"') || planStr.includes("limitplan");
  if (!hasLimit) {
    hints.push(
      "WARNING: No LIMIT in plan. Without .limit(N), the query may process all matching rows. " +
      "Add .limit(N) to cap results, especially during development."
    );
  }

  // Check for joins
  const hasJoin = planStr.includes("join");
  if (hasJoin) {
    hints.push(
      "NOTE: Plan includes a join. Ensure both sides have TDE views with appropriate columns. " +
      "Push .where() constraints before .joinInner() to reduce the row set before joining."
    );
  }

  // Check for order-by
  const hasOrderBy = planStr.includes("order-by") || planStr.includes("orderby");
  if (hasOrderBy) {
    hints.push(
      "NOTE: Plan includes ORDER BY. For efficient sorting, the sort column must have a " +
      "MarkLogic range index. Without one, all matching documents must be loaded to sort. " +
      "Verify with ml_indexes_list."
    );
  }

  if (hints.length === 0) {
    hints.push(
      "Plan looks standard. Review the JSON above for estimated-count values: " +
      "high cardinality nodes without a following limit() indicate potential full scans."
    );
  }

  hints.push(
    "\nTIP: Use ml_optic_query to run the plan and compare actual vs estimated row counts. " +
    "A large discrepancy may indicate stale index statistics."
  );

  return hints;
}

/** Analyze search debug response for performance patterns. */
function analyzeSearchDebug(raw: Record<string, unknown>): string[] {
  const hints: string[] = [];
  const total = raw["total"] as number | undefined;
  const qtext = raw["qtext"] as string | undefined;

  if (typeof total === "number") {
    if (total === 0) {
      hints.push("Result count: 0. Verify the query resolves to the correct CTS expression above.");
    } else if (total > 100_000) {
      hints.push(
        `HIGH CANDIDATE COUNT: ${total.toLocaleString()} fragments pass index resolution. ` +
        "If the final result set is much smaller, filtering is doing significant work. " +
        "Consider narrowing the query with a collection scope or range constraint."
      );
    } else {
      hints.push(`Candidate count from index resolution: ${total.toLocaleString()}.`);
    }
  }

  if (qtext) {
    hints.push(`Resolved query text: ${qtext}`);
  }

  hints.push(
    "\nTIP: Compare 'total' (index estimate) against the actual result you expect. " +
    "A much higher total than expected means the query is not selective enough — add a " +
    "range constraint or tighter collection scope to reduce filtering work.\n" +
    "For runtime metrics (elapsed time, cache misses, filter activity), use ml_profile_query " +
    "with the equivalent XQuery or SJS code (requires ML_ALLOW_EVAL=true)."
  );

  return hints;
}

/** Unwrap a MarkLogic Management API {units, value} property envelope or return as-is. */
function unwrapMgmtValue(v: unknown): unknown {
  if (v !== null && typeof v === "object" && "value" in (v as object)) {
    return (v as { value: unknown }).value;
  }
  return v;
}

/** Safely extract a wrapped or plain numeric value from a Management API status-properties object. */
function extractMgmtNumber(obj: Record<string, unknown>, key: string): number | null {
  const raw = unwrapMgmtValue(obj[key]);
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  }
  return null;
}

/** Extract key metrics from a forest status Management API response. */
function analyzeForestStatus(
  forestName: string,
  raw: Record<string, unknown>
): { summary: string; hints: string[] } {
  const hints: string[] = [];

  // Management API response: forest-status → status-properties (each value is {units, value})
  // view=counts data is merged in as forest-status._counts by the client.
  const forestStatus = (raw["forest-status"] as Record<string, unknown> | undefined) ?? raw;
  const statusProps = (forestStatus["status-properties"] as Record<string, unknown> | undefined) ?? {};
  const countsData = (forestStatus["_counts"] as Record<string, unknown> | undefined) ?? {};

  const stateRaw = unwrapMgmtValue(statusProps["state"]);
  const state = typeof stateRaw === "string" ? stateRaw : "unknown";
  const mergeRaw = unwrapMgmtValue(statusProps["merge-in-progress"]);
  const mergeInProgress = mergeRaw === true || mergeRaw === "true";

  // Fragment/stand counts come from view=counts (counts-properties section)
  const countsProps = (countsData["counts-properties"] as Record<string, unknown> | undefined) ?? countsData;
  const standCount = extractMgmtNumber(countsProps, "stand-count");
  const fragmentCount = extractMgmtNumber(countsProps, "fragment-count") ??
                        extractMgmtNumber(countsProps, "active-fragment-count");
  const deletedFragmentCount = extractMgmtNumber(countsProps, "deleted-fragment-count");
  const activeFragmentCount = extractMgmtNumber(countsProps, "active-fragment-count");

  // Compute fragmentation percentage
  const totalFragments = fragmentCount !== null ? fragmentCount : 0;
  const deletedPct =
    totalFragments > 0 && deletedFragmentCount !== null
      ? Math.round((deletedFragmentCount / totalFragments) * 100)
      : 0;

  const summary = [
    `State: ${state}`,
    standCount !== null ? `Stand count: ${standCount} / 64 max` : null,
    fragmentCount !== null ? `Fragment count: ${fragmentCount.toLocaleString()}` : null,
    deletedFragmentCount !== null
      ? `Deleted fragments: ${deletedFragmentCount.toLocaleString()} (${deletedPct}% fragmentation)`
      : null,
    activeFragmentCount !== null ? `Active fragments: ${activeFragmentCount.toLocaleString()}` : null,
    `Merge in progress: ${mergeInProgress}`,
  ]
    .filter(Boolean)
    .join("\n");

  // Generate alerts
  if (standCount !== null && standCount >= 50) {
    hints.push(
      `Stand count ${standCount}/64 is dangerously high. MarkLogic becomes unavailable at 64 stands. ` +
      "Ensure merges are running (check background-io-limit setting) or reduce ingest rate."
    );
  } else if (standCount !== null && standCount >= 30) {
    hints.push(
      `Stand count ${standCount}/64 is elevated. Monitor merge activity to ensure it keeps up with ingest.`
    );
  }

  if (fragmentCount !== null && fragmentCount >= 90_000_000) {
    hints.push(
      `Fragment count ${fragmentCount.toLocaleString()} is approaching the 96 million per-forest limit. ` +
      "Add forests and rebalance (ml_database_properties to check rebalancer config)."
    );
  }

  if (deletedPct > 30) {
    hints.push(
      `High fragmentation: ${deletedPct}% of fragments are deleted. ` +
      "Background merges will reclaim this space automatically. If disk is tight, " +
      "you can trigger a forced merge via the Admin UI (Forests → {name} → Merge)."
    );
  } else if (deletedPct > 15) {
    hints.push(
      `Moderate fragmentation: ${deletedPct}% deleted fragments. Normal for active ingest. ` +
      "Background merges handle this automatically."
    );
  }

  if (state !== "open" && state !== "unknown") {
    hints.push(
      `Forest state '${state}' is not 'open'. Queries and ingest to this forest may be affected.`
    );
  }

  return { summary, hints };
}

/** Interpret query meters and generate performance hints. */
function interpretQueryMetrics(
  metrics: Record<string, unknown>,
  language: string
): string[] {
  const hints: string[] = [];

  const elapsedMs = metrics["elapsedMs"] as number | undefined;
  const filterMisses = metrics["filterMisses"] as number | undefined;
  const filterHits = metrics["filterHits"] as number | undefined;
  const listCacheMisses = metrics["listCacheMisses"] as number | undefined;
  const expandedTreeCacheMisses = metrics["expandedTreeCacheMisses"] as number | undefined;
  const resultCount = (metrics["resultCount"] ?? metrics["rowCount"]) as number | undefined;

  if (elapsedMs !== undefined) {
    if (elapsedMs < 10) {
      hints.push(`Elapsed: ${elapsedMs}ms — very fast (likely index-only).`);
    } else if (elapsedMs < 100) {
      hints.push(`Elapsed: ${elapsedMs}ms — fast.`);
    } else if (elapsedMs < 1000) {
      hints.push(`Elapsed: ${elapsedMs}ms — moderate. Review cache misses and filter activity below.`);
    } else {
      hints.push(
        `Elapsed: ${elapsedMs}ms — SLOW. Likely causes: filtered search, cold cache, or unindexed scan. ` +
        "See specific hints below."
      );
    }
  }

  if (filterMisses !== undefined && filterMisses > 0) {
    const filterTotal = (filterHits ?? 0) + filterMisses;
    const falsePosRate = filterTotal > 0 ? Math.round((filterMisses / filterTotal) * 100) : 0;
    hints.push(
      `FILTERED SEARCH: ${filterMisses.toLocaleString()} documents were loaded from disk to verify match ` +
      `(${falsePosRate}% false-positive rate from index resolution). ` +
      "Options to improve:\n" +
      "  1. Add a range index on the constrained field so the query can run unfiltered.\n" +
      "  2. Add 'unfiltered' option to cts:search / cts.search() if false positives are acceptable.\n" +
      "  3. Scope the search to a specific collection first to reduce candidate count."
    );
  } else if (filterMisses === 0 && (filterHits ?? 0) > 0) {
    hints.push("GOOD: Search ran filtered but with 0 false positives — index resolution was precise.");
  } else if (filterMisses === 0 && filterHits === 0) {
    hints.push("Query ran unfiltered (no document-level verification needed).");
  }

  if (listCacheMisses !== undefined && listCacheMisses > 0) {
    hints.push(
      `LIST CACHE: ${listCacheMisses.toLocaleString()} index term list misses — read from disk. ` +
      "This is expected on the first (cold) run. If still high on subsequent warm runs, the " +
      "List Cache may be undersized relative to the number of indexed terms. " +
      "Check xdmp:cache-status() for partition-busy% (if > 80%, the cache is under pressure)."
    );
  }

  if (expandedTreeCacheMisses !== undefined && expandedTreeCacheMisses > 0) {
    hints.push(
      `EXPANDED TREE CACHE: ${expandedTreeCacheMisses.toLocaleString()} misses — document trees expanded ` +
      "from disk. If this is high on warm runs, the E-node Expanded Tree Cache may be too small " +
      "relative to the working set, or too many distinct documents are being accessed per query."
    );
  }

  if (language === "sparql" && elapsedMs !== undefined && elapsedMs > 500) {
    hints.push(
      "SPARQL NOTE: All SPARQL joins execute in-memory on the E-node. For complex graph queries:\n" +
      "  • Filter by rdf:type first to reduce the join input.\n" +
      "  • Use NAMED GRAPH scoping (GRAPH <uri> { ... }) to avoid scanning all graphs.\n" +
      "  • For SPARQL-heavy workloads, separate E-nodes and D-nodes are recommended.\n" +
      "  • Minimum 64 GB RAM on E-nodes for production semantics applications."
    );
  }

  if (hints.length === 0) {
    hints.push(
      "Query metrics look healthy. For deeper analysis:\n" +
      "  • In XQuery, add xdmp:plan(your_search_expr) to see the index plan.\n" +
      "  • Add xdmp:query-trace(true()) before your code and check ErrorLog.txt for 'unsearchable' steps."
    );
  }

  return hints;
}

/** Safely extract a numeric value from a nested object using common key patterns. */
function extractNumber(obj: Record<string, unknown>, key: string): number | null {
  const val = obj[key];
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseInt(val, 10);
    return isNaN(n) ? null : n;
  }
  return null;
}
