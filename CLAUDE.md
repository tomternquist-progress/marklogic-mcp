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

4. **Is this already covered?** Check the 18 existing tool groups before adding a new
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

**Readonly gating** — every tool that mutates state must be gated on `readonly`, and the
gate belongs in `registerXxxTools()`'s signature so `src/tools/index.ts` passes it in.
Two accepted patterns:

- **Skip registration** (`documents.ts`, `admin.ts`, `extensions.ts`): wrap the write
  registrations in `if (!readonly) { … }`. Prefer this when the tool has no standalone
  discovery value.
- **Register, then refuse** (`flux.ts`, `semaphore.ts`): keep the registration and return
  the structured `UNSUPPORTED_IN_BUILD` / `runtime_capability` envelope from the top of
  the handler, before any config or parameter validation. Prefer this when the tool's
  description carries guidance an agent benefits from reading even when it can't call it.

This applies to tools that write through an **external service** too — Flux and Semaphore
are both gated. "It doesn't write to MarkLogic directly" is not an exemption.

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
    index.ts            — calls all registerXxxTools() — add new groups here
    suggest-approach.ts — ml_suggest_approach: maps a goal to the best-fit tool(s)
    answer.ts           — ml_answer_query: one-shot NL question answering over a collection
    admin.ts            — cluster, databases, forests, servers (readonly-gated writes)
    documents.ts        — get/sample/list/put/delete/patch/patch-batch (readonly-gated)
    search.ts           — search, QBE, values, suggest
    schema.ts           — discover, TDE, indexes, collections, namespaces
    eval.ts             — XQuery, SJS, SPARQL-via-eval, invoke (allowEval-gated)
    graphs.ts           — SPARQL, graphs list (readonly-gated writes)
    optic.ts            — Optic query
    quicksight.ts       — aggregate, timeseries, export, facets
    flux.ts             — import/export/copy/reprocess/preview/help/status (readonly-gated)
    fasttrack.ts        — FastTrack scaffolding (readonly-gated)
    extensions.ts       — REST resource/transform extension management (readonly-gated)
    security.ts         — users/roles/permissions introspection (read-only)
    performance.ts      — database/forest metrics, merge/reindex status (eval-gated bits)
    dhf.ts              — Data Hub Framework flow run/scaffold (eval + readonly + JAR gated)
    ml-gradle.ts        — ml-gradle project scaffolding / command guidance
    semaphore.ts        — CLS + KMM + taxonomy + KID templates (~27 tools)
  resources/
    index.ts         — all resources; INSTRUCTIONS_TEXT constant at top
  prompts/
    index.ts         — all prompts; problem_advisor first, then domain-specific
  client/
    index.ts         — MarkLogicClients factory + interface
    base.ts          — Axios HTTP + Digest/Basic/OAuth auth + error mapping
    admin.ts         — cluster, databases, forests, servers
    documents.ts     — CRUD + patch
    search.ts        — full-text, structured, QBE, values, suggest
    schema.ts        — TDE, indexes, collections, namespaces, discovery
    eval.ts          — XQuery, SJS, module invocation, cts.parse, static check
    graphs.ts        — SPARQL
    optic.ts         — Optic plan execution
    flux.ts          — Flux runner HTTP client (SSE /run-stream + /run fallback)
    fasttrack.ts     — FastTrack client
    extensions.ts    — REST extension management client
    security.ts      — users/roles/permissions client
    performance.ts   — metrics + status client
    dhf.ts           — Data Hub Framework client
    semaphore.ts     — CLS XML API + KMM REST API (SPARQL, publish, workspace ZIP)
  config/
    index.ts         — dotenv loading + validation
    schema.ts        — Zod schemas for all config sections
  transport/
    stdio.ts         — StdioServerTransport wrapper
    http.ts          — Express server with session management + Bearer/OAuth token binding
  utils/
    errors.ts            — error classes + toToolError() string formatter
    tool-error.ts        — structured makeToolError() envelope + edit-distance "did you mean"
    logger.ts            — Winston configuration
    digest.ts            — HTTP Digest auth builder
    multipart.ts         — Multipart form-data builder + multipart/mixed parser
    eval-lint.ts         — preflight SJS lint for ml_eval_javascript
    capabilities.ts      — per-tool capability tags (CAP ABILITIES)
    projection.ts        — field projection / aggregation for ml_answer_query
    recipes.ts           — canned query recipes for ml_answer_query
    value-normalize.ts   — case/plural/closest-value normalization
    collection-routing.ts— score-based collection routing for ml_answer_query
    security-posture.ts  — startup security-misconfig analysis (readonly/eval/TLS/admin-user)
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
