import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── Intent patterns → tool recommendations ────────────────────────────────────

interface ToolRecipe {
  tool: string;
  description: string;
  use_when: string[];
  recipe: Record<string, unknown>;
  rationale: string;
  not_this_tool?: string;
  warnings?: string[];
}

function classify(task: string): ToolRecipe[] {
  const t = task.toLowerCase();
  const results: ToolRecipe[] = [];

  // ── Bulk import / URL fetch / file ingestion ────────────────────────────────
  const isBulkImport =
    /import|load|ingest|csv|tsv|parquet|avro|orc|jdbc|s3\b|http url|download|open data|socrata|gdelt|data\.gov|bulk|thousand|million|records|rows|dataset/.test(t);
  const isUrlFetch =
    /http[s]?:\/\/|url|download|fetch|public data|open data|api endpoint|socrata|gdelt/.test(t);
  const isFileFormat =
    /\.csv|\.tsv|\.json|\.parquet|\.avro|\.orc|\.zip|\.gz|delimited|comma.separated|tab.separated/.test(t);

  if (isBulkImport || isUrlFetch || isFileFormat) {
    const isSocrata = /socrata|data\.gov|city.*data|resource\/.*\.json/.test(t);
    const isJdbc = /jdbc|postgres|mysql|oracle|sql server|database table/.test(t);
    const isS3 = /s3[a]?:\/\/|amazon s3|s3 bucket/.test(t);
    const isHeaderless = /no header|headerless|column.names|gdelt/.test(t);
    const isJson = /\.json|json.lines|ndjson/.test(t) && !isSocrata;

    const subcommand = isJdbc ? "import-jdbc"
      : isS3 && isJson ? "import-files"
      : isJson ? "import-files"
      : "import-delimited-files";

    const recipe: Record<string, unknown> = {
      subcommand,
      collections: ["<collection-name>"],
      generate_tde: true,
      tde_schema: "<schema>",
      tde_view: "<view>",
    };

    if (isJdbc) {
      recipe.jdbc_url = "jdbc:<driver>://<host>/<database>";
      recipe.jdbc_driver = "<driver-class>";
      recipe.query = "SELECT * FROM <table>";
      delete recipe.generate_tde;
    } else if (isS3) {
      recipe.path = "s3a://<bucket>/<prefix>/";
    } else if (isUrlFetch || isBulkImport) {
      recipe.http_url = isSocrata
        ? "https://<domain>/resource/<id>.csv?$limit=10000"
        : "<https://example.com/data.csv>";
      recipe.uri_template = "/data/{<id-field>}.json";
    }

    if (isHeaderless) {
      recipe.column_names = ["Col1", "Col2", "..."];
      recipe.extra_args = ["--delimiter", "\\t", "--ignore-null-fields"];
    }

    const warnings: string[] = [];
    if (isSocrata) {
      warnings.push(
        "Use /rows.csv (not /rows.json) — Socrata's /rows.json returns an array-of-arrays format, not an array of objects. " +
        "URL pattern: https://<domain>/resource/<id>.csv?$limit=<n>"
      );
    }
    if (isJdbc) {
      warnings.push("JDBC driver JAR must be present in the flux-runner classpath.");
    }

    results.push({
      tool: "flux_import",
      description: "Bulk data import from URL, file, JDBC, or S3",
      use_when: ["bulk-import", "http-fetch", "csv", "json", "parquet", "jdbc", "s3", "tde-generation"],
      recipe,
      rationale:
        "flux_import handles HTTP fetch, format parsing, parallel batching, and optional TDE view generation in a single tool call. " +
        "It is 10–100× faster than manual approaches for bulk loads and avoids the ~10 KB eval payload limit entirely.",
      not_this_tool:
        "Do NOT use ml_eval_javascript (10 KB payload cap, no parallelism) or ml_document_put (one document at a time) for bulk loads.",
      warnings: warnings.length ? warnings : undefined,
    });
  }

  // ── Analytics / aggregation / reporting ────────────────────────────────────
  const isAnalytics =
    /aggregat|count|group.?by|sum\b|avg\b|average|max\b|min\b|analytic|report|dashboard|top \d|rank|totals?/.test(t);
  const isTimeSeries = /time.?series|over time|trend|daily|weekly|monthly|by (date|month|year)/.test(t);

  if (isAnalytics && !isTimeSeries) {
    results.push({
      tool: "ml_optic_query",
      description: "Aggregation and analytics over a TDE view",
      use_when: ["analytics-aggregation", "tde-view", "group-by", "sql-like"],
      recipe: {
        plan: {
          $optic: {
            ns: "op", fn: "operators", args: [
              { ns: "op", fn: "from-view", args: ["<schema>", "<view>"] },
              { ns: "op", fn: "group-by", args: [
                { ns: "op", fn: "col", args: ["<dimension-column>"] },
                [{ ns: "op", fn: "count", args: ["count", { ns: "op", fn: "col", args: ["<any-col>"] }] }]
              ]},
              { ns: "op", fn: "order-by", args: [{ ns: "op", fn: "desc", args: [{ ns: "op", fn: "col", args: ["count"] }] }] },
              { ns: "op", fn: "limit", args: [20] },
            ],
          },
        },
      },
      rationale:
        "ml_optic_query runs SQL-like row operations over TDE views — ideal for GROUP BY, aggregations, and multi-table joins. " +
        "Requires a TDE template in the Schemas database (use flux_import with generate_tde=true, or ml_schema_discover to find existing views).",
      warnings: [
        "Run ml_schema_discover or ml_indexes_list first to confirm TDE views exist.",
        "TDE template must be in the Schemas database under collection 'http://marklogic.com/xdmp/tde'.",
      ],
    });
  }

  if (isTimeSeries) {
    results.push({
      tool: "ml_timeseries_query",
      description: "Time-bucketed aggregation over a date/time field",
      use_when: ["time-series", "trend", "date-bucketing"],
      recipe: {
        schema: "<schema>",
        view: "<view>",
        time_field: "<date-or-datetime-column>",
        metric_field: "<numeric-column>",
        aggregation: "count",
        bucket: "day",
      },
      rationale:
        "ml_timeseries_query produces date-bucketed counts or sums in a single call, returning chart-ready data without manual Optic GROUP BY construction.",
      warnings: ["Requires a TDE view with a date/dateTime column for the time_field."],
    });
  }

  // ── Full-text / keyword search ──────────────────────────────────────────────
  const isSearch =
    /search|find|query|full.?text|keyword|word|contains|mention|document.*about/.test(t) &&
    !/import|ingest|load/.test(t);

  if (isSearch) {
    results.push({
      tool: "ml_search",
      description: "Full-text and structured document search",
      use_when: ["full-text-search", "keyword-search", "document-retrieval"],
      recipe: {
        q: "<search terms>",
        collection: "<collection-name>",
        page_length: 20,
      },
      rationale:
        "ml_search uses MarkLogic's Universal Index — no TDE or range index required for basic word queries. " +
        "Use ml_optic_query for exact-match structured filtering or aggregations.",
    });
  }

  // ── Hybrid: full-text search + aggregation ──────────────────────────────────
  // Detect goals that combine content scoping with aggregation — these need
  // Optic fromSearch, not a choice between ml_search OR ml_optic_query.
  const isHybrid =
    isSearch && isAnalytics && !isTimeSeries;

  if (isHybrid) {
    // Remove the standalone ml_search suggestion added above — the hybrid plan supersedes it
    const searchIdx = results.findIndex(r => r.tool === "ml_search");
    if (searchIdx !== -1) results.splice(searchIdx, 1);
    // Remove any standalone ml_optic_query suggestion too
    const opticIdx = results.findIndex(r => r.tool === "ml_optic_query");
    if (opticIdx !== -1) results.splice(opticIdx, 1);

    results.unshift({
      tool: "ml_optic_query (fromSearch + Optic pipeline)",
      description: "Hybrid: full-text content scoping followed by aggregation or GROUP BY",
      use_when: ["hybrid-search-aggregate", "search-then-count", "search-then-group"],
      recipe: {
        plan: {
          $optic: {
            ns: "op", fn: "operators", args: [
              {
                ns: "op", fn: "from-search",
                args: [{ ns: "cts", fn: "word-query", args: ["<search term>"] }],
              },
              {
                ns: "op", fn: "join-inner",
                args: [
                  { ns: "op", fn: "from-view", args: ["<schema>", "<view>"] },
                  { ns: "op", fn: "on", args: [
                    { ns: "op", fn: "fragment-id-col", args: [] },
                    { ns: "op", fn: "fragment-id-col", args: [] },
                  ]},
                ],
              },
              { ns: "op", fn: "group-by", args: [
                { ns: "op", fn: "col", args: ["<dimension-column>"] },
                [{ ns: "op", fn: "count", args: ["count", { ns: "op", fn: "col", args: ["<any-col>"] }] }],
              ]},
              { ns: "op", fn: "order-by", args: [{ ns: "op", fn: "desc", args: [{ ns: "op", fn: "col", args: ["count"] }] }] },
              { ns: "op", fn: "limit", args: [20] },
            ],
          },
        },
        strip_schema_prefix: true,
      },
      rationale:
        "When you need to BOTH filter by document content (full-text) AND aggregate/group results, " +
        "use Optic fromSearch as the source with a cts query for scoping, then join to a TDE view to access " +
        "structured columns for GROUP BY. This is faster than fetching all search results and post-processing them. " +
        "Requires a TDE view — verify with ml_views_list.",
      not_this_tool:
        "Do NOT use ml_search for aggregation (returns documents, not counts). " +
        "Do NOT use ml_optic_query fromView alone if you need content-based filtering.",
      warnings: [
        "Requires a TDE view in the Schemas database — use flux_import with generate_tde=true or ml_schema_get_tde to verify.",
        "fromSearch joins via fragment IDs — the TDE view must cover the same documents as the search collection.",
        "Run ml_views_list and ml_indexes_list before building this query.",
        "Use the query_approach_advisor prompt to get a complete, filled-in plan for your specific goal.",
      ],
    });
  }

  // ── Schema / TDE discovery ──────────────────────────────────────────────────
  const isSchemaDiscovery =
    /schema|tde|view|template|what.*fields|what.*columns|structure|discover|indexes?/.test(t) &&
    !/generate|create|build/.test(t);

  if (isSchemaDiscovery) {
    results.push({
      tool: "ml_schema_discover",
      description: "Discover existing TDE schemas and views",
      use_when: ["schema-discovery", "tde-exploration"],
      recipe: {
        database: "<database-name>",
      },
      rationale:
        "ml_schema_discover lists all TDE schemas and views already installed in the Schemas database. " +
        "Run this before ml_optic_query to confirm view names.",
      not_this_tool: "If no views exist yet, use flux_import with generate_tde=true to auto-generate a TDE from an imported collection.",
    });
  }

  // ── Single document write / TDE install / module install ───────────────────
  const isSingleWrite =
    /write|insert|create|update|put|store/.test(t) &&
    /document|tde|template|module|schema|config/.test(t) &&
    !isBulkImport;

  if (isSingleWrite) {
    results.push({
      tool: "ml_document_put",
      description: "Write a single document, TDE template, or module",
      use_when: ["single-document-write", "tde-template-install", "module-install"],
      recipe: {
        uri: "/path/to/document.json",
        content: "<JSON or XML string>",
        content_type: "application/json",
        collections: ["<collection>"],
        database: "<database>",
      },
      rationale:
        "ml_document_put is the right tool for installing TDE templates (database=Schemas), SJS/XQuery modules (database=Modules), or writing a small number of individual documents.",
      not_this_tool: "Do NOT use ml_document_put in a loop for bulk loads — use flux_import instead.",
    });
  }

  // ── Graph / semantic / SPARQL ───────────────────────────────────────────────
  const isGraph =
    /sparql|triple|graph|semantic|rdf|owl|ontolog|subject|predicate|object/.test(t);

  if (isGraph) {
    results.push({
      tool: "ml_sparql_query",
      description: "Query the MarkLogic semantic triple store",
      use_when: ["graph-query", "sparql", "rdf", "semantic"],
      recipe: {
        sparql: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 20",
        database: "<database>",
      },
      rationale: "ml_sparql_query executes SPARQL 1.1 against MarkLogic's built-in triple store.",
      warnings: ["Run ml_graphs_list first to discover named graph URIs."],
    });
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  const isExport =
    /export|extract|download from marklogic|dump|backup|send.*to|push.*to/.test(t) &&
    !/import|load|ingest/.test(t);

  if (isExport) {
    results.push({
      tool: "flux_export",
      description: "Export documents from MarkLogic to file, S3, or JDBC",
      use_when: ["export", "extract", "bi-integration"],
      recipe: {
        subcommand: "export-files",
        collections: ["<source-collection>"],
        path: "/tmp/export-output/",
      },
      rationale:
        "flux_export reads from MarkLogic in parallel batches and writes to local disk, S3, Parquet, Avro, or a JDBC target. " +
        "Use subcommand='export-parquet-files' for BI/analytics downstream consumption.",
    });
  }

  // ── Server-side logic / custom transformation ───────────────────────────────
  const isEval =
    /custom logic|transformation|xdmp|cts\.|built.?in|server.?side|xquery|sjs|javascript|compute|calculate|server.*function/.test(t) &&
    !isBulkImport;

  if (isEval) {
    results.push({
      tool: "ml_eval_javascript",
      description: "Server-side JavaScript for custom logic and MarkLogic built-ins",
      use_when: ["server-side-logic", "xdmp-access", "cts-access", "custom-transformation"],
      recipe: {
        javascript: "// Your SJS here\n'result';",
        vars: { myVar: "<value>" },
        database: "<database>",
      },
      rationale:
        "ml_eval_javascript is the right tool for calling MarkLogic built-ins (xdmp.*, cts.*) not exposed by other tools, " +
        "running custom in-database transformations, or one-off read/write operations on a small number of documents.",
      not_this_tool:
        "Do NOT use for bulk inserts or URL-fetched data — use flux_import for anything beyond ~5 documents.",
      warnings: [
        "~10 KB script payload limit — pass large arrays/strings via the vars parameter.",
        "xdmp.httpGet() requires outbound network access from the MarkLogic host — may be blocked.",
      ],
    });
  }

  // ── Fallback: if nothing matched, suggest problem_advisor prompt ────────────
  if (results.length === 0) {
    results.push({
      tool: "problem_advisor (prompt)",
      description: "General MarkLogic solution advisor",
      use_when: ["unknown-intent", "multi-step-planning"],
      recipe: {
        goal: task,
      },
      rationale:
        "The task did not match a specific tool pattern. Call the problem_advisor prompt with your goal to get a " +
        "structured 6-section analysis: problem classification, MarkLogic-native approach, discovery sequence, " +
        "recommended tool chain, pitfalls, and simpler alternatives.",
    });
  }

  return results;
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerSuggestApproachTool(server: McpServer): void {
  server.tool(
    "ml_suggest_approach",
    "Analyse a natural-language task description and return the recommended MarkLogic MCP tool chain, with ready-to-use recipe parameters, rationale, and warnings. Call this before starting any non-trivial task to avoid using the wrong tool (e.g. ml_eval_javascript for bulk import). Returns 1–3 ranked suggestions.",
    {
      task: z.string().describe(
        "Natural-language description of what you want to accomplish, e.g. 'import a CSV from a public URL into MarkLogic and create a view', 'find all documents mentioning climate change', 'export the sales collection to Parquet'."
      ),
    },
    async ({ task }) => {
      const suggestions = classify(task);

      const lines: string[] = [
        `APPROACH RECOMMENDATIONS FOR: "${task}"`,
        `${"─".repeat(60)}`,
        "",
      ];

      suggestions.forEach((s, i) => {
        lines.push(`## ${i + 1}. ${s.tool}`);
        lines.push(`   ${s.description}`);
        lines.push("");
        lines.push(`   CAPABILITIES: ${s.use_when.join(", ")}`);
        lines.push("");
        lines.push(`   RATIONALE: ${s.rationale}`);
        lines.push("");
        lines.push("   RECIPE:");
        lines.push("   ```json");
        lines.push(JSON.stringify(s.recipe, null, 4).split("\n").map(l => `   ${l}`).join("\n"));
        lines.push("   ```");
        if (s.not_this_tool) {
          lines.push("");
          lines.push(`   ⚠ AVOID: ${s.not_this_tool}`);
        }
        if (s.warnings?.length) {
          lines.push("");
          lines.push("   WARNINGS:");
          s.warnings.forEach(w => lines.push(`   - ${w}`));
        }
        lines.push("");
      });

      if (suggestions.length > 1) {
        lines.push(`${"─".repeat(60)}`);
        lines.push(`${suggestions.length} approaches matched. The first entry is the strongest match for your task.`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
