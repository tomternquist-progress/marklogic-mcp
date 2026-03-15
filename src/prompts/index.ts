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
    "Generate MarkLogic Server-Side JavaScript (SJS) modules including transforms, REST extensions, and library modules.",
    {
      module_purpose: z.string().describe("What this SJS module should do"),
      module_type: z.enum(["transform", "extension", "library", "scheduled-task"]).optional().describe("Type of MarkLogic module"),
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
- For transforms: export transform function with (content, context) signature
- For REST extensions: export get/put/post/delete functions with (context, params, input) signatures
- For library modules: use module.exports or exports.functionName pattern
- Use declareUpdate() when writing to the database
- Use xdmp.log() for server-side logging
- Use cts.search() not fn.doc() for document retrieval
- Handle errors with try/catch blocks
- Include JSDoc comments for all exported functions

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
  graph-query | time-series | schema-discovery | export-bi | code-generation |
  admin-health | data-transform

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
  Search:     ml_search, ml_search_qbe, ml_values_query, ml_suggest, ml_facets_query
  Schema:     ml_schema_discover, ml_schema_get_tde, ml_tde_validate, ml_indexes_list,
              ml_collections_list, ml_namespaces_list
  Eval:       ml_eval_javascript, ml_eval_xquery, ml_invoke_module
  Graph:      ml_sparql_query, ml_graphs_list
  QuickSight: ml_aggregate_query, ml_timeseries_query, ml_export_tabular, ml_facets_query
  Optic:      ml_optic_query
  Flux:       flux_import, flux_export, flux_copy, flux_reprocess, flux_preview, flux_help,
              flux_status
  Prompts:    xquery_function_generator, sjs_module_generator, tde_schema_generator,
              rest_extension_generator, structured_query_builder, optic_query_builder,
              sparql_query_builder, data_import_advisor, gdelt_import,
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
