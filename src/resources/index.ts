import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

const INSTRUCTIONS_TEXT = `\
MARKLOGIC MCP — PROBLEM-FIRST DECISION GUIDE
============================================

READ THIS BEFORE CALLING ANY TOOL.

This server exposes 42+ tools across 9 domains. Reaching for the wrong tool wastes
round-trips and produces inferior results. Use the decision principles and
problem→solution table below to identify the MarkLogic-native approach first, then
select the matching tools.

Also invoke the "problem_advisor" prompt with a natural-language goal whenever the
right approach is not immediately obvious. It will return a structured 6-section
analysis (classification → native approach → discovery sequence → tool sequence →
pitfalls → alternatives) before any tool is called.


── DECISION PRINCIPLES (in priority order) ────────────────────────────────────

1. DISCOVER BEFORE YOU QUERY
   Never assume a collection name, field name, or index exists. Start with
   ml_collections_list → ml_schema_discover → ml_indexes_list before writing
   any query or import plan.

2. NATIVE BEFORE EVAL
   Every problem has a native MarkLogic API. Use ml_search, ml_optic_query,
   ml_sparql_query, ml_values_query before reaching for ml_eval_javascript or
   ml_eval_xquery. Eval tools are last-resort: ~10 KB payload limit, no parallel
   batching, requires ML_ALLOW_EVAL=true.

3. FLUX BEFORE REST FOR BULK LOADS
   Any import of more than ~10 documents must use flux_import, not ml_document_put
   in a loop. Flux gives parallel batching, ZIP/gzip decompression, HTTP URL fetch,
   and automatic TDE generation in a single call.

4. SCHEMA AFTER IMPORT, NOT BEFORE
   TDE templates apply at query time — write and fix them after import without
   re-importing. Use ml_tde_validate to verify; ml_schema_get_tde to inspect.

5. OPTIC FOR JOINS AND AGGREGATIONS
   For joins across collections, GROUP BY aggregates, or BI export, use Optic API
   via ml_optic_query. Requires TDE views — check ml_schema_get_tde first.

6. SPARQL FOR ENTITY RELATIONSHIPS
   When data is modelled as subject-predicate-object triples or needs graph
   traversal, use ml_sparql_query. Check ml_graphs_list first.

7. SEARCH FOR FULL-TEXT AND FACETING
   MarkLogic's universal index makes ml_search very fast over millions of documents.
   Use ml_search with structured_query for precision; ml_facets_query for categories;
   ml_suggest for autocomplete.

8. TIME-SERIES VIA RANGE INDEXES
   Bucketed time aggregations hit range indexes directly via ml_timeseries_query and
   ml_values_query. No document scanning. Prerequisite: verify with ml_indexes_list.

9. ASK problem_advisor WHEN UNSURE
   If the goal does not map cleanly to the table below, invoke the problem_advisor
   prompt before picking any tool.


── PROBLEM → MARKLOGIC-NATIVE SOLUTION TABLE ──────────────────────────────────

PROBLEM TYPE         NATIVE APPROACH            PRIMARY TOOLS             DISCOVER FIRST
──────────────────────────────────────────────────────────────────────────────────────────
Load data (bulk)     Flux import pipeline       flux_import               flux_status
                                                flux_preview
                                                (flux_help for flags)

Load data (few docs) REST document API          ml_document_put           —
                                                ml_document_patch

Full-text search     Universal index /          ml_search                 ml_collections_list
                     Search API                 ml_search_qbe             ml_schema_discover
                                                ml_suggest
                                                ml_facets_query

Structured filter    Structured query /         ml_search                 ml_indexes_list
(range/date/numeric) range index                ml_values_query           ml_schema_discover

Analytics /          Optic API over TDE         ml_optic_query            ml_schema_get_tde
aggregation          row views                  ml_aggregate_query        ml_schema_discover
                                                (optic_query_builder)     ml_tde_validate

Export for BI        Optic → tabular export     ml_export_tabular         ml_schema_get_tde
(QuickSight etc.)                               ml_optic_query            ml_indexes_list
                                                flux_export

Graph / entity       Triple store / SPARQL      ml_sparql_query           ml_graphs_list
relationships                                   (sparql_query_builder)

Time-series          Range index / values API   ml_timeseries_query       ml_indexes_list
                                                ml_values_query           ml_collections_list

Schema discovery     TDE + schema sampling      ml_schema_discover        ml_collections_list
                                                ml_schema_get_tde
                                                ml_indexes_list
                                                ml_namespaces_list

Data transform /     Reprocess pipeline /       flux_reprocess            ml_document_list
enrichment           SJS module                 ml_document_patch
                                                ml_invoke_module

Database admin /     Management API             ml_cluster_status         —
health                                          ml_databases_list
                                                ml_database_statistics
                                                ml_forests_list
                                                ml_servers_list

Query planning       Query approach advisor     query_approach_advisor    ml_views_list
(cts.search/Optic)                                                         ml_indexes_list

Code generation      Prompt templates           xquery_function_generator —
(XQuery/SJS/TDE)                                sjs_module_generator
                                                tde_schema_generator
                                                rest_extension_generator

Data import design   Import advisor prompt      data_import_advisor       —
                                                flux_import

QuickSight design    Dataset/dashboard prompts  quicksight_dataset_designer ml_schema_discover
                                                quicksight_dashboard_planner


── OPTIC vs CTS.SEARCH SELECTION GUIDE ────────────────────────────────────────

Use this when your goal involves querying data that already exists in MarkLogic.
Choose based on WHAT you need, not what you already know how to write.

QUERY GOAL                     BEST TOOL            INDEX REQUIREMENT
────────────────────────────────────────────────────────────────────────────────
Find documents by content /    ml_search            None (universal index)
keyword / ranked relevance     (cts.search)         Always available

Filter documents by exact      ml_search            Range index recommended
field value or date range      structured_query     (verify: ml_indexes_list)

Count / sum / average /        ml_optic_query       TDE view in Schemas DB
GROUP BY over a field          (Optic fromView)     (verify: ml_views_list)

Join two collections by key    ml_optic_query       TDE views for both
                               (join-inner)         collections required

Search content THEN aggregate  ml_optic_query       TDE view + cts query
results (hybrid)               (Optic fromSearch)   composable in plan

Count distinct field values    ml_values_query      Range index or element
/ faceted navigation           ml_facets_query      word index required

OPTIC RULES OF THUMB:
• fromView → use for SQL-like filtering, GROUP BY, joins over TDE row views
• fromSearch → use when you need full-text relevance to scope an Optic pipeline
• select() every column you actually need — avoids scanning unused columns
• push where() before groupBy() to reduce the row set early
• orderBy() takes exactly ONE argument; wrap multiple sort keys in an array:
    single: {"fn":"order-by","args":{"fn":"desc","args":["col"]}}
    multi:  {"fn":"order-by","args":[[{"fn":"asc","args":["col1"]},{"fn":"desc","args":["col2"]}]]}
• TDE template MUST be in Schemas DB, collection http://marklogic.com/xdmp/tde
• Reindex takes time after TDE install — check ml_reindex_status before querying

CTS.SEARCH RULES OF THUMB (via ml_search):
• word-query uses the universal index — always safe, no prerequisite
• range-query requires a pre-existing range index — check ml_indexes_list first
• structured_query is more precise than the q string for field-level filters
• For counting by category, ml_values_query is faster than paging result sets
• Use collection parameter to scope search to one collection before filtering
• Never use full-scan queries (no cts predicates) against large collections

WHEN TO COMBINE THEM (hybrid):
  Goal: "Find documents about X, then count by category Y"
  → Optic fromSearch with a cts.wordQuery scoping, then groupBy on a TDE column
  → Requires both a TDE view AND the content to be indexed (always true)
  → Use the query_approach_advisor prompt to build the plan


── TOOL GROUPS AT A GLANCE ─────────────────────────────────────────────────────

Admin (7):     ml_cluster_status, ml_databases_list, ml_database_properties,
               ml_database_statistics, ml_forests_list, ml_servers_list,
               ml_server_properties

Documents (2–5, config-dependent):
               ml_document_get, ml_document_list
               [write-enabled] ml_document_put, ml_document_delete, ml_document_patch

Search (4):    ml_search, ml_search_qbe, ml_values_query, ml_suggest

Schema (6):    ml_schema_discover, ml_schema_get_tde, ml_tde_validate,
               ml_indexes_list, ml_collections_list, ml_namespaces_list

Eval (3, gated): ml_eval_javascript, ml_eval_xquery, ml_invoke_module

Graph (2):     ml_sparql_query, ml_graphs_list

QuickSight (4): ml_aggregate_query, ml_timeseries_query, ml_export_tabular,
                ml_facets_query

Optic (1):     ml_optic_query

Flux (7):      flux_import, flux_export, flux_copy, flux_reprocess,
               flux_preview, flux_help, flux_status
`;

export function registerAllResources(server: McpServer, clients: MarkLogicClients): void {
  // List of databases
  server.resource(
    "marklogic_databases",
    "marklogic://databases",
    { mimeType: "application/json", description: "List of all MarkLogic databases in the cluster" },
    async () => {
      try {
        const databases = await clients.admin.listDatabases();
        return { contents: [{ uri: "marklogic://databases", text: JSON.stringify(databases, null, 2), mimeType: "application/json" }] };
      } catch (err) {
        return { contents: [{ uri: "marklogic://databases", text: toToolError(err) }] };
      }
    }
  );

  // Cluster status
  server.resource(
    "marklogic_cluster_status",
    "marklogic://cluster/status",
    { mimeType: "application/json", description: "MarkLogic cluster health and version information" },
    async () => {
      try {
        const status = await clients.admin.getClusterStatus();
        return { contents: [{ uri: "marklogic://cluster/status", text: JSON.stringify(status, null, 2), mimeType: "application/json" }] };
      } catch (err) {
        return { contents: [{ uri: "marklogic://cluster/status", text: toToolError(err) }] };
      }
    }
  );

  // Document by URI (static resource — agents pass the doc URI as a parameter via ml_document_get)
  server.resource(
    "marklogic_document_info",
    "marklogic://documents",
    { mimeType: "text/plain", description: "MarkLogic document access. Use the ml_document_get tool to retrieve a specific document by URI." },
    async () => ({
      contents: [{
        uri: "marklogic://documents",
        text: "Use the ml_document_get tool to retrieve a MarkLogic document by URI.\nUse ml_document_list to browse available documents by collection or directory.",
        mimeType: "text/plain",
      }],
    })
  );

  // Problem-first decision guide — always-available context for AI agents
  server.resource(
    "marklogic_instructions",
    "marklogic://instructions",
    {
      mimeType: "text/plain",
      description: "Problem-first decision guide: maps user goals to MarkLogic-native capabilities and the correct MCP tools. Read this before calling any other tool.",
    },
    async () => ({
      contents: [{
        uri: "marklogic://instructions",
        text: INSTRUCTIONS_TEXT,
        mimeType: "text/plain",
      }],
    })
  );

  // Forests list
  server.resource(
    "marklogic_forests",
    "marklogic://forests",
    { mimeType: "application/json", description: "List of all MarkLogic forests" },
    async () => {
      try {
        const forests = await clients.admin.listForests();
        return { contents: [{ uri: "marklogic://forests", text: JSON.stringify(forests, null, 2), mimeType: "application/json" }] };
      } catch (err) {
        return { contents: [{ uri: "marklogic://forests", text: toToolError(err) }] };
      }
    }
  );
}
