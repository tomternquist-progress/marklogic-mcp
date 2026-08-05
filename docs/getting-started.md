# Getting Started with marklogic-mcp

This guide takes you from an empty machine to an AI agent that can query your MarkLogic
instance — using **stdio**, the default and simplest way to run the server.

Roughly 10 minutes: build the server, point your agent at it, install the skills, ask a
question. If you need a shared or remote deployment instead, jump to
[Deploying over HTTP](#deploying-over-http-docker).

---

## How the pieces fit

```
your agent  ──launches──►  marklogic-mcp (node dist/index.js)  ──REST──►  MarkLogic
(Claude Code,               103 tools: search, Optic, SPARQL,             ports 8000 / 8002
 Claude Desktop,            schema, Flux, admin …
 Copilot, …)
     │
     └─reads──►  .claude/skills/   ← the MarkLogic know-how (installed separately)
```

Two things travel separately, and it trips people up:

- **Tools** come from the MCP server over the connection. Nothing to install.
- **Skills** are Markdown files the agent reads from **its own filesystem**. They do *not*
  come over the MCP connection — you copy them in once (step 4).

---

## Prerequisites

- **MarkLogic 12** — running and reachable. No instance yet? See
  [Starting a MarkLogic for testing](#starting-a-marklogic-for-testing) below.
- **Node.js 20+** (22 recommended) — to build and run the server.
- **An MCP client** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code),
  [Claude Desktop](https://claude.ai/download),
  [GitHub Copilot in VS Code](https://code.visualstudio.com/docs/copilot/chat/mcp-servers),
  or any MCP-capable agent framework.

---

## Step 1 — Build the server

```bash
git clone https://github.com/tternquist/marklogic-mcp.git
cd marklogic-mcp
npm install
npm run build          # → dist/index.js, the file your agent will launch
```

Note the absolute path — you need it in the next step:

```bash
echo "$PWD/dist/index.js"
```

---

## Step 2 — Connect your MCP client (stdio)

In stdio mode the agent starts the server itself, one process per session, and talks to it over
stdin/stdout. There is no port, no API key, and nothing left running when you close the session.

> **Where do the credentials go?** In your **client's config**, not in `.env`. The `.env` file is
> read from the working directory of the server process, and clients launch it from their own
> directory — usually not this repo. `.env` is for `npm start`, `npm run dev`, and Docker.

### Claude Code

```bash
claude mcp add marklogic \
  -e ML_HOST=localhost -e ML_PORT=8000 -e ML_MANAGEMENT_PORT=8002 \
  -e ML_USERNAME=admin -e ML_PASSWORD=your-password \
  -e ML_AUTH_TYPE=digest -e ML_READONLY=true \
  -- node /absolute/path/to/marklogic-mcp/dist/index.js
```

Verify:

```bash
claude mcp list      # marklogic: ... - ✓ Connected
```

By default this lands in your user config (`~/.claude.json`) so it works in every project. Add
`--scope project` to write `.mcp.json` in the current directory and share it with your team
instead.

### Claude Desktop

| OS | Config path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "marklogic": {
      "command": "node",
      "args": ["/absolute/path/to/marklogic-mcp/dist/index.js"],
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

Restart Claude Desktop, then check the tools icon in the chat input — MarkLogic tools should be
listed.

### GitHub Copilot CLI

Copilot CLI stores MCP servers in `~/.copilot/mcp-config.json` (or `$COPILOT_HOME/mcp-config.json`).
Add this one without leaving the terminal:

```bash
copilot mcp add marklogic \
  --env ML_HOST=localhost --env ML_PORT=8000 --env ML_MANAGEMENT_PORT=8002 \
  --env ML_USERNAME=admin --env ML_PASSWORD=your-password \
  --env ML_AUTH_TYPE=digest --env ML_READONLY=true \
  -- node /absolute/path/to/marklogic-mcp/dist/index.js
```

The `--` separates Copilot's own flags from the command it should launch. Then start `copilot`
and check:

```
/mcp show                 # marklogic should be listed, with its tool count
/mcp show marklogic       # details for one server
```

Other useful commands: `/mcp add` (guided form instead of the CLI flags), `/mcp edit marklogic`,
`/mcp disable marklogic`, `/mcp delete marklogic`.

Written by hand, the same entry looks like this:

```json
{
  "mcpServers": {
    "marklogic": {
      "type": "local",
      "command": "node",
      "args": ["/absolute/path/to/marklogic-mcp/dist/index.js"],
      "env": {
        "ML_HOST": "localhost",
        "ML_PORT": "8000",
        "ML_MANAGEMENT_PORT": "8002",
        "ML_USERNAME": "admin",
        "ML_PASSWORD": "${ML_PASSWORD}",
        "ML_AUTH_TYPE": "digest",
        "ML_READONLY": "true"
      },
      "tools": ["*"]
    }
  }
}
```

Three things worth knowing:

- **`"type": "local"` and `"type": "stdio"` both work.** Prefer `stdio` if you want the same
  block to be portable to other MCP clients.
- **`env` values expand `${VAR}` from your shell**, as with `ML_PASSWORD` above — that keeps the
  password out of the config file.
- **`tools` filters the surface.** `["*"]` exposes all 103; narrow it (or pass `--tools`) if you
  want Copilot to see only some.

Skills work slightly differently here — see [Step 4](#step-4--install-the-agent-skills).

> `.vscode/mcp.json` is **not** the Copilot CLI's config. The CLI used to make a best-effort
> attempt to read it, that support was removed, and it now uses the file above. VS Code itself
> still uses `.vscode/mcp.json` — see the next section.

### GitHub Copilot in VS Code

Open **Settings (JSON)** (`Ctrl+Shift+P` → "Preferences: Open User Settings (JSON)") and add:

```json
{
  "mcp": {
    "servers": {
      "marklogic": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/marklogic-mcp/dist/index.js"],
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

To share the config with your team without committing a password, put a `.vscode/mcp.json` in
your project and use an `inputs` prompt — VS Code asks for the value once per session:

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
      "args": ["/absolute/path/to/marklogic-mcp/dist/index.js"],
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

Then open **Copilot Chat** (`Ctrl+Shift+I` / `Cmd+Shift+I`) and switch to **Agent mode** — MCP
tools are only available there.

---

## Step 3 — Know what the defaults protect

The server starts in the safest configuration:

| Setting | Default | Effect |
|---|---|---|
| `ML_READONLY` | `true` | Write tools (`ml_document_put`, `ml_graph_put`, `flux_import`, …) are **not registered at all** — the agent cannot call them by name |
| `ML_ALLOW_EVAL` | `false` | Server-side XQuery/SJS execution tools are not registered |

Flip `ML_READONLY=false` in your client config when you want the agent to write. Before you do,
read [Security Notes](../README.md#security-notes) — the short version is that this flag limits
the *tool surface*, not the MarkLogic user, so the durable protection is giving the MCP server a
MarkLogic user that only has the roles it needs.

---

## Step 4 — Install the Agent Skills

The server gives the agent 103 tools. The **skills** tell it which one to reach for, what has to
exist first, and how each one fails — the difference between an agent that loops
`ml_document_put` 40,000 times and one that reaches for `flux_import`.

If you are working **inside this repo**, they are already in place — both Claude Code and Copilot
CLI discover `.claude/skills` from the project root (`/skills` and `/skills list`). If your agent
runs in **your own project**, copy them in:

```bash
# from your clone of this repo
npm run skills:install -- --list                     # see what's available
npm run skills:install -- --user                     # → ~/.claude/skills (Claude, every project)
npm run skills:install -- --project ~/my-app         # → ~/my-app/.claude/skills (check in for the team)
npm run skills:install -- --dest ~/.copilot/skills   # Copilot CLI personal skills
```

Where each agent looks:

| Agent | Project skills | Personal skills |
|---|---|---|
| Claude Code | `<project>/.claude/skills` | `~/.claude/skills` |
| Copilot CLI | `<repo>/.claude/skills`, `.github/skills`, `.agents/skills` | `~/.copilot/skills`, `~/.agents/skills` |

The trap: Copilot CLI reads the **project** `.claude/skills` directory happily, but it does *not*
read `~/.claude/skills` — so `--user` is a no-op for it. Use `--dest ~/.copilot/skills` for
personal installs, or `--project` and let both agents share one directory.

Restart the agent session afterwards — skills are read at session start. In Copilot CLI you can
also run `/skills reload` without restarting.

Full guide, including what each skill covers and what to do when one doesn't fire:
[SKILLS.md](SKILLS.md).

---

## Step 5 — First conversations

Try these in order. Each maps to a tool you can see the agent call.

**1. Get oriented**

> "Read the `marklogic://instructions` resource and tell me what this server can do."

That resource is the problem→tool decision table — the fallback for clients that don't support
skills, and a good sanity check that the connection works.

**2. Discover the data**

> "What databases exist? What collections are in Documents? Show me a sample document from the
> biggest one."

→ `ml_databases_list`, `ml_collections_list`, `ml_document_sample`

**3. Search**

> "Search for documents mentioning 'revenue' in the invoices collection."

→ `ml_search`, using the universal index — no index configuration needed.

**4. Understand the shape, then aggregate**

> "Discover the schema of the customers collection, create a TDE view for it, then count
> customers by country."

→ `ml_schema_discover` → the `marklogic-server-side-code` skill for TDE syntax → `ml_tde_install`
→ `ml_reindex_status` → `ml_optic_query` with a GROUP BY. (Needs `ML_READONLY=false`.)

**5. Bulk load**

> "Import /data/sales.csv into a `sales` collection and generate a TDE view for it."

→ `flux_import` — which needs the Flux runner from the next section.

---

## Adding bulk import (the Flux runner)

The `flux_*` tools drive **Flux**, MarkLogic's bulk data pipeline. It runs as its own container
in every deployment mode, including stdio:

```bash
docker run -d --name flux-runner -p 8080:8080 \
  -e FLUX_PORT=8080 -v "$PWD/flux-data:/data" \
  ghcr.io/tternquist/marklogic-mcp/flux-runner:master
```

Add `FLUX_RUNNER_URL=http://localhost:8080` to the server's env in your client config and restart
the session. Ask the agent to run `flux_status` to confirm.

Two things to know:

- **Paths are resolved inside the runner.** `-v "$PWD/flux-data:/data"` means a file at
  `./flux-data/sales.csv` on your machine is `/data/sales.csv` to `flux_import`.
- **MarkLogic must be reachable from the runner container**, not from your laptop. If MarkLogic
  is also in Docker, put both on the same network — see [docker-networking.md](docker-networking.md).

Without a runner, the other 96 tools work normally and `flux_*` returns an error explaining how
to start one.

---

## Deploying over HTTP (Docker)

stdio covers one person on one machine. Switch to the HTTP transport when:

- **a team or several agents share one deployment** — one container to configure and one place to
  rotate credentials;
- **the agent isn't on your machine** — AWS QuickSight, a hosted agent, or CI can't spawn a local
  subprocess;
- **you need per-user MarkLogic RBAC** — `ML_AUTH_TYPE=oauth` forwards each caller's own bearer
  token so MarkLogic enforces that user's roles (stdio carries only one static token);
- **you'd rather not install Node or MarkLogic locally** — one compose file brings up everything.

### Option A: MCP server only, against MarkLogic you already run

```bash
ML_HOST=your-marklogic-host ML_PASSWORD=your-password MCP_API_KEY=choose-a-secret \
  docker compose -f docker-compose.mcp-only.yml up -d

# add the Flux sidecar too:
ML_HOST=your-marklogic-host ML_PASSWORD=your-password MCP_API_KEY=choose-a-secret \
  docker compose -f docker-compose.mcp-only.yml --profile flux up -d
```

### Option B: full sandbox — MarkLogic + Flux runner + MCP server

```bash
docker compose up -d
docker compose logs -f marklogic     # wait for "MarkLogic Server is online" (~60s first run)
```

- MarkLogic Admin UI — http://localhost:8001 (`admin` / `admin`)
- MarkLogic REST API — http://localhost:8000
- MCP server — http://localhost:3000

### Option C: MarkLogic and/or Semaphore already in other Docker projects

Containers in separate compose projects can't see each other. Put them on a shared network:

```bash
docker network create shared                          # one-time
docker network connect shared marklogic               # your container names
docker network connect shared semaphore               # if using Semaphore

ML_HOST=marklogic ML_PASSWORD=admin SEMAPHORE_HOST=semaphore \
  docker compose -f docker-compose.external.yml up -d
```

[docker-networking.md](docker-networking.md) covers this and the alternatives (host network mode,
host IP).

### Verify and connect

```bash
curl http://localhost:3000/health          # {"status":"ok","sessions":0}

claude mcp add --transport http marklogic http://localhost:3000/mcp \
  --header "Authorization: Bearer choose-a-secret"
```

VS Code / Copilot uses the same endpoint:

```json
{ "servers": { "marklogic": {
    "type": "http",
    "url": "http://localhost:3000/mcp",
    "headers": { "Authorization": "Bearer choose-a-secret" }
} } }
```

**Set `MCP_API_KEY` on anything that isn't localhost.** Without it, anyone who can reach the port
gets your MarkLogic credentials' full tool surface. More detail:
[claude-code-remote-mcp.md](claude-code-remote-mcp.md).

---

## Starting a MarkLogic for testing

If you have no MarkLogic yet and only want one to try this against, the bundled compose file can
start just the database:

```bash
docker compose up -d marklogic
docker compose logs -f marklogic     # wait for it to come online
```

Admin UI at http://localhost:8001, credentials `admin` / `admin`. Then continue with
[Step 1](#step-1--build-the-server) and point the server at `ML_HOST=localhost`,
`ML_PORT=8000`.

---

## Troubleshooting

**The client shows the server as failed / disconnected.**
Run it by hand with the same environment to see the real error:

```bash
ML_HOST=localhost ML_USERNAME=admin ML_PASSWORD=your-password node dist/index.js
```

A startup log line means it is fine (stdio servers then wait silently for input — Ctrl-C out). A
config error prints exactly which variable is wrong.

**`Invalid configuration: connection.username: Required when ML_AUTH_TYPE is not oauth`**
The client isn't passing credentials. In stdio mode they must be in the client's `env` block —
a `.env` file in this repo is not read unless the process starts here.

**`ECONNREFUSED` / `ETIMEDOUT`.**
`ML_HOST`/`ML_PORT` don't reach MarkLogic. Check both ports the server uses:
`curl -u admin:pass http://<host>:8002/manage/v2` (management) and
`curl -u admin:pass http://<host>:8000/v1/search?pageLength=1` (REST). From inside a container,
`localhost` means the container itself — use the container name or `host.docker.internal`.

**`401 Unauthorized`.**
Wrong credentials, or the wrong `ML_AUTH_TYPE`. MarkLogic app servers are configured per port for
`digest` or `basic`; check the port's authentication setting in the Admin UI (port 8001 →
Configure → Groups → Default → App Servers).

**The agent says a tool doesn't exist.**
Write tools are absent when `ML_READONLY=true` and eval tools when `ML_ALLOW_EVAL=false` — by
design, so they can't be called accidentally. Also note `ML_READONLY=true` disables eval tools
even if `ML_ALLOW_EVAL=true`; the server logs a warning at startup when both are set.

**Flux tools return "Flux runner is not reachable".**
The runner isn't running or `FLUX_RUNNER_URL` is wrong — see
[Adding bulk import](#adding-bulk-import-the-flux-runner).

**The agent ignores the skills.**
Confirm they're visible (`/skills` in Claude Code) and that you restarted the session after
installing. You can always name one explicitly: *"use the marklogic-bulk-import skill"*. More in
[SKILLS.md](SKILLS.md#troubleshooting).

**Changing config had no effect.**
stdio servers are launched per session — restart the agent session (or `claude mcp remove
marklogic` and re-add) after editing the client config.

---

## Next steps

- [Agent Skills](SKILLS.md) — what each skill covers, how to install, how to author your own
- [Tools reference](../README.md#tools-reference) — all 103 tools by group
- [Configuration](../README.md#configuration) — every environment variable
- [Security notes](../README.md#security-notes) — before you set `ML_READONLY=false`
- [Semaphore integration](../README.md#semaphore-25-tools) — taxonomy and classification
- [AWS QuickSight](../README.md#aws-quicksight-integration) — BI dashboards over MarkLogic
