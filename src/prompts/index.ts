import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerAllPrompts(server: McpServer): void {
  // ── AI Coding Prompts ──────────────────────────────────────────────────────

  server.prompt(
    "xquery_function_generator",
    "Generate XQuery functions for MarkLogic 12 with proper namespace handling, built-in function usage, and error handling patterns.",
    {
      function_purpose: z.string().describe("What the XQuery function should do"),
      input_type: z.enum(["json", "xml", "both"]).optional().describe("Expected document type (default: json)"),
      database: z.string().optional().describe("Target database name for context"),
    },
    ({ function_purpose, input_type, database }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a MarkLogic 12 XQuery expert. Generate a well-structured XQuery function for the following purpose:

**Purpose:** ${function_purpose}
**Input document type:** ${input_type ?? "json"}
**Target database:** ${database ?? "(default)"}

Requirements:
- Use proper MarkLogic 12 namespace declarations
- Include cts: query functions where appropriate
- Handle errors with try/catch and xdmp:log
- Follow MarkLogic best practices (avoid doc() in favor of cts:search, use xdmp:database() for DB references)
- For JSON documents use fn:doc() with object-node() casts
- For XML documents use element() and namespace-aware XPath
- Include a brief comment explaining inputs, outputs, and any required indexes
- Wrap in a proper module declaration if this is a library function

Generate the XQuery code now.`,
        },
      }],
    })
  );

  server.prompt(
    "sjs_module_generator",
    "Generate MarkLogic Server-Side JavaScript (SJS) modules including transforms, REST extensions, library modules, and Flux reprocessing module pairs (reader + transform).",
    {
      module_purpose: z.string().describe("What this SJS module should do"),
      module_type: z.enum(["transform", "extension", "library", "scheduled-task", "flux-reader", "flux-transform"]).optional().describe("Type of MarkLogic module. Use 'flux-reader' for the Phase 1 URI collector and 'flux-transform' for the Phase 2 per-URI processor in a flux_reprocess pipeline. Use 'transform' only for MarkLogic REST API transforms (Content Transformation Framework)."),
      database: z.string().optional().describe("Target database name"),
    },
    ({ module_purpose, module_type, database }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a MarkLogic 12 Server-Side JavaScript expert. Generate a ${module_type ?? "library"} module for the following purpose:

**Purpose:** ${module_purpose}
**Module type:** ${module_type ?? "library"}
**Target database:** ${database ?? "(default)"}

Requirements:
- Use 'use strict'; at the top
- For flux-reader (Phase 1 — URI collector for flux_reprocess --read-documents-javascript):
  - NO declareUpdate() — this is a read-only module
  - Use sem.sparql() or cts.uris() to collect the full set of URIs/IRIs to process
  - Return a Sequence or Array of URI strings as the last expression — do NOT forEach/iterate
  - Keep the query lightweight: SELECT DISTINCT ?subject only, no optional predicates
  - Example structure:
      'use strict';
      var GRAPH = 'http://...';
      var rows = sem.sparql('SELECT DISTINCT ?s FROM NAMED <' + GRAPH + '> WHERE { GRAPH <' + GRAPH + '> { ?s a ?type } }');
      Array.from(rows).map(function(r) { return String(r.s); });
- For flux-transform (Phase 2 — per-URI processor for flux_reprocess --invoke):
  - declareUpdate() must be the FIRST statement after 'use strict'
  - var URI; declares the Flux-injected variable (one URI per invocation — do NOT query all)
  - Scope all SPARQL queries to this single URI: WHERE { ... FILTER(?subject = sem.iri(URI)) ... }
  - Write exactly one output document per invocation
  - Example structure:
      'use strict';
      declareUpdate();
      var URI; // injected by Flux
      var rows = Array.from(sem.sparql('SELECT ... WHERE { GRAPH <' + GRAPH + '> { <' + URI + '> ... } }'));
      var row = rows[0];
      if (!row) { xdmp.log('No data for URI: ' + URI, 'warning'); } else {
        xdmp.documentInsert(outputUri, doc, { permissions: perms, collections: [...] });
      }
- For REST transforms (Content Transformation Framework): export transform function with (content, context) signature
- For REST extensions: export get/put/post/delete functions with (context, params, input) signatures
- For library modules: use module.exports or exports.functionName pattern
- For scheduled-task modules: write a self-contained script with declareUpdate() if writing
- Use xdmp.log() for server-side logging
- Use cts.search() not fn.doc() for document retrieval
- Handle errors with try/catch blocks
- Include JSDoc comments for all exported functions
- When building entity documents from RDF/SPARQL results, NEVER assign empty string ""
  for unbound optional variables. Either omit the field (if (row.broader) doc.broaderUri = row.broader)
  or assign null (broaderUri: row.broader ?? null). Empty strings pollute indexes and mislead queries.

FLUX REPROCESSING — DESIGN FOR SCALE:
When the task involves bulk RDF-to-entity transformation or any bulk transform over a large set,
ALWAYS generate TWO modules (flux-reader + flux-transform), not one monolithic script.
A single script iterating all results in one transaction will time out on > ~1 000 documents and
cannot use Flux's parallel threads. The two-module split is the only approach that scales.

Generate the SJS module now.`,
        },
      }],
    })
  );

  server.prompt(
    "tde_schema_generator",
    "Generate a MarkLogic Template Driven Extraction (TDE) schema to create SQL/row views over document collections.",
    {
      collection: z.string().describe("Collection URI containing the source documents"),
      target_view_name: z.string().describe("Name for the TDE view/table"),
      sample_schema: z.string().optional().describe("Paste a sample document or field list to map"),
    },
    ({ collection, target_view_name, sample_schema }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a MarkLogic 12 TDE (Template Driven Extraction) expert. Generate a TDE JSON template that creates a row view over the following collection:

**Collection:** ${collection}
**View name:** ${target_view_name}
**Sample document / field list:**
${sample_schema ?? "(not provided — infer reasonable fields from the collection name)"}

Requirements:
- Output valid TDE JSON format (not XML)
- Include a template context matching the collection
- Map fields to appropriate SQL types: string, long, double, dateTime, date, boolean
- Handle optional fields with nullable: true
- For nested objects, use object-node() path expressions
- For arrays, create a separate row-level template
- Include a schemaName and viewName
- Add a context/path that correctly matches document structure
- The template should be directly deployable via: tde.templateInsert("/tde/${target_view_name}.json", template)

Generate the TDE template JSON now.`,
        },
      }],
    })
  );

  server.prompt(
    "rest_extension_generator",
    "Generate a MarkLogic REST API extension scaffold with proper resource module structure.",
    {
      extension_name: z.string().describe("Name of the REST extension endpoint"),
      http_methods: z.array(z.enum(["GET", "PUT", "POST", "DELETE"])).describe("HTTP methods to implement"),
      description: z.string().describe("What this extension should do"),
    },
    ({ extension_name, http_methods, description }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Generate a MarkLogic REST API extension for the following:

**Extension name:** ${extension_name}
**HTTP methods:** ${http_methods.join(", ")}
**Purpose:** ${description}

Requirements:
- Create a Server-Side JavaScript resource module
- Implement each of: ${http_methods.join(", ")}
- Each method receives (context, params, input)
- Return results via context.outputMultiple or context.output
- Set appropriate content types via context.outputTypes
- Include error handling that returns proper HTTP status codes
- Include the metadata object with the extension description and param declarations
- Also show the curl command to install this extension via the Management API

Generate the extension module now.`,
        },
      }],
    })
  );

  // ── Query Building Prompts ─────────────────────────────────────────────────

  server.prompt(
    "structured_query_builder",
    "Translate a natural language description into a MarkLogic structured query JSON object.",
    {
      natural_language: z.string().describe("Describe what documents you want to find"),
      collection: z.string().optional().describe("Collection to search"),
      available_indexes: z.string().optional().describe("Comma-separated list of available range index field names"),
    },
    ({ natural_language, collection, available_indexes }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Translate this natural language search requirement into a MarkLogic structured query JSON:

**Find:** ${natural_language}
**Collection:** ${collection ?? "(any)"}
**Available range indexes:** ${available_indexes ?? "(unknown — use word-query for text fields)"}

Output a valid MarkLogic structured query JSON object using the search:query format. Include:
- word-query for full-text matching
- range-query for numeric/date comparisons (only if range index exists)
- collection-query if collection is specified
- and-query / or-query / not-query for combining conditions

Output only the JSON object, no explanation.`,
        },
      }],
    })
  );

  server.prompt(
    "optic_query_builder",
    "Generate a MarkLogic Optic API query for row-based access to TDE views — ideal for QuickSight dataset preparation.",
    {
      requirements: z.string().describe("What data you need to retrieve"),
      schema_name: z.string().describe("TDE schema name"),
      view_name: z.string().describe("TDE view name"),
    },
    ({ requirements, schema_name, view_name }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Generate a MarkLogic Optic API query (Server-Side JavaScript) for the following:

**Requirements:** ${requirements}
**TDE Schema:** ${schema_name}
**TDE View:** ${view_name}

Use the op (Optic) module pattern:
\`\`\`javascript
const op = require('/MarkLogic/optic');
const result = op.fromView('${schema_name}', '${view_name}')
  // add your pipeline here
  .result();
\`\`\`

Include:
- fromView() as the source
- where() for filtering
- groupBy() with aggregates if summarization is needed
- orderBy() for sorting
- select() to choose output columns
- limit() if appropriate
- .result() to execute and return as a sequence

Generate the Optic query now.`,
        },
      }],
    })
  );

  server.prompt(
    "sparql_query_builder",
    "Generate a SPARQL query for the MarkLogic triple store (semantic graph).",
    {
      natural_language: z.string().describe("Describe what triples/facts you want to retrieve"),
      graph_uri: z.string().optional().describe("Named graph URI to query"),
      prefixes: z.string().optional().describe("Common namespace prefixes to use (e.g. 'schema: http://schema.org/')"),
    },
    ({ natural_language, graph_uri, prefixes }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Generate a SPARQL query for the MarkLogic triple store:

**Find:** ${natural_language}
**Named graph:** ${graph_uri ?? "(default graph)"}
**Prefixes:** ${prefixes ?? "(none specified)"}

Requirements:
- Start with PREFIX declarations
- Use SELECT for tabular results or CONSTRUCT for graph results
- Use OPTIONAL for optional properties
- Use FILTER for conditions
- Use FROM NAMED if graph_uri is specified
- Keep it readable with proper indentation

Output only the SPARQL query.`,
        },
      }],
    })
  );

  // ── Multi-Model Data Modeling Advisor ─────────────────────────────────────

  server.prompt(
    "data_modeling_advisor",
    "Design a MarkLogic multi-model data architecture covering Documents, Triples (RDF), and Vectors. " +
    "Returns a structured plan: model selection, storage layout, TDE design, query approach per model, " +
    "import sequence, and pitfalls. Emphasises the entity-oriented document pattern for RDF data.",
    {
      domain: z.string().describe("What business data you are modelling — describe entities, relationships, and the kinds of queries the data must support"),
      models: z.array(z.enum(["documents", "triples", "vectors", "all"])).optional().describe("Which MarkLogic model types are involved (omit to let the advisor choose)"),
      data_sources: z.string().optional().describe("Where data comes from: JSON/CSV feeds, RDF/Turtle files, relational tables, embedding APIs, etc."),
      query_goals: z.string().optional().describe("Key query patterns: full-text search, similarity search, graph traversal, aggregation, RAG, etc."),
      database: z.string().optional().describe("Target MarkLogic database, if known"),
    },
    ({ domain, models, data_sources, query_goals, database }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a MarkLogic multi-model data architect. Design a MarkLogic data model for the
following domain. Do NOT call any tools — this is a design planning step only.

═══════════════════════════════════════════
DOMAIN
═══════════════════════════════════════════
${domain}

KNOWN CONTEXT
  Database     : ${database ?? "(not yet known)"}
  Models in use: ${models ? models.join(", ") : "(advisor to recommend)"}
  Data sources : ${data_sources ?? "(not specified)"}
  Query goals  : ${query_goals ?? "(not specified — infer from domain)"}

═══════════════════════════════════════════
PRODUCE THE FOLLOWING DESIGN
═══════════════════════════════════════════

## 1. MODEL SELECTION
Recommend which MarkLogic models to use (Documents / Triples / Vectors / combination).
For each model selected:
- State WHY it fits this domain
- State what data or relationships it will hold
- State what query capability it unlocks

If models are NOT needed, explain what to use instead:
- No need for Triples if relationships are simple parent-child (use document nesting)
- No need for Vectors if similarity search is not a requirement
- No need for Optic/TDE if analytical aggregation is not required

## 2. DOCUMENT DESIGN
Describe the document structure:
- Collection strategy: which collections, URI patterns (/entities/{type}/{id}.json)
- JSON field structure for each major entity type
- Which fields should be indexed (range index candidates for ml_values_query / ml_search filters)
- TDE view candidates (which fields need GROUP BY or JOIN)

## 3. TRIPLE DESIGN (if applicable)
MarkLogic's preferred pattern is entity-oriented: one document per entity, with triples
embedded inside the document. The document URI equals the entity's IRI.

### 3a. Entity-Oriented Pattern (preferred)
Describe:
- How to assign one document per entity (URI = IRI)
- Which relationships to model as embedded sem:triple objects using the "triple" JSON key (unmanaged format)
- Example JSON structure with both entity properties AND embedded triples in the same doc
  (JSON: "triples": [{"triple":{"subject":"...","predicate":"...","object":"..."}}] — use "triples"
   (plural) for the array key; each element is wrapped in a "triple" key. IRI objects are plain URI
   strings; literal objects use {"datatype":"...","value":"..."}. NOT "sem:triples" = managed triples.)
- How cts.search and ml_sparql_query both find the entity via this co-located layout

### 3b. Managed Triples → Reprocess (when raw RDF files are the source)
If the data source is Turtle, N-Triples, or RDF/XML files, describe the two-step path:
  Step 1: flux_import with subcommand=import-rdf-files → loads as managed triples in
          named graphs. Fast, lossless initial load. Inspectable with ml_sparql_query.
  Step 2: flux_reprocess with an SJS transform that:
    - Groups triples by subject IRI (SELECT ?s WHERE { ?s ?p ?o } GROUP BY ?s)
    - Writes one JSON document per IRI at /entities/{type}/{localname}.json
    - Embeds the triples as "triple" array in the document (unmanaged format, not "sem:triples")
    - Assigns the document to an entity collection
  Rule: group by IRI where reasonable. Avoid creating documents that aggregate
  thousands of triples from unrelated subjects.

  OPTIONAL PREDICATE RULE — when a SPARQL OPTIONAL clause yields an unbound variable
  (predicate absent for this subject), do NOT write an empty string for the field.
  Either omit the field from the document (preferred) or assign null:
    WRONG:   broaderUri: row.broader || ""          // pollutes indexes, misleads queries
    CORRECT: if (row.broader) doc.broaderUri = row.broader;  // omit the key entirely
    CORRECT: broaderUri: row.broader ?? null                  // null when unbound
  For TDE columns backed by optional predicates, mark the column nullable: true.

### 3c. SPARQL Query Patterns
Show example SPARQL for the key relationship queries in this domain.

## 4. VECTOR DESIGN (if applicable, MarkLogic 12+)
Describe:
- Which entity type needs embeddings and why (semantic search, RAG, recommendations)
- Which text fields to embed (title, description, full content, combined)
- Recommended embedding dimensionality and model (e.g. 768d BERT, 1536d OpenAI)
- Where to store the embedding in the document ("embedding": [float, ...] JSON array)
- TDE column mapping: {"name":"embedding","scalar":"vec:vector","val":"embedding"}
- How to query: ml_vector_search(schema, view, "embedding", queryVector, k)
- How to combine with structured filters: ml_optic_query with bind(vec:cosine-similarity)
  + where() for pre-filtering (e.g. filter by category before computing similarity)

## 5. TDE SCHEMA DESIGN
Design the TDE view(s) needed:
- Schema name and view name(s)
- Columns per view: name, scalar type, val (JSON path)
- Flag any vec:vector columns for vector search
- Collection context for each template
- How to install: ml_document_put (database='Schemas', collection='http://marklogic.com/xdmp/tde')
- Validation: ml_tde_validate before installing

Show the TDE JSON template structure (not full, but key sections).

## 6. IMPORT SEQUENCE
Step-by-step import plan using MCP tools:
  Step 1: <tool> — purpose and key parameters
  Step 2: <tool> — purpose and key parameters
  ...
Consider:
- flux_import for bulk document loads (subcommand based on format)
- flux_import subcommand=import-rdf-files for raw RDF
- flux_reprocess for the managed-triples → entity-doc transform
- ml_document_put for TDE template installation
- ml_tde_validate to verify the schema before querying
- ml_reindex_status to wait for TDE indexing to complete

## 7. QUERY PLAN
For each stated query goal, show which MCP tool to use and why:
  Goal: "..."
    Tool: ml_vector_search / ml_sparql_query / ml_search / ml_optic_query
    Why: ...
    Key parameters: ...

Highlight any multi-model query combinations (e.g. vector similarity → SPARQL traversal).

## 8. PITFALLS TO AVOID
List 4–6 specific, concrete pitfalls for this domain:
- Triple: "Importing raw RDF without reprocessing leaves triples as managed triples in named
  graphs — cts.search will NOT find them as entity documents"
- Triple: "Grouping unrelated subjects into one document creates oversized documents that
  are slow to update and hard to secure with per-entity permissions"
- Vector: "TDE vec:vector column requires scalar type 'vec:vector' — not 'string' or 'double'"
- Vector: "Dimensionality of query_vector must match stored vectors exactly or Optic will error"
- Vector: "Computing cosine similarity over millions of rows without pre-filtering is slow —
  always add a where() clause before the bind(vec:cosine-similarity(...)) step"
- General: "Never assume collection names — always run ml_collections_list first"

Be specific, use actual MarkLogic function names (sem:triple, vec:vector, vec:cosine-similarity,
op:from-sparql, flux_reprocess), and reference actual MCP tools throughout.
Do not give generic database design advice.`,
        },
      }],
    })
  );

  // ── Query Approach Advisor ─────────────────────────────────────────────────

  server.prompt(
    "query_approach_advisor",
    "Choose between cts.search (ml_search), Optic (ml_optic_query), or a hybrid approach for a given query goal. Returns a structured 6-section plan: query classification, recommended approach with justification, prerequisite checks, query construction guide, performance notes, and pitfalls.",
    {
      goal: z.string().describe("What you want to query or retrieve — be specific about whether you need documents, counts, aggregates, or joins"),
      collection: z.string().optional().describe("MarkLogic collection to query, if already known"),
      available_views: z.string().optional().describe("Comma-separated TDE schema.view names already discovered via ml_views_list"),
      available_indexes: z.string().optional().describe("Comma-separated range index field names already discovered via ml_indexes_list"),
      database: z.string().optional().describe("Target MarkLogic database, if known"),
    },
    ({ goal, collection, available_views, available_indexes, database }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a MarkLogic query architect. A user has described a query goal. Produce a structured
analysis that guides construction of the correct query using the right MarkLogic tool.
Do NOT call any tools — this is a planning step only.

═══════════════════════════════════════════
QUERY GOAL
═══════════════════════════════════════════
${goal}

KNOWN CONTEXT
  Database        : ${database ?? "(not yet known)"}
  Collection      : ${collection ?? "(not yet known — discover with ml_collections_list)"}
  TDE views       : ${available_views ?? "(not yet checked — use ml_views_list)"}
  Range indexes   : ${available_indexes ?? "(not yet checked — use ml_indexes_list)"}

═══════════════════════════════════════════
PRODUCE THE FOLLOWING ANALYSIS
═══════════════════════════════════════════

## 1. QUERY CLASSIFICATION
Classify this goal into one or more of these types (pick all that apply):
  full-text-search | structured-filter | aggregation | join |
  hybrid-search-aggregate | value-count | document-retrieval

For each type selected, give a one-sentence justification.

## 2. RECOMMENDED APPROACH
State ONE of:
  A) cts.search via ml_search  — for document retrieval, full-text ranking, or simple filters
  B) Optic via ml_optic_query  — for GROUP BY, aggregates, joins, or row-level filtering over a TDE view
  C) Hybrid: fromSearch + Optic — for full-text scoping FOLLOWED BY aggregation or joining

Provide:
- The specific Optic source operator if Optic is involved:
    fromView(schema, view)    → when querying TDE row data
    fromSearch(cts.query)     → when full-text scoping is needed before Optic operators
    fromLexicons(...)         → when using range index values directly
- Why this approach is preferred over the alternatives for THIS specific goal
- What prerequisite must exist: none | range index on [field] | TDE view [schema.view]

## 3. PREREQUISITE CHECKS
List in order the MCP tools to call BEFORE running the main query:
  Step 1: <tool_name> — what to look for
  Step 2: <tool_name> — what to look for
Only include steps genuinely needed. Skip inapplicable ones.

## 4. QUERY CONSTRUCTION GUIDE
Provide a concrete, ready-to-adapt query.

If approach is ml_search, show the structured_query JSON:
\`\`\`json
{
  "query": {
    "and-query": {
      "queries": [
        { "collection-query": { "uri": ["<collection>"] } },
        { "word-query": { "text": ["<search term>"] } }
      ]
    }
  }
}
\`\`\`

If approach is ml_optic_query, show the $optic plan JSON:
\`\`\`json
{
  "$optic": {
    "ns": "op", "fn": "operators", "args": [
      { "ns": "op", "fn": "from-view", "args": ["<schema>", "<view>"] },
      { "ns": "op", "fn": "where", "args": [{ "ns": "op", "fn": "eq", "args": [{ "ns": "op", "fn": "col", "args": ["<field>"] }, "<value>"] }] },
      { "ns": "op", "fn": "group-by", "args": [
        { "ns": "op", "fn": "col", "args": ["<dimension>"] },
        [{ "ns": "op", "fn": "count", "args": ["count", { "ns": "op", "fn": "col", "args": ["<any-col>"] }] }]
      ]},
      { "ns": "op", "fn": "order-by", "args": [{ "ns": "op", "fn": "desc", "args": [{ "ns": "op", "fn": "col", "args": ["count"] }] }] },
      { "ns": "op", "fn": "limit", "args": [20] }
    ]
  }
}
\`\`\`

If approach is hybrid (fromSearch + Optic), show the fromSearch operator as the source
with a cts query inline, then the Optic pipeline operators.

Fill in the placeholders using the context provided. Where context is unknown, use
<schema>, <view>, <field>, <value> as placeholders and explain what to substitute.

## 5. PERFORMANCE NOTES
Give 2–4 specific, concrete performance notes for this query type. Examples:
  - "word-query uses the universal index — no range index needed, constant-time lookup"
  - "range-query on an unindexed field falls back to a full document scan — always verify with ml_indexes_list"
  - "groupBy() reduces the row set; always put where() before groupBy() to minimize rows processed"
  - "fromSearch with a cts.collectionQuery scoping is much faster than scanning all documents in fromView"
  - "strip_schema_prefix=true in ml_optic_query reduces response size when querying a single view"

## 6. PITFALLS TO AVOID
List 3–5 concrete, specific pitfalls for this exact query goal:
  - Optic: "SQL-TABLENOTFOUND if TDE template not in Schemas DB collection http://marklogic.com/xdmp/tde"
  - Optic: "op.orderBy() takes exactly 1 argument — wrap multiple sort keys in a nested array"
  - Optic: "Column names in groupBy/where must exactly match TDE view column names (case-sensitive)"
  - cts.search: "range-query silently falls back to full scan if no range index exists — check ml_indexes_list first"
  - cts.search: "structured_query field names must match element/attribute names exactly as indexed"
  - hybrid: "fromSearch cts query must be serialized as a cts query node, not a structured search query object"

Be specific, use actual MarkLogic operator names, and reference the actual MCP tools.
Do not give generic advice.`,
        },
      }],
    })
  );

  // ── Problem-First Advisor ──────────────────────────────────────────────────

  server.prompt(
    "problem_advisor",
    "Understand a user goal and map it to the best MarkLogic-native approach before any tools are called. Returns a structured 6-section analysis: problem classification, native approach, discovery sequence, tool sequence, pitfalls, and alternatives.",
    {
      goal: z.string().describe("Natural-language description of what the user wants to accomplish"),
      database: z.string().optional().describe("Target MarkLogic database, if already known"),
      collection: z.string().optional().describe("MarkLogic collection URI, if already known"),
      context: z.string().optional().describe("Additional context: data format, document count, existing indexes, current state, etc."),
    },
    ({ goal, database, collection, context }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a MarkLogic solution architect. A user has described a goal. Produce a
structured problem analysis that another AI agent can use to select the correct tools
and approach. Do NOT call any tools — this is a planning step only.

═══════════════════════════════════════════
USER GOAL
═══════════════════════════════════════════
${goal}

KNOWN CONTEXT
  Database  : ${database ?? "(not yet known — discover with ml_databases_list)"}
  Collection: ${collection ?? "(not yet known — discover with ml_collections_list)"}
  Extra     : ${context ?? "(none provided)"}

═══════════════════════════════════════════
PRODUCE THE FOLLOWING ANALYSIS
═══════════════════════════════════════════

## 1. PROBLEM CLASSIFICATION
Classify this goal into one or more of these MarkLogic problem types:
  data-loading | full-text-search | structured-filter | analytics-aggregation |
  geospatial-search | graph-query | vector-similarity | multi-model-design | time-series |
  schema-discovery | export-bi | code-generation | admin-health | data-transform

## 2. MARKLOGIC-NATIVE APPROACH
For each problem type, state the idiomatic MarkLogic capability:
- Approach name (e.g. "Optic API over TDE view", "Flux import pipeline", "Universal index search")
- Why this is preferred over alternatives for this specific goal
- Any prerequisite (e.g. "requires a range index on DateField", "requires TDE template in Schemas DB")

## 3. DISCOVERY SEQUENCE
List the exact MCP tools to call first, before the main task, in order:
  Step 1: <tool_name> — reason
  Step 2: <tool_name> — reason
  ...
Only include steps that are genuinely needed for this goal. Skip inapplicable ones.

## 4. RECOMMENDED TOOL SEQUENCE
List the MCP tools for the main task, in order:
  Step 1: <tool_name> — key parameters and purpose
  Step 2: <tool_name> — key parameters and purpose
  ...

Available tools (use only these):
  Admin:      ml_cluster_status, ml_databases_list, ml_database_properties,
              ml_database_statistics, ml_forests_list, ml_servers_list, ml_server_properties
  Documents:  ml_document_get, ml_document_list, ml_document_put, ml_document_delete,
              ml_document_patch
  Search:     ml_search, ml_search_qbe, ml_values_query, ml_suggest, ml_facets_query,
              ml_geospatial_search
  Schema:     ml_schema_discover, ml_schema_get_tde, ml_tde_validate, ml_indexes_list,
              ml_collections_list, ml_namespaces_list
  Eval:       ml_eval_javascript, ml_eval_xquery, ml_invoke_module
  Graph:      ml_sparql_query, ml_graphs_list
  QuickSight: ml_aggregate_query, ml_timeseries_query, ml_export_tabular, ml_facets_query
  Optic:      ml_optic_query, ml_views_list, ml_vector_search
  Flux:       flux_import, flux_export, flux_copy, flux_reprocess, flux_preview, flux_help,
              flux_status
  Prompts:    uri_designer, xquery_function_generator, sjs_module_generator,
              tde_schema_generator, rest_extension_generator, structured_query_builder,
              optic_query_builder, sparql_query_builder, query_approach_advisor,
              data_modeling_advisor, data_import_advisor, gdelt_import,
              quicksight_dataset_designer, quicksight_dashboard_planner

## 5. PITFALLS TO AVOID
List 2–5 specific, concrete pitfalls for this goal. Examples of good pitfalls:
  - "ml_optic_query fails with SQL-TABLENOTFOUND if the TDE template is not in the Schemas database collection http://marklogic.com/xdmp/tde"
  - "flux_import uses the connection from the MCP server host — http_url must be reachable from the server, not just from the user's machine"
  - "ml_eval_javascript has a ~10 KB script payload limit — pass large arrays via the vars parameter, not inline in the script"
  - "Range queries require a pre-existing range index — verify with ml_indexes_list before writing the query"
  - "ml_document_put in a loop for bulk loads is 10–100x slower than flux_import for the same data"

## 6. SIMPLER ALTERNATIVE (if applicable)
If there is a faster or lower-effort path the user may have overlooked, describe it briefly.
Example: "If the collection has fewer than 500 documents, ml_export_tabular may be faster than
setting up a full Optic TDE view."
If no simpler alternative exists, write: "No simpler alternative — the recommended approach is
already the most direct path."

Be specific, actionable, and refer to actual MarkLogic concepts and the actual tools above.
Do not hedge with generic advice.`,
        },
      }],
    })
  );

  // ── URI Design Prompt ──────────────────────────────────────────────────────

  server.prompt(
    "uri_designer",
    "Design well-formed MarkLogic document URIs from entity type, primary key fields, and collection. " +
    "Returns URI patterns, flux_import uri_template syntax, multi-key and hierarchical variants, " +
    "and pitfalls. Call this before ml_document_put or flux_import whenever URIs are not already defined.",
    {
      entity_type: z.string().describe("Entity or document type, e.g. 'order', 'customer', 'event'"),
      primary_key_fields: z.string().describe("Comma-separated primary key field names, e.g. 'orderId' or 'country,year'"),
      format: z.enum(["json", "xml"]).optional().describe("Document format — determines URI extension (default: json)"),
      collection: z.string().optional().describe("Collection URI or short name that documents will be assigned to, e.g. 'orders' or 'http://example.com/orders'"),
      parent_entity: z.string().optional().describe("Parent entity type if this is a child/nested entity, e.g. 'customer' for a child 'order'"),
      parent_key_fields: z.string().optional().describe("Parent entity primary key fields if hierarchical URI is needed, e.g. 'customerId'"),
    },
    ({ entity_type, primary_key_fields, format, collection, parent_entity, parent_key_fields }) => {
      const ext = format ?? "json";
      const keys = primary_key_fields.split(",").map(k => k.trim());
      const keyPlaceholders = keys.map(k => `{${k}}`).join("-");
      const collectionPrefix = collection
        ? collection.replace(/^https?:\/\/[^/]+/, "").replace(/\/$/, "") || `/${collection.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`
        : `/${entity_type.toLowerCase()}s`;
      const flatUri = `${collectionPrefix}/${entity_type.toLowerCase()}-${keyPlaceholders}.${ext}`;
      const pathUri = keys.length === 1
        ? `${collectionPrefix}/${keyPlaceholders}.${ext}`
        : `${collectionPrefix}/${keys[0] ? `{${keys[0]}}` : ""}/${keys.slice(1).map(k => `{${k}}`).join("-")}.${ext}`;
      const hierarchicalUri = parent_entity && parent_key_fields
        ? `/${parent_entity.toLowerCase()}s/{${parent_key_fields.trim()}}/${entity_type.toLowerCase()}s/${keyPlaceholders}.${ext}`
        : null;
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are a MarkLogic URI design expert. Design well-formed document URIs for the following entity.
Do NOT call any tools — this is a design step only.

═══════════════════════════════════════════
ENTITY CONTEXT
═══════════════════════════════════════════
  Entity type        : ${entity_type}
  Primary key fields : ${primary_key_fields}
  Document format    : ${ext}
  Collection         : ${collection ?? "(derive from entity type)"}
  Parent entity      : ${parent_entity ?? "(none — top-level entity)"}
  Parent key fields  : ${parent_key_fields ?? "(n/a)"}

═══════════════════════════════════════════
URI DESIGN RULES (always apply)
═══════════════════════════════════════════

RULE 1 — PREFIX WITH COLLECTION OR ENTITY TYPE
  Every URI must start with a meaningful path prefix that groups related documents.
  This prefix is the "directory" in MarkLogic; ml_document_list can scope to it.
  Good:  /orders/order-{orderId}.json
  Bad:   /{orderId}.json   ← no prefix; no grouping; impossible to list all orders

RULE 2 — EMBED ALL PRIMARY KEY VALUES IN THE PATH
  URI = stable identity. Include every primary key field value so the URI is
  deterministic and collision-free. Never use UUIDs unless the source data has none.
  Good:  /events/gdelt/{GlobalEventID}.json
  Good:  /prices/{country}-{year}-{productId}.json   ← composite key
  Bad:   /orders/order.json   ← no key; overwrites on every write

RULE 3 — MATCH URI PREFIX TO COLLECTION SHORT NAME
  When a document belongs to collection "orders", start its URI with /orders/.
  This makes ml_document_list and directory queries intuitive.
  Assign: collections = ["orders"]
  URI:    /orders/{orderId}.json

RULE 4 — USE ONLY URL-SAFE CHARACTERS
  Allowed: letters, digits, /, -, _, .
  Encode or replace: spaces → -, colons in key values → -, slashes in values → use path segment

RULE 5 — USE THE RIGHT EXTENSION
  .json for JSON documents, .xml for XML documents.
  Modules: .sjs or .xqy (stored in Modules database, not content database).
  TDE templates: .json or .xml (stored in Schemas database).

RULE 6 — HIERARCHICAL URIS FOR CHILD ENTITIES
  If this entity belongs to a parent, nest it under the parent's key in the path:
  /customers/{customerId}/orders/{orderId}.json
  Benefits: ml_document_list /customers/42/orders/ lists all orders for customer 42.

═══════════════════════════════════════════
PRODUCE THE FOLLOWING URI DESIGN
═══════════════════════════════════════════

## 1. RECOMMENDED URI PATTERN
State the single best URI pattern for this entity:
  Pattern  : ${flatUri}
  Rationale: explain why this grouping and key embedding satisfies the rules above

Also show the alternative path-style pattern if keys > 1:
  Pattern  : ${pathUri}
  When to use: (explain trade-off vs flat pattern)

${hierarchicalUri ? `## 1b. HIERARCHICAL VARIANT (parent entity detected)
  Pattern  : ${hierarchicalUri}
  When to use: when every child query is scoped by parent key; enables directory-scoped listing` : ""}

## 2. FLUX IMPORT uri_template
Show the exact flux_import uri_template string to use when bulk-loading this entity from a delimited/JSON file:
\`\`\`json
{
  "uri_template": "${flatUri}",
  "collections": ["${collection ?? entity_type.toLowerCase() + "s"}"]
}
\`\`\`
Explain: Flux replaces {FieldName} with the field value from each source row at import time.
If a key field contains slashes or special characters, note how to sanitize them.

## 3. SINGLE-DOCUMENT EXAMPLE
Show a concrete ml_document_put call using a realistic example value for each key:
\`\`\`json
{
  "uri": "<filled-in example URI>",
  "content_type": "${ext === "json" ? "application/json" : "application/xml"}",
  "content": { "<example ${entity_type} document with ${primary_key_fields} field(s)>" },
  "collections": ["${collection ?? entity_type.toLowerCase() + "s"}"]
}
\`\`\`

## 4. DIRECTORY LISTING CALL
Show the ml_document_list call that lists all documents for this entity type:
\`\`\`json
{
  "directory": "${collectionPrefix}/",
  "page_size": 20
}
\`\`\`

## 5. COLLECTION ASSIGNMENT
State the exact collection URI(s) to assign, and why:
- Primary collection: "${collection ?? entity_type.toLowerCase() + "s"}"  — groups all ${entity_type} documents for ml_collections_list and search scoping
- (add any secondary collections if the domain calls for it, e.g. a status collection)

## 6. PITFALLS TO AVOID
List 3–5 URI-specific pitfalls:
- "Using UUIDs instead of natural keys makes URIs opaque — prefer source system IDs"
- "Omitting the collection prefix means ml_document_list cannot scope to this entity type"
- "Composite keys joined without a separator cause collisions: id=12,year=3 ≡ id=123,year=''"
- "Mutable fields (status, name) in URIs cause stale URIs after updates — only use immutable keys"
- "Key values with path separators (/) break the directory structure — replace / with - in values"
- "Storing TDE templates at /tde/... in the content database instead of the Schemas database — they must go to database='Schemas'"

Be specific. Reference actual MCP tool names (flux_import, ml_document_put, ml_document_list).
Do not give generic advice.`,
          },
        }],
      };
    }
  );

  // ── Dataset Import Prompts ─────────────────────────────────────────────────

  server.prompt(
    "gdelt_import",
    "Import GDELT 1.0 Event Database records into MarkLogic for a specific date. Provides the correct URL, all 58 column names, and exact flux_import parameters.",
    {
      date: z.string().describe("Date to import in YYYYMMDD format, e.g. '20260314'"),
      collection: z.string().optional().describe("MarkLogic collection to assign (default: gdelt-events)"),
      database: z.string().optional().describe("Target MarkLogic database (defaults to configured database)"),
    },
    ({ date, collection, database }) => {
      const columnNames = [
        "GlobalEventID", "SQLDATE", "MonthYear", "Year", "FractionDate",
        "Actor1Code", "Actor1Name", "Actor1CountryCode", "Actor1KnownGroupCode", "Actor1EthnicCode",
        "Actor1Religion1Code", "Actor1Religion2Code", "Actor1Type1Code", "Actor1Type2Code", "Actor1Type3Code",
        "Actor2Code", "Actor2Name", "Actor2CountryCode", "Actor2KnownGroupCode", "Actor2EthnicCode",
        "Actor2Religion1Code", "Actor2Religion2Code", "Actor2Type1Code", "Actor2Type2Code", "Actor2Type3Code",
        "IsRootEvent", "EventCode", "EventBaseCode", "EventRootCode", "QuadClass", "GoldsteinScale",
        "NumMentions", "NumSources", "NumArticles", "AvgTone",
        "Actor1Geo_Type", "Actor1Geo_FullName", "Actor1Geo_CountryCode", "Actor1Geo_ADM1Code",
        "Actor1Geo_Lat", "Actor1Geo_Long", "Actor1Geo_FeatureID",
        "Actor2Geo_Type", "Actor2Geo_FullName", "Actor2Geo_CountryCode", "Actor2Geo_ADM1Code",
        "Actor2Geo_Lat", "Actor2Geo_Long", "Actor2Geo_FeatureID",
        "ActionGeo_Type", "ActionGeo_FullName", "ActionGeo_CountryCode", "ActionGeo_ADM1Code",
        "ActionGeo_Lat", "ActionGeo_Long", "ActionGeo_FeatureID",
        "DATEADDED", "SOURCEURL",
      ];
      const targetCollection = collection ?? "gdelt-events";
      const url = `http://data.gdeltproject.org/events/${date}.export.CSV.zip`;
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Import GDELT 1.0 Event Database records for ${date} into MarkLogic.

GDELT event export files are tab-delimited ZIP archives with no header row. Use the column_names parameter so each imported JSON document gets proper field names.

Call flux_import with these exact parameters:
\`\`\`json
{
  "subcommand": "import-delimited-files",
  "http_url": "${url}",
  "column_names": ${JSON.stringify(columnNames)},
  "extra_args": ["--delimiter", "\\t", "--ignore-null-fields"],
  "collections": ["${targetCollection}"],
  "uri_template": "/gdelt/events/{GlobalEventID}.json",
  "permissions": "rest-reader:read,rest-writer:update"${database ? `,\n  "database": "${database}"` : ""},
  "skip_preview": true
}
\`\`\`

Expect ~80,000–100,000 event records and approximately 90 seconds import time.`,
          },
        }],
      };
    }
  );

  // ── QuickSight Integration Prompts ─────────────────────────────────────────

  server.prompt(
    "quicksight_dataset_designer",
    "Design a QuickSight dataset definition sourced from MarkLogic. Guides schema discovery, field selection, and aggregation strategy.",
    {
      data_description: z.string().describe("What business data is in MarkLogic that you want to visualize"),
      collection: z.string().optional().describe("MarkLogic collection to source from"),
      refresh_schedule: z.string().optional().describe("How often the dataset should refresh (e.g. hourly, daily)"),
    },
    ({ data_description, collection, refresh_schedule }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are designing a QuickSight dataset sourced from MarkLogic. Help me plan this end-to-end:

**Data description:** ${data_description}
**MarkLogic collection:** ${collection ?? "(unknown — discover it)"}
**Refresh schedule:** ${refresh_schedule ?? "daily"}

Please provide a step-by-step plan:

1. **Schema Discovery** — What MCP tools should I call first? (ml_schema_discover, ml_collections_list)
2. **Field Selection** — Which fields should become QuickSight dimensions vs measures?
3. **Data Type Mapping** — Map MarkLogic types to QuickSight types (STRING, INTEGER, DECIMAL, DATETIME)
4. **Aggregation Strategy** — Should I use TDE views + Optic API, or direct search + export?
5. **MCP Tool Sequence** — The exact sequence of ml_* tool calls to validate and extract the data
6. **QuickSight Dataset Definition** — Outline the dataset configuration (manifest or SPICE ingestion approach)
7. **Refresh Mechanism** — How to keep the QuickSight dataset current

Provide actionable steps I can follow right now using this MCP server.`,
        },
      }],
    })
  );

  server.prompt(
    "quicksight_dashboard_planner",
    "Plan a QuickSight dashboard from a business question, mapping it to MarkLogic queries and chart types.",
    {
      business_question: z.string().describe("The business question this dashboard should answer"),
      database: z.string().optional().describe("MarkLogic database name"),
    },
    ({ business_question, database }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Plan a QuickSight dashboard that answers the following business question using MarkLogic data:

**Business question:** ${business_question}
**MarkLogic database:** ${database ?? "(default)"}

Provide:
1. **Data Requirements** — What MarkLogic collections/fields contain the needed data?
2. **MCP Tool Calls** — Exact ml_* tool calls to discover and validate the data exists
3. **Chart Recommendations** — Recommended QuickSight visual types (bar, line, pie, KPI, table, etc.)
4. **Filters & Parameters** — What filter controls should the dashboard have?
5. **Aggregations** — What group-by and metric combinations are needed?
6. **Sample Query** — An ml_export_tabular or ml_aggregate_query call that returns the core dataset
7. **Dashboard Layout** — Suggested layout of visuals on the QuickSight canvas

Be specific and actionable.`,
        },
      }],
    })
  );

  // ── Data Import Design Advisor ─────────────────────────────────────────────

  server.prompt(
    "data_import_advisor",
    "Advise on the right tool and strategy for loading data into MarkLogic. Always evaluates flux_import first before suggesting REST API or eval-based approaches.",
    {
      data_description: z.string().describe("Describe the data you want to import (file format, source, size estimate)"),
      source_location: z.enum(["local_file", "http_url", "jdbc_database", "s3"]).optional().describe("Where the data lives"),
      target_collection: z.string().optional().describe("Intended MarkLogic collection"),
    },
    ({ data_description, source_location, target_collection }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a MarkLogic data-loading expert. Advise on the best import strategy for:

**Data:** ${data_description}
**Source location:** ${source_location ?? "unknown — ask the user"}
**Target collection:** ${target_collection ?? "(to be determined)"}

## Tool Selection Decision Tree

**ALWAYS consider flux_import first.** It is the preferred tool for the vast majority of import tasks.

### Use flux_import when:
- Data is CSV, TSV, JSON, JSON-Lines, Parquet, Avro, ORC, or MLCP archive
- Source is a local file, HTTP/HTTPS URL, or S3 URI (s3a://...)
- Source is a JDBC-accessible database (PostgreSQL, MySQL, Oracle, etc.)
- File is ZIP or gzip compressed — Flux decompresses natively
- You want one MarkLogic document per row/record
- You need automatic TDE view generation (set generate_tde: true)
- Batch size, thread count, and URI templates need to be configurable
- The file has no header row — use the column_names parameter

**Key flux_import advantages over manual approaches:**
- Parallel batch writes with configurable thread_count
- Automatic ZIP/gzip decompression
- HTTP URL fetch — Flux downloads the file, you don't need to
- generate_tde: true creates a TDE Optic view from the imported collection automatically
- column_names injects a synthetic header row for headerless delimited files (e.g. GDELT events)
- uri_template controls document URIs with {FieldName} interpolation
- A single tool call replaces dozens of REST API multipart requests

### Use ml_document_put when:
- Inserting a small number of individual documents (< ~10)
- Installing a TDE template, SJS module, or config file into Schemas/Modules database
- The content is already a complete JSON/XML string you have in hand

### Use ml_eval_javascript / ml_eval_xquery when:
- **Read-only** server-side computations or aggregations
- You need to call MarkLogic built-ins not exposed via other tools
- Always add \`declareUpdate();\` at the top if writing documents
- **Avoid for bulk inserts** — 10 KB script payload limit, no parallel batching

### Use the MarkLogic REST API directly (curl / requests) when:
- flux_import is unavailable and the file cannot be served over HTTP
- You need fine-grained per-document metadata control in multipart/mixed format
- **This is a last resort** — requires manual chunking and auth handling

## Recommended next steps for this task

1. Confirm the source format and location of the data.
2. If the data is at an HTTP URL or local file path accessible from the MCP server, call:
   \`\`\`json
   {
     "subcommand": "import-delimited-files",  // or import-files for JSON
     "http_url": "<url>",                     // or "local_file": "<path>"
     "collections": ["${target_collection ?? "my-collection"}"],
     "generate_tde": true,
     "tde_schema": "myschema",
     "tde_view": "myview"
   }
   \`\`\`
3. If the file has no header row, add \`"column_names": [...]\` with the field names in order.
4. After import, verify with ml_schema_discover or ml_optic_query to confirm the view is live.

Provide a concrete flux_import call for this specific data now, or explain which alternative tool is required and why.`,
        },
      }],
    })
  );
}
