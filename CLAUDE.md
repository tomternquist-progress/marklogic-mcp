# MarkLogic MCP — Agent Working Instructions

This file is read automatically by Claude Code when working in this repository.
Follow all principles below for every feature addition, bug fix, and refactor.

---

## Core Principle: Problem-First Thinking

Before writing any new tool, prompt, resource, or client method, answer:

1. **What is the user problem?** State it as a concrete goal, not a technical task.
   - Bad: "expose the `/v1/values` REST endpoint"
   - Good: "allow agents to count distinct values of a field without scanning every document"

2. **What is the MarkLogic-native capability?** Every user problem has a best-fit
   MarkLogic API. Identify it before writing any code.
   - Bulk import → Flux pipeline (`flux_import`)
   - Counting/bucketing → Values/range index API (`ml_values_query`)
   - Joins/aggregates → Optic API over TDE views (`ml_optic_query`)
   - Full-text → Universal index search (`ml_search`)
   - Graph traversal → Triple store / SPARQL (`ml_sparql_query`)
   - Content classification / auto-tagging → Semaphore CLS + KMM (`semaphore_classify`,
     `semaphore_publish`, `flux_import` with `classify_with_semaphore: true`)

3. **What must an agent discover first?** If the tool requires a pre-existing index,
   collection, or TDE template, document that prerequisite in the tool's `description`
   string so the agent knows to check before calling.

4. **Is this already covered?** Check the 11 existing tool groups before adding a new
   tool. Extend an existing tool (via a new parameter) rather than adding a new one
   unless the problem type is genuinely distinct.

---

## The Two Guidance Mechanisms — Keep Them in Sync

### `marklogic://instructions` resource (`src/resources/index.ts`)

The `INSTRUCTIONS_TEXT` constant is the machine-readable problem→solution map.
It is the first thing a capable MCP client will read. **Every time you add a new tool
or prompt, update both:**

- The **PROBLEM → MARKLOGIC-NATIVE SOLUTION TABLE** (add a row if it covers a new
  problem type, or add the tool name to an existing row's PRIMARY TOOLS column)
- The **TOOL GROUPS AT A GLANCE** section (add the tool name to its group)

Keep the text in plain `text/plain` with ASCII column alignment. Do not use JSON.

### `problem_advisor` prompt (`src/prompts/index.ts`)

This is the structured planning prompt that maps a natural-language goal to MarkLogic
tools. The tool list in Section 4 of the prompt text must mirror the actual registered
tools. **When adding a new tool, add it to the relevant group in Section 4.**

---

## Tool Design Conventions

**Descriptions must state prerequisites.**
If a tool requires a range index, TDE template, specific database, or config flag,
say so in the `server.tool()` description string. Agents read descriptions to decide
whether to call a tool.

```typescript
// Good — states the prerequisite
server.tool(
  "ml_optic_query",
  "Execute an Optic query against a TDE view. Requires a TDE template in the Schemas " +
  "database (collection http://marklogic.com/xdmp/tde). Call ml_schema_get_tde first " +
  "to verify the view exists.",
  ...
);
```

**Error messages must be actionable.**
Append `\nNOTE: ...` or `\nHint: ...` to error text when the failure has a known fix.
See `flux.ts` (`buildTdeNote`, `condenseWriteErrors`) and `optic.ts` for patterns.

**No silent no-ops.**
If a config flag disables a tool, either skip registration entirely (see `eval.ts`)
or return an explicit error with instructions for enabling it. Never silently return
empty results when the real cause is a missing permission or disabled feature.

**Readonly gating** — write tools check `readonly` at registration time (`documents.ts` pattern).

**Eval gating** — eval tools check `allowEval` at registration time (`eval.ts` pattern).

---

## Adding a New Tool Group

1. Create `src/tools/<domain>.ts` with a `registerXxxTools(server, clients, ...)` function.
2. Import and call it in `src/tools/index.ts` inside `registerAllTools()`.
3. If new API calls are needed, add `src/client/<domain>.ts` implementing a typed client
   class, and export it from `src/client/index.ts` in the `MarkLogicClients` interface.
4. Update `INSTRUCTIONS_TEXT` in `src/resources/index.ts`:
   - Add row(s) to the problem table
   - Add the tool group to TOOL GROUPS AT A GLANCE
5. Update the tool list in the `problem_advisor` prompt (Section 4).
6. Update this file (`CLAUDE.md`) — add the new tool group to the Core Principle section
   if it covers a new problem type.

## Adding a New Prompt

1. Add a `server.prompt()` call in `src/prompts/index.ts` inside `registerAllPrompts()`.
2. All parameters must have `.describe()` strings.
3. Return `{ messages: [{ role: "user", content: { type: "text", text: "..." } }] }`.
4. For **advisor/planning prompts**: use a numbered fill-in template so the LLM produces
   structured output that downstream agents can parse section by section.
5. For **code-generation prompts**: include explicit requirements as a bullet list and
   end with "Generate the code now." so the output is directly usable.
6. Add the prompt name to the `problem_advisor` Section 4 tool list.

## Adding a New Resource

1. Add a `server.resource()` call in `src/resources/index.ts` inside `registerAllResources()`.
2. Use URI scheme `marklogic://<domain>/<name>`.
3. **Static resources** (no client calls): return immediately, no try/catch needed.
   See the `marklogic_document_info` and `marklogic_instructions` patterns.
4. **Dynamic resources** (client calls): wrap in try/catch, use `toToolError(err)` for
   the error text. See `marklogic_databases` and `marklogic_forests` patterns.

---

## File Map

```
src/
  server.ts          — factory: createMcpServer() wires tools + resources + prompts
  index.ts           — CLI entry point; selects stdio or HTTP transport
  tools/
    index.ts         — calls all registerXxxTools() — add new groups here
    admin.ts         — cluster, databases, forests, servers (7 tools)
    documents.ts     — get/list/put/delete/patch (2–5 tools, readonly-gated)
    search.ts        — search, QBE, values, suggest (4 tools)
    schema.ts        — discover, TDE, indexes, collections, namespaces (6 tools)
    eval.ts          — XQuery, SJS, invoke (3 tools, allowEval-gated)
    graphs.ts        — SPARQL, graphs list (2 tools)
    optic.ts         — Optic query (1 tool)
    quicksight.ts    — aggregate, timeseries, export, facets (4 tools)
    flux.ts          — import/export/copy/reprocess/preview/help/status (7 tools)
    semaphore.ts     — CLS status/classify + KMM model management + publish (12 tools)
  resources/
    index.ts         — all resources; INSTRUCTIONS_TEXT constant at top
  prompts/
    index.ts         — all prompts; problem_advisor first, then domain-specific
  client/
    index.ts         — MarkLogicClients factory + interface
    base.ts          — Axios HTTP + Digest/Basic auth + error mapping
    admin.ts         — cluster, databases, forests, servers
    documents.ts     — CRUD + patch
    search.ts        — full-text, structured, QBE, values, suggest
    schema.ts        — TDE, indexes, collections, namespaces, discovery
    eval.ts          — XQuery, SJS, module invocation
    graphs.ts        — SPARQL
    optic.ts         — Optic plan execution
    flux.ts          — Flux runner HTTP client
    semaphore.ts     — CLS XML API + KMM REST API (SPARQL, publish, workspace ZIP)
  config/
    index.ts         — dotenv loading + validation
    schema.ts        — Zod schemas for all config sections
  transport/
    stdio.ts         — StdioServerTransport wrapper
    http.ts          — Express server with session management + Bearer auth
  utils/
    errors.ts        — error classes + toToolError() formatter
    logger.ts        — Winston configuration
    digest.ts        — HTTP Digest auth builder
    multipart.ts     — Multipart form-data builder
```

---

## Build & Test

```bash
npm run build   # TypeScript → dist/; always run after editing .ts files
npm test        # Vitest; tests skip gracefully if ML_HOST is not set
npm run dev     # Watch mode for development
```

The project uses ES modules (`"type": "module"`). All local imports must use `.js`
extensions even though the source files are `.ts`.
