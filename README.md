# marklogic-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for MarkLogic 12. Enables AI agents to interrogate, query, and manage MarkLogic using MarkLogic-native capabilities — full-text search, Optic row queries, SPARQL, Flux bulk import/export, TDE schema management, and more.

## Features

- **103 MCP tools** across 15 domains: admin (incl. logs), documents, security, search, search options, schema, eval, SPARQL/graphs, Optic (incl. vector search), performance, QuickSight, Flux, REST extensions, Semaphore (taxonomy + classification), and DHF
- **13 Agent Skills** carrying the MarkLogic know-how — import recipes, index prerequisites, TDE traps, SKOS publishing order — loaded only when the task calls for them ([guide](docs/SKILLS.md))
- **6 MCP resources** including a machine-readable problem→solution decision guide
- **3 MCP prompts** for one-shot import and BI-integration flows
- **Two transports**: stdio (Claude Desktop, GitHub Copilot, local agents) and HTTP+SSE (Claude Code, GitHub Copilot, remote agents, QuickSight)
- **Read-only by default** — writes gated behind `ML_READONLY=false`, eval gated behind `ML_ALLOW_EVAL=true`
- **Basic and Digest auth** for MarkLogic REST API

---

## How Agents Should Use This Server

### Start with the decision guide

Before calling any query or import tool, an agent should read the `marklogic://instructions` resource. It contains a problem→tool decision table and a set of nine principles (e.g. "discover before you query", "native before eval", "Flux before REST for bulk loads"). This prevents common mistakes like using `ml_eval_javascript` for bulk import or `ml_document_put` in a loop.

### Let the skills do the routing

The deeper how-to guidance lives in [Agent Skills](docs/SKILLS.md), not in tool descriptions. Start from the **`marklogic`** router skill: it maps a goal to the MarkLogic-native capability, names the tools that implement it, and hands off to a deeper skill (`marklogic-bulk-import`, `marklogic-query-authoring`, `marklogic-performance`, …).

Skills are model-invoked — describe the goal and the agent loads what matches. If your client doesn't support skills, `marklogic://instructions` carries the same routing table.

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

The `marklogic-query-authoring` skill covers this in depth — index prerequisites, a structured-query cookbook, and what to do when a query returns nothing or everything.

### Multi-model data: Documents + Triples + Vectors

MarkLogic stores all three model types natively. The `marklogic-data-modeling` skill covers guided design — model selection, the six URI design rules, and the envelope pattern.

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

## Agent Skills

The MarkLogic know-how — Flux import recipes, index prerequisites, TDE syntax traps, SKOS publishing order, OAuth claim mapping — ships as **13 Agent Skills** in `.claude/skills/`, following the open [Agent Skills spec](https://agentskills.io/specification).

Only each skill's ~500-character description stays in context; the body loads when the model matches a task to it, and bundled `references/` and `templates/` load only when the body points at them. That keeps the guidance out of the per-request tool-description budget — it previously cost ~50,700 tokens on every request.

| Skill | Reach for it when |
|---|---|
| **`marklogic`** | Start here. Problem→capability router, discovery sequence, overlapping-tool selection, safety-flag effects, complete tool index |
| **`marklogic-bulk-import`** | Bulk loading via Flux — URLs, S3, JDBC, RDF, open-data portals, TDE-at-ingest, bulk reprocessing |
| **`marklogic-query-authoring`** | Composing any query, or triaging one returning nothing / everything |
| **`marklogic-data-modeling`** | Documents vs triples vs vectors, URI schemes, TDE views, the envelope pattern |
| **`marklogic-project-setup`** | The work should be repeatable or deployable — ml-gradle project, dev/prod config, CI/CD |
| **`marklogic-server-side-code`** | SJS/XQuery modules, REST extensions, CTF and Flux transforms, TDE templates |
| **`marklogic-rag`** | RAG and semantic search on ML 12 — Lexical, Vector, and Graph paradigms |
| **`marklogic-performance`** | A query is slow or timing out; reading plans, caches, forest health |
| **`marklogic-fasttrack`** | Faceted search UI — search options set plus the React scaffold |
| **`marklogic-oauth-setup`** | OAuth2/OIDC bearer auth, or "token authenticates but has no roles" |
| **`semaphore-integration`** | Wiring Semaphore to MarkLogic — pattern choice, CLS/KMM config, enrichment module |
| **`semaphore-taxonomy`** | Authoring, loading, validating, and publishing SKOS taxonomies in KMM |
| **`semaphore-classification-tuning`** | Classification results are wrong — labels → threshold → `.kid` weights |

**Working in this repo?** Claude Code picks them up automatically; check with `/skills`.

**Using the MCP server from your own project?** Skills don't travel over the MCP connection — copy them across:

```bash
npm run skills:install -- --list             # see what's available
npm run skills:install -- --user             # → ~/.claude/skills (all projects)
npm run skills:install -- --project ~/my-app # → ~/my-app/.claude/skills (check in for your team)
```

**Client without skill support?** Read `marklogic://instructions` — it carries the same routing table plus an index of every skill.

See **[docs/SKILLS.md](docs/SKILLS.md)** for the full guide: the catalog with bundled files, how skills differ from tools and prompts, where the removed advisory tools and prompts went, authoring rules, and troubleshooting.

---

## Quick Start

> **New to marklogic-mcp?** See the [Getting Started Guide](docs/getting-started.md) for a complete walkthrough.

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

### GitHub Copilot in VS Code

Add to VS Code user settings or `.vscode/mcp.json`:

```json
{
  "mcp": {
    "servers": {
      "marklogic": {
        "type": "stdio",
        "command": "node",
        "args": ["/path/to/marklogic-mcp/dist/index.js"],
        "env": {
          "ML_HOST": "localhost",
          "ML_PORT": "8000",
          "ML_USERNAME": "admin",
          "ML_PASSWORD": "your-password",
          "ML_AUTH_TYPE": "digest",
          "ML_READONLY": "true"
        }
      }
    }
  }
}
```

Or connect to a running HTTP server: set `"type": "http"` and `"url": "http://localhost:3000/mcp"`.
See [docs/getting-started.md](docs/getting-started.md#github-copilot-cli--vs-code-stdio-or-http) for the full guide including per-project config with input variables for secrets.

### HTTP/SSE Transport (AWS QuickSight / remote agents)

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=3000 ML_HOST=your-host ML_USERNAME=admin ML_PASSWORD=pass \
  node dist/index.js
```

### OAuth2 Bearer Token Passthrough

When MarkLogic is configured as an OAuth2 resource server, the MCP server can forward each client's Bearer token directly to MarkLogic — MarkLogic validates the JWT and enforces its own per-user RBAC.

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=3000 ML_HOST=your-host ML_AUTH_TYPE=oauth \
  node dist/index.js
# ML_USERNAME / ML_PASSWORD are not used in oauth mode
# Clients pass: Authorization: Bearer <user-jwt>
```

To configure MarkLogic as an OAuth2 resource server, use the `marklogic-oauth-setup` skill — it walks through the required Management API calls and XQuery for your OIDC provider. Key points verified on ML 12:

- Create the external security via `sec:create-external-security()` (not raw XQuery) to preserve required element ordering
- Set `authorization: oauth` and map JWT claim values to MarkLogic roles via `sec:role-set-external-names()` — the claim value matches the role's **external-name**, not its role-name
- Apply `authentication: oauth` to **all** server groups (apps, enode, etc.)

Flux tools are disabled in oauth mode (they require username:password credentials).

Health check: `GET http://localhost:3000/health`

### Docker Compose — full stack (MarkLogic + MCP server)

```bash
docker compose up
# MarkLogic at http://localhost:8001 (Admin UI)
# MCP server at http://localhost:3000
```

### Docker Compose — connect to existing MarkLogic / Semaphore containers

If MarkLogic and/or Semaphore are already running in Docker on the same host, use
the external-network compose file:

```bash
docker network create shared                      # one-time
docker network connect shared <marklogic-container>  # attach existing containers
docker network connect shared <semaphore-container>

ML_HOST=marklogic SEMAPHORE_HOST=semaphore ML_PASSWORD=admin \
  docker compose -f docker-compose.external.yml up -d
```

See [docs/docker-networking.md](docs/docker-networking.md) for the full guide and
alternative approaches (host network mode, host IP).

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
| `ML_AUTH_TYPE` | `digest` | `digest`, `basic`, or `oauth` (Bearer token passthrough to MarkLogic) |
| `ML_OAUTH_TOKEN` | _(none)_ | Static Bearer token; required in `stdio` mode when `ML_AUTH_TYPE=oauth` |
| `ML_SSL` | `false` | Enable HTTPS |
| `ML_READONLY` | `true` | Block all write operations |
| `ML_ALLOW_EVAL` | `false` | Enable `/v1/eval` (XQuery/SJS execution) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `json` | `json` or `pretty` |
| `SEMAPHORE_HOST` | _(none)_ | Semaphore hostname (enables CLS + KMM connectivity) |
| `SEMAPHORE_SCS_PORT` | `5058` | Classification Server port |
| `SEMAPHORE_KMM_PORT` | `5080` | Studio / KMM port |
| `SEMAPHORE_USERNAME` | _(none)_ | KMM username |
| `SEMAPHORE_PASSWORD` | _(none)_ | KMM password |
| `SEMAPHORE_URL` | _(none)_ | Explicit CLS URL override (takes precedence over host:port) |
| `FLUX_RUNNER_URL` | _(none)_ | Flux runner HTTP URL (e.g. `http://localhost:8082`) |
| `FLUX_DATA_DIR` | `./flux-data` | Local directory mounted as `/data` in the Flux Docker container |
| `FLUX_TIMEOUT_MINUTES` | `30` | Flux operation timeout in minutes |
| `ML_TIMEOUT_MS` | `30000` | HTTP request timeout for MarkLogic calls (milliseconds) |
| `ML_SSL_REJECT_UNAUTHORIZED` | `true` | Reject self-signed SSL certificates (`false` for dev environments) |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind address for HTTP transport |
| `MCP_CORS_ORIGIN` | _(all)_ | Restrict CORS to a single origin (default: allow all) |
| `MCP_TRUST_PROXY` | _(disabled)_ | Express `trust proxy` setting — set when behind a reverse proxy (nginx, ALB, ingress). Use `1` for a single proxy, a number of hops, an IP/subnet list (e.g. `10.0.0.0/8`), or `loopback`. Avoid `true` (spoofable). Required to silence `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` from `express-rate-limit`. |
| `ML_OAUTH_TOKEN` | _(none)_ | Static Bearer token; required in `stdio` mode when `ML_AUTH_TYPE=oauth` |
| `ML_DHF_CLIENT_JAR` | _(none)_ | Absolute path to `marklogic-data-hub-<version>-client.jar` |
| `ML_DHF_PORT` | _(ML_PORT)_ | DHF staging app server port |
| `ML_DHF_JOBS_PORT` | _(ML_DHF_PORT+2)_ | DHF jobs app server port |
| `AWS_REGION` | _(none)_ | AWS region for QuickSight integration |
| `AWS_QUICKSIGHT_ACCOUNT_ID` | _(none)_ | QuickSight account ID |

### AI Client API Keys

This MCP server does **not** use AI provider API keys itself — it is a tool server that AI agents connect to. The API keys for your AI provider are configured in your **client application**, not in this server.

| AI Client | Environment Variable | Where to configure |
|---|---|---|
| **Claude Desktop** | `ANTHROPIC_API_KEY` | Built into the app (uses your Anthropic account) |
| **Claude Code** | `ANTHROPIC_API_KEY` | Shell environment or `~/.bashrc` / `~/.zshrc` |
| **OpenAI-compatible agents** | `OPENAI_API_KEY` | Agent's own environment or config file |
| **Amazon Bedrock agents** | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | AWS credentials chain |
| **Google Vertex AI agents** | `GOOGLE_APPLICATION_CREDENTIALS` | GCP service account JSON path |

**Example: Claude Code with this MCP server**

```bash
# 1. Set your Anthropic API key (client-side — not in the MCP server)
export ANTHROPIC_API_KEY=sk-ant-...

# 2. Start the MCP server (server-side — no AI keys needed)
ML_HOST=my-marklogic MCP_API_KEY=my-secret \
  docker compose -f docker-compose.mcp-only.yml up -d

# 3. Register the MCP server with Claude Code
claude mcp add --transport http marklogic http://localhost:3000/mcp \
  --header "Authorization: Bearer my-secret"
```

> **Tip:** `MCP_API_KEY` secures the MCP server's HTTP endpoint — it is unrelated to any AI provider key. Think of it as a password for the MCP server itself.

---

## Tools Reference

103 tools. Approach advisory is no longer a tool — see [Agent Skills](#agent-skills). The `marklogic` skill carries the same list in a form the agent reads directly.

### Answer & Recipes (2 tools)

| Tool | Description |
|---|---|
| `ml_answer_query` | One-shot natural-language question answering over a collection — returns a concise answer plus rows and an audit trace of how it was resolved |
| `ml_query_recipe` | Execute a pre-validated query template by name with minimal parameters, instead of hand-building a structured query |

### Admin (11 tools)

| Tool | Description |
|---|---|
| `ml_cluster_status` | Cluster health, version, host info |
| `ml_databases_list` | List all databases |
| `ml_database_properties` | Full database configuration |
| `ml_database_statistics` | Document counts, forest sizes |
| `ml_database_set_forests` *(write)* | Attach a specific list of forests to a database — primary fix for the forest-hang pattern when cluster nodes are offline |
| `ml_forests_list` | Forest status |
| `ml_servers_list` | App server list |
| `ml_server_properties` | App server configuration |
| `ml_reindex_status` | Check whether a database has finished reindexing after TDE installation or index config changes. Returns `ready=true` when safe to run `ml_optic_query` or `ml_tde_validate`. Use after `flux_import` with `generate_tde=true` to avoid SQL-TABLEREINDEXING errors. |
| `ml_logs_list` | List available MarkLogic log files (ErrorLog.txt, AccessLog.txt, port-specific logs). Use before `ml_logs_read`. |
| `ml_logs_read` | Read a MarkLogic server log file with optional time-range and regex filtering. Key files: `ErrorLog.txt`, `8002_AccessLog.txt`, `8000_AccessLog.txt`. |

### Documents (7 tools)

| Tool | Description |
|---|---|
| `ml_document_get` | Retrieve document by URI |
| `ml_document_list` | List by collection or directory |
| `ml_document_sample` | Sample random documents from a collection |
| `ml_document_put` *(write)* | Create/replace document |
| `ml_document_delete` *(write)* | Delete document |
| `ml_document_patch` *(write)* | Partial update |
| `ml_document_patch_batch` *(write)* | Apply the same patch operation across many documents in one call |

### Security (3 tools)

| Tool | Description |
|---|---|
| `ml_users_list` | List all MarkLogic users (requires manage-user privilege) |
| `ml_roles_list` | List all roles, or retrieve full properties for a named role |
| `ml_document_permissions` | Return the read/update/insert/execute permissions on a document URI |

### Search (6 tools)

Uses MarkLogic's universal index — no TDE or range index required for word queries.

| Tool | Description |
|---|---|
| `ml_search` | Full-text and structured search with cts.search semantics |
| `ml_search_qbe` | Query By Example — match by document structure |
| `ml_values_query` | Lexicon/range index value counts and aggregates |
| `ml_geospatial_search` | Find documents within a geospatial region — circle, bounding box, or polygon. Requires a geospatial element pair index; confirm with `ml_indexes_list` first. |
| `ml_suggest` | Search autocomplete from a partial query string |
| `ml_parse_query` | Parse a string-grammar query into a structured `cts.query` JSON object without executing it |

> Range queries within `ml_search` require a pre-existing range index. Verify with `ml_indexes_list` first.

### Search Options / FastTrack (4 tools)

Manage named search-options configurations stored in the FastTrack endpoint (`/v1/config/query`).

| Tool | Description |
|---|---|
| `ml_search_options_list` | List all named search-options configurations |
| `ml_search_options_get` | Retrieve a named search-options configuration |
| `ml_search_options_put` *(write)* | Create or replace a search-options configuration |
| `ml_search_options_delete` *(write)* | Delete a search-options configuration |

### Schema Discovery (8 tools)

| Tool | Description |
|---|---|
| `ml_schema_discover` | Infer field shapes by sampling documents in a collection |
| `ml_schema_get_tde` | Retrieve TDE templates from the Schemas database |
| `ml_tde_validate` | Validate a TDE template against sampled documents |
| `ml_tde_install` *(write)* | Install a TDE template into the Schemas database with the correct collection — convenience wrapper around `ml_document_put` that sets `database=Schemas` and the required `http://marklogic.com/xdmp/tde` collection automatically |
| `ml_indexes_list` | All configured range, element, and field indexes |
| `ml_collections_list` | Collections with document counts |
| `ml_namespaces_list` | XML namespace registry |
| `ml_search_surface` | One-shot discovery for query building — queryable fields, range indexes, and stored options sets for a collection or database |

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
| `ml_sparql` | Execute SPARQL via `sem:sparql()` XQuery — handles boilerplate automatically. Use instead of `ml_eval_xquery` when running SPARQL with `sem:` API features not available via `ml_sparql_query`. |

### Graphs / SPARQL (4 tools)

Queries MarkLogic's triple store. Supports three storage patterns: embedded triples (co-located inside the source document as a `sem:triples` array), named graphs (standalone RDF documents), and hybrid (entity document + named graph for cross-entity relationships).

| Tool | Description |
|---|---|
| `ml_sparql_query` | SPARQL 1.1 SELECT/CONSTRUCT/ASK/DESCRIBE. SELECT and ASK return `{ head, results }` JSON. CONSTRUCT and DESCRIBE return raw Turtle text. Supports embedded, named-graph, and hybrid triple patterns. |
| `ml_graphs_list` | List named graphs. Identifies managed-triple graphs that may be candidates for reprocessing into entity-oriented documents via `flux_reprocess`. |
| `ml_graph_put` *(write)* | Load Turtle, N-Triples, JSON-LD, or RDF/XML into a named graph via PUT/PATCH `/v1/graphs`. |
| `ml_graph_delete` *(write)* | Permanently delete a named graph and all its triples. |

> **Turtle prefix syntax**: Prefixed local names cannot contain `/` in Turtle 1.0 (MarkLogic's parser). Use `<http://full/uri>` for subjects/objects whose IRI paths contain slashes, or define one prefix per entity type so local names are slash-free.

### QuickSight Integration (4 tools)

| Tool | Description |
|---|---|
| `ml_aggregate_query` | Group-by + metrics → tabular rows for BI consumption |
| `ml_timeseries_query` | Date-bucketed aggregation (day/week/month/year) |
| `ml_export_tabular` | Export collection as CSV or JSON rows |
| `ml_facets_query` | Facet breakdowns for filter controls |

### Performance (3 tools + 2 eval-gated)

| Tool | Description |
|---|---|
| `ml_explain_optic` | Get the execution plan for an Optic query without running it — shows join strategy and index usage |
| `ml_search_query_plan` | Run a search in debug mode to see the resolved CTS query structure and candidate estimate |
| `ml_forest_metrics` | Per-forest fragment counts, stand counts, deleted-fragment ratio, and merge status |
| `ml_profile_query` *(requires `ML_ALLOW_EVAL=true`)* | Profile XQuery, SJS, or SPARQL execution time and cache/filter metrics |
| `ml_force_merge` *(requires `ML_ALLOW_EVAL=true`)* | Force a merge on a database's forests to reclaim deleted fragments |

### REST Extensions (5 tools)

| Tool | Description |
|---|---|
| `ml_extension_list` | List installed REST API extensions |
| `ml_extension_get` | Retrieve the source of an extension module |
| `ml_extension_call` | Call an extension endpoint with arbitrary method, params, and body |
| `ml_extension_put` *(write)* | Install or replace a REST extension module |
| `ml_extension_delete` *(write)* | Remove a REST extension module |

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
> `flux_import` also supports inline Semaphore classification at ingest via `classify_with_semaphore: true` — attaches taxonomy categories to every imported document.

### Data Hub Framework (5 tools)

Requires `ML_ALLOW_EVAL=true`; `dhf_flow_run` additionally requires `ML_READONLY=false`, and `dhf_flow_run_jar` requires `DHF_CLIENT_JAR_PATH`.

| Tool | Description |
|---|---|
| `dhf_status` | Check whether DHF 5.x is installed and report its version |
| `dhf_flows_list` | List deployed flows in the staging database with each flow's steps |
| `dhf_flow_run` *(write)* | Run a flow via the server-side DHF API |
| `dhf_flow_run_jar` | Run a flow through the DHF client JAR |
| `dhf_job_status` | Status and results of a flow run |

### Semaphore (25 tools)

Semaphore is the Progress Data Platform taxonomy and classification engine. These tools manage the full lifecycle: load a SKOS vocabulary into KMM, configure the publisher, publish rules to the Classification Server (CLS), and classify content.

**CLS (Classification Server) — port 5058**

| Tool | Description |
|---|---|
| `semaphore_status` | Check CLS connectivity and version |
| `semaphore_publish_sets` | List active taxonomy rule sets loaded in the CLS |
| `semaphore_classes` | List classification class names in the active rulenet |
| `semaphore_classify` | Classify text against the loaded rulenet (exploratory / small-scale) |
| `semaphore_cls_languages` | List available language packs in the CLS (uses indexed codes like `en1`, not ISO codes) |

**KMM / Studio (taxonomy authoring) — port 5080**

| Tool | Description |
|---|---|
| `semaphore_studio_status` | Check KMM connectivity and authentication |
| `semaphore_kmm_models_list` | List all taxonomy models in KMM |
| `semaphore_kmm_model_create` | Create a new model container in KMM |
| `semaphore_kmm_skos_load` | Load a SKOS vocabulary from a public URL into a KMM model |
| `semaphore_kmm_sparql` | Query model content via SPARQL SELECT |
| `semaphore_kmm_sparql_update` | Run SPARQL INSERT/DELETE/LOAD to modify model triples |
| `semaphore_kmm_model_delete` | Permanently delete a KMM model and all its triples |
| `semaphore_publish` | Trigger an async KMM publish — compiles the taxonomy into CLS rules |
| `semaphore_publish_config_fix_plain_skos` | Patch the publisher config for plain-SKOS vocabularies (skos:prefLabel, no SKOS-XL) — adds GRAPH clause, switches to AllConcepts, bootstraps workspace automatically |
| `semaphore_publish_diagnose` | Diagnose publish failures — compares KMM concept count vs CLS rule count and identifies the root cause |

**Concept / Taxonomy Editing**

| Tool | Description |
|---|---|
| `semaphore_concept_search` | Search for concepts across a KMM model by keyword (matches prefLabel, altLabel, hiddenLabel) |
| `semaphore_concept_get` | Retrieve full concept profile: all labels, broader/narrower hierarchy, related links, scopeNote |
| `semaphore_concept_labels_update` | Add or remove a single label on a concept — primary tool for classification quality tuning |
| `semaphore_taxonomy_validate` | Run SPARQL-based structural quality checks on a KMM model (hierarchy health, orphan detection, anti-patterns) |
| `semaphore_classify_batch` | Classify multiple MarkLogic documents against a taxonomy in one call |
| `semaphore_kid_template_get` | Retrieve a model's publisher rule template (`.kid` file) from its workspace |
| `semaphore_kid_template_set` | Upload a custom `.kid` Velocity rule template — controls how each concept becomes CLS rules at publish time |
| `semaphore_task_list` | List open working copies (tasks) in KMM |
| `semaphore_task_create` | Create a working copy of a taxonomy model |
| `semaphore_task_commit` | Merge a task's changes into the master graph |

> **Plain-SKOS vocabularies** (UNESCO, EuroVoc, AGROVOC, IPTC): run `semaphore_publish_config_fix_plain_skos` before `semaphore_publish`. Without it, the publisher generates only 1 CLS rule (for the ConceptScheme root) instead of one per concept. The root cause is that the publisher's SPARQL endpoint is a global store — each model's data lives in the named graph `urn:x-evn-master:{ModelName}` and is invisible without an explicit `GRAPH` clause. This tool adds the clause automatically.
>
> **Fully programmatic pipeline**: The entire taxonomy workflow — create model, load SKOS, fix config, publish — runs via API with no Semaphore Studio interaction. The publisher workspace is initialised automatically on first publish. The only one-time global prerequisite is adding a CLS environment in Studio Admin once (`Administration → Publisher → Classification Server Environments → Add`); after that, `semaphore_publish` auto-discovers it for all future models.
>
> **Configuration**: Set `SEMAPHORE_HOST`, `SEMAPHORE_SCS_PORT` (default 5058), `SEMAPHORE_KMM_PORT` (default 5080), `SEMAPHORE_USERNAME`, and `SEMAPHORE_PASSWORD` in the MCP server `.env`.

---

## Resources Reference

| Resource URI | Description |
|---|---|
| `marklogic://instructions` | Problem-first decision guide — maps goals to native MarkLogic capabilities and tools, and indexes the Agent Skills. Read this at session start. |
| `marklogic://security` | Live security posture (readonly, allowEval, auth) plus warnings about misconfigurations |
| `marklogic://databases` | Live list of all databases in the cluster |
| `marklogic://cluster/status` | Cluster health and version |
| `marklogic://forests` | Forest list with status |
| `marklogic://documents` | Usage note for document access tools |

---

## Prompts Reference

Three prompts remain. They are narrow, one-shot flows where invoking by name fits — everything advisory or reference-shaped is now an [Agent Skill](#agent-skills), so the agent can reach for it without being asked.

| Prompt | Purpose |
|---|---|
| `gdelt_import` | Ready-to-run `flux_import` call for a GDELT 1.0 event export date |
| `quicksight_dataset_designer` | Design a QuickSight dataset sourced from MarkLogic — discovery, field mapping, aggregation strategy |
| `quicksight_dashboard_planner` | Plan a QuickSight dashboard from a business question |

The 22 advisor and generator prompts that used to live here became skills; [docs/SKILLS.md](docs/SKILLS.md#what-moved-here) maps each old name to its replacement.

---

## Architecture

```
src/
  server.ts          — factory: createMcpServer() wires tools + resources + prompts
  index.ts           — CLI entry; selects stdio or HTTP transport
  tools/             — one file per domain; registerXxxTools() functions
    semaphore.ts     — Semaphore tools (CLS + KMM taxonomy management)
  resources/         — static + dynamic resources; INSTRUCTIONS_TEXT decision guide
  prompts/           — the three remaining one-shot prompts
  client/            — typed HTTP clients for each MarkLogic API surface
    semaphore.ts     — CLS XML API + KMM REST API + publisher workspace ZIP client
  config/            — dotenv loading and Zod validation
  transport/         — stdio and Express/HTTP transport wrappers
  utils/             — error formatting, digest auth, multipart builder

.claude/skills/      — Agent Skills: the how-to guidance, loaded on demand
scripts/
  validate-skills.mjs — Agent Skills spec compliance check
  install-skills.mjs  — copy the skills into another project or ~/.claude/skills
```

All write tools check `readonly` at registration time and are not registered when `ML_READONLY=true`. Eval tools check `allowEval` and are not registered when `ML_ALLOW_EVAL=false`. This means tools are absent from the MCP tool list entirely — they are never silently no-ops.

---

## Development

```bash
npm run dev          # tsx watch — auto-reload on save
npm run build        # TypeScript → dist/
npm run typecheck    # Type check without emitting
npm test             # Vitest (skips gracefully if ML_HOST not set)
npm run validate:skills   # Agent Skills spec compliance for .claude/skills/
npm run skills:install    # Copy skills into another project (-- --user | --project <dir>)
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

### What `ML_READONLY` actually does

`ML_READONLY=true` (the default) is a **tool-layer safety belt**, not a credential-level restriction. When it is on:

- **Write tools are not registered.** `ml_document_put` / `_delete` / `_patch`, `ml_tde_install`, `ml_graph_put` / `_delete`, `ml_search_options_put` / `_delete`, `ml_extension_put` / `_delete`, `ml_database_set_forests`, and `dhf_flow_run` are absent from the server's tool list.
- **Flux write subcommands refuse.** `flux_import` / `flux_copy` / `flux_reprocess` return a structured `UNSUPPORTED_IN_BUILD` error. `flux_export` / `flux_preview` / `flux_help` / `flux_status` remain available (read-only).
- **Eval tools are not registered.** `ml_eval_javascript` / `_xquery` / `_sparql`, `ml_invoke_module`, `ml_profile_query`, and `ml_force_merge` are skipped entirely — even if `ML_ALLOW_EVAL=true`. Server-side eval can call any write API (`xdmp.documentInsert`, `admin:database-create`, `sec:create-user`, etc.), so allowing it alongside readonly would defeat the safety belt. The server logs a critical warning at startup when this combination is set, then disables eval.

### What `ML_READONLY` does NOT do

The flag controls **which tools this server registers**. It does **not** restrict what the underlying MarkLogic user can do:

- The MCP server holds one set of MarkLogic credentials (`ML_USERNAME` / `ML_PASSWORD`). Those credentials have whatever MarkLogic roles the operator granted them. If the user is `admin`, that user can do anything against MarkLogic — via the Admin UI, the Management REST API, or any other process that finds the credentials on the host.
- **The MCP server cannot prevent shell-level bypass.** A user (or agent) with shell access to the host running the MCP server can read the credentials, write a separate Node/curl script that uses them, and call MarkLogic directly. The server is a single process; it does not control other processes on the same host.

A real-world example: an agent given `ML_READONLY=true` was asked to create a database. The MCP write tools were correctly unavailable. The agent then read the MCP server's source to learn the auth scheme, wrote a Node script that imported the same client classes, and ran it via `node create-db.mjs` — bypassing the server entirely. The database was created because the underlying user had admin privileges.

### Recommended security posture

For **defence in depth**, both layers should be locked:

1. **Credential layer (most important).** Create a MarkLogic role with only the privileges you actually need (typically just `rest-reader` and any application-specific read privileges — no `rest-writer`, no `manage-admin`, no `any-uri` / `any-collection update`). Create a user bound to that role. Set `ML_USERNAME` / `ML_PASSWORD` to those credentials. **A read-only MarkLogic user makes bypass impossible regardless of what runs on the host.**
2. **Tool layer.** Keep `ML_READONLY=true` so the MCP server's tool surface is sealed. This is your protection against accidental writes from agents calling write tools by name.
3. **Host layer.** Treat the credentials in the MCP server's environment as secrets. Don't run the server on a host that untrusted agents have shell access to.

### Inspect the live posture

Read the `marklogic://security` resource at any time. It reports:
- Active config: `readonly`, `allowEval`, `authType`, username hint.
- Detected warnings, each with a code, severity, message, and remedy:
  - `READONLY_DEFEATED_BY_EVAL` (critical) — readonly is on alongside allowEval (eval is auto-disabled; warning explains why).
  - `READONLY_WITH_PRIVILEGED_USER` (warning) — the configured username looks like an admin account; tool-layer readonly does not provide credential-layer protection.
  - `READONLY_POSTURE_OK` (info) — clean posture; verify the MarkLogic role is also read-only.

Critical and warning items are also logged at startup.

### Agent guidance

The `marklogic://instructions` resource includes explicit agent guidance: when `ML_READONLY=true` is set and a write operation is requested, the agent should **refuse the operation** rather than crafting shell scripts, curl invocations, or side-channel Node code to bypass the safety belt. This is published in the instructions so Claude / Copilot / other MCP clients pick it up.

### Other relevant configuration

- `MCP_API_KEY` — set to require Bearer token auth on the HTTP transport.
- `ML_AUTH_TYPE=oauth` — Bearer tokens from MCP clients are forwarded directly to MarkLogic; the MCP server never sees credentials, only opaque tokens; MarkLogic enforces per-user RBAC via its own JWT validation. In oauth mode, **per-user RBAC is your real readonly mechanism** — give each user only the roles they need.
- Credentials are read from environment variables only — never hardcoded.
- Digest auth recomputes the challenge per request — no credential caching.
- The Flux runner executes on the MCP server host; `http_url` must be reachable from that host, not from the user's machine.
- In oauth mode, `MCP_API_KEY` gateway auth uses the `X-MCP-Api-Key` header to avoid conflicting with the `Authorization: Bearer` header used for the user token.
