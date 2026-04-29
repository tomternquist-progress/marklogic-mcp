import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

const INSTRUCTIONS_TEXT = `\
MARKLOGIC MCP — PROBLEM-FIRST DECISION GUIDE
============================================

READ THIS BEFORE CALLING ANY TOOL.

This server exposes 100+ tools across 16 domains. Reaching for the wrong tool wastes
round-trips and produces inferior results. Use the decision principles and
problem→solution table below to identify the MarkLogic-native approach first, then
select the matching tools.

Also invoke the "problem_advisor" prompt with a natural-language goal whenever the
right approach is not immediately obvious. It will return a structured 6-section
analysis (classification → native approach → discovery sequence → tool sequence →
pitfalls → alternatives) before any tool is called.

★ STARTING A NEW PROJECT? Read this first ★
   Call ml_suggest_approach or invoke the "project_setup_advisor" prompt BEFORE writing
   any code or running any tools. Key principle: MCP tools are for exploration and
   prototyping; the canonical, repeatable pipeline uses Gradle + Flux CLI, not MCP calls:
     • Indexes → src/main/ml-config/databases/content-database.json → gradle mlDeploy
     • TDE     → src/main/ml-schemas/tde/                           → gradle mlLoadSchemas
     • Modules → src/main/ml-modules/root/                          → gradle mlLoadModules
     • Data    → Gradle Exec tasks calling: flux import-files / flux import-rdf-files
   See the PROJECT SETUP / DEPLOYMENT (ml-gradle) section below for the full layout.


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
   re-importing. ml_tde_install runs tde.validate on insert and rejects structurally
   broken templates (wrong "collections" shape, scalarType "IRI", "column" in triples)
   that would otherwise install silently and produce no working view. After install,
   use ml_views_list with verify_registered=true to confirm each view is live (live |
   reindexing | missing | error). Use ml_tde_validate (pass database= for multi-DB
   topologies) to check row counts; ml_schema_get_tde to inspect template content.

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

9. DIAGNOSE BEFORE GUESSING ON PERFORMANCE
   Never assume a query is slow due to a particular cause. Use the diagnostic tools:
   ml_explain_optic (Optic plan), ml_search_query_plan (CTS debug),
   ml_forest_metrics (ingest health), ml_profile_query (runtime metrics + cache stats).
   Then invoke performance_advisor with the symptoms for a structured remediation plan.

10. ASK problem_advisor WHEN UNSURE
    If the goal does not map cleanly to the table below, invoke the problem_advisor
    prompt before picking any tool.

11. FASTTRACK APPS START WITH SEARCH OPTIONS
    FastTrack UI widgets (SearchBar, FacetFilters, Geospatial Map, Timeline) are
    configured entirely through named search-options sets stored in MarkLogic.
    Use ml_search_options_list to see existing configs, ml_search_options_get to
    inspect them, and the fasttrack_search_designer prompt to generate a new one.
    Constraints in the options require pre-existing range or geospatial indexes —
    always call ml_indexes_list before designing constraints.


── PROBLEM → MARKLOGIC-NATIVE SOLUTION TABLE ──────────────────────────────────

PROBLEM TYPE         NATIVE APPROACH            PRIMARY TOOLS             DISCOVER FIRST
──────────────────────────────────────────────────────────────────────────────────────────
Load data (bulk)     Flux import pipeline       flux_import               flux_status
                                                flux_preview
                                                (flux_help for flags)

Load data (few docs) REST document API          ml_document_put           —
                                                ml_document_patch

Install TDE        Schema database             ml_tde_install            ml_schema_get_tde
template           (convenience wrapper for    ml_tde_validate
                   ml_document_put with        (use ml_tde_validate after
                   correct DB+collection)      install to verify rows)

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

Geospatial search    Geospatial element pair    ml_geospatial_search      ml_indexes_list
(radius / box /      index + structured query                             (index_type=geospatial)
 polygon)            (cts geospatial family)

Graph / entity       Triple store / SPARQL      ml_sparql_query           ml_graphs_list
relationships        + entity-oriented docs     (sparql_query_builder)
                                                data_modeling_advisor

Vector similarity    Optic annTopK / cosine      ml_vector_search          ml_views_list
/ RAG / embeddings   over TDE vec:vector col    ml_optic_query            ml_schema_get_tde
(ML 12+)             ANN hybrid: annTopK +      ml_eval_javascript        ml_reindex_status
                     fromSearchDocs +            data_modeling_advisor
                     vec.vectorScore             rag_pipeline_designer

Graph RAG /          Semaphore classify →        semaphore_classify        semaphore_status
concept-scoped       concept IDs →               ml_eval_javascript        semaphore_classes
retrieval            cts.jsonPropertyValueQuery  ml_search                 ml_collections_list
                     → URI scope → search/ANN    rag_pipeline_designer

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
                                                ml_document_patch_batch
                                                (parallel patch of many URIs)
                                                ml_invoke_module

Content              Semaphore Classification   semaphore_classify        semaphore_status
classification /     Server (CLS) + KMM         semaphore_classify_batch  semaphore_publish_sets
auto-tagging         taxonomy authoring         semaphore_publish_sets    semaphore_classes
(taxonomy /          (Progress Data Platform)   semaphore_classes         semaphore_kmm_models_list
concept extraction)  Classify via Flux or       semaphore_kmm_models_list
                     pre-classify app-side      semaphore_kmm_model_create
                                                semaphore_kmm_skos_load
                                                semaphore_kmm_sparql
                                                semaphore_kmm_sparql_update
                                                semaphore_publish
                                                semaphore_publish_config_fix_plain_skos
                                                semaphore_kid_template_get / _set /
                                                  _diagnose (tune CLS rule weights —
                                                  phrase/near/hierarchy/assoc)
                                                semaphore_task_list / _create / _commit
                                                  (governance: working-copy workflow
                                                   for production taxonomy changes)
                                                flux_import (classify_with_semaphore:
                                                  true — bulk classification at ingest)
                                                flux_reprocess
                                                semaphore_integration_advisor (prompt)

Database admin /     Management API             ml_cluster_status         —
health                                          ml_databases_list
                                                ml_database_properties
                                                ml_database_statistics
                                                ml_forests_list
                                                ml_servers_list
                                                ml_server_properties
                                                ml_reindex_status

Cluster diagnosis   Management API log files    ml_logs_list              ml_cluster_status
(read server logs)                              ml_logs_read
                                                (ErrorLog.txt,
                                                 8002_AccessLog.txt,
                                                 8020/8021 for DHF;
                                                 supports start/end/regex/tail)

Forest recovery     Management API database     ml_database_set_forests   ml_forests_list
(forest-hang fix)   properties                                            ml_cluster_status
                    Restrict DB to forests on
                    available hosts when nodes
                    are offline (accepts conn
                    but never responds pattern)

Security / RBAC      Management API +           ml_users_list             ml_roles_list
audit                REST permissions API        ml_roles_list             ml_users_list
("why can't user                                ml_document_permissions
X see doc Y?")

Query performance    Performance diagnostic      ml_explain_optic          ml_indexes_list
/ bottleneck         tools + advisor            ml_search_query_plan      ml_views_list
diagnosis            (filtered vs unfiltered,   ml_forest_metrics         ml_collections_list
                     range index coverage,      ml_force_merge (eval)     ml_reindex_status
                     Optic/SPARQL/ingest)       ml_profile_query (eval)
                                                performance_advisor (prompt)

Query planning       Query approach advisor     query_approach_advisor    ml_views_list
(cts.search/Optic)                                                         ml_indexes_list

Code generation      Prompt templates           xquery_function_generator —
(XQuery/SJS/TDE)                                sjs_module_generator
                                                tde_schema_generator
                                                rest_extension_generator

DHF flow execution   Data Hub Framework         dhf_status                dhf_flows_list
(entity pipelines:   flows/steps API            dhf_flows_list
 ingest → map →      Requires DHF 5.x +         dhf_flow_run              (check flow exists)
 match → master)     allowEval + !readonly       dhf_flow_run_jar
                     Flow runs async — poll     (jar runner when REST
                     dhf_job_status for result  runner is unavailable)
                                                dhf_job_status

Data integration     Envelope pattern           envelope_pattern_advisor  ml_document_sample
design / diagnosis   (source → headers →        ml_schema_discover        ml_collections_list
(multi-source,       instance → triples)
DHF / canonical)

Data import design   Import advisor prompt      data_import_advisor       —
                                                flux_import

URI design           URI designer prompt        uri_designer              —
(naming/keys)                                   ml_document_put
                                                flux_import (uri_template)

QuickSight design    Dataset/dashboard prompts  quicksight_dataset_designer ml_schema_discover
                                                quicksight_dashboard_planner

Project setup /      ml-gradle config-as-code   project_setup_advisor     —
deploy indexes       (content-database.json,    (prompt)
(ml-gradle / DHF)    ml-schemas/tde/)

FastTrack UI         Named search-options       ml_search_options_list    ml_indexes_list
(SearchBar,          (constraints = facets;     ml_search_options_get     ml_collections_list
 FacetFilters,       extract-document-data =    ml_search_options_put     ml_schema_discover
 Map, Timeline)      result card fields;        fasttrack_search_designer
                     geo/date constraints =     fasttrack_app_scaffold
                     map/timeline widgets)

Custom REST API      REST resource extensions   ml_extension_list         ml_extension_list
endpoint             deployed at                ml_extension_put          (check existing)
(biz logic,          /v1/resources/{name};      ml_extension_call
multi-op, custom     SJS exports.GET/POST;      ml_extension_get
response shape)      uses cts.search +          ml_extension_delete
                     cts.values inline;         rest_extension_generator
                     no separate options set    (prompt)


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


── PERFORMANCE DIAGNOSTICS ──────────────────────────────────────────────────

DIAGNOSTIC TOOLS (use BEFORE guessing at root cause):

ml_explain_optic       — Optic execution plan without running the query. No eval required.
                         Key: "lexicon" nodes = index-only (fast); "document" nodes = disk reads.
                         No "limit" node + high cardinality = full-scan risk.

ml_search_query_plan   — Search debug mode (debug=true). Shows resolved CTS query and
                         candidate count from index resolution. No eval required.
                         Compare "total" against expected results: large gap → low selectivity.

ml_profile_query       — Runtime profiling: elapsed time + query meters (cache stats, filter
                         activity). language: "xquery" | "javascript" | "sparql". Requires eval.
                         Returns: elapsedMs, filterMisses, listCacheMisses, expandedTreeCacheMisses.

ml_forest_metrics      — Per-forest health: stand count (max 64), fragment count (warn at 96M),
                         deleted-fragment % (fragmentation), merge-in-progress. No eval required.

Also useful (via ml_eval_xquery / ml_profile_query XQuery code):
  xdmp:plan(expr)      — shows index plan for a search expression (which indexes are used)
  xdmp:estimate(expr)  — fast index-only count; compare to fn:count() to measure selectivity
  xdmp:query-trace()   — logs "searchable" vs "unsearchable" XPath steps to ErrorLog.txt


FILTERED vs UNFILTERED SEARCH (most common performance issue):
  cts:search runs FILTERED by default: Step 1 = index resolution → Step 2 = load and verify.
  Step 2 loads every candidate document from disk — expensive for large result sets.
  → Add option "unfiltered" when the query is fully backed by range or word indexes.
  → Detect: ml_profile_query filterMisses > 0 = Step 2 is doing significant work.
  → Estimate false-positive rate: xdmp:estimate(unfiltered_expr) vs fn:count(filtered_result).
  → Unfiltered fast pagination: cts:search(fn:doc(), query, "unfiltered")[100001 to 100010]
    skips directly to position 100001 without fetching preceding fragments.


RANGE INDEX REQUIREMENTS (missing range index = full scan):
  cts:element-range-query, cts:attribute-range-query, cts:path-range-query
    → require a matching element/attribute/path range index
  ORDER BY in FLWOR  → requires range index on the last step of the order-by expression
  ml_values_query    → requires range index or element word index
  ml_facets_query    → requires range index per facet field
  Always: ml_indexes_list BEFORE writing any range-dependent query.
  After adding an index: ml_reindex_status until reindex-count = 0.


INGEST PERFORMANCE CHECKLIST:
  1. ml_forest_metrics to see stand count, fragment count, and merge activity.
  2. Stand count approaching 64 → reduce ingest rate or increase background-io-limit.
  3. XDMP-INMMTREEFULL / XDMP-INMMLISTFULL in error log → increase in-memory stand settings
     in Admin UI (Databases → {name} → in-memory tree/list/range-index size).
  4. Fragmentation > 20% → normal during heavy ingest; merge handles it automatically.
     After bulk deletes, use ml_force_merge to reclaim space before capacity projections.
  5. For maximum ingest throughput: use flux_import (parallel batching, not ml_document_put loop).


SPARQL PERFORMANCE:
  All SPARQL joins execute in-memory on the E-node. Complex graph traversals need RAM.
  Minimum 64 GB RAM on E-nodes for production semantics workloads.
  • Filter by rdf:type first (cheapest triple filter) before traversal predicates.
  • Use NAMED GRAPH scoping: GRAPH <uri> { ... } to avoid scanning all graphs.
  • SPARQL aggregations (GROUP BY, COUNT) happen on E-node — not D-node index.
  • Profile SPARQL: ml_profile_query(language="sparql", code="SELECT ...").
  For semantics-heavy clusters: separate E-nodes and D-nodes (reduces E-node memory contention).


QUERY METERS INTERPRETATION (ml_profile_query output):
  elapsedMs                     → total wall time
  filterMisses > 0              → documents loaded to verify match (filtered search)
  filterHits                    → documents that passed filter verification
  listCacheMisses > 0           → index term lists read from disk (cold or cache too small)
  expandedTreeCacheMisses > 0   → document trees expanded from disk (E-node pressure)
  Cold run has higher misses than warm — compare both for structural vs startup diagnosis.
  If listCacheMisses stay high on warm runs: List Cache is undersized for the indexed data.
  If expandedTreeCacheMisses stay high: too many documents in working set for E-node cache.

→ Invoke performance_advisor prompt with symptoms for a full structured remediation plan.


── PROJECT SETUP / DEPLOYMENT (ml-gradle) ──────────────────────────────────────

MarkLogic projects are configured as code via ml-gradle. When advising on adding
indexes, deploying TDE templates, or structuring a new project, use the
project_setup_advisor prompt. Key concepts:

STANDARD ml-gradle LAYOUT (src/main/):
  ml-config/databases/content-database.json  ← range/geospatial indexes, lexicons
  ml-config/security/{roles,users,privileges} ← app security
  ml-config/servers/                          ← REST/XDBC server config
  ml-schemas/tde/                             ← TDE templates; auto-assigned to
                                                http://marklogic.com/xdmp/tde collection
  ml-modules/root/                            ← XQuery/SJS application modules
  gradle.properties                           ← mlHost, mlRestPort, mlUsername, etc.
  gradle-{env}.properties                     ← per-environment overrides

DATA HUB FRAMEWORK (DHF) ADDITIONS:
  entities/            ← .entity.json descriptors; DHF auto-generates TDE from these
  flows/               ← ingestion / mapping / mastering orchestration
  mappings/            ← field-to-entity-model mappings
  hub-internal-config/ ← SYSTEM-MANAGED — do not edit (staging/jobs DBs, data-hub-* roles)
  ml-config/           ← editable final-database.json and custom security

KEY RULES:
  • Indexes live in content-database.json — adding one requires a reindex
    (check ml_reindex_status after deployment)
  • TDE templates in ml-schemas/tde/ deploy via "gradle mlLoadSchemas" and are
    immediately queryable without reimporting data
  • DHF has two content DBs: data-hub-STAGING (raw) and data-hub-FINAL (mastered)
  • Never manually edit hub-internal-config/ — it is managed by DHF tooling
  • Use project_setup_advisor when the user asks to add indexes, set up a new DB,
    or structure a new ml-gradle / DHF project


── PROGRESS DATA PLATFORM — SEMAPHORE + MARKLOGIC ──────────────────────────

MarkLogic and Semaphore together form the Progress Data Platform. Semaphore is
an AI-powered taxonomy management and auto-classification platform. Together:
  • Semaphore classifies and enriches content with taxonomy concepts/categories.
  • MarkLogic stores, searches, and serves the enriched documents at scale.

SEMAPHORE INTEGRATION PATTERNS (in recommended order):

1. INGEST + CLASSIFY IN ONE STEP (Flux native — preferred for new data)
   Flux has built-in Semaphore support via extra_args on flux_import:
     extra_args: ["--classifier-host", "<host>", "--classifier-port", "<port>",
                  "--classifier-path", "/api/v1/classify"]
   Semaphore categories are attached to each MarkLogic document at ingest time.
   → Use when loading new content from URL, file, JDBC, or S3.

2. REPROCESS EXISTING DOCUMENTS (post-ingest enrichment)
   Use flux_reprocess with an SJS transform module that:
     a. Reads each document URI (via collections or a SPARQL reader)
     b. Calls Semaphore via xdmp.httpPost() with the document body
     c. Patches the document with returned categories (ml_document_patch)
   → Use when Semaphore is added after data is already in MarkLogic.

3. TRANSFORM ON INGEST (canonical model + classification together)
   Write an SJS REST transform (database=Modules) that:
     a. Maps the raw source record to your canonical JSON/XML model
     b. Calls Semaphore for classification in the same transaction
     c. Stores categories in a dedicated "classification" property
   Pass the transform name via flux_import extra_args: ["--transform", "<name>"]
   → Use when raw-to-canonical mapping and classification must happen together.

4. DATA HUB FRAMEWORK PIPELINE (DHF — for complex scenarios)
   Use when you need: staging/final split, mastering, multiple source systems.
   DHF flows: Ingestion step (raw) → Mapping step (canonical) → Custom step
   (Semaphore enrichment via xdmp.httpPost) → Mastering step (dedup).
   Semaphore enrichment is a custom DHF step: reads STAGING, calls Semaphore,
   writes enriched entity to FINAL with classification metadata attached.
   → Use the semaphore_integration_advisor prompt for full DHF design.

SURFACING SEMAPHORE CATEGORIES IN MARKLOGIC SEARCH:
  • Store categories as a JSON array: "categories": [{"id":"...","label":"...","score":0.9}]
  • Add a range index on categories[].label (or a path range index) via ml-gradle
  • Use ml_search_options_put to define a constraint for faceted navigation
  • FastTrack FacetFilters can surface category facets directly from range indexes

TOOLS FOR SEMAPHORE:
  semaphore_status              — check CLS connectivity and version
  semaphore_studio_status       — check KMM/Studio connectivity and auth
  semaphore_publish_sets        — list active taxonomy rule sets in CLS
  semaphore_classes             — browse classification class names in active rulenet
  semaphore_classify            — classify sample text (exploratory / small scale)
  semaphore_kmm_models_list     — list all taxonomy models in KMM/Studio
  semaphore_kmm_model_create    — create a new model container in KMM
  semaphore_kmm_skos_load       — load a SKOS vocabulary from a public URL into KMM
  semaphore_kmm_sparql          — query model content via SPARQL SELECT
  semaphore_kmm_sparql_update   — run SPARQL INSERT/DELETE/LOAD to modify model triples
                                  (fix labels, delete unwanted triples, bulk updates)
  semaphore_publish             — trigger async KMM publish → compiles taxonomy into CLS rules
                                  always use async=true for models with 500+ concepts
  semaphore_publish_config_fix_plain_skos
                                — patch publisher config for plain-SKOS vocabularies
                                  (skos:prefLabel, not SKOS-XL); downloads, patches, re-uploads
                                  the workspace ZIP; run BEFORE semaphore_publish for
                                  UNESCO, EuroVoc, AGROVOC, and similar vocabularies
  semaphore_integration_advisor (prompt) — full architectural design guidance

PLAIN SKOS WORKFLOW (UNESCO / EuroVoc / AGROVOC):
  1. semaphore_kmm_model_create
  2. semaphore_kmm_skos_load — sem:guid auto-generated during OE import (no manual step needed)
  3. semaphore_publish_config_fix_plain_skos — patch AllResources→AllConcepts + label SPARQL
  4. semaphore_publish async=true — rebuild CLS rules
  5. semaphore_publish_sets / semaphore_classify — verify

KMM AUTHENTICATION NOTE:
  KMM uses Java EE form auth (not Basic auth). The MCP server handles the two-step
  login automatically (POST /j_security_check → JSESSIONID → GET /api/token).
  Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD in the MCP server .env.

MARKLOGIC AUTHENTICATION MODES (ML_AUTH_TYPE):
  digest (default) — HTTP Digest auth using ML_USERNAME + ML_PASSWORD.
  basic            — HTTP Basic auth using ML_USERNAME + ML_PASSWORD.
  oauth            — OAuth2 Bearer token passthrough. Each MCP HTTP session forwards
                     the user's JWT to MarkLogic as "Authorization: Bearer <token>".
                     MarkLogic validates the token against its configured OIDC provider
                     and enforces per-user RBAC. No shared service account is used.
                     Requires: ML_AUTH_TYPE=oauth, MCP_TRANSPORT=http.
                     For stdio mode: also set ML_OAUTH_TOKEN=<jwt>.
                     Flux tools are disabled in oauth mode (Flux requires credentials).
                     To configure MarkLogic as an OAuth2 resource server, invoke the
                     "oauth_setup_advisor" prompt with your OIDC provider details.

FLUX CLASSIFIER FLAGS:
  --classifier-host <host>  --classifier-port <port>  --classifier-path /
  Add --classifier-http for plain-HTTP CLS endpoints (required unless SEMAPHORE_SSL=true).
  The correct path is /  (not /api/v1/classify).

KUBERNETES NETWORK NOTE:
  xdmp.httpPost() from MarkLogic pods may be blocked by network policy from reaching
  the CLS. Prefer Flux (which runs outside MarkLogic) for inline classification, or
  pre-classify from the application/MCP tier before document insertion.


── TOOL GROUPS AT A GLANCE ─────────────────────────────────────────────────────

Admin (11):    ml_cluster_status, ml_databases_list, ml_database_properties,
               ml_database_statistics, ml_database_set_forests, ml_forests_list,
               ml_servers_list, ml_server_properties, ml_reindex_status,
               ml_logs_list, ml_logs_read

Security (3):  ml_users_list, ml_roles_list, ml_document_permissions

Documents (3–7, config-dependent):
               ml_document_get, ml_document_list, ml_document_sample
               [write-enabled] ml_document_put, ml_document_delete,
                               ml_document_patch, ml_document_patch_batch

Search (5):    ml_search, ml_search_qbe, ml_values_query, ml_suggest,
               ml_geospatial_search

Schema (7):    ml_schema_discover, ml_schema_get_tde, ml_tde_validate,
               ml_tde_install, ml_indexes_list, ml_collections_list, ml_namespaces_list

Eval (4, gated): ml_eval_javascript, ml_eval_xquery, ml_sparql, ml_invoke_module

Graph (4):     ml_sparql_query, ml_graphs_list, ml_graph_put, ml_graph_delete

QuickSight (4): ml_aggregate_query, ml_timeseries_query, ml_export_tabular,
                ml_facets_query

Optic (3):     ml_optic_query, ml_views_list, ml_vector_search

Flux (7, disabled in oauth mode):
               flux_import, flux_export, flux_copy, flux_reprocess,
               flux_preview, flux_help, flux_status

FastTrack (2–4, config-dependent):
               ml_search_options_list, ml_search_options_get
               [write-enabled] ml_search_options_put, ml_search_options_delete

Extensions (3–5, config-dependent):
               ml_extension_list, ml_extension_get, ml_extension_call
               [write-enabled] ml_extension_put, ml_extension_delete

Semaphore (27): semaphore_status, semaphore_studio_status,
                semaphore_publish_sets, semaphore_classes, semaphore_classify,
                semaphore_classify_batch, semaphore_cls_languages,
                semaphore_kmm_models_list, semaphore_kmm_model_create,
                semaphore_kmm_model_delete, semaphore_kmm_skos_load,
                semaphore_kmm_sparql, semaphore_kmm_sparql_update,
                semaphore_publish, semaphore_publish_config_fix_plain_skos,
                semaphore_publish_diagnose, semaphore_concept_search,
                semaphore_concept_get, semaphore_concept_labels_update,
                semaphore_taxonomy_validate, semaphore_taxonomy_scaffold,
                semaphore_kid_template_get, semaphore_kid_template_set,
                semaphore_kid_template_diagnose,
                semaphore_task_list, semaphore_task_create, semaphore_task_commit

DHF (3–5, DHF-install-dependent):
               dhf_status, dhf_flows_list, dhf_job_status
               [allowEval + write-enabled] dhf_flow_run, dhf_flow_run_jar

Performance (3–5, eval-dependent):
               ml_explain_optic, ml_search_query_plan, ml_forest_metrics
               [eval-enabled] ml_force_merge, ml_profile_query

Planning (1):  ml_suggest_approach

Prompts:       uri_designer, xquery_function_generator, sjs_module_generator,
               performance_advisor,
               tde_schema_generator, rest_extension_generator,
               structured_query_builder, optic_query_builder, sparql_query_builder,
               query_approach_advisor, data_modeling_advisor, data_import_advisor,
               project_setup_advisor,
               rag_pipeline_designer, envelope_pattern_advisor,
               gdelt_import, quicksight_dataset_designer, quicksight_dashboard_planner,
               fasttrack_search_designer, fasttrack_app_scaffold,
               semaphore_integration_advisor, semaphore_model_workflow,
               oauth_setup_advisor,
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
