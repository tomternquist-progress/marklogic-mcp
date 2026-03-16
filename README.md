# marklogic-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for MarkLogic 12. Enables AI agents to interrogate, query, and manage MarkLogic using MarkLogic-native capabilities — full-text search, Optic row queries, SPARQL, Flux bulk import/export, TDE schema management, and more.

## Features

- **46 MCP tools** across 10 domains: admin, documents, search, schema, eval, SPARQL, Optic (incl. vector search), QuickSight, Flux, and approach advisory
- **5 MCP resources** including a machine-readable problem→solution decision guide
- **13 MCP prompts** for query planning, code generation, import design, and BI integration
- **Two transports**: stdio (Claude Desktop / local agents) and HTTP+SSE (remote agents, QuickSight)
- **Read-only by default** — writes gated behind `ML_READONLY=false`, eval gated behind `ML_ALLOW_EVAL=true`
- **Basic and Digest auth** for MarkLogic REST API

---

## How Agents Should Use This Server

### Start with the decision guide

Before calling any query or import tool, an agent should read the `marklogic://instructions` resource. It contains a problem→tool decision table and a set of nine principles (e.g. "discover before you query", "native before eval", "Flux before REST for bulk loads"). This prevents common mistakes like using `ml_eval_javascript` for bulk import or `ml_document_put` in a loop.

### Use the advisory tools when unsure

Two tools exist specifically to guide tool selection:

| Advisory tool / resource | When to use |
|---|---|
| `marklogic://instructions` resource | Read at session start — machine-readable decision guide |
| `ml_suggest_approach` | Call with a natural-language task to get ranked tool recommendations with ready-to-use recipe parameters |
| `problem_advisor` prompt | Call with a goal to get a 6-section structured analysis (classification → native approach → discovery → tool sequence → pitfalls → alternatives) |
| `query_approach_advisor` prompt | Call when the goal is a query and you need to choose between cts.search, Optic, or a hybrid |

### Discover before you query

Never assume a collection, TDE view, or index exists. The standard discovery sequence is:

```
ml_collections_list → ml_schema_discover → ml_indexes_list → ml_views_list
```

Run these before writing any query or import plan.

### Optic vs cts.search

| Goal | Use | Prerequisite |
|---|---|---|
| Find documents by content / keyword | `ml_search` (cts.search) | None — universal index always available |
| Filter by exact field value or date range | `ml_search` structured_query | Range index recommended (`ml_indexes_list`) |
| COUNT / SUM / AVG / GROUP BY | `ml_optic_query` (fromView) | TDE view in Schemas DB (`ml_views_list`) |
| Join two collections by key | `ml_optic_query` (join-inner) | TDE views for both collections |
| Full-text filter THEN aggregate (hybrid) | `ml_optic_query` (fromSearch) | TDE view + cts query |
| Count distinct values / faceted nav | `ml_values_query`, `ml_facets_query` | Range or element word index |

Use the `query_approach_advisor` prompt to get a concrete, filled-in query plan for any of these goals.

### Multi-model data: Documents + Triples + Vectors

MarkLogic stores all three model types natively. Use `data_modeling_advisor` for guided design.

**Entity-oriented triple pattern (preferred)**

Group triples by IRI so that each entity is one document. The document URI equals the entity IRI, and triples are embedded as a `sem:triples` array inside the document body. This avoids a separate triple store lookup for entity properties and keeps the document and its graph relationships co-located.

**Importing raw RDF (two-step)**

1. `flux_import` with subcommand `import-rdf-files` → loads triples as *managed triples* (quad store, one quad per document)
2. `flux_reprocess` with an SJS transform that groups quads by subject IRI and writes one entity document per subject → produces the entity-oriented layout

**Vector search**

Store embeddings as a JSON array field. Define a TDE column with `scalar: "vec:vector"`. Query with `ml_vector_search` — it uses `vec:cosine-similarity` through the Optic API with no eval required. MarkLogic 12+ only.

### Bulk loading

Always use `flux_import` for more than ~10 documents. It handles HTTP URL fetch, ZIP/gzip decompression, parallel batching, and automatic TDE view generation in a single call — 10–100× faster than looping `ml_document_put`.

---

## Quick Start

### Claude Desktop (stdio)

1. Install and build:
   ```bash
   npm install && npm run build
   ```

2. Configure `.env`:
   ```bash
   cp .env.example .env
   # Edit with your MarkLogic connection details
   ```

3. Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):
   ```json
   {
     "mcpServers": {
       "marklogic": {
         "command": "node",
         "args": ["/path/to/marklogic-mcp/dist/index.js"],
         "env": {
           "ML_HOST": "your-marklogic-host",
           "ML_PORT": "8000",
           "ML_MANAGEMENT_PORT": "8002",
           "ML_USERNAME": "admin",
           "ML_PASSWORD": "your-password",
           "ML_AUTH_TYPE": "basic",
           "ML_READONLY": "true"
         }
       }
     }
   }
   ```

### Claude Code (remote HTTP transport)

```bash
# Start server (Docker)
ML_HOST=<host> ML_PASSWORD=<pass> MCP_API_KEY=<secret> \
  docker compose -f docker-compose.mcp-only.yml up -d

# Register with Claude Code
claude mcp add --transport http marklogic http://localhost:3000/mcp \
  --header "Authorization: Bearer <secret>"
```

See [docs/claude-code-remote-mcp.md](docs/claude-code-remote-mcp.md) for the full guide.

### HTTP/SSE Transport (AWS QuickSight / remote agents)

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=3000 ML_HOST=your-host ML_USERNAME=admin ML_PASSWORD=pass \
  node dist/index.js
```

Health check: `GET http://localhost:3000/health`

### Docker Compose — full stack (MarkLogic + MCP server)

```bash
docker compose up
# MarkLogic at http://localhost:8001 (Admin UI)
# MCP server at http://localhost:3000
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_PORT` | `3000` | HTTP transport port |
| `MCP_API_KEY` | _(none)_ | Bearer token for HTTP transport auth |
| `ML_HOST` | `localhost` | MarkLogic hostname or IP |
| `ML_PORT` | `8000` | REST API port |
| `ML_MANAGEMENT_PORT` | `8002` | Management API port |
| `ML_USERNAME` | `admin` | MarkLogic username |
| `ML_PASSWORD` | `admin` | MarkLogic password |
| `ML_DATABASE` | `Documents` | Default database |
| `ML_AUTH_TYPE` | `digest` | `digest` or `basic` |
| `ML_SSL` | `false` | Enable HTTPS |
| `ML_READONLY` | `true` | Block all write operations |
| `ML_ALLOW_EVAL` | `false` | Enable `/v1/eval` (XQuery/SJS execution) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `json` | `json` or `pretty` |

---

## Tools Reference

### Approach Advisory

| Tool | Description |
|---|---|
| `ml_suggest_approach` | Analyse a natural-language task and return ranked tool recommendations with ready-to-use recipe parameters. Call this before starting any non-trivial task. |

### Admin (8 tools)

| Tool | Description |
|---|---|
| `ml_cluster_status` | Cluster health, version, host info |
| `ml_databases_list` | List all databases |
| `ml_database_properties` | Full database configuration |
| `ml_database_statistics` | Document counts, forest sizes |
| `ml_forests_list` | Forest status |
| `ml_servers_list` | App server list |
| `ml_server_properties` | App server configuration |
| `ml_reindex_status` | Check whether a database has finished reindexing after TDE installation or index config changes. Returns `ready=true` when safe to run `ml_optic_query` or `ml_tde_validate`. Use after `flux_import` with `generate_tde=true` to avoid SQL-TABLEREINDEXING errors. |

### Documents (6 tools)

| Tool | Description |
|---|---|
| `ml_document_get` | Retrieve document by URI |
| `ml_document_list` | List by collection or directory |
| `ml_document_sample` | Sample random documents from a collection |
| `ml_document_put` *(write)* | Create/replace document |
| `ml_document_delete` *(write)* | Delete document |
| `ml_document_patch` *(write)* | Partial update |

### Search (5 tools)

Uses MarkLogic's universal index — no TDE or range index required for word queries.

| Tool | Description |
|---|---|
| `ml_search` | Full-text and structured search with cts.search semantics |
| `ml_search_qbe` | Query By Example — match by document structure |
| `ml_values_query` | Lexicon/range index value counts and aggregates |
| `ml_geospatial_search` | Find documents within a geospatial region — circle, bounding box, or polygon. Requires a geospatial element pair index; confirm with `ml_indexes_list` first. |
| `ml_suggest` | Search autocomplete from a partial query string |

> Range queries within `ml_search` require a pre-existing range index. Verify with `ml_indexes_list` first.

### Schema Discovery (6 tools)

| Tool | Description |
|---|---|
| `ml_schema_discover` | Infer field shapes by sampling documents in a collection |
| `ml_schema_get_tde` | Retrieve TDE templates from the Schemas database |
| `ml_tde_validate` | Validate a TDE template against sampled documents |
| `ml_indexes_list` | All configured range, element, and field indexes |
| `ml_collections_list` | Collections with document counts |
| `ml_namespaces_list` | XML namespace registry |

### Optic (3 tools)

Row-based query engine over TDE views. Use for GROUP BY, aggregations, joins, and vector similarity search. Requires a TDE template in the Schemas database — verify with `ml_views_list` before calling `ml_optic_query`.

| Tool | Description |
|---|---|
| `ml_optic_query` | Execute a serialised Optic plan (fromView, fromSearch, join, group-by, etc.) |
| `ml_vector_search` | Find k nearest neighbours via cosine similarity over a TDE `vec:vector` column. MarkLogic 12+, no eval required. |
| `ml_views_list` | List all available TDE schema.view pairs with the collections they cover |

### Eval *(requires `ML_ALLOW_EVAL=true`)*

Use as a last resort — ~10 KB script payload limit, no parallel batching.

| Tool | Description |
|---|---|
| `ml_eval_xquery` | Execute XQuery on the server |
| `ml_eval_javascript` | Execute Server-Side JavaScript |
| `ml_invoke_module` | Call a stored SJS/XQuery module |

### Graphs / SPARQL (3 tools)

Queries MarkLogic's triple store. Supports three storage patterns: embedded triples (co-located inside the source document as a `sem:triples` array), named graphs (standalone RDF documents), and hybrid (entity document + named graph for cross-entity relationships).

| Tool | Description |
|---|---|
| `ml_sparql_query` | SPARQL 1.1 SELECT/CONSTRUCT/ASK/DESCRIBE. SELECT and ASK return `{ head, results }` JSON. CONSTRUCT and DESCRIBE return raw Turtle text. Supports embedded, named-graph, and hybrid triple patterns. |
| `ml_graphs_list` | List named graphs. Identifies managed-triple graphs that may be candidates for reprocessing into entity-oriented documents via `flux_reprocess`. |
| `ml_graph_put` *(write)* | Load Turtle, N-Triples, JSON-LD, or RDF/XML into a named graph via PUT/PATCH `/v1/graphs`. |

### QuickSight Integration (4 tools)

| Tool | Description |
|---|---|
| `ml_aggregate_query` | Group-by + metrics → tabular rows for BI consumption |
| `ml_timeseries_query` | Date-bucketed aggregation (day/week/month/year) |
| `ml_export_tabular` | Export collection as CSV or JSON rows |
| `ml_facets_query` | Facet breakdowns for filter controls |

### Flux (7 tools)

Flux is the preferred path for all bulk data operations. It runs as a subprocess via the MCP server host.

| Tool | Description |
|---|---|
| `flux_import` | Import from CSV, JSON, Parquet, Avro, JDBC, S3, or HTTP URL |
| `flux_export` | Export documents to file, S3, or JDBC target |
| `flux_copy` | Copy documents between databases |
| `flux_reprocess` | Re-run a transform over an existing collection |
| `flux_preview` | Preview import without writing to the database |
| `flux_help` | Get Flux subcommand flags and options |
| `flux_status` | Check Flux runner availability |

> `flux_import` supports `generate_tde: true` to auto-create an Optic view from the imported collection in one call.

---

## Resources Reference

| Resource URI | Description |
|---|---|
| `marklogic://instructions` | Problem-first decision guide — maps goals to native MarkLogic capabilities and tools. Read this at session start. |
| `marklogic://databases` | Live list of all databases in the cluster |
| `marklogic://cluster/status` | Cluster health and version |
| `marklogic://forests` | Forest list with status |
| `marklogic://documents` | Usage note for document access tools |

---

## Prompts Reference

### Query Planning

| Prompt | Purpose |
|---|---|
| `query_approach_advisor` | Choose between cts.search, Optic, or a hybrid approach for a query goal. Returns 6-section plan: classification, approach, prerequisites, query construction, performance notes, pitfalls. |
| `problem_advisor` | Map any natural-language goal to MarkLogic-native tools. Returns 6-section analysis: classification, native approach, discovery sequence, tool sequence, pitfalls, alternatives. |
| `structured_query_builder` | Natural language → MarkLogic structured query JSON |
| `optic_query_builder` | Requirements + schema/view → Optic API plan (SJS style) |
| `sparql_query_builder` | Natural language → SPARQL |

### Code Generation

| Prompt | Purpose |
|---|---|
| `xquery_function_generator` | Generate XQuery with MarkLogic 12 idioms and namespace handling |
| `sjs_module_generator` | Generate SJS transforms, REST extensions, or library modules |
| `tde_schema_generator` | Generate a TDE JSON template from a collection and sample fields |
| `rest_extension_generator` | Scaffold a MarkLogic REST API extension with HTTP method handlers |

### Import Design

| Prompt | Purpose |
|---|---|
| `data_import_advisor` | Choose the right import tool and strategy (always considers Flux first) |
| `gdelt_import` | Ready-to-run `flux_import` call for a GDELT 1.0 event export date |

### Multi-Model Design

| Prompt | Purpose |
|---|---|
| `data_modeling_advisor` | Design a MarkLogic multi-model schema combining Documents, Triples, and Vectors. Returns 8-section plan: model selection, document design, triple design (entity-oriented pattern + managed-triples reprocess path), vector/embedding design, TDE schema, import sequence, query plan, pitfalls. |

### QuickSight

| Prompt | Purpose |
|---|---|
| `quicksight_dataset_designer` | Design a QuickSight dataset sourced from MarkLogic — discovery, field mapping, aggregation strategy |
| `quicksight_dashboard_planner` | Plan a QuickSight dashboard from a business question |

---

## Architecture

```
src/
  server.ts          — factory: createMcpServer() wires tools + resources + prompts
  index.ts           — CLI entry; selects stdio or HTTP transport
  tools/             — one file per domain; registerXxxTools() functions
  resources/         — static + dynamic resources; INSTRUCTIONS_TEXT decision guide
  prompts/           — all prompts; query_approach_advisor and problem_advisor first
  client/            — typed HTTP clients for each MarkLogic API surface
  config/            — dotenv loading and Zod validation
  transport/         — stdio and Express/HTTP transport wrappers
  utils/             — error formatting, digest auth, multipart builder
```

All write tools check `readonly` at registration time and are not registered when `ML_READONLY=true`. Eval tools check `allowEval` and are not registered when `ML_ALLOW_EVAL=false`. This means tools are absent from the MCP tool list entirely — they are never silently no-ops.

---

## Development

```bash
npm run dev          # tsx watch — auto-reload on save
npm run build        # TypeScript → dist/
npm run typecheck    # Type check without emitting
npm test             # Vitest (skips gracefully if ML_HOST not set)
npm run inspector    # Launch MCP Inspector UI
```

---

## AWS QuickSight Integration

QuickSight agents connect via the HTTP transport. Recommended pattern:

1. Start the MCP server in HTTP mode (ECS task or EC2 accessible from QuickSight)
2. Agent calls `ml_schema_discover` and `ml_views_list` to understand data shape
3. Agent calls `ml_export_tabular` or `ml_aggregate_query` to extract data rows
4. Agent uses the QuickSight API to create/refresh a SPICE dataset
5. Use `quicksight_dataset_designer` prompt for guided step-by-step assistance

---

## Security Notes

- `ML_READONLY=true` (default) — write tools (`ml_document_put`, `ml_document_delete`, `ml_document_patch`) are not registered at all
- `ML_ALLOW_EVAL=false` (default) — eval tools (`ml_eval_javascript`, `ml_eval_xquery`, `ml_invoke_module`) are not registered
- `MCP_API_KEY` — set to require Bearer token auth on the HTTP transport
- Credentials are read from environment variables only — never hardcoded
- Digest auth recomputes the challenge per request — no credential caching
- The Flux runner executes on the MCP server host; `http_url` must be reachable from that host, not from the user's machine
