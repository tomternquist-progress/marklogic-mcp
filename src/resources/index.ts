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
relationships        + entity-oriented docs     (sparql_query_builder)
                                                data_modeling_advisor

Vector similarity    Optic vec:cosine-sim       ml_vector_search          ml_views_list
/ RAG / embeddings   over TDE vec:vector col    ml_optic_query            ml_schema_get_tde
(ML 12+)                                        data_modeling_advisor

Multi-model design   Document + Triple +        data_modeling_advisor     ml_collections_list
(combined)           Vector architecture        ml_vector_search          ml_graphs_list
                                                ml_sparql_query

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

URI design           URI designer prompt        uri_designer              —
(naming/keys)                                   ml_document_put
                                                flux_import (uri_template)

QuickSight design    Dataset/dashboard prompts  quicksight_dataset_designer ml_schema_discover
                                                quicksight_dashboard_planner


── URI DESIGN — ALWAYS CALL uri_designer BEFORE WRITING DOCUMENTS ─────────────

Before calling ml_document_put or setting uri_template in flux_import, decide on a
URI pattern using these rules. Use the uri_designer prompt when unsure.

RULE 1 — PREFIX WITH COLLECTION OR ENTITY TYPE
  Every URI starts with a path segment that groups related documents.
  ml_document_list can scope to this prefix as a "directory".
  Good: /orders/order-{orderId}.json   Bad: /{orderId}.json

RULE 2 — EMBED ALL PRIMARY KEY VALUES
  URI = stable, deterministic identity. Include every primary key field so the URI
  is collision-free and can be reconstructed from the source record alone.
  Good: /prices/{country}-{year}-{productId}.json   Bad: /prices/price.json

RULE 3 — MATCH URI PREFIX TO COLLECTION SHORT NAME
  Collection "orders" → URI prefix /orders/. This keeps directory listing and
  collection scoping consistent.

RULE 4 — HIERARCHICAL URIS FOR CHILD ENTITIES
  /customers/{customerId}/orders/{orderId}.json
  Enables: ml_document_list /customers/42/orders/ → all orders for one customer.

RULE 5 — IMMUTABLE KEYS ONLY
  Never embed mutable fields (status, name) in URIs. Only use stable IDs.

RULE 6 — URL-SAFE CHARACTERS ONLY
  letters, digits, /, -, _, .   Replace spaces and special chars before use.

FLUX uri_template SYNTAX:
  flux_import uses {FieldName} interpolation in uri_template.
  Example: "/orders/{orderId}.json" → Flux substitutes the value from each row.
  Use uri_designer to confirm the pattern before running flux_import.


── MULTI-MODEL DATA DESIGN ─────────────────────────────────────────────────────

MarkLogic stores Documents, Triples (RDF), and Vectors in the same database, all
query-able together. Choose the model(s) that match your data's structure.
Use the data_modeling_advisor prompt for a full design plan.

MODEL       STORE AS                    PRIMARY QUERY           PREREQUISITE
────────────────────────────────────────────────────────────────────────────────
Documents   JSON / XML in collections   ml_search               None
                                        ml_optic_query          TDE view

Triples     Embedded in entity docs     ml_sparql_query         None (embedded)
(RDF)       OR managed named graphs     ml_sparql_query         Named graph

Vectors     float[] field in doc        ml_vector_search        TDE view +
(ML 12+)    → TDE maps to vec:vector    ml_optic_query          vec:vector col


TRIPLE DESIGN — ENTITY-ORIENTED PATTERN (preferred):
  Goal: one document per entity; document URI = entity IRI; triples embedded inside.
  /entities/person/12345.json  ← document holds all entity properties + triples

  JSON UNMANAGED TRIPLE FORMAT — "triples" (plural) for the array key; each element wrapped in "triple":
  {
    "id": "12345", "name": "Alice",
    "triples": [
      { "triple": { "subject":   "http://example.org/person/12345",
                    "predicate": "http://schema.org/knows",
                    "object":    "http://example.org/person/67890" } },
      { "triple": { "subject":   "http://example.org/person/12345",
                    "predicate": "http://schema.org/name",
                    "object":    { "datatype": "http://www.w3.org/2001/XMLSchema#string",
                                   "value": "Alice" } } }
    ]
  }
  IRI objects → plain URI string. Literal objects → {"datatype":"...","value":"..."}.
  CAUTION: "sem:triples" as the JSON root key = MANAGED triples (raw RDF doc), not embedded.

  XML UNMANAGED TRIPLE FORMAT — sem:triple element (namespace http://marklogic.com/semantics):
  <doc xmlns:sem="http://marklogic.com/semantics">
    <id>12345</id>
    <sem:triple>
      <sem:subject>http://example.org/person/12345</sem:subject>
      <sem:predicate>http://schema.org/knows</sem:predicate>
      <sem:object>http://example.org/person/67890</sem:object>
    </sem:triple>
  </doc>
  Outer <sem:triples> wrapper is optional; <sem:triple> elements are required.
  CAUTION: a document whose ROOT element is <sem:triples> = MANAGED triples, not embedded.

  Benefits: one fragment holds structured data AND graph edges. cts.search and
  SPARQL both find it. TDE can expose both as Optic rows.

TRIPLE DESIGN — MANAGED TRIPLES THEN REPROCESS (import-first path):
  When you have raw RDF files (Turtle, N-Triples, RDF/XML):
  Step 1: flux_import subcommand=import-rdf-files → loads as managed triples in
          named graphs (one graph per source file). Fast initial load.
  Step 2: ml_sparql_query to GROUP triples by subject IRI and inspect structure.
  Step 3: flux_reprocess → SJS transform groups triples by IRI and writes one
          entity document per subject with embedded triples ("triple" key). Group by IRI
          where reasonable — avoid docs with thousands of unrelated triples.
  Step 4: ml_sparql_query continues to work; embedded triples are found automatically.
  Rule: one entity = one document = one IRI.

VECTOR DESIGN (MarkLogic 12+, no eval required):
  Step 1: Add "embedding": [float, ...] to documents when inserting.
  Step 2: TDE template column: {"name":"embedding","scalar":"vec:vector","val":"embedding"}
  Step 3: ml_vector_search(schema, view, vector_column, query_vector, k)
  Step 4: For hybrid (filter + vector): ml_optic_query with
          bind(as("score", vec:cosine-similarity(col("embedding"), vec:vector([...]))))
          + where() pre-filter + order-by(desc("score")) + limit(k)

MULTI-MODEL QUERY COMBINATIONS:
  Documents + Triples  → ml_search for text, ml_sparql_query for graph traversal
  Documents + Vectors  → ml_vector_search for similarity, ml_document_get for content
  Triples + Vectors    → ml_vector_search finds similar entities; SPARQL traverses edges
  All three (RAG)      → ml_vector_search → retrieve entity docs → SPARQL for context


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

Optic (3):     ml_optic_query, ml_views_list, ml_vector_search

Flux (7):      flux_import, flux_export, flux_copy, flux_reprocess,
               flux_preview, flux_help, flux_status

Prompts:       uri_designer, xquery_function_generator, sjs_module_generator,
               tde_schema_generator, rest_extension_generator,
               structured_query_builder, optic_query_builder, sparql_query_builder,
               query_approach_advisor, data_modeling_advisor, data_import_advisor,
               gdelt_import, quicksight_dataset_designer, quicksight_dashboard_planner,
               problem_advisor
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
