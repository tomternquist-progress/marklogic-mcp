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
- Map fields to appropriate SQL types: string, long, double, dateTime, date, boolean, anyURI
  (NEVER use scalarType "IRI" — it is NOT a valid row column type)
- Handle optional fields with nullable: true
- For nested objects, use object-node() path expressions
- For arrays, create a separate row-level template
- Include a schemaName and viewName
- Add a context/path that correctly matches document structure
- The template should be directly deployable via: ml_tde_install (or ml_document_put with database='Schemas')

CRITICAL TDE SYNTAX RULES — common mistakes that cause TDE-INVALIDTEMPLATEPROPNODE:
1. Triple subject/predicate/object MUST use { "val": "<XPath-expression>" }, NOT { "column": "<name>" }.
   The "column" key is INVALID in TDE triples.
   WRONG:   { "subject": { "column": "movieIRI" } }
   CORRECT: { "subject": { "val": "sem:iri(fn:concat('http://example.org/movie/', id))" } }

2. Parent axis navigation (../id) does NOT work in JSON sub-templates.
   Use fn:root() to navigate back to the document root instead:
   WRONG:   { "val": "fn:concat('http://example.org/', ../id)" }
   CORRECT: { "val": "fn:concat('http://example.org/', fn:root()/rootElement/id)" }

3. scalarType "IRI" is NOT valid for row column definitions.
   Use "string" for URI columns. Construct IRIs only in the triples section via sem:iri().
   WRONG:   { "name": "movieUri", "scalarType": "IRI" }
   CORRECT: { "name": "movieId",  "scalarType": "string" }
   Then in triples: { "subject": { "val": "sem:iri(fn:concat('http://example.org/', movieId))" } }

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
    "nl_to_search_query",
    "Translate a natural-language question into a MarkLogic search query for a chat → MarkLogic integration. " +
    "Produces a string-grammar query (primary, parser-friendly) AND a structured-query JSON (fallback for cases " +
    "the grammar cannot express). Designed to consume the JSON output of ml_search_surface — paste that JSON in " +
    "as the 'surface' argument so the model sees the available fields, range indexes, and search-options names.",
    {
      natural_language: z.string().describe("The user's question in natural language, e.g. 'show me customers in Texas over 65 who mentioned diabetes'"),
      surface: z.string().optional().describe("JSON output of ml_search_surface for the target collection (inferredFields, rangeIndexes, searchOptionsNames, suggestedBindings)"),
      collection: z.string().optional().describe("Collection URI to search, if known"),
      options_name: z.string().optional().describe("Named search-options set to target (one of surface.searchOptionsNames). When provided, ml_search will use the options' grammar + constraints."),
      hint: z.string().optional().describe("Optional extra context, e.g. 'prefer phrase matching over keyword' or 'date field is enrolledOn'"),
    },
    ({ natural_language, surface, collection, options_name, hint }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are translating a natural-language question into a MarkLogic search query for a chat-to-MarkLogic
integration layer (this MCP server). The downstream pipeline is:

   chat → nl_to_search_query (this prompt) → ml_parse_query (validate) → ml_search (execute)

═══════════════════════════════════════════
USER QUESTION
═══════════════════════════════════════════
${natural_language}

CONTEXT
  Collection   : ${collection ?? "(unspecified — assume default or call ml_collections_list first)"}
  Options name : ${options_name ?? "(none — bareword/boolean grammar only unless bindings are supplied)"}
  Hint         : ${hint ?? "(none)"}

SEARCH SURFACE (from ml_search_surface — fields, range indexes, available options sets):
${surface ?? "(NOT PROVIDED — run ml_search_surface first; without this you must guess field names. Recommend the caller re-invoke after discovery.)"}

═══════════════════════════════════════════
PRODUCE THE FOLLOWING ANALYSIS
═══════════════════════════════════════════

## 1. INTENT EXTRACTION
List the searchable concepts in the user's question. For each, state:
  • The concept (e.g. "location is Texas", "age over 65", "diabetes mentioned")
  • Whether it is a TEXT match, FIELD-EQUALITY match, RANGE comparison, or a NEGATION
  • The candidate field name from inferredFields/rangeIndexes (or "(text — universal index)")

## 2. STRING-GRAMMAR QUERY (preferred output)
Write a single MarkLogic string-grammar query that captures the question. Rules:
  • Bareword tokens hit the universal index → free-text concepts go in unquoted.
  • Multi-word phrases go in double quotes: "type 2 diabetes"
  • Booleans: AND, OR, NOT, NEAR/k (k is an optional proximity distance)
  • Grouping: ( … )
  • Negation prefix: - or NOT
  • Tagged constraints (ONLY for fields in surface.suggestedBindings — these are the
    range-indexed fields; cts.parse REQUIRES a range index for any tag):
        importedAt:2026-01-01          → equality through a range index reference
        age >= 65                      → range; ops are < <= = != > >= (symbol) or LT LE EQ NE GE GT (named)
        enrolledOn GE 2024-01-01       → range on a dateTime binding (date strings auto-coerce)
    GRAMMAR RULES (strict in cts.parse SJS):
        - Comparison operators take SPACES on both sides: "age >= 65", NOT "age:>=65".
        - Forms like "age:GE:65" are INVALID — cts.parse rejects with XDMP-UNEXPECTED.
        - The ONLY colon allowed is the equality delimiter in "tag:value".
  • For fields in surface.valueQueryableFields / wordQueryableFields (no range index):
    DO NOT tag them in the string grammar (cts.parse would reject) — but DO NOT fall back to
    a bareword if the user's intent is "field equals value". A bareword matches anywhere in
    the document. Instead, capture the field-scoped constraint in section 3 (structured-query
    fallback) using a value-query / word-query, then AND it with the string-grammar clause:
        { and-query: { queries: [
            <parsed string query from section 2>,
            { value-query: { json-property: 'state', text: ['TX'] } }
        ] } }
    Use bareword tokens ONLY for true free-text concepts the user didn't pin to a specific
    field (e.g. "diabetes" in the user's question "customers who mentioned diabetes").
  • If options_name is set, prefer the tag syntax for any field bound by that options set.

Output the query as a single line. Then on a new line: "Pass this as: ml_search q='<query>'\${optionsLine}"
${options_name ? `(\${optionsLine} resolves to " options='${options_name}'" for that line)` : ""}

## 3. STRUCTURED-QUERY FALLBACK (only when needed)
If the question expresses something the string grammar CANNOT cleanly capture — geospatial regions,
nested boolean precedence beyond simple grouping, custom collection or directory scoping, or a
WHERE-NOT pattern with multiple range constraints — output a complete MarkLogic structured-query
JSON object instead (search:query schema). Otherwise write: "Not needed — string grammar is sufficient."

## 4. ml_parse_query BINDINGS
List the minimum 'bindings' map (as JSON) to pass to ml_parse_query so that every tag in your
string query resolves correctly. Pull entries from surface.suggestedBindings when possible. Example:
  {
    "state": { "type": "json-property",       "name": "state" },
    "age":   { "type": "json-property-range", "name": "age", "scalar_type": "int" }
  }
If your query uses no tags, write: "No bindings needed — boolean/phrase grammar only."

## 5. VALIDATION STEP
Recommend the exact ml_parse_query call to verify the query before executing:
  ml_parse_query qtext="<your query>" bindings=<from section 4>

## 6. EXECUTION STEP
Recommend the exact ml_search call:
  ml_search q="<your query>" [collection="${collection ?? "..."}"] [options="${options_name ?? "..."}"]
If you produced a structured-query fallback in section 3, give that ml_search call too with structured_query=.

## 7. CONFIDENCE & CAVEATS
State your confidence (high / medium / low) and call out any assumption the agent should verify:
  • "Assumed 'state' is a top-level JSON property — verify with ml_schema_discover if results are empty."
  • "No range index on 'age' in the surface — the range tag may fall back to filtered evaluation; consider adding one."
  • "User said 'recently' — interpreted as last 90 days; ask the user to confirm the window."

Be concrete. Reference actual field names from the surface. Do not invent fields not listed in the surface.
Do not hedge with generic advice. Do not call any tools — this is a planning step the caller will execute.`,
        },
      }],
    })
  );

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
**Available range indexes:** ${available_indexes ?? "(unknown — use value-query for exact match; range-query only on indexed fields)"}

Output a valid MarkLogic structured query JSON object using the search:query format. Pick the right
constructor per concept — these all work WITHOUT a range index:
- value-query  for EXACT match on a JSON property / element / field
    { value-query: { json-property: 'incidentType', text: ['Hurricane'] } }
    Multi-value OR: { value-query: { json-property: 'state', text: ['FL','TX','LA'] } }
- word-query   for tokenised free-text scoped to a property/field
    { word-query: { json-property: 'description', text: ['hurricane'] } }
- term-query / cts word-query equivalent for free-text across the whole document
- collection-query if a collection is specified
- and-query / or-query / not-query to combine
These REQUIRE a range index on the bound field:
- range-query  for numeric / date comparisons (use only if 'available range indexes' lists the field)

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
              ml_database_statistics, ml_forests_list, ml_servers_list,
              ml_server_properties, ml_reindex_status
  Documents:  ml_document_get, ml_document_list, ml_document_sample, ml_document_put,
              ml_document_delete, ml_document_patch
  Search:     ml_search, ml_search_qbe, ml_values_query, ml_suggest, ml_facets_query,
              ml_geospatial_search, ml_parse_query
              (ml_search supports select_fields=, distinct=, group_by=,
               normalize_whitespace=, response_mode= for inline projection
               and aggregation without follow-up ml_document_get calls)
  Answer:     ml_answer_query (one-shot NL → CTS → projection + audit trace;
                                value-normalizes "hurricanes" → "Hurricane";
                                suppresses filler residual by default;
                                translation_only=true returns CTS without executing),
              ml_query_recipe (named templates for common analytics),
              ml_capabilities (runtime parameter manifest — inspect supported params per tool)
  Schema:     ml_schema_discover, ml_schema_get_tde, ml_tde_validate, ml_tde_install,
              ml_indexes_list, ml_collections_list, ml_namespaces_list, ml_search_surface
  Eval:       ml_eval_javascript, ml_eval_xquery, ml_sparql, ml_invoke_module
  Graph:      ml_sparql_query, ml_graphs_list, ml_graph_put, ml_graph_delete
  QuickSight: ml_aggregate_query, ml_timeseries_query, ml_export_tabular, ml_facets_query
  Optic:      ml_optic_query, ml_views_list, ml_vector_search
  Flux:       flux_import, flux_export, flux_copy, flux_reprocess, flux_preview, flux_help,
              flux_status
  FastTrack:  ml_search_options_list, ml_search_options_get, ml_search_options_put,
              ml_search_options_delete
  Extensions: ml_extension_list, ml_extension_get, ml_extension_put,
              ml_extension_delete, ml_extension_call
  Semaphore:  semaphore_status, semaphore_studio_status, semaphore_publish_sets,
              semaphore_classes, semaphore_classify, semaphore_cls_languages,
              semaphore_kmm_models_list, semaphore_kmm_model_create,
              semaphore_kmm_model_delete, semaphore_kmm_skos_load,
              semaphore_kmm_sparql, semaphore_kmm_sparql_update,
              semaphore_publish, semaphore_publish_config_fix_plain_skos,
              semaphore_publish_diagnose, semaphore_concept_search,
              semaphore_concept_get, semaphore_concept_labels_update,
              semaphore_taxonomy_validate, semaphore_taxonomy_scaffold
  DHF:        dhf_status, dhf_flows_list, dhf_job_status,
              dhf_flow_run (allowEval + write-enabled; async — returns job ID)
  Security:   ml_users_list, ml_roles_list, ml_document_permissions
  Performance: ml_explain_optic, ml_search_query_plan, ml_forest_metrics,
              ml_force_merge (eval-gated), ml_profile_query (eval-gated)
  Planning:   ml_suggest_approach
  Prompts:    uri_designer, xquery_function_generator, sjs_module_generator,
              tde_schema_generator, rest_extension_generator,
              nl_to_search_query, structured_query_builder,
              optic_query_builder, sparql_query_builder, query_approach_advisor,
              data_modeling_advisor, data_import_advisor, project_setup_advisor,
              gdelt_import, quicksight_dataset_designer, quicksight_dashboard_planner,
              fasttrack_search_designer, fasttrack_app_scaffold,
              semaphore_integration_advisor, semaphore_model_workflow,
              rag_pipeline_designer, envelope_pattern_advisor,
              performance_advisor

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

  // ── FastTrack UI Prompts ───────────────────────────────────────────────────

  server.prompt(
    "fasttrack_search_designer",
    "Design a MarkLogic search-options configuration and FastTrack React component scaffold " +
    "for SearchBar, FacetFilters, Geospatial Map, and Timeline widgets. " +
    "Given a collection and schema, generates the search options JSON and React component code.",
    {
      collection: z.string().describe("MarkLogic collection to build the FastTrack app for"),
      schema: z.string().describe("JSON object describing fields: {fieldName: {type, indexed, sample}} — output of ml_schema_discover or ml_document_sample"),
      indexes: z.string().optional().describe("JSON array of available indexes from ml_indexes_list — used to decide which constraints are safe to add"),
      widgets: z.enum(["search-only", "search-facets", "search-facets-map", "search-facets-map-timeline", "full"]).optional().describe("Which FastTrack widgets to configure (default: search-facets)"),
      options_name: z.string().optional().describe("Name to give the search options configuration (default: derived from collection)"),
    },
    ({ collection, schema, indexes, widgets, options_name }) => {
      const optName = options_name ?? collection.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
      const widgetSet = widgets ?? "search-facets";
      const includeMap = widgetSet === "search-facets-map" || widgetSet === "search-facets-map-timeline" || widgetSet === "full";
      const includeTimeline = widgetSet === "search-facets-map-timeline" || widgetSet === "full";
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are a MarkLogic FastTrack expert. Design a complete FastTrack search configuration for the following collection.

**Collection:** ${collection}
**Schema (fields):** ${schema}
**Available indexes:** ${indexes ?? "(not provided — be conservative: only add range constraints for fields confirmed to have range indexes)"}
**Widgets to configure:** ${widgetSet}
**Search options name:** ${optName}

## Your deliverables

### 1. PREREQUISITES CHECKLIST
List every index required by the constraints you plan to add. For each:
- Field name and constraint type (range xs:string, range xs:date, geo-elem-pair, etc.)
- Whether the index is confirmed in the provided indexes data or assumed
- The ml_indexes_list filter to verify it (e.g., index_type='range-element')
- If the index is MISSING: provide the ml_eval_javascript call to create it via the Admin module

### 2. SEARCH OPTIONS JSON
Generate the complete search options JSON to pass to ml_search_options_put:
\`\`\`json
{
  "options": {
    "return-results": true,
    "return-facets": true,
    "return-metrics": false,
    "extract-document-data": {
      "selected": "include",
      "extract-path": ["/<field1>", "/<field2>", "..."]
    },
    "constraint": [
      // one entry per FacetFilters facet — only string/numeric range constraints with confirmed indexes
      // one geo-elem-pair entry if includeMap and geo fields exist
      // one date/dateTime range entry if includeTimeline and date field exists
    ]
  }
}
\`\`\`

Rules for constraints:
- PREFERRED index type for JSON: path-index with path "//fieldName" (uses range-path-index, creatable via
  admin:database-add-range-path-index in ml_eval_xquery). This is always preferred over json-property.
- FALLBACK: json-property requires a range-json-property-index (only creatable via Management API port 8002).
- String facets:  {"name":"field","range":{"type":"xs:string","facet":true,"path-index":{"text":"//field"}}}
- Numeric facets: {"name":"field","range":{"type":"xs:decimal","facet":true,"path-index":{"text":"//field"}}}
- Date range:     {"name":"field","range":{"type":"xs:date","facet":true,"path-index":{"text":"//field"}}} with buckets
  NOTE: If the date is stored as a string in ISO format (YYYY-MM-DD), use type xs:string — ISO strings sort chronologically.
- Geospatial (map): geo-elem-pair with parent/lat/lon — only if schema shows geo fields
- BUCKET SYNTAX — use "name" attribute (NOT "label") on every bucket or the REST API will return XDMP-VALIDATEMISSINGATTR:
  CORRECT: {"name":"Under 80k","lt":"80000"} and {"name":"80-100k","ge":"80000","lt":"100000"}
  WRONG:   {"label":"Under 80k","lt":"80000"}   ← will be rejected with a 400 error${includeMap ? "\n- INCLUDE a geo-elem-pair constraint for the map widget" : ""}${includeTimeline ? "\n- INCLUDE a date range constraint with buckets for the timeline widget" : ""}

### 3. ml_search_options_put CALL
The exact tool call parameters:
\`\`\`json
{
  "name": "${optName}",
  "options": { ... }
}
\`\`\`

### 4. VERIFICATION CALL
The ml_search call to verify facets and result fields work:
\`\`\`json
{
  "q": "",
  "options": "${optName}",
  "collection": "${collection}",
  "page_length": 3
}
\`\`\`

### 5. FASTTRACK REACT COMPONENT SCAFFOLD
Generate a complete React component that uses the FastTrack library. Include:
- package.json dependency: "@progress/marklogic-fasttrack": "^1.0.0"
- MarkLogicContext setup with connection props
- SearchBar component with optionsName="${optName}"
- FacetFilters component with the constraint names from section 2
- Results component with the extracted fields from section 2${includeMap ? "\n- GeospatialMap component (if geo constraint was added)" : ""}${includeTimeline ? "\n- Timeline component (if date constraint was added)" : ""}

Component structure example:
\`\`\`tsx
import { MarkLogicContext, SearchBar, FacetFilters, Results${includeMap ? ", GeospatialMap" : ""}${includeTimeline ? ", Timeline" : ""} } from "@progress/marklogic-fasttrack";

export function ${collection.replace(/[^a-zA-Z0-9]/g, "")}SearchApp() {
  return (
    <MarkLogicContext
      host={process.env.REACT_APP_ML_HOST ?? "localhost"}
      port={Number(process.env.REACT_APP_ML_PORT ?? 8000)}
      database="${collection}"
    >
      <div className="search-layout">
        <SearchBar optionsName="${optName}" />
        <div className="search-body">
          <aside><FacetFilters optionsName="${optName}" /></aside>
          <main><Results optionsName="${optName}" /></main>
        </div>
        {/* Add visualizations below */}
      </div>
    </MarkLogicContext>
  );
}
\`\`\`

Tailor the component to the actual constraint names from section 2.

### 6. PITFALLS
List 3–5 FastTrack-specific pitfalls relevant to this configuration, e.g.:
- "Range constraint on an unindexed field will throw XDMP-BADLEXICO at search time"
- "geo-elem-pair constraint requires the parent property to exist at the document root, not nested"
- "FacetFilters expects constraint names to match exactly — case-sensitive"
- "extract-path uses XPath (forward slash + property name), not dot notation"
- "MarkLogicContext host/port must match the App Server that has the search options, not the Management port"
- "Bucket entries must use 'name' not 'label' — the REST API enforces this with a 400 XDMP-VALIDATEMISSINGATTR error"
- "path-index constraints need a range-path-index (//fieldName) — not a range-element or range-json-property-index"
- "Scoping facets to a collection: pass collection= to ml_search OR patch the stored options XML with additional-query via ml_eval_xquery. The JSON additional-query: {collection-query: ...} format is NOT parsed by the REST API options endpoint."

Be specific to the fields in this schema.`,
          },
        }],
      };
    }
  );

  server.prompt(
    "fasttrack_app_scaffold",
    "Generate a complete FastTrack React application scaffold including project structure, " +
    "MarkLogicContext configuration, environment setup, and all widget components for a given data model.",
    {
      app_name: z.string().describe("Name for the React application"),
      collection: z.string().describe("Primary MarkLogic collection the app searches"),
      ml_host: z.string().optional().describe("MarkLogic host (default: localhost)"),
      ml_port: z.number().optional().describe("MarkLogic REST port (default: 8000)"),
      search_options_name: z.string().optional().describe("Named search options configuration (created with ml_search_options_put)"),
      features: z.array(z.enum(["search", "facets", "map", "timeline", "network-graph", "ai-summary"])).optional().describe("FastTrack features to include (default: search, facets)"),
    },
    ({ app_name, collection, ml_host, ml_port, search_options_name, features }) => {
      const optName = search_options_name ?? `${collection.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase()}-options`;
      const featureSet = features ?? ["search", "facets"];
      const hasMap = featureSet.includes("map");
      const hasTimeline = featureSet.includes("timeline");
      const hasNetwork = featureSet.includes("network-graph");
      const hasAI = featureSet.includes("ai-summary");
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Generate a complete FastTrack React application scaffold for the following requirements:

**App name:** ${app_name}
**Primary collection:** ${collection}
**MarkLogic host:** ${ml_host ?? "localhost"}
**MarkLogic port:** ${ml_port ?? 8000}
**Search options name:** ${optName}
**Features:** ${featureSet.join(", ")}

## Deliverables

### 1. PROJECT STRUCTURE
\`\`\`
${app_name}/
├── package.json
├── .env.example
├── src/
│   ├── index.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── SearchLayout.tsx       ← main search page
│   │   ├── ResultCard.tsx         ← single result display
│   │   └── ...                    ← one file per widget
│   └── types/
│       └── result.ts              ← TypeScript types for result docs
└── public/
    └── index.html
\`\`\`

### 2. package.json
Include these dependencies:
- react, react-dom, typescript
- @progress/marklogic-fasttrack (latest)
- @progress/kendo-react-* (peer deps required by FastTrack)

### 3. .env.example
\`\`\`
REACT_APP_ML_HOST=${ml_host ?? "localhost"}
REACT_APP_ML_PORT=${ml_port ?? 8000}
REACT_APP_ML_DATABASE=${collection}
REACT_APP_ML_OPTIONS=${optName}
\`\`\`

### 4. App.tsx
Root component with MarkLogicContext wrapping the app.
MarkLogicContext reads connection details from environment variables.

### 5. SearchLayout.tsx
Main search page component wiring together:
- SearchBar (always)
- FacetFilters (always)
- Results with ResultCard (always)${hasMap ? "\n- GeospatialMap widget (synchronized with search state)" : ""}${hasTimeline ? "\n- Timeline widget (date range brush filter)" : ""}${hasNetwork ? "\n- NetworkGraph widget (entity relationship visualization)" : ""}${hasAI ? "\n- AISummary widget (AI-generated summary of results)" : ""}

### 6. ResultCard.tsx
A typed result card component. Include a TypeScript interface for the document shape
and show the key fields from the extract-document-data configuration.

### 7. SETUP INSTRUCTIONS
Step-by-step to get the app running:
1. Prerequisites MCP calls (ml_search_options_list to verify '${optName}' exists)
2. npm create / npx create-react-app commands
3. Environment variable setup
4. npm start

### 8. MARKLOGIC PREREQUISITE CHECKLIST
Before the app will work, these must exist in MarkLogic:
- Named search options '${optName}' — verify with ml_search_options_get name='${optName}'
- Range indexes for all constraint fields — verify with ml_indexes_list
- The '${collection}' collection must have documents — verify with ml_collections_list${hasMap ? "\n- Geospatial element pair index for map widget — verify with ml_indexes_list index_type='geospatial'" : ""}

Generate all files with complete, working code. Do not use placeholder comments — write the actual implementation.`,
          },
        }],
      };
    }
  );

  // ── Data Import Design Advisor ─────────────────────────────────────────────

  server.prompt(
    "project_setup_advisor",
    "Advise on structuring a new MarkLogic project with ml-gradle or Data Hub Framework (DHF). " +
    "Covers directory layout, database/index config, TDE deployment, security, and module structure.",
    {
      project_description: z.string().describe(
        "Describe the project: what kind of data, expected query patterns, any existing MarkLogic setup"
      ),
      use_dhf: z.enum(["yes", "no", "unsure"]).optional().describe(
        "Whether to use Data Hub Framework (yes/no/unsure). DHF is appropriate for entity-centric data " +
        "integration pipelines with ingestion, mapping, and mastering steps."
      ),
      existing_indexes: z.string().optional().describe(
        "Paste or describe any range/geospatial indexes that need to be added (from ml_indexes_list output)"
      ),
    },
    ({ project_description, use_dhf, existing_indexes }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a MarkLogic infrastructure expert. Produce a structured project setup plan.

**Project:** ${project_description}
**Use DHF:** ${use_dhf ?? "unsure — recommend based on project description"}
**Indexes to add:** ${existing_indexes ?? "none specified — recommend based on query patterns"}

---

## Section 1 — Framework choice: ml-gradle vs DHF

Decide whether to use plain ml-gradle or Data Hub Framework.

**Use plain ml-gradle when:**
- Custom application (not a data integration / MDM pipeline)
- Single content database
- Full control over DB config without DHF conventions
- Lighter footprint, simpler deployment

**Use DHF when:**
- Entity-centric data integration from multiple source systems
- Ingestion → mapping → matching/merging (mastering) pipeline needed
- Need staging (raw) and final (mastered) databases
- SmartMastering or entity services features required

State your recommendation and the reason.

---

## Section 2 — Directory structure

Show the complete \`src/main/\` layout for this project. For plain ml-gradle:

\`\`\`
src/main/
  ml-config/
    databases/
      content-database.json    ← indexes, lexicons
    security/
      roles/
      users/
    servers/
      rest-api-server.json
  ml-schemas/
    tde/
      <entity>-tde.json        ← one TDE file per entity/view
  ml-modules/
    root/
      <app modules>
  ml-data/                     ← seed/test data (optional)
gradle.properties
gradle-local.properties        ← gitignore this file (contains passwords)
gradle-dev.properties
\`\`\`

For DHF also show: \`entities/\`, \`flows/\`, \`mappings/\`, \`hub-internal-config/\` (note: system-managed).

---

## Section 3 — Database configuration

Show the \`content-database.json\` (or \`final-database.json\` for DHF) snippet needed for this project.
Include:
- All range element indexes needed for the described query patterns
- Geospatial indexes if spatial search is needed
- uri-lexicon: true and collection-lexicon: true (almost always required)
- Any word lexicons for suggest/autocomplete

Index JSON format:
\`\`\`json
{
  "range-element-indexes": [
    {
      "scalar-type": "string",
      "namespace-uri": "",
      "localname": "<fieldName>",
      "collation": "http://marklogic.com/collation/codepoint",
      "range-value-positions": false,
      "invalid-values": "reject"
    }
  ]
}
\`\`\`

---

## Section 4 — TDE template

Show a starter TDE template (\`ml-schemas/tde/<entity>-tde.json\`) for the primary entity.
Remind the user:
- Files here are auto-assigned to the \`http://marklogic.com/xdmp/tde\` collection by ml-gradle
- Deploy with: \`gradle mlLoadSchemas\`
- Check ml_reindex_status after deployment before querying via Optic
- For DHF: DHF auto-generates TDE from \`.entity.json\` descriptors — manual TDE only needed
  for custom views not covered by the entity model

---

## Section 5 — Key gradle.properties settings

List the minimum required properties for this project. Flag any DHF-specific properties
(mlStagingDbName, mlFinalDbName, mlJobDbName, etc.) vs plain ml-gradle properties.

Always include:
\`\`\`properties
mlHost=localhost
mlRestPort=<port>
mlAppName=<name>
mlUsername=<admin-user>
mlPassword=<password>        # Never commit — use gradle-local.properties

# Pre-emptive Basic auth across all four sub-services. Required when the cluster's
# Manage server returns "WWW-Authenticate: Basic realm=public" — the default
# ml-java-client interceptor cannot complete a Basic challenge-response and throws
#   "unsupported auth scheme: [Basic realm=public]"
# Setting this group forces pre-emptive Basic so no challenge round-trip happens.
mlAuthentication=basic
mlManageAuthentication=basic
mlAdminAuthentication=basic
mlAppServicesAuthentication=basic
mlRestAuthentication=digest  # REST API server stays on digest by default
\`\`\`

For DHF projects, always override the default ports (8010 conflicts with other MarkLogic servers):
\`\`\`properties
mlStagingPort=8020
mlFinalPort=8021
mlJobsPort=8022
\`\`\`

---

## Section 5b — First-deploy pitfalls (call these out explicitly)

These four gotchas bite virtually every first-time ml-gradle user. Tell the user about
them before they try to deploy:

1. **schemas-database.json + triggers-database.json must be present** alongside
   content-database.json whenever content-database.json references the
   \`%%SCHEMAS_DATABASE%%\` / \`%%TRIGGERS_DATABASE%%\` tokens. Without those stub files,
   first deploy fails with:
   \`\`\`
   CMA-INVALIDPROPERTIES: ADMIN-NOSUCHDATABASE: No such database <app>-schemas,
   denote schema-database after it has been created
   \`\`\`
   Each stub is a 1-line JSON file:
   \`\`\`json
   { "database-name": "%%SCHEMAS_DATABASE%%" }
   \`\`\`

2. **TDE templates use the .tdej (JSON) or .tde (XML) extension** under
   \`src/main/ml-schemas/tde/\`. Any URI starting with \`/tde\` is auto-assigned to the
   \`http://marklogic.com/xdmp/tde\` collection by ml-gradle 4.3.5+ — you do NOT need
   a special suffix or manual collection assignment.

3. **ml-data collections.properties uses per-file syntax**, not a global key.
   Right:
   \`\`\`
   item-001.json=my-collection,demo
   item-002.json=my-collection
   \`\`\`
   Wrong (silently ignored):
   \`\`\`
   collections=my-collection,demo
   \`\`\`
   Same per-file format applies to permissions.properties:
   \`\`\`
   item-001.json=rest-reader,read,rest-writer,update
   \`\`\`
   For applying the same setting to every file in a tree, use \`mlCascadeCollections=true\`
   / \`mlCascadePermissions=true\` (ml-gradle 4.6.0+).

4. **REST resource extension parameters require the \`rs:\` prefix from the client.**
   Calling \`/v1/resources/echo?text=hi\` returns
   \`\`\`
   REST-UNSUPPORTEDPARAM: invalid parameters: text for echo
   \`\`\`
   Use \`/v1/resources/echo?rs:text=hi\` instead. Inside the SJS / XQuery service,
   read it as \`params['rs:text']\` (SJS) or \`map:get($params, "rs:text")\` (XQuery).

---

## Section 5c — Custom token replacement and environment overlays

ml-gradle replaces \`%%TOKEN%%\` placeholders in any JSON/XML file under \`ml-config/\`
and \`ml-schemas/\` (modules too, unless \`mlReplaceTokensInModules=false\`). The full
list of active tokens is shown by:
\`\`\`bash
gradle mlPrintTokens
\`\`\`

Add custom tokens in build.gradle:
\`\`\`groovy
ext {
  mlAppConfig {
    customTokens.put("%%CATALOG_REGION%%", project.hasProperty('catalogRegion') ? catalogRegion : 'us-east')
  }
}
\`\`\`
Then use \`%%CATALOG_REGION%%\` in any JSON/XML file or SJS/XQuery module.

For environment-specific config (dev / qa / prod), apply the
\`net.saliman.properties\` plugin BEFORE ml-gradle — it loads
\`gradle-\${environmentName}.properties\` on top of \`gradle.properties\`:
\`\`\`groovy
plugins {
  id "net.saliman.properties" version "1.5.2"
  id "com.marklogic.ml-gradle" version "6.1.0"
}
\`\`\`
Then set \`mlConfigPaths\` in \`gradle-dev.properties\` to add an overlay directory:
\`\`\`properties
mlConfigPaths=src/main/ml-config,src/main/dev-config
\`\`\`
Files in \`src/main/dev-config/\` deep-merge on top of the base config. Switch with:
\`\`\`bash
gradle -PenvironmentName=dev mlDeploy
\`\`\`

> **Tip:** Instead of producing this layout by hand, call the \`ml_gradle_scaffold\` tool
> with \`include_environments: true\`. It returns a complete file map with every
> gotcha above already addressed.

---

## Section 6 — Deployment checklist

### Plain ml-gradle
1. \`gradle mlDeploy\` — deploys databases, servers, security, loads schemas + modules
2. \`gradle mlLoadSchemas\` — (re)deploy TDE templates without full redeploy
3. \`gradle mlLoadModules\` — (re)deploy XQuery/SJS modules
4. Check \`ml_reindex_status\` in MCP after adding indexes
5. Verify with \`ml_views_list\` that TDE views are live before querying

### DHF (Data Hub Framework)
**Important:** \`gradle mlDeployApp\` and \`gradle hubDeploy\` fail under Java 21 with an
\`IllegalAccessError\` on \`URLDecoder\` (bytecode-level violation, not fixable with \`--add-opens\`).
Use individual tasks in this order:

1. \`gradle hubInstallModules\` — loads DHF internal modules into data-hub-MODULES
2. \`gradle hubDeployAsSecurityAdmin\` — security roles, privileges, amps
3. \`gradle mlDeployDatabases\` — database configuration
4. \`gradle mlDeployTriggers\` — **required before first flow run** — deploys the trigger that
   compiles mapping steps into XSLT; without this, mapping fails with XDMP-MODNOTFOUND
5. \`gradle hubDeployArtifacts\` — DHF built-in artifacts (default flows, step definitions)
6. \`gradle hubDeployUserArtifacts\` — your entities, flows, and steps

**Kubernetes / single-host note:** DHF creates one forest per cluster host per database.
If cluster nodes are offline, databases hang silently. Use \`ml_database_set_forests\` to
restrict each DHF database to only forests on available hosts before running any flows.

**Mapping XSLT not found?** If a mapping step fails with \`XDMP-MODNOTFOUND: *.step.xml.xslt\`,
the trigger hasn't fired yet. Touch the step document in STAGING to re-fire it:
\`\`\`javascript
// Run via ml_eval_javascript on database: data-hub-STAGING
declareUpdate();
var uri = "/steps/mapping/YourStep.step.json";
xdmp.nodeReplace(cts.doc(uri), cts.doc(uri));
\`\`\`

Generate the complete plan now.`,
        },
      }],
    })
  );

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

  // ── Semaphore Integration Advisor ──────────────────────────────────────────

  server.prompt(
    "semaphore_integration_advisor",
    "Design a complete Semaphore + MarkLogic integration architecture (the Progress Data Platform). " +
    "Returns a step-by-step plan covering ingest strategy, classification pipeline, canonical model design, " +
    "MarkLogic storage patterns, search facet configuration, and optional Data Hub Framework guidance.",
    {
      pattern: z.enum([
        "ingest-and-classify",
        "reprocess-enrich",
        "dhf-pipeline",
        "explore",
      ]).optional().describe(
        "Integration pattern: " +
        "'ingest-and-classify' = classify new content via Flux at load time; " +
        "'reprocess-enrich' = enrich documents already in MarkLogic via flux_reprocess; " +
        "'dhf-pipeline' = full Data Hub Framework pipeline with Semaphore enrichment step; " +
        "'explore' = help me choose the right pattern. Default: explore."
      ),
      content_type: z.string().describe(
        "Describe the content to classify. E.g. 'news articles in JSON', 'PDF contracts as plain text', " +
        "'product descriptions scraped from a website', 'government regulatory documents'."
      ),
      taxonomy: z.string().optional().describe(
        "Describe the Semaphore taxonomy or classification model. E.g. 'a 3-level industry taxonomy', " +
        "'IPTC NewsML subject codes', 'internal product category tree with ~500 concepts'."
      ),
      volume: z.string().optional().describe(
        "Approximate document volume and growth rate. E.g. '500k documents, 10k new/day'. " +
        "Affects thread/batch sizing recommendations."
      ),
      existing_ml_setup: z.string().optional().describe(
        "Describe existing MarkLogic setup if any. E.g. 'fresh install', 'existing DHF project with staging/final DBs', " +
        "'REST API app server on port 8010 with range indexes on date and source fields'."
      ),
    },
    ({ pattern, content_type, taxonomy, volume, existing_ml_setup }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a Progress Data Platform architect specialising in Semaphore + MarkLogic integrations.
Design a complete, actionable integration architecture for the scenario below.

═══════════════════════════════════════════
SCENARIO
═══════════════════════════════════════════
Pattern requested : ${pattern ?? "explore (help me choose)"}
Content type      : ${content_type}
Taxonomy/model    : ${taxonomy ?? "(not specified — include guidance on model selection)"}
Volume            : ${volume ?? "(not specified — provide sizing guidance)"}
Existing ML setup : ${existing_ml_setup ?? "(not specified — assume fresh MarkLogic install)"}

═══════════════════════════════════════════
PRODUCE THE FOLLOWING DESIGN
═══════════════════════════════════════════

## 1. PATTERN SELECTION (skip if pattern is not "explore")
Compare the four patterns and recommend the best fit:

  A. INGEST + CLASSIFY (Flux native — preferred for new pipelines)
     Flux imports documents and calls Semaphore Classification Server inline via
     --classifier-host/port/path extra_args. Categories stored in MarkLogic metadata
     or document body at write time.
     BEST FOR: new data pipelines; clean separation of raw and enriched not required.

  B. REPROCESS + ENRICH (post-ingest via flux_reprocess)
     Documents already exist in MarkLogic. An SJS transform module calls Semaphore
     via xdmp.httpPost(), receives scored categories, and patches each document.
     Flux handles parallelism (thread_count, batch_size).
     BEST FOR: legacy data already loaded; adding Semaphore to an existing MarkLogic deployment.

  C. TRANSFORM ON INGEST (SJS REST transform + Flux)
     A MarkLogic REST transform (stored in Modules DB) receives raw content, maps it
     to a canonical model, and calls Semaphore in the same step. Flux passes
     --transform <name> at import time.
     BEST FOR: simultaneous raw→canonical mapping AND classification; no separate reprocess needed.

  D. DATA HUB FRAMEWORK PIPELINE (DHF)
     Full DHF flows: Ingestion (raw → STAGING) → Mapping (STAGING → canonical entity in FINAL)
     → Custom Semaphore step (calls Semaphore, writes categories onto entity in FINAL)
     → optional Mastering step (entity resolution / dedup).
     BEST FOR: multiple source systems; need for STAGING/FINAL split; entity mastering required.

State which pattern you recommend and why for this scenario.

## 2. SEMAPHORE CONFIGURATION
  CLS (Classification Server) — required for classification:
  - Set SEMAPHORE_HOST (and optionally SEMAPHORE_SCS_PORT, default 5058) in the MCP server .env
  - Or use SEMAPHORE_URL=http://<host>:<port> for an explicit override
  - No authentication required for the CLS by default
  - Run semaphore_status to verify CLS connectivity and confirm version

  KMM (Knowledge Model Manager / Studio) — required for taxonomy authoring:
  - Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD (KMM uses Java EE form auth, not Basic auth)
  - Set SEMAPHORE_KMM_PORT (default 5080) for the Studio/KMM port
  - Run semaphore_studio_status to verify KMM connectivity

  Taxonomy discovery:
  - Run semaphore_publish_sets to see which taxonomy rule sets are loaded and active in CLS
  - Run semaphore_classes to see the classification class names (taxonomy domain names)
  - Run semaphore_classify with a sample document snippet (threshold=0) to validate output
  - If no rule sets are loaded: use semaphore_kmm_model_create + semaphore_kmm_skos_load to
    import a public SKOS vocabulary, then publish from Semaphore Studio UI

## 3. INGEST PIPELINE DESIGN
Provide the exact flux_import (or flux_reprocess) call for this scenario.

For PATTERN A (ingest-and-classify):
\`\`\`json
{
  "tool": "flux_import",
  "subcommand": "import-files",
  "http_url": "<source-url>",
  "collections": ["<content-type>-raw"],
  "extra_args": [
    "--classifier-host", "<semaphore-host>",
    "--classifier-port", "<semaphore-scs-port>",
    "--classifier-path", "/",
    "--classifier-http"
  ]
}
\`\`\`

For PATTERN B (reprocess-enrich):
\`\`\`json
{
  "tool": "flux_reprocess",
  "collections": ["<existing-collection>"],
  "invoke_module": "/transforms/enrich-with-semaphore.sjs",
  "thread_count": 4,
  "batch_size": 50
}
\`\`\`

Provide the concrete recipe for the recommended pattern, with correct parameter values.

## 4. CANONICAL DOCUMENT MODEL
Design the MarkLogic document structure that stores both the source content and
Semaphore classification results. Include:

a. Document URI pattern (follow uri_designer rules: /type/id.json)
b. JSON structure showing where classification data lives, e.g.:
   \`\`\`json
   {
     "id": "<source-id>",
     "title": "...",
     "body": "...",
     "source": "<source-system>",
     "publishedAt": "2024-01-15T10:00:00Z",
     "semaphore": {
       "classifiedAt": "<timestamp>",
       "classifiedBy": "flux-import",
       "clsHost": "<semaphore-host>",
       "threshold": 48,
       "categoryCount": 3,
       "categories": [
         { "className": "IPTC-MediaTopics", "label": "Sport", "id": "...", "score": 0.875 },
         { "className": "IPTC-MediaTopics", "label": "Football", "id": "...", "score": 0.721 }
       ],
       "topCategory": { "className": "IPTC-MediaTopics", "label": "Sport", "id": "..." }
     }
   }
   \`\`\`
c. Collections: recommend at least one collection per content type PLUS
   a "semaphore-classified" collection after enrichment, to scope queries.
d. Permissions: rest-reader:read, rest-writer:update minimum.

## 5. TRANSFORM MODULE (SJS) — for PATTERN B/C/D
Write a complete, production-ready SJS transform module for the Semaphore enrichment step.

For PATTERN B (flux_reprocess invoke module):
\`\`\`javascript
'use strict';
declareUpdate();
var URI; // injected by Flux — one document URI per invocation

var SEMAPHORE_HOST = '<semaphore-host>';
var SEMAPHORE_PORT = <semaphore-scs-port>;   // default: 5058
var THRESHOLD      = 48;

var doc = cts.doc(URI);
if (!doc) { xdmp.log('Document not found: ' + URI, 'warning'); }
else {
  var obj = doc.toObject();
  var textToClassify = obj.body || obj.title || obj.content || '';

  // CLS uses URL-encoded form POST to /, not JSON.
  // IMPORTANT: xdmp.httpPost() arg3 must be a Node, not a plain string.
  // Wrap the body string with fn.head(xdmp.unquote(...)) to convert.
  var bodyStr = 'body=' + encodeURIComponent(textToClassify) +
                '&threshold=' + THRESHOLD + '&singlearticle=1';
  var bodyNode = fn.head(xdmp.unquote(bodyStr, null, ['format-text']));
  var resp = Array.from(xdmp.httpPost(
    'http://' + SEMAPHORE_HOST + ':' + SEMAPHORE_PORT + '/',
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    bodyNode
  ));
  var xml = String(resp[1]);

  // Parse <META name="ClassName" value="Label" id="uuid" score="float"/>
  // CLS @score is a 0.0–1.0 float (e.g. "0.84" = 84% confidence). Do NOT divide by 100.
  // The threshold parameter sent to CLS uses a 0–100 integer scale — different from the returned score.
  var categories = [];
  var re = /<META\s+[^>]*name="([^"]+)"[^>]*value="([^"]+)"[^>]*id="([^"]+)"[^>]*score="([^"]+)"[^>]*\/>/g;
  var m;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== 'Type' && m[1] !== 'Template') {
      categories.push({ className: m[1], label: m[2], id: m[3], score: parseFloat(m[4]) });
    }
  }

  var sorted = categories.slice().sort(function(a, b) { return b.score - a.score; });
  obj.semaphore = {
    classifiedAt: (new Date()).toISOString(),
    classifiedBy: 'flux-reprocess',
    clsHost: SEMAPHORE_HOST,
    threshold: THRESHOLD,
    categoryCount: sorted.length,
    categories: sorted.map(function(c) {
      return { className: c.className, label: c.label, id: c.id, score: c.score };
    }),
    topCategory: sorted.length > 0 ? { className: sorted[0].className, label: sorted[0].label, id: sorted[0].id } : null,
  };

  xdmp.documentInsert(URI, obj, {
    permissions: xdmp.documentGetPermissions(URI),
    collections: xdmp.documentGetCollections(URI).concat(['semaphore-classified']),
  });
  xdmp.log('Classified: ' + URI + ' → ' + (sorted[0] ? sorted[0].label : 'no categories'), 'info');
}
\`\`\`

NETWORK NOTE (Kubernetes):
xdmp.httpPost() from MarkLogic pods may be blocked by K8s network policy from reaching the CLS.
If you get SVC-SOCCONN errors, switch to Pattern A (Flux classifier flags) which runs outside MarkLogic,
or pre-classify from the application/MCP tier and use ml_document_patch to write results back.

## 6. MARKLOGIC INDEXING FOR CLASSIFICATION FACETS
To expose Semaphore categories as search facets and range-query targets:

a. Path range index (add to content-database.json via ml-gradle):
   \`\`\`json
   {
     "path-namespace": [],
     "path-range-index": [
       {
         "scalar-type": "string",
         "path-expression": "semaphore/categories/label",
         "collation": "http://marklogic.com/collation/codepoint",
         "range-value-positions": false,
         "invalid-values": "ignore"
       },
       {
         "scalar-type": "string",
         "path-expression": "semaphore/topCategory/label",
         "collation": "http://marklogic.com/collation/codepoint",
         "range-value-positions": false,
         "invalid-values": "ignore"
       },
       {
         "scalar-type": "string",
         "path-expression": "semaphore/categories/className",
         "collation": "http://marklogic.com/collation/codepoint",
         "range-value-positions": false,
         "invalid-values": "ignore"
       }
     ]
   }
   \`\`\`

b. After deploying the index, verify with: ml_indexes_list (filter for path-range-index)

c. FastTrack / search options constraint:
   Use ml_search_options_put to add a constraint on semaphore/categories/label.
   This powers FacetFilters in a FastTrack UI with Semaphore categories as facets.

d. Verify with: ml_values_query on the semaphore/categories/label range index
   to see the top category distribution across the collection.

## 7. DATA HUB FRAMEWORK DETAILS (PATTERN D only)
If DHF is the recommended pattern, describe:
  a. Flow structure: Ingestion → Mapping → Custom (Semaphore) → Mastering
  b. Entity model (.entity.json) showing classification as a nested type
  c. Custom step configuration pointing at the SJS module above
  d. How DHF's built-in provenance tracks when and how a document was classified
  e. ml-gradle deployment: "gradle mlDeploy" deploys all flows, entity models, and indexes

## 8. OPERATIONAL CHECKLIST
Before going to production:
  Taxonomy setup (if rule sets are not yet loaded):
  □ semaphore_kmm_models_list — list existing taxonomy models in KMM
  □ semaphore_kmm_model_create — create a new model if needed
  □ semaphore_kmm_skos_load — load SKOS from a public URL (IPTC, EuroVoc, AGROVOC …)
  □ semaphore_kmm_sparql — verify concept count and spot-check labels
  □ Semaphore Studio UI — publish model as a CLS rule set (required before CLS can classify)

  CLS classification validation:
  □ semaphore_status — confirm CLS reachability from the Flux runner host
  □ semaphore_publish_sets — confirm taxonomy publish sets are loaded and active
  □ semaphore_classes — confirm classification class names match your taxonomy
  □ semaphore_classify (threshold=0) — spot-check 3–5 sample documents
  □ If all scores are 0: wait for Publisher service to finish indexing after publish

  Pipeline and indexing:
  □ flux_preview before flux_import / flux_reprocess — verify document structure
  □ ml_indexes_list after deploying indexes — confirm path range indexes are active
  □ ml_reindex_status — wait for background reindex to complete before facet queries
  □ ml_values_query on semaphore/topCategory/label — verify category distribution
  □ ml_tde_validate (if using TDE over classification fields) — confirm view is correct

Be specific, practical, and reference actual MCP tool names and Zod parameter names throughout.`,
        },
      }],
    })
  );

  // ── OAuth2 Setup Advisor ────────────────────────────────────────────────────
  server.prompt(
    "oauth_setup_advisor",
    "Generate MarkLogic Management API configuration steps to register an OIDC provider as an external security source and enable OAuth2 Bearer token authentication on a MarkLogic app server. Outputs ready-to-use JSON bodies for the Management API, XQuery verification code, and a test cURL command.",
    {
      oidc_issuer_url: z.string().describe("OIDC provider issuer URL, e.g. https://authentik.example.com/application/o/my-app/ or https://login.microsoftonline.com/<tenant>/v2.0"),
      client_id: z.string().describe("OAuth2 client ID registered in your OIDC provider"),
      client_secret: z.string().optional().describe("OAuth2 client secret (required for token introspection; omit if using public clients or JWKS-only validation)"),
      role_claim: z.string().optional().describe("JWT claim name that contains MarkLogic role(s), e.g. 'roles' or 'groups'. Defaults to using the sub claim for user mapping."),
      app_server_name: z.string().optional().describe("Name of the MarkLogic app server to configure (default: 'Documents'). Use ml_servers_list to find available servers."),
      app_server_port: z.coerce.number().optional().describe("Port of the app server to configure (default: 8000). Helps identify the correct server."),
    },
    ({ oidc_issuer_url, client_id, client_secret, role_claim, app_server_name, app_server_port }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a MarkLogic security configuration expert. Generate the complete configuration steps to enable OAuth2/OIDC Bearer token authentication on a MarkLogic app server.

**OIDC Provider Details:**
- Issuer URL: ${oidc_issuer_url}
- Client ID: ${client_id}
${client_secret ? `- Client Secret: (provided — used for token introspection if needed)\n` : "- Client Secret: not provided (JWKS public key validation only)\n"}- Role claim in JWT: ${role_claim ?? "(not specified — use sub claim + internal authorization)"}

**Target App Server:**
- Name: ${app_server_name ?? "App-Services"}
- Port: ${app_server_port ?? 8000}

**CRITICAL — How MarkLogic OAuth role authorization works (verified on ML 12):**

There are two authorization modes. Choose based on your token structure:

**authorization: "oauth"** (recommended when JWT carries role claims):
- MarkLogic reads the JWT claim named by oauth-role-attribute (e.g. "${role_claim ?? "roles"}")
- The claim VALUE(s) are matched against each MarkLogic role's **external-name** list (NOT the role-name)
- You must call sec:role-set-external-names() to register the JWT claim value as an external-name on the target role
- Example: JWT has "${role_claim ?? "roles"}": "rest-reader" → you must set external-name "rest-reader" on the rest-reader role

**authorization: "internal"** (when users are pre-provisioned in MarkLogic):
- MarkLogic reads the JWT claim named by oauth-username-attribute (typically "sub")
- That value is matched against each MarkLogic user's **external-name** list
- The matching user's roles are assigned to the session
- You must call sec:user-set-external-names() to register the JWT sub value on the MarkLogic user

**CRITICAL — External security must be created via sec:create-external-security() API, not raw XQuery node manipulation.** Raw XQuery edits can place elements in the wrong order, which silently breaks role assignment in ML 12.

Generate the following sections:

## Section 1: Prerequisites Checklist
- MarkLogic version 11+ required for OAuth2 JWT external security with JWKS validation
- The OIDC provider must have this MarkLogic server registered as an OAuth2 client
- MarkLogic must be able to reach the JWKS endpoint over HTTPS (test with xdmp:http-get via ml_eval_xquery)
- The JWT "iss" claim must EXACTLY match the oauth-jwt-issuer-uri (including trailing slash)
- Use ml_servers_list to find the correct app server name and group-id before running Section 3

## Section 2: Create the External Security Object (XQuery API — required)
Use ml_eval_xquery with database="Security". The sec:create-external-security() API ensures correct XML element ordering that ML 12 requires:

\`\`\`xquery
xquery version "1.0-ml";
import module namespace sec = "http://marklogic.com/xdmp/security"
  at "/MarkLogic/security.xqy";

let $ext-sec-name := "${oidc_issuer_url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+$/, "")}"

(: If it already exists, remove it first :)
let $_ := try { sec:remove-external-security($ext-sec-name) } catch ($e) { () }

let $oauth-server :=
  <sec:oauth-server xmlns:sec="http://marklogic.com/xdmp/security">
    <sec:oauth-vendor>Other</sec:oauth-vendor>
    <sec:oauth-flow-type>Resource server</sec:oauth-flow-type>
    <sec:oauth-client-id>${client_id}</sec:oauth-client-id>
    <sec:oauth-jwt-issuer-uri>${oidc_issuer_url}</sec:oauth-jwt-issuer-uri>
    <sec:oauth-token-type>JSON Web Tokens</sec:oauth-token-type>
    <sec:oauth-username-attribute>sub</sec:oauth-username-attribute>
    <sec:oauth-role-attribute>${role_claim ?? ""}</sec:oauth-role-attribute>
    <sec:oauth-privilege-attribute/>
    <sec:oauth-jwt-alg>RS256</sec:oauth-jwt-alg>
    <sec:oauth-jwks-uri>${oidc_issuer_url.replace(/\/?$/, "/jwks/")}</sec:oauth-jwks-uri>
  </sec:oauth-server>

return sec:create-external-security(
  $ext-sec-name,
  "OIDC external security for ${oidc_issuer_url}",
  "oauth",            (: authentication :)
  xs:unsignedInt(0),  (: cache-timeout: 0 = no caching during setup/testing :)
  "${role_claim ? "oauth" : "internal"}",    (: authorization mode :)
  (),                 (: ldap-server :)
  (),                 (: saml-server :)
  $oauth-server
)
\`\`\`

## Section 3: App Server Configuration (Management API)
Run ml_servers_list first to confirm server name and group-id values, then apply to ALL groups:
\`\`\`bash
# Repeat for each group (apps, enode, Default, etc.)
curl -u admin:password -X PUT \\
  "http://<ML_HOST>:8002/manage/v2/servers/${app_server_name ?? "App-Services"}/properties?group-id=<GROUP>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "authentication": "oauth",
    "internal-security": true,
    "API-token-authentication": false,
    "default-user": "nobody",
    "external-security": ["${oidc_issuer_url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+$/, "")}"]
  }'
\`\`\`
Note: "external-security" is an **array** in the JSON body. "default-user": "nobody" means requests without a valid Bearer token receive an error (no anonymous access).

## Section 4: Role / User Mapping
${role_claim
  ? `**authorization: "oauth" mode** — JWT claim "${role_claim}" values are matched against role **external-names**.

For each role you want to grant via the "${role_claim}" claim, register the JWT claim value as an external-name on that role:
\`\`\`xquery
xquery version "1.0-ml";
import module namespace sec = "http://marklogic.com/xdmp/security"
  at "/MarkLogic/security.xqy";
(: Example: JWT has "${role_claim}": "rest-reader" — register "rest-reader" as external-name on the rest-reader role :)
sec:role-set-external-names("rest-reader", ("rest-reader")),
sec:role-set-external-names("rest-writer", ("rest-writer")),
sec:role-set-external-names("admin", ("admin"))
(: Add one call per role you want to map. The external-name string must EXACTLY match the JWT claim value. :)
\`\`\`
Run via ml_eval_xquery with database: "Security".

If the JWT "${role_claim}" claim is a **string** (not an array), only one role is mapped per token. If it is a **JSON array**, MarkLogic maps all values.`
  : `**authorization: "internal" mode** — JWT "sub" claim value is matched against user **external-names**.

Create a MarkLogic user and set its external-name to the JWT sub value:
\`\`\`xquery
xquery version "1.0-ml";
import module namespace sec = "http://marklogic.com/xdmp/security"
  at "/MarkLogic/security.xqy";
(: Create the user with desired roles :)
let $uid := sec:create-user(
  "<JWT-sub-value>",
  "OIDC user",
  xdmp:random(),
  "OIDC user via ${oidc_issuer_url}",
  ("rest-reader", "rest-writer"),
  (), ()
)
(: Set the external-name to the JWT sub value :)
return sec:user-set-external-names("<JWT-sub-value>", ("<JWT-sub-value>"))
\`\`\`
The username and external-name must both equal the exact JWT sub string.`}

## Section 5: Verification Steps

1. Verify the external security document structure (run via ml_eval_xquery, database: "Security"):
\`\`\`xquery
xquery version "1.0-ml";
for $doc in cts:search(fn:doc(),
  cts:collection-query("http://marklogic.com/xdmp/external-securities"))
return $doc
\`\`\`
Confirm: authentication → cache-timeout → authorization appear in that order BEFORE oauth-server.

2. Decode a test JWT to check claim names and values:
\`\`\`xquery
xquery version "1.0-ml";
let $token := "<YOUR_BEARER_TOKEN>"
return xdmp:jwt-decode($token)
\`\`\`
Verify the "iss" matches oauth-jwt-issuer-uri exactly, and the role/sub claim values match what you configured in Section 4.

3. Test MarkLogic directly:
\`\`\`bash
# With valid Bearer token — expect HTTP 200
curl -H "Authorization: Bearer <YOUR_JWT>" \\
  http://<ML_HOST>:${app_server_port ?? 8000}/v1/search?format=json

# Check access log for role assignment (Kubernetes example)
kubectl exec <ml-pod> -n <namespace> -- tail -5 /var/opt/MarkLogic/Logs/8000_AccessLog.txt
# Expected log line: External User(...) is Mapped to Temp User(...) with Role(s): <role-name>
\`\`\`

4. If roles are still empty after confirming all configuration, clear the external security cache:
\`\`\`xquery
xquery version "1.0-ml";
import module namespace sec = "http://marklogic.com/xdmp/security"
  at "/MarkLogic/security.xqy";
sec:external-security-clear-cache("${oidc_issuer_url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+$/, "")}")
\`\`\`

## Section 6: MCP Server Configuration
\`\`\`bash
ML_HOST=<your-marklogic-host>
ML_PORT=${app_server_port ?? 8000}
ML_AUTH_TYPE=oauth
MCP_TRANSPORT=http
# ML_USERNAME and ML_PASSWORD are NOT used in oauth mode
# Each MCP client provides its own Bearer token in the Authorization header
\`\`\`

## Section 7: Troubleshooting
- **Temp User with Role(s): (empty) → HTTP 403**: The JWT claim value doesn't match any role external-name (oauth mode) or no user has the JWT sub as external-name (internal mode). Check Section 4.
- **Element order in Security DB**: The external security document MUST have authentication/cache-timeout/authorization BEFORE oauth-server. Always use sec:create-external-security() — never build the doc manually with xdmp:node-insert-child().
- **Issuer mismatch**: The "iss" claim in the JWT must exactly match oauth-jwt-issuer-uri including trailing slash. Decode your JWT with xdmp:jwt-decode() and compare character-for-character.
- **JWKS unreachable**: MarkLogic pods must reach ${oidc_issuer_url.replace(/\/?$/, "/jwks/")} over HTTPS. Test server-side: xdmp:http-get("${oidc_issuer_url.replace(/\/?$/, "/jwks/")}") via ml_eval_xquery.
- **Multiple groups**: If your cluster has multiple groups (apps, enode, etc.), apply Section 3 to EACH group separately or requests will fail on nodes in unconfigured groups.
- **API-token-authentication**: Keep this false when using standard OIDC JWTs. Setting it true enables MarkLogic's own token format and may conflict with external JWTs.
- **Port 8000 locked out**: If you accidentally break basic auth on port 8000, use port 8002 (Management API) to restore it: PUT /manage/v2/servers/App-Services/properties?group-id=<GROUP> with {"authentication":"basic","external-security":[]}.`,
        },
      }],
    })
  );

  // ── RAG Pipeline Designer ───────────────────────────────────────────────────
  server.prompt(
    "rag_pipeline_designer",
    "Design a Retrieval-Augmented Generation (RAG) pipeline using MarkLogic 12 as the vector store and/or knowledge graph. " +
    "Covers three composable paradigms — Lexical RAG (BM25, no embeddings), Vector RAG (ANN/KNN hybrid with vec:vectorScore), " +
    "and Graph RAG (Semaphore concept classification → concept-scoped search) — and their layered combinations. " +
    "Returns a 6-section plan: document+embedding design, TDE vec:vector column spec, retrieval strategy options, " +
    "step-by-step tool sequence, reranking, and pitfalls from live testing. " +
    "Requires MarkLogic 12+. Call ml_views_list and ml_schema_get_tde first to check for existing vector TDE views.",
    {
      domain: z.string().describe("Type of content stored, e.g. 'legal contracts', 'news articles', 'product manuals'"),
      embedding_source: z.string().optional().describe("How embeddings are generated, e.g. 'OpenAI text-embedding-3-small (1536d)', 'local BERT 768d'. Omit if using Lexical RAG only."),
      collection: z.string().optional().describe("MarkLogic collection holding the documents, if known"),
      filter_fields: z.string().optional().describe("Comma-separated fields used to pre-filter before vector search, e.g. 'category,date,language'"),
      k: z.number().int().positive().optional().describe("Number of nearest neighbours to retrieve (default: 10)"),
      approach: z.enum(["lexical", "vector", "hybrid", "graph", "graph+lexical", "graph+vector", "all"]).optional()
        .describe("Retrieval paradigm to focus on. 'all' (default) shows all options with tradeoffs. 'hybrid' = ANN vector + BM25 combined via vec:vectorScore."),
      has_semaphore: z.boolean().optional().describe("Set true if Semaphore Classification Server is available for Graph RAG. Enables concept-scoped retrieval using semaphore_classify."),
    },
    ({ domain, embedding_source, collection, filter_fields, k, approach, has_semaphore }) => {
      const schema = domain.toLowerCase().replace(/[^a-z0-9]/g, "_") + "_schema";
      const view   = domain.toLowerCase().replace(/[^a-z0-9]/g, "_") + "_view";
      const kVal   = k ?? 10;
      const focus  = approach ?? "all";
      const hasSem = has_semaphore ?? false;
      const dims   = embedding_source?.match(/(\d+)d/)?.[1] ?? "1536";
      const col    = collection ?? "(use ml_collections_list to discover)";

      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `You are a MarkLogic 12 architect. Design a complete RAG pipeline for the following context:

**Content domain:** ${domain}
**Embedding model:** ${embedding_source ?? "not yet specified — recommend one based on domain"}
**MarkLogic collection:** ${col}
**Pre-filter fields:** ${filter_fields ?? "(none — consider adding for precision)"}
**k (nearest neighbours):** ${kVal}
**Retrieval approach:** ${focus}
**Semaphore available:** ${hasSem ? "yes — Graph RAG enabled" : "no — graph patterns require semaphore_classify"}

Produce a 6-section design plan:

## Section 1: DOCUMENT + EMBEDDING DESIGN

Describe how to store embeddings alongside content in MarkLogic JSON documents:
- Use field name \`"embedding"\` containing a JSON array of floats as a sibling of the content fields.
- Recommend chunk-vs-whole-document strategy based on the domain (legal contracts → chunk by clause; news articles → whole-document or paragraph; product manuals → chunk by section).
- Include metadata fields: \`"embeddingModel"\`, \`"embeddingDim"\`, \`"chunkIndex"\`, \`"chunkText"\`, \`"sourceUri"\` (if chunked).
- Show a representative JSON document skeleton for ${domain}.
- Important: embeddings must be generated externally (OpenAI, Cohere, local sentence-transformer) then stored via flux_import or ml_document_put. MarkLogic's xdmp.httpPost cannot reliably reach HTTPS embedding APIs from the server due to SSL SNI constraints — generate embeddings in your application tier and store the float array.

## Section 2: TDE VEC:VECTOR COLUMN

Provide the exact TDE JSON template to expose the embedding for Optic vector queries.
Deploy via ml_document_put to the Schemas database (collection \`http://marklogic.com/xdmp/tde\` is added automatically when the URI starts with /tde/).

\`\`\`json
{
  "template": {
    "context": "/",
    "collections": ["${collection ?? domain.toLowerCase().replace(/[^a-z0-9]/g, "-")}"],
    "rows": [{
      "schemaName": "${schema}",
      "viewName": "${view}",
      "columns": [
        { "name": "uri",       "scalarType": "string", "val": "xdmp:node-uri(.)" },
        { "name": "content",   "scalarType": "string", "val": "chunkText" },
        { "name": "embedding", "scalarType": "vector", "val": "array-node('embedding')",
          "dimension": "${dims}", "invalidValues": "reject" }${filter_fields ? filter_fields.split(",").map(f =>
          `,\n        { "name": "${f.trim()}", "scalarType": "string", "val": "${f.trim()}" }`).join("") : ""}
      ]
    }]
  }
}
\`\`\`

Critical rules:
- \`"scalarType": "vector"\` (not \`"vec:vector"\` or \`"scalar": "vec:vector"\` — those cause TDE-INVALIDTEMPLATENODEVAL).
- \`"val": "array-node('embedding')"\` — selects the JSON array node as a whole; \`"val": "embedding"\` atomises to individual number nodes and causes XDMP-CAST.
- \`"dimension"\` is required and must match the embedding model output exactly (${dims} for ${embedding_source ?? "your chosen model"}).
- \`"invalidValues": "reject"\` — skips documents where embedding is missing/malformed instead of failing the whole view.
- After deployment run ml_reindex_status(database="Documents") and wait for ready=true before issuing vector queries.
- Validate with: tde.validate([cts.doc('/tde/your/template.json')],[]) in ml_eval_javascript — empty array = no errors.

## Section 3: RETRIEVAL STRATEGY OPTIONS

Three composable RAG paradigms. Choose one or layer them:

---

### Paradigm 1 — LEXICAL RAG (BM25, no embeddings required)

Best for: domains where exact terminology matters (legal, medical, technical); fast path with no embedding infrastructure.

Limitations from live testing on a 5-article corpus:
- Misses cross-concept connections: a query about "chemical contaminants in marine ecosystems" may miss an article about "urban air pollution" even though both share the Pollutants concept.
- Single-term queries return sparse results when vocabulary doesn't overlap the document text.

\`\`\`javascript
// ml_search or ml_eval_javascript
cts.search(cts.andQuery([
  cts.collectionQuery("${collection ?? domain}"),
  cts.wordQuery(queryTerms)
]), ["score-bm25", "unfiltered"])
\`\`\`

Via MCP: ml_search with collection="${collection ?? domain}" and the query text.

---

### Paradigm 2 — VECTOR RAG (ANN + BM25 hybrid)

Requires: TDE view from Section 2 deployed and indexed. Embedding array stored on each document.

**2a. Pure cosine similarity** (simplest):
\`\`\`javascript
const op = require('/MarkLogic/optic');
// vec is a global in MarkLogic 12 — do NOT require('/MarkLogic/vec')
const queryVec = vec.vector(queryEmbedding);  // float[]

op.fromView("${schema}", "${view}")
  .bind(op.as("score", op.vec.cosine(op.col("embedding"), op.vec.vector(queryVec))))
  .orderBy(op.desc(op.col("score")))
  .select(["uri", "content", "score"])
  .limit(${kVal})
  .result()
\`\`\`
Via MCP: ml_vector_search(schema="${schema}", view="${view}", vector_column="embedding", query_vector=[...], k=${kVal})

**2b. ANN top-k** (faster for large corpora, uses approximate nearest neighbour index):
\`\`\`javascript
const op = require('/MarkLogic/optic');
const queryVec = vec.vector(queryEmbedding);

// annTopK is a METHOD on the plan — not a function on op or vec
op.fromView("${schema}", "${view}")
  .annTopK(${kVal}, op.col("embedding"), queryVec, op.col("ann_distance"),
           { distanceThreshold: 1.0 })
  .select(["uri", "content", "ann_distance"])
  .result()
// Note: ann_distance is cosine distance (lower = more similar; 0=identical, 2=opposite)
\`\`\`

**2c. ANN hybrid (ANN + BM25 combined via vec.vectorScore)** — recommended for production:
\`\`\`javascript
// Two-step hybrid: ANN for candidates, fromSearchDocs for BM25 signal, vec.vectorScore to combine
const op = require('/MarkLogic/optic');
const queryVec = vec.vector(queryEmbedding);  // float[]
const lexQuery = cts.andQuery([
  cts.collectionQuery("${collection ?? domain}"),
  cts.wordQuery(queryTerms)
]);

// Step 1: ANN top-k candidates
const annRows = Array.from(
  op.fromView("${schema}", "${view}")
    .annTopK(${kVal * 3}, op.col("embedding"), queryVec, op.col("ann_distance"),
             { distanceThreshold: 1.5 })
    .result()
);
const candidateUris = annRows.map(r => r["${schema}.${view}.uri"]);

// Step 2: BM25 scores for candidates via fromSearchDocs (returns normalized Optic scores)
const lexScores = {};
Array.from(
  op.fromSearchDocs(cts.andQuery([cts.documentQuery(candidateUris), lexQuery]))
    .select(["uri", "score"])
    .result()
).forEach(r => { lexScores[r.uri] = r.score; });

// Step 3: Combine — vec.vectorScore(distance, bm25, weight) returns a RANK (lower = better)
// weight = lexical signal weight (0.0–1.0); higher weight emphasises BM25
const results = annRows.map(r => {
  const uri  = r["${schema}.${view}.uri"];
  const dist = r["ann_distance"];
  const bm25 = lexScores[uri] || null;
  return { uri, dist, bm25, rank: vec.vectorScore(dist, bm25, 0.7) };
}).sort((a, b) => {
  if (a.rank === null && b.rank === null) return a.dist - b.dist;  // both lex-only: sort by vector
  if (a.rank === null) return 1;   // nulls (no BM25 match) go last
  if (b.rank === null) return -1;
  return a.rank - b.rank;          // ASCENDING — lower rank = better combined score
}).slice(0, ${kVal});
\`\`\`

**IMPORTANT — vec.vectorScore semantics (verified by live testing):**
- Returns an integer RANK where **lower is better** → sort ASCENDING.
- First arg: vector distance from annTopK (0–2, lower=closer).
- Second arg: BM25 score from fromSearchDocs (large positive integer).
- Documents matching ONLY the vector arm (null BM25) receive rank=null — sort them last.
- The weight parameter controls lexical emphasis (0.7 = 70% lexical influence).
- Do NOT use raw cts.score() values — use the Optic fromSearchDocs \`score\` column.

---

### Paradigm 3 — GRAPH RAG (Semaphore concept classification → concept-scoped retrieval)

Requires: Semaphore Classification Server (semaphore_classify). ${hasSem ? "✓ Available." : "Not configured — set has_semaphore=true if you add Semaphore."}

Best for: domains where cross-concept connections matter (news, research, policy). Bridges vocabulary gaps that lexical search misses.

From live testing: a query about "health impacts of environmental pollution" correctly retrieved an article about "urban air pollution" AND surfaced a cross-concept connection via the shared "Pollutants" taxonomy concept — which pure lexical search missed for a related query.

\`\`\`javascript
// Step 1: Classify the user question → taxonomy concepts
// MCP: semaphore_classify(content=userQuestion, threshold=40)
// → [{label:"Health", id:"29a0..."}, {label:"Pollutants", id:"e821..."}, ...]

// Step 2: Build concept-scope query from returned concept IDs
const conceptIds = classificationResults.map(c => c.id);
const conceptQuery = cts.jsonPropertyValueQuery("id", conceptIds);

// Step 3: Retrieve concept-matched document URIs
const scopedUris = Array.from(
  cts.uris("", ["limit=100"], conceptQuery)
).map(String);

// Step 4: Lexical search within concept scope
const results = Array.from(
  cts.search(cts.andQuery([cts.documentQuery(scopedUris), cts.wordQuery(queryTerms)]),
             ["score-bm25", "unfiltered"])
);
\`\`\`

**Graph + Vector (recommended when both Semaphore and embeddings are available):**
\`\`\`javascript
// Concept scope narrows the ANN candidate set — eliminates false positives
const queryVec = vec.vector(queryEmbedding);
const conceptQuery = cts.jsonPropertyValueQuery("id", conceptIds);
const scopedUris = Array.from(cts.uris("", ["limit=100"], conceptQuery)).map(String);

// ANN scoped to concept-matched documents only
const op = require('/MarkLogic/optic');
const results = Array.from(
  op.fromView("${schema}", "${view}")
    .where(cts.documentQuery(scopedUris))          // concept filter BEFORE ANN
    .annTopK(${kVal}, op.col("embedding"), queryVec,
             op.col("ann_distance"), { distanceThreshold: 1.5 })
    .select(["uri", "content", "ann_distance"])
    .result()
);
\`\`\`

Live test finding: Graph+Vector eliminated a CRISPR article that wrongly matched "chemical" and "ecosystem" lexically — the concept filter blocked it because it lacked the Marine Ecosystems concept.

---

### Choosing and Layering Strategies

| Situation | Recommended approach |
|---|---|
| No embeddings, fast prototype | Lexical RAG |
| Embeddings available, simple queries | Pure vector (2a) |
| Mixed vocab + semantic queries | ANN Hybrid (2c) |
| Knowledge graph / taxonomy available | Graph + Lexical |
| Highest precision, all infrastructure | Graph + Vector (3+2b) |
| Multi-hop concept traversal | Graph + ANN Hybrid |

Graph layer can be added to ANY retrieval paradigm — it simply provides a URI scope filter. Apply it before any search/ANN step.

## Section 4: RETRIEVAL SEQUENCE (step-by-step tool calls)

For a production Graph + Vector RAG query:

1. **semaphore_classify** (if has_semaphore) — classify the user question; extract concept IDs from results
2. **ml_eval_javascript** — \`cts.uris("", ["limit=100"], cts.jsonPropertyValueQuery("id", conceptIds))\` → scoped URI list
3. **ml_views_list** — confirm TDE view exists: schema="${schema}", view="${view}"
4. **ml_reindex_status**(database="Documents") — confirm ready=true
5. **ml_eval_javascript** — run ANN hybrid (Section 3 Step 2b/2c) scoped to concept URIs → top-${kVal} ranked results
6. **ml_document_get** (for each URI) — retrieve full document content
7. *(Application)* Assemble retrieved content + scores into LLM prompt. Pass to Claude/GPT with the user's question.

For Lexical RAG only (steps 1–2 optional, skip 3–5):
- Replace step 5 with: **ml_search** or **ml_eval_javascript** with cts.search + cts.wordQuery.

## Section 5: RERANKING

When to add a second-pass reranker:
- **Cosine alone is sufficient** for whole-document embeddings with high-quality models (e.g. text-embedding-3-small).
- **Add a cross-encoder reranker** when: chunks are short (sentence-level), query is multi-faceted, or top-k results have inconsistent quality. Options: Cohere Rerank v3, cross-encoder/ms-marco-MiniLM.
- **Graph pre-filter replaces reranking** in many cases — if concept scoping already eliminates off-topic results, a reranker adds overhead without benefit.
- **Deduplication**: for chunked documents, group by \`sourceUri\` after reranking to avoid the LLM context window being filled by chunks from a single document.
- **Score threshold for pure vector**: discard results where cosine similarity < 0.5 (distance > 1.0) to avoid weakly related context. For ANN hybrid, discard results where rank > 50 (heuristic — tune per domain).

## Section 6: PITFALLS (from live testing)

1. **TDE vec:vector format** — \`"scalar": "vec:vector"\` and \`"scalarType": "vec:vector"\` both fail. The correct field is \`"scalarType": "vector"\` (no namespace prefix) plus \`"dimension": "${dims}"\`. Validate before querying: tde.validate([cts.doc('/tde/...')],[]) returns [] on success.

2. **TDE val for JSON arrays** — \`"val": "embedding"\` atomises the JSON array into 1536 individual number nodes → XDMP-CAST. Use \`"val": "array-node('embedding')"\` to select the array node as a unit.

3. **vec module** — \`require('/MarkLogic/vec')\` throws XDMP-MODNOTFOUND. \`vec\` is a global object in MarkLogic 12 SJS — use it directly: \`vec.vector([...])\`, \`vec.vectorScore(...)\`.

4. **annTopK is a plan method** — call as \`.annTopK(k, op.col('embedding'), queryVec, op.col('distance'), options)\` on a ModifyPlan. It is NOT \`op.annTopK()\`. The query vector argument uses the global \`vec.vector()\`, not \`op.vec.vector()\`.

5. **vec.vectorScore sort direction** — sorts ASCENDING (lower rank = better). The Optic \`op.vec.vectorScore\` used inside a plan sorts descending, but the SJS global \`vec.vectorScore()\` returns an integer rank where lower is better. If you use the two-step JS pattern, sort asc.

6. **ANN hybrid false positives** — BM25 can surface articles that match query words in an irrelevant context (e.g. "chemical" in a gene-editing article matching a marine pollution query). Apply Graph concept pre-filtering to prune these before the hybrid step.

7. **Dimensionality mismatch** — stored embeddings (${dims}d) must match query vector dimensions exactly. MarkLogic returns XDMP-DIMMISMATCH. Log \`embeddingDim\` at ingest time.

8. **Querying before reindex** — ml_reindex_status shows indexing=true after TDE deployment. Vector queries return SQL-TABLEREINDEXING until ready=true.

9. **OpenAI from MarkLogic server** — xdmp.httpPost to external HTTPS APIs often fails with \`tlsv1 unrecognized name\` (SSL SNI issue in MarkLogic's Java SSL client). Generate embeddings in your application tier and store the float array via ml_document_put or flux_import.`,
          },
        }],
      };
    }
  );

  // ── Envelope Pattern Advisor ────────────────────────────────────────────────
  server.prompt(
    "envelope_pattern_advisor",
    "Design or diagnose the MarkLogic envelope pattern for data integration. " +
    "Returns a 7-section plan covering envelope anatomy, URI/collection strategy, header design, " +
    "instance document design, triple attachment, MCP ingest sequence, and query patterns. " +
    "In diagnose mode, inspects an existing collection for envelope conformance using ml_document_sample output. " +
    "The envelope pattern is canonical for multi-source data integration and DHF (Data Hub Framework) deployments.",
    {
      mode: z.enum(["design", "diagnose"]).describe("'design' for planning a new integration; 'diagnose' for inspecting existing documents"),
      domain: z.string().describe("What data you are integrating, e.g. 'orders from SAP and Salesforce', 'patient records'"),
      collection: z.string().optional().describe("Existing MarkLogic collection to inspect (especially useful for diagnose mode)"),
      source_systems: z.string().optional().describe("Comma-separated source system names, e.g. 'SAP,Salesforce,CSV'"),
      database: z.string().optional().describe("Target MarkLogic database name"),
    },
    ({ mode, domain, collection, source_systems, database }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a MarkLogic data integration architect. ${mode === "diagnose" ? `Diagnose whether existing ${domain} documents in ${collection ? `collection '${collection}'` : "MarkLogic"} follow the envelope pattern.` : `Design the envelope pattern for integrating ${domain}.`}

**Mode:** ${mode}
**Domain:** ${domain}
**Collection:** ${collection ?? "(use ml_collections_list to discover)"}
**Source systems:** ${source_systems ?? "(not specified)"}
**Database:** ${database ?? "(default)"}

${mode === "diagnose" ? `
## DIAGNOSIS INSTRUCTIONS

Before producing the sections below, instruct the agent to:
1. Call \`ml_document_sample\` on collection '${collection ?? "<collection>"}' to retrieve 3–5 sample documents.
2. Inspect each sample for a top-level \`"envelope"\` key.
3. Within \`envelope\`, check for sub-keys: \`"headers"\`, \`"instance"\`, \`"attachments"\`, \`"triples"\`.
4. Report conformance level:
   - **Full**: all four zones present
   - **Partial**: \`headers\` and \`instance\` present; \`attachments\` or \`triples\` missing
   - **Instance-only**: only \`instance\` present under \`envelope\`
   - **Non-conformant**: no \`envelope\` key at root level
5. For non-conformant documents, describe what structure IS present and suggest a migration path.

Then produce the sections below based on what the agent finds.
` : ""}

## Section 1: ENVELOPE ANATOMY

The envelope pattern wraps every document in a consistent outer structure with four zones:

\`\`\`json
{
  "envelope": {
    "headers": {
      "sourceDocument": "/raw/${source_systems ? source_systems.split(",")[0].trim().toLowerCase() : "source"}/{id}",
      "sourceFormat":   "json",
      "ingestTime":     "2025-01-15T09:30:00Z",
      "datahubCreatedBy": "flux-import-pipeline",
      "sourceQuery":    "SELECT * FROM ${domain.replace(/[^a-zA-Z]/g, "_").toUpperCase()}",
      "permissions":    [{ "role-name": "app-user", "capabilities": ["read"] }],
      "classifications": []
    },
    "instance": {
      "${domain.replace(/[^a-zA-Z]/g, "_").toLowerCase()}": {
        "info": { "title": "${domain}", "version": "1.0.0" }
      }
    },
    "attachments": {
      "raw": "<original source document preserved here>"
    },
    "triples": []
  }
}
\`\`\`

**Zone responsibilities:**
- \`headers\` — provenance, permissions, ingest metadata, Semaphore classifications. Never contains business data.
- \`instance\` — canonical model: the normalized, business-ready version of the data. This is what queries target.
- \`attachments\` — raw source document, preserved for audit and re-processing. Optional but recommended.
- \`triples\` — RDF relationships expressed as \`[{"triple":{"subject":"...","predicate":"...","object":"..."}}]\`. Use the **plural** key \`"triples"\` with each element wrapped in \`"triple"\`.

## Section 2: COLLECTION + URI STRATEGY

Design the collection and URI scheme for ${domain}:

${source_systems ? source_systems.split(",").map(s => `- Collection \`${s.trim().toLowerCase()}-raw\` — raw documents from ${s.trim()} before harmonization`).join("\n") : "- Collection `<source>-raw` — raw documents from each source system"}
- Collection \`${domain.replace(/[^a-zA-Z]/g, "-").toLowerCase()}\` — all harmonized ${domain} entity documents
- Collection \`${domain.replace(/[^a-zA-Z]/g, "-").toLowerCase()}-envelopes\` — optional: scope envelope queries only

**URI pattern:**
\`\`\`
/entities/${domain.replace(/[^a-zA-Z]/g, "-").toLowerCase()}/{sourceSystem}-{primaryKey}.json
\`\`\`
Examples:
${source_systems ? source_systems.split(",").map(s => `- \`/entities/${domain.replace(/[^a-zA-Z]/g, "-").toLowerCase()}/${s.trim().toLowerCase()}-12345.json\``).join("\n") : `- \`/entities/${domain.replace(/[^a-zA-Z]/g, "-").toLowerCase()}/sap-12345.json\``}

**Rules:**
- URI = stable identity. Include ONLY immutable primary key fields.
- Prefix matches the collection name so ml_document_list can scope by directory.
- Never embed mutable fields (status, owner, date) in URIs.

## Section 3: HEADER DESIGN

Mandatory header fields for ${domain} documents:

\`\`\`json
"headers": {
  "sourceDocument":    "<URI of the raw source record>",
  "sourceSystem":      "${source_systems ? source_systems.split(",")[0].trim() : "<system>"}",
  "sourceFormat":      "json | xml | csv",
  "ingestTime":        "<ISO-8601 timestamp>",
  "datahubCreatedBy":  "flux-import | dhf-flow | rest-transform",
  "datahubCreatedOn":  "<ISO-8601 timestamp>",
  "id":                "<primary key value for dedup>",
  "permissions":       [{ "role-name": "app-user", "capabilities": ["read", "update"] }],
  "classifications":   []
}
\`\`\`

Optional but recommended:
- \`"sourceQuery"\` — the JDBC query or file path that produced this document
- \`"schemaVersion"\` — instance model version for schema evolution
- \`"mergeHash"\` — fingerprint for mastering/dedup (DHF mastering step)

## Section 4: INSTANCE DOCUMENT DESIGN

The \`instance\` zone holds the canonical model for ${domain}:

\`\`\`json
"instance": {
  "${domain.replace(/[^a-zA-Z]/g, "_").toLowerCase()}": {
    "info": {
      "title": "${domain}",
      "version": "1.0.0",
      "baseUri": "http://example.org/${domain.replace(/[^a-zA-Z]/g, "-").toLowerCase()}/"
    },
    "primaryKey": "<value>",
    "canonicalField1": "<mapped value>",
    "canonicalField2": "<mapped value>"
  }
}
\`\`\`

**Field mapping rules:**
- All source field names mapped to a canonical schema (run ml_schema_discover on source docs to get field list).
- Conflicting values from different source systems: keep both under source-qualified keys, or use the "last-writer-wins" or "most-trusted-source" strategy.
- Empty strings → omit the field entirely (never store \`""\`; it pollutes range indexes).
- Date fields → ISO-8601 strings for consistency with range index scalar type \`"dateTime"\`.

**DHF mapping step**: If using DHF, the mapping step transforms source → instance automatically from an entity model descriptor. Use \`project_setup_advisor\` for DHF project layout.

## Section 5: TRIPLE ATTACHMENT

When to add triples to ${domain} documents and how:

Use \`envelope.triples\` when:
- ${domain} entities have relationships to other entities (e.g. order → customer, patient → provider).
- You need graph traversal via ml_sparql_query alongside document search.
- Semaphore classification produces concept URIs that should link to a taxonomy.

\`\`\`json
"triples": [
  {
    "triple": {
      "subject":   "http://example.org/${domain.replace(/[^a-zA-Z]/g, "-").toLowerCase()}/12345",
      "predicate": "http://schema.org/relatedTo",
      "object":    "http://example.org/other-entity/67890"
    }
  },
  {
    "triple": {
      "subject":   "http://example.org/${domain.replace(/[^a-zA-Z]/g, "-").toLowerCase()}/12345",
      "predicate": "http://schema.org/name",
      "object":    { "datatype": "http://www.w3.org/2001/XMLSchema#string", "value": "<name>" }
    }
  }
]
\`\`\`

Key rules:
- Use the **plural** key \`"triples"\` (not \`"triple"\`).
- Each element MUST be wrapped in \`{"triple": {...}}\`.
- IRI objects → plain URI string. Literal objects → \`{"datatype":"...","value":"..."}\`.
- Do NOT use \`"sem:triples"\` as the root key — that marks a managed triple document, not an envelope.

## Section 6: INGEST SEQUENCE

Exact MCP tool call order to build this envelope pipeline:

1. **ml_document_sample** — sample the raw source documents to understand current structure
2. **ml_schema_discover** — infer canonical field names and types from the source collection
3. **ml_indexes_list** — check which range indexes exist for the canonical fields
4. **flux_import** with an SJS transform:
   - Use \`flux_import\` with \`extra_args: ["--transform", "<transform-name>"]\`
   - The SJS transform (generated via \`sjs_module_generator\` prompt with \`module_type="transform"\`) maps source fields to \`envelope.instance\` structure
   - Deploy the transform via \`ml_extension_put\` or ml-gradle before running import
5. **ml_schema_get_tde** — verify a TDE template covers \`envelope.instance.*\` paths
6. **ml_tde_validate** — confirm rows are extracted correctly from harmonized documents
7. **ml_optic_query** — validate row extraction: \`SELECT * FROM schema.view LIMIT 5\`

## Section 7: QUERY PATTERNS

How to query ${domain} envelope documents:

**Full-text search over instance fields:**
\`\`\`
ml_search(q="<term>", collection="${domain.replace(/[^a-zA-Z]/g, "-").toLowerCase()}")
\`\`\`

**Structured filter on a canonical field (requires range index):**
\`\`\`
ml_search(structured_query={"range-query":{"json-property":"canonicalField","value":"<val>"}},
          collection="${domain.replace(/[^a-zA-Z]/g, "-").toLowerCase()}")
\`\`\`

**Aggregate across source systems using Optic (requires TDE):**
\`\`\`
ml_optic_query(plan={"fn":"from-view","args":["schema","view"],
  "select":[...], "group-by":[{"fn":"col","args":["sourceSystem"]}],
  "aggregate":[{"fn":"count","args":["count","uri"]}]})
\`\`\`

**Graph traversal across relationships:**
\`\`\`
ml_sparql_query(query="SELECT ?related WHERE { <entity-IRI> schema:relatedTo ?related }")
\`\`\`

**Faceted navigation (requires range index on classification fields):**
\`\`\`
ml_facets_query(collection="${domain.replace(/[^a-zA-Z]/g, "-").toLowerCase()}",
                facet_options=[{"name":"sourceSystem","type":"collection"}])
\`\`\``,
        },
      }],
    })
  );

  // ── performance_advisor ──────────────────────────────────────────────────────

  server.prompt(
    "performance_advisor",
    "Diagnose MarkLogic performance bottlenecks. Given a symptom description, returns a structured " +
    "plan: likely causes, diagnostic tool calls (ml_explain_optic, ml_profile_query, " +
    "ml_search_query_plan, ml_forest_metrics), interpretation guide, quick wins, and index recommendations.",
    {
      symptoms: z.string().describe(
        "Describe the performance problem. Examples: 'Optic query takes 30s on 1M docs', " +
        "'ingest slowing after 10M documents', 'SPARQL aggregation times out', " +
        "'search returns results slowly on first query', 'cts:search with date range is slow'"
      ),
      query_type: z.enum(["optic", "search", "sparql", "ingest", "general"]).optional().describe(
        "Category of the bottleneck: 'optic' (Optic/row queries), 'search' (cts:search / ml_search), " +
        "'sparql' (SPARQL / semantics), 'ingest' (flux_import / write throughput), 'general'"
      ),
      current_approach: z.string().optional().describe(
        "Describe what you are currently doing — the query, import pipeline, or API call that is slow"
      ),
    },
    ({ symptoms, query_type, current_approach }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `You are a MarkLogic performance engineer. Analyze this performance issue and return a structured diagnostic plan.

SYMPTOMS: ${symptoms}
QUERY TYPE: ${query_type ?? "not specified"}
CURRENT APPROACH: ${current_approach ?? "not provided"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MARKLOGIC PERFORMANCE FUNDAMENTALS (use to inform your analysis)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ARCHITECTURE
  E-node (Evaluator): parses requests, executes XQuery/SJS, handles filtering,
    snippeting, joins (including ALL SPARQL joins), and tree expansion.
  D-node (Data Manager): stores data and indexes; handles index resolution,
    data reads from disk, and background merges.
  Combined node = both roles. At ~16+ nodes, separate E/D for analytics workloads.

THE TWO-STEP SEARCH PROCESS
  Step 1 — Index resolution (D-nodes): produces candidate fragment IDs from indexes.
  Step 2 — Filtering (E-nodes): loads each candidate document, verifies full match.
  cts:search runs FILTERED by default.
  → Add "unfiltered" option when the query is fully backed by range/word indexes.
  → Diagnostic: ml_profile_query → filterMisses > 0 means Step 2 is doing real work.
  → False-positive rate: cts:contains(result, query) returns false for false positives.

CACHES (key for interpreting ml_profile_query output)
  List cache     — holds index term lists (D-node). Miss = disk read for index resolution.
  Compressed tree cache — holds document bodies (D-node). Miss = disk read for filtering.
  Expanded tree cache   — holds uncompressed doc trees (E-node). Miss = doc expansion work.
  Triple cache   — holds triple data for SPARQL. Misses on first query are normal.
  Cold run (first query) = many misses. Warm run (repeated) = steady-state behavior.
  Compare cold vs warm to distinguish "startup slowness" from "structural bottleneck".

RANGE INDEXES (when required)
  cts:range-query, cts:element-range-query → require element/attribute/path range index.
  ORDER BY in FLWOR → requires range index on the ORDER BY field (last XPath step).
  ml_values_query, ml_facets_query         → require range index or element word index.
  Always run ml_indexes_list before writing any range-dependent query.
  Missing range index + filtered search = worst case: full document scan.

OPTIC PERFORMANCE RULES
  ml_explain_optic shows the plan. Key nodes:
    "lexicon" / "TemplateLexiconPlan" = index-only (fast, no document expansion).
    "document" / "DocumentPlan"       = document expansion needed (acceptable but slower).
    "join"                            = join between two sources; ensure both have TDE views.
  Push .where() BEFORE .groupBy() to reduce row count before aggregation.
  .select() only needed columns to avoid loading unused column data.
  .limit(N) prevents full-collection scans during development.
  ORDER BY requires a range index on the sort column. Without one: loads all docs to sort.

SPARQL PERFORMANCE
  ALL SPARQL joins execute in-memory on the E-node. Large joins = high E-node memory.
  Minimum 64 GB RAM on E-nodes for production semantics workloads.
  Filter by rdf:type first (cheapest triple filter) before graph traversal predicates.
  Use NAMED GRAPH scoping: GRAPH <uri> { ... } to avoid scanning all graphs.
  SPARQL aggregations (GROUP BY, COUNT) happen on E-node — need sufficient Expanded Tree Cache.

INGEST HEALTH (ml_forest_metrics)
  Stand count → max 64 per forest; forest unavailable if it hits 64.
  Fragment count → warn at 96 million per forest; hard limit ~160 million.
  deletedFragmentPct > 20% → significant fragmentation (normal during heavy ingest;
    background merges reclaim automatically). After bulk deletes, use ml_force_merge
    to reclaim space before capacity projections.
  Merge in progress → expected during heavy ingest; high background I/O is normal.
  In-memory stand full errors (XDMP-INMMTREEFULL, XDMP-INMMLISTFULL, etc.) → increase
    in-memory stand settings for the database in the Admin UI.
  background-io-limit = 100 (MB/sec per host) is a good throttle starting point.

DIAGNOSTIC TOOLS AVAILABLE
  ml_explain_optic      — Optic query plan (no eval). Shows join strategy, index vs doc access.
  ml_search_query_plan  — Search debug (no eval). Shows resolved CTS query, candidate count.
  ml_profile_query      — Runtime metrics (eval-gated). Elapsed time, cache stats, filter activity.
                          language: "xquery" | "javascript" | "sparql"
  ml_forest_metrics     — Forest health (no eval). Fragment counts, stand count, merge status.
  ml_force_merge        — Force merge on all forests of a database (eval-gated). Use after bulk
                          deletes to reclaim space from deleted fragments.

  Also useful in XQuery/SJS (via ml_eval_xquery / ml_profile_query):
    xdmp:plan(search_expr)     — query plan showing which indexes will be used
    xdmp:estimate(search_expr) — fast index-only count without executing the search
    xdmp:query-trace(true())   — logs "searchable/unsearchable" steps to ErrorLog.txt

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RESPONSE FORMAT — complete all 6 sections
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 1. LIKELY CAUSES
List the 2–4 most probable root causes based on the symptoms and query type.
Be specific: "filtered search with high false-positive rate" not just "slow query".

## 2. DIAGNOSTIC STEPS
Ordered list of specific tool calls to run. For each step:
  a. The exact tool to call (ml_explain_optic / ml_profile_query / etc.)
  b. What inputs to provide
  c. What to look for in the output

Prioritize no-eval tools first (ml_explain_optic, ml_search_query_plan, ml_forest_metrics),
then eval-gated tools if those are inconclusive.

## 3. INTERPRETING THE RESULTS
Map specific metric values to diagnoses:
  • elapsedMs > 1000 + filterMisses > 0 → filtered search bottleneck
  • elapsedMs > 1000 + filterMisses = 0 + listCacheMisses > 0 → cold cache or index too large
  • ml_explain_optic shows "document" nodes + no "limit" → full-scan risk
  • ml_forest_metrics standCount > 50 → merge falling behind ingest
  • ml_search_query_plan total >> expected results → query not selective enough

## 4. QUICK WINS (implement immediately, no schema changes)
List 2–4 low-effort, high-impact changes:
  • Add "unfiltered" to cts:search (if fully index-backed)
  • Add collection scope before field filters
  • Add .limit(N) to Optic query
  • Push .where() before .groupBy() in Optic
  • Scope SPARQL to named graph
  • Add OFFSET/LIMIT for SPARQL

## 5. INDEX RECOMMENDATIONS
Which indexes to add, and why, based on the query pattern:
  • element-range-index: for exact field value, date range, numeric comparison, ORDER BY
  • path-range-index: for nested JSON paths (e.g. envelope.instance.price)
  • element-word-index: for full-text search on a specific element
  • triple-index: always required when using semantics/SPARQL (verify it is enabled)
  State the deployment path: ml-gradle content-database.json → gradle mlDeploy → ml_reindex_status.

## 6. ARCHITECTURE NOTES
Longer-term recommendations if the bottleneck is structural:
  Optic:   TDE column types (lexicon vs. document), fragmentation of large views
  SPARQL:  E/D node separation, E-node RAM sizing, named graph design
  Ingest:  in-memory stand sizes, Fast Data Directory (SSD) for journals, forest count
  Search:  unfiltered pagination pattern, search options and index configuration

Provide the analysis now.`,
        },
      }],
    })
  );

  // ── Semaphore Model Workflow ───────────────────────────────────────────────

  server.prompt(
    "semaphore_model_workflow",
    "Step-by-step workflow for creating and publishing a new Semaphore taxonomy model end-to-end. " +
    "Covers all required steps from model creation through classification testing, with common pitfalls and fixes.",
    {
      model_name: z.string().describe("CamelCase model identifier, e.g. 'MoviesModel'"),
      namespace: z.string().describe("Base namespace URI for concepts, e.g. 'http://example.org/ontology/movies/'"),
      description: z.string().optional().describe("What this taxonomy is for"),
    },
    ({ model_name, namespace, description }) => {
      const ns = namespace.endsWith("/") || namespace.endsWith("#") ? namespace : namespace + "/";
      const expectedSchemeUri = `${ns}${model_name}Taxonomy`;
      return {
        messages: [{
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Guide me through creating and publishing a Semaphore taxonomy model end-to-end.

**Model name:** ${model_name}
**Namespace:** ${ns}
**Purpose:** ${description ?? "(not specified)"}

Follow these steps in order, calling each tool before proceeding to the next:

## Step 1 — Create the Model
\`\`\`
semaphore_kmm_model_create(
  name="${model_name}",
  default_namespace="${ns}"
)
\`\`\`
Expected output: model URI = model:${model_name}

## Step 2 — Prepare SKOS Content (ConceptScheme URI is CRITICAL)
The ConceptScheme URI MUST follow the convention: {namespace}{ModelId}Taxonomy
Required URI: **${expectedSchemeUri}**

Use semaphore_taxonomy_scaffold to generate correctly-structured Turtle, OR ensure your
hand-crafted SKOS includes:
\`\`\`turtle
@prefix ns: <${ns}> .
ns:${model_name}Taxonomy a skos:ConceptScheme ;
    skos:prefLabel "${model_name} Taxonomy"@en ;
    skos:hasTopConcept ns:TopConcept1 .
\`\`\`

⚠️  DO NOT use OWL constructs (owl:Class, owl:Ontology) — Semaphore KMM only supports SKOS.
    Convert OWL to SKOS: owl:Class → skos:Concept, rdfs:subClassOf → skos:broader.

## Step 3 — Load SKOS Content
\`\`\`
semaphore_kmm_skos_load(
  model_uri="model:${model_name}",
  skos_content="<your Turtle content>"
)
\`\`\`
After loading, verify the concept count in the named graph:
\`\`\`
semaphore_kmm_sparql(
  model_uri="model:${model_name}",
  query="PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
         SELECT (COUNT(?c) AS ?n) WHERE { GRAPH <urn:x-evn-master:${model_name}> { ?c a skos:Concept } }"
)
\`\`\`

## Step 4 — Validate Taxonomy Structure
\`\`\`
semaphore_taxonomy_validate(model_uri="model:${model_name}")
\`\`\`
Fix any issues reported (orphan concepts, missing labels, wrong ConceptScheme URI) before continuing.

## Step 5 — Fix Publisher Config for Plain SKOS
\`\`\`
semaphore_publish_config_fix_plain_skos(model_uri="model:${model_name}")
\`\`\`
This patches the publisher to:
  - Query the model's named graph (urn:x-evn-master:${model_name})
  - Use plain skos:prefLabel instead of SKOS-XL reification
  - Generate one rule per concept (not just 1 for the ConceptScheme root)

NOTE: sem:guid is auto-generated by KMM during semaphore_kmm_skos_load — no manual INSERT needed.

## Step 6 — Publish to CLS
\`\`\`
semaphore_publish(
  model_uri="model:${model_name}",
  wait_for_completion=true
)
\`\`\`
Expected: rule count estimate should be proportionate to concept count.
If the publish tool warns about a low rule count, run semaphore_publish_diagnose then retry.

## Step 7 — Verify Model is Active
\`\`\`
semaphore_publish_sets()
\`\`\`
Confirm model:${model_name} (as a lowercase publish set name) appears as ACTIVE.

## Step 8 — Test Classification
\`\`\`
semaphore_classify(
  content="<sample text relevant to your taxonomy>",
  threshold=0
)
\`\`\`

## Common Pitfalls
- **Only 1 rule published**: ConceptScheme URI doesn't match '${expectedSchemeUri}', or plain-SKOS config fix wasn't applied.
- **0 concepts after load**: OWL ontology loaded instead of SKOS — convert to SKOS first.
- **Label check shows 0**: Language check queries named graph; if 0 results, verify your prefLabels have @en (or correct language) tags.
- **Score=0 after publish**: Rulenet index still building — wait 1-2 minutes and retry semaphore_classify.

Begin by calling semaphore_status to verify connectivity, then proceed step by step.`,
          },
        }],
      };
    }
  );
}
