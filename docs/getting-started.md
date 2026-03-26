# Getting Started with marklogic-mcp

This guide walks you through setting up the MarkLogic MCP server from scratch,
connecting it to your MarkLogic instance, and using it with an AI agent.

---

## Prerequisites

- **MarkLogic 12** — running and accessible (local install, Docker, or remote)
- **Node.js 22+** — for building from source (not needed for Docker-only setup)
- **Docker** — if using the container-based setup
- An MCP-compatible client — [Claude Desktop](https://claude.ai/download),
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code),
  [GitHub Copilot in VS Code](https://code.visualstudio.com/docs/copilot/chat/mcp-servers),
  or any MCP-capable agent framework

---

## Option A: Docker (Recommended)

### 1. Full stack — MarkLogic + MCP server together

If you don't have MarkLogic running yet, the bundled compose file starts
everything:

```bash
git clone https://github.com/tternquist/marklogic-mcp.git
cd marklogic-mcp
docker compose up -d
```

This starts:
- **MarkLogic 12** — Admin UI at http://localhost:8001, REST API at http://localhost:8000
- **Flux runner** — bulk import/export sidecar
- **MCP server** — HTTP transport at http://localhost:3000

Default credentials: `admin` / `admin`.

Wait for MarkLogic to finish initializing (~60 seconds on first run):

```bash
docker compose logs -f marklogic   # watch for "MarkLogic Server is online"
```

### 2. MCP server only — connect to existing MarkLogic

If MarkLogic is already installed (bare metal, VM, or cloud):

```bash
cd marklogic-mcp

ML_HOST=your-marklogic-host ML_PASSWORD=your-password \
  docker compose -f docker-compose.mcp-only.yml up -d
```

To also start the Flux sidecar for bulk import/export:

```bash
ML_HOST=your-marklogic-host ML_PASSWORD=your-password \
  docker compose -f docker-compose.mcp-only.yml --profile flux up -d
```

### 3. MCP server + existing MarkLogic/Semaphore Docker containers

When MarkLogic and/or Semaphore are already running as Docker containers on the
same host, containers in different compose projects can't see each other by default.
The solution is a shared Docker network:

```bash
# Create a shared network (one-time)
docker network create shared

# Attach your existing containers
docker network connect shared marklogic     # use your container name
docker network connect shared semaphore     # if using Semaphore

# Start the MCP server
ML_HOST=marklogic ML_PASSWORD=admin SEMAPHORE_HOST=semaphore \
  docker compose -f docker-compose.external.yml up -d
```

See [docker-networking.md](docker-networking.md) for a detailed guide covering
alternative approaches (host network mode, host IP).

### Verify the server is running

```bash
curl http://localhost:3000/health
```

You should see a JSON response with `"status": "ok"`.

---

## Option B: From Source (stdio transport)

### 1. Clone and build

```bash
git clone https://github.com/tternquist/marklogic-mcp.git
cd marklogic-mcp
npm install
npm run build
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your MarkLogic connection details:

```bash
ML_HOST=localhost
ML_PORT=8000
ML_MANAGEMENT_PORT=8002
ML_USERNAME=admin
ML_PASSWORD=your-password
ML_AUTH_TYPE=digest
ML_READONLY=true
ML_ALLOW_EVAL=false
```

### 3. Test the connection

```bash
npm test
```

Tests that require a MarkLogic connection will run; others skip gracefully.

---

## Connecting an MCP Client

### Claude Desktop (stdio)

Add to your Claude Desktop config:

| OS | Config path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "marklogic": {
      "command": "node",
      "args": ["/path/to/marklogic-mcp/dist/index.js"],
      "env": {
        "ML_HOST": "localhost",
        "ML_PORT": "8000",
        "ML_MANAGEMENT_PORT": "8002",
        "ML_USERNAME": "admin",
        "ML_PASSWORD": "your-password",
        "ML_AUTH_TYPE": "digest",
        "ML_READONLY": "true"
      }
    }
  }
}
```

Restart Claude Desktop to pick up the new config.

### Claude Code (remote HTTP)

With the MCP server running on HTTP transport:

```bash
claude mcp add --transport http marklogic http://localhost:3000/mcp
```

If you set `MCP_API_KEY`:

```bash
claude mcp add --transport http marklogic http://localhost:3000/mcp \
  --header "Authorization: Bearer your-api-key"
```

See [claude-code-remote-mcp.md](claude-code-remote-mcp.md) for the full guide.

### GitHub Copilot CLI / VS Code (stdio or HTTP)

GitHub Copilot in VS Code supports MCP servers in agent mode. You can connect
via stdio (local) or HTTP (remote).

#### Option 1: stdio (local, from source)

Build the project first (see [Option B](#option-b-from-source-stdio-transport) above),
then add an entry to your VS Code settings. Open **Settings (JSON)** (`Ctrl+Shift+P` →
"Preferences: Open User Settings (JSON)") and add:

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
          "ML_MANAGEMENT_PORT": "8002",
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

Alternatively, create a `.vscode/mcp.json` file in your project root to share
the configuration with your team (use `"inputs"` for secrets so credentials
stay out of source control):

```json
{
  "inputs": [
    {
      "id": "ml-password",
      "type": "promptString",
      "description": "MarkLogic password",
      "password": true
    }
  ],
  "servers": {
    "marklogic": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/index.js"],
      "env": {
        "ML_HOST": "localhost",
        "ML_PORT": "8000",
        "ML_MANAGEMENT_PORT": "8002",
        "ML_USERNAME": "admin",
        "ML_PASSWORD": "${input:ml-password}",
        "ML_AUTH_TYPE": "digest",
        "ML_READONLY": "true"
      }
    }
  }
}
```

#### Option 2: HTTP (remote, Docker)

With the MCP server already running on HTTP transport (see
[Option A](#option-a-docker-recommended)), add to your VS Code settings or
`.vscode/mcp.json`:

```json
{
  "servers": {
    "marklogic": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

Omit the `"headers"` block if you haven't set `MCP_API_KEY`.

#### Using with Copilot

1. Open the **Copilot Chat** panel in VS Code (`Ctrl+Shift+I` or `Cmd+Shift+I`).
2. Switch to **Agent mode** (click the mode picker at the top of the chat panel).
3. The MarkLogic MCP tools will appear in the tool list (click the tools icon to
   verify). You can now ask Copilot questions like:
   - *"What databases exist on my MarkLogic server?"*
   - *"Search for documents about revenue in the invoices collection"*
   - *"Discover the schema for the customers collection"*

---

## First Steps with an Agent

Once connected, try these prompts with your AI agent:

### 1. Read the decision guide

> "Read the marklogic://instructions resource and summarize the available tools."

This gives the agent the problem→tool decision table — the foundation for every
subsequent request.

### 2. Discover your data

> "What databases exist? What collections are in the Documents database? Show me
> a sample document."

The agent will call `ml_databases_list`, `ml_collections_list`, and
`ml_document_sample`.

### 3. Search

> "Search for documents containing 'revenue' in the invoices collection."

The agent will use `ml_search` with the universal index — no configuration needed.

### 4. Schema discovery → Optic query

> "Discover the schema for the 'customers' collection, create a TDE view, then
> count customers by country."

The agent will chain `ml_schema_discover` → `tde_schema_generator` prompt →
`ml_tde_install` → `ml_optic_query` with a GROUP BY.

### 5. Bulk import

> "Import this CSV file into MarkLogic: /data/sales.csv"

The agent will use `flux_import` — 10-100x faster than looping `ml_document_put`.

---

## Configuration Reference

See the [Configuration table](../README.md#configuration) in the README for all
environment variables.

Key settings to know:

| Setting | Default | What it controls |
|---|---|---|
| `ML_READONLY` | `true` | Write tools are not registered at all when true |
| `ML_ALLOW_EVAL` | `false` | Eval tools (XQuery/SJS execution) hidden when false |
| `MCP_API_KEY` | _(none)_ | Set to require Bearer auth on HTTP transport |
| `ML_AUTH_TYPE` | `digest` | `digest`, `basic`, or `oauth` |

---

## Next Steps

- Browse the full [Tools Reference](../README.md#tools-reference) for all 80+ tools
- Try the `problem_advisor` prompt with a natural-language goal
- Set up [Semaphore integration](../README.md#semaphore-20-tools) for taxonomy
  and classification
- Connect [AWS QuickSight](../README.md#aws-quicksight-integration) for BI dashboards
