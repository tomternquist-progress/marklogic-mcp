# Connecting Claude Code to MarkLogic MCP via Remote Transport

Claude Code supports remote MCP servers over HTTP (Streamable HTTP transport). This lets you run
the MarkLogic MCP server once — in Docker, on a VM, or in Kubernetes — and connect to it without
any local Node.js process.

> **This is the non-default path.** For a single developer on a single machine, stdio is simpler:
> `claude mcp add marklogic -e ML_HOST=... -- node /path/to/dist/index.js`, with no port, no API
> key, and nothing left running. See [getting-started.md](getting-started.md). Use HTTP when a
> team shares one deployment, when the agent is remote (QuickSight, hosted agents, CI), when you
> need per-user OAuth passthrough, or when you don't want Node on the client machine.

## 1. Start the MCP server

Use the standalone Docker Compose file. It binds to `0.0.0.0:3000` by default.

```bash
# Minimal — connects to a MarkLogic instance on the same host
ML_HOST=<marklogic-host> ML_PASSWORD=<password> \
  docker compose -f docker-compose.mcp-only.yml up -d
```

Set an API key to require bearer-token auth (recommended for any non-localhost deployment):

```bash
ML_HOST=<marklogic-host> ML_PASSWORD=<password> MCP_API_KEY=<secret> \
  docker compose -f docker-compose.mcp-only.yml up -d
```

Verify it is up:

```bash
curl http://localhost:3000/health
# {"status":"ok","sessions":0}
```

## 2. Add the remote MCP server to Claude Code

Run the following command (replace the URL and key with your values):

```bash
# Without authentication
claude mcp add --transport http marklogic http://localhost:3000/mcp

# With bearer token authentication
claude mcp add --transport http marklogic http://localhost:3000/mcp \
  --header "Authorization: Bearer <your-api-key>"
```

The `--transport http` flag tells Claude Code to use the Streamable HTTP transport instead of
launching a local process.

To connect to a server running on a remote host:

```bash
claude mcp add --transport http marklogic http://<remote-host>:3000/mcp \
  --header "Authorization: Bearer <your-api-key>"
```

## 3. Verify the connection

```bash
claude mcp list
# marklogic: http://localhost:3000/mcp  (http)

claude mcp get marklogic
```

Once connected, Claude Code will discover all MarkLogic tools (document search, query eval,
schema inspection, etc.) automatically.

## 4. Scope

By default the config is added to your **user** scope (`~/.claude.json`) so it is available in
every project. To restrict it to one project, add `--scope project`:

```bash
claude mcp add --transport http --scope project marklogic http://localhost:3000/mcp
```

This writes the entry to `.mcp.json` in the current directory, which you can check into the
project so teammates get the same server.

## Environment variables reference

Defaults below are the server's own; the Docker Compose files in this repo already set
`MCP_TRANSPORT=http` for you.

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | Must be set to `http` for remote access |
| `MCP_HTTP_PORT` | `3000` | Port the server listens on |
| `MCP_HTTP_HOST` | `0.0.0.0` | Bind address |
| `MCP_API_KEY` | _(none)_ | Bearer token required by clients if set |
| `ML_HOST` | `localhost` | MarkLogic hostname |
| `ML_PORT` | `8000` | MarkLogic App-Services port |
| `ML_USERNAME` | _(required)_ | MarkLogic username (unless `ML_AUTH_TYPE=oauth`) |
| `ML_PASSWORD` | _(required)_ | MarkLogic password (unless `ML_AUTH_TYPE=oauth`) |
| `ML_AUTH_TYPE` | `digest` | `digest`, `basic`, or `oauth` (forwards each client's bearer token to MarkLogic) |
| `ML_READONLY` | `true` | Write and eval tools are not registered |

The full list is in the [README Configuration section](../README.md#configuration).

## Notes

- The server uses the **Streamable HTTP** MCP transport (`POST /mcp`). This is the current MCP
  standard and is supported by Claude Code 1.x+.
- Each Claude Code session gets its own server-side session (tracked by `mcp-session-id` header).
  Sessions are cleaned up automatically when the client disconnects.
- The server rate-limits to 500 requests per minute per IP by default.
