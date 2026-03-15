# marklogic-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for MarkLogic 12. Enables AI agents to interrogate MarkLogic for search, document retrieval, schema discovery, admin introspection, and tabular data export for AWS QuickSight.

## Features

- **29 MCP tools** covering admin, documents, search, schema, eval, SPARQL, and QuickSight aggregation
- **4 MCP resources** exposing cluster status, databases, forests, and documents
- **9 MCP prompts** for XQuery/SJS generation, TDE schema creation, structured query building, and QuickSight dataset design
- **Two transports**: stdio (Claude Desktop / local agents) and HTTP+SSE (QuickSight / remote agents)
- **Read-only by default** — writes and eval gated behind environment variables
- **Basic and Digest auth** support for MarkLogic REST API

## Quick Start

### Claude Desktop (stdio)

1. Install dependencies and build:
   ```bash
   npm install && npm run build
   ```

2. Copy and configure `.env`:
   ```bash
   cp .env.example .env
   # Edit .env with your MarkLogic connection details
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

### HTTP/SSE Transport (AWS QuickSight / Remote Agents)

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=3000 ML_HOST=your-host ML_USERNAME=admin ML_PASSWORD=pass node dist/index.js
```

Health check: `GET http://localhost:3000/health`

### Docker Compose — MCP only (existing MarkLogic install)

```bash
# Point at your existing MarkLogic instance
ML_HOST=192.168.175.200 ML_AUTH_TYPE=basic ML_PASSWORD=admin \
  docker compose -f docker-compose.mcp-only.yml up

# MCP server available at http://localhost:3000
# Health check: curl http://localhost:3000/health
```

All variables fall back to defaults so you can override only what you need. You can also create a `.env` file in the same directory and `docker compose` will pick it up automatically.

### Docker Compose — full stack (MarkLogic + MCP server)

```bash
docker compose up
# MarkLogic available at http://localhost:8001 (Admin UI)
# MCP server at http://localhost:3000
```

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

## Tools Reference

### Admin
| Tool | Description |
|---|---|
| `ml_cluster_status` | Cluster health, version, host info |
| `ml_databases_list` | List all databases |
| `ml_database_properties` | Full database configuration |
| `ml_database_statistics` | Document counts, forest sizes |
| `ml_forests_list` | Forest status |
| `ml_servers_list` | App server list |
| `ml_server_properties` | App server configuration |

### Documents
| Tool | Description |
|---|---|
| `ml_document_get` | Retrieve document by URI |
| `ml_document_list` | List by collection or directory |
| `ml_document_put` *(write)* | Create/replace document |
| `ml_document_delete` *(write)* | Delete document |
| `ml_document_patch` *(write)* | Partial update |

### Search
| Tool | Description |
|---|---|
| `ml_search` | Full-text and structured search |
| `ml_search_qbe` | Query By Example |
| `ml_values_query` | Lexicon/range index facets |
| `ml_suggest` | Search autocomplete |

### Schema Discovery
| Tool | Description |
|---|---|
| `ml_schema_discover` | Infer field shapes from document samples |
| `ml_schema_get_tde` | Retrieve TDE schemas |
| `ml_indexes_list` | All configured indexes |
| `ml_collections_list` | Collections with document counts |
| `ml_namespaces_list` | XML namespace registry |

### Eval *(requires `ML_ALLOW_EVAL=true`)*
| Tool | Description |
|---|---|
| `ml_eval_xquery` | Execute XQuery on server |
| `ml_eval_javascript` | Execute Server-Side JavaScript |
| `ml_invoke_module` | Call stored module |

### Graphs / SPARQL
| Tool | Description |
|---|---|
| `ml_sparql_query` | SPARQL SELECT/CONSTRUCT |
| `ml_graphs_list` | List named graphs |

### QuickSight Integration
| Tool | Description |
|---|---|
| `ml_aggregate_query` | Group-by + metrics → tabular rows |
| `ml_timeseries_query` | Time-bucketed aggregation |
| `ml_export_tabular` | Export as CSV or JSON rows |
| `ml_facets_query` | Facet breakdowns for filter controls |

## Prompts Reference

| Prompt | Purpose |
|---|---|
| `xquery_function_generator` | Generate XQuery with MarkLogic 12 idioms |
| `sjs_module_generator` | Generate SJS transforms/extensions |
| `tde_schema_generator` | Generate TDE templates from collections |
| `rest_extension_generator` | Scaffold MarkLogic REST extensions |
| `structured_query_builder` | Natural language → structured query JSON |
| `optic_query_builder` | Natural language → Optic API query |
| `sparql_query_builder` | Natural language → SPARQL |
| `quicksight_dataset_designer` | Design QuickSight datasets from MarkLogic |
| `quicksight_dashboard_planner` | Plan dashboards from business questions |

## Development

```bash
npm run dev          # Run with tsx watch (auto-reload)
npm run typecheck    # TypeScript check
npm run build        # Compile to dist/
npm run inspector    # Launch MCP Inspector UI
```

## AWS QuickSight Integration

QuickSight agents connect to the HTTP transport. The recommended pattern:

1. Start the MCP server in HTTP mode on an ECS task or EC2 instance accessible from QuickSight
2. The QuickSight agent calls `ml_schema_discover` to understand the data shape
3. The agent calls `ml_export_tabular` or `ml_aggregate_query` to extract data
4. The agent uses the QuickSight API to create/refresh a SPICE dataset with the extracted rows
5. Use the `quicksight_dataset_designer` prompt to get guided assistance through this workflow

## Security Notes

- `ML_READONLY=true` (default) prevents all document writes and deletes
- `ML_ALLOW_EVAL=false` (default) prevents server-side code execution via `/v1/eval`
- Set `MCP_API_KEY` to require bearer token auth on the HTTP transport
- Credentials are read from environment variables only — never hardcoded
- The Digest auth implementation recomputes the challenge per request — no credential caching
