# Architecture & Code Review — marklogic-mcp

**Date**: 2026-03-18
**Scope**: Full codebase review (~20,900 lines TypeScript across 30+ source files)

---

## Executive Summary

The MarkLogic MCP server is a well-architected, modular TypeScript project that bridges AI agents with MarkLogic databases via the Model Context Protocol. The codebase demonstrates strong engineering practices: strict TypeScript, Zod-validated configuration, comprehensive error handling with actionable hints, and safety-by-default design (readonly=true, eval=false). The project registers ~70 tools across 13 domain groups, 19 prompts, and 5 resources.

**Key strengths**: Safety gating, error messaging quality, modular tool/client separation, comprehensive INSTRUCTIONS_TEXT resource.

**Key areas for improvement**: Unused tool parameters (3 bugs), resources/prompts out of sync with tools, test coverage gaps (only 2 of 13 tool groups tested), and the Semaphore client's size/complexity.

---

## 1. Architecture Overview

### Layered Design (Good)

```
Transport (stdio | HTTP)
    ↓
MCP Server (server.ts factory)
    ↓
┌─────────────┬──────────────┬──────────────┐
│   Tools     │  Resources   │   Prompts    │
│  (13 groups)│  (5 entries) │ (19 entries) │
└──────┬──────┴──────┬───────┴──────────────┘
       ↓             ↓
   Client Layer (12 typed HTTP clients)
       ↓
   Base Client (Axios + Digest/Basic auth)
       ↓
   MarkLogic REST API / Flux Runner / Semaphore
```

The layered separation is clean. Tools never make HTTP calls directly — they delegate to typed client classes, which share a single `MarkLogicBaseClient` for authentication and error mapping. This makes the codebase testable and consistent.

### Factory Pattern (Good)

`createMcpServer()` is a pure factory: it creates clients, registers tools/resources/prompts, and returns a ready server. HTTP transport creates one server per session (SDK requirement). No global mutable state.

### Configuration (Good)

Zod schemas validate all config at startup with actionable error messages. Boolean coercion handles string env vars (`"true"` → `true`). Defaults are safe (readonly=true, eval=false, port=8000).

---

## 2. Bugs — Unused Parameters

### ~~BUG-1: `ml_timeseries_query` ignores `bucket`, `from`, `to` parameters~~ — INCORRECT, RESOLVED

This finding was incorrect at review time. The handler at `src/tools/quicksight.ts:85` correctly destructures and uses all three parameters — date-range filtering (lines 96–103) and bucketing into hour/day/week/month/quarter/year buckets (lines 107–126) are both implemented. No action required.

### BUG-2: `ml_views_list` ignores `database` parameter (MEDIUM) — FIXED

**File**: `src/tools/optic.ts:145`

The handler signature is `async () => { ... }` — it doesn't destructure the `database` parameter. The underlying `clients.schema.listViews()` is called without any database override.

**Fix**: Handler now destructures `database` and passes it to `clients.schema.listViews(database)`.

### BUG-3: `ml_vector_search` ignores `strip_schema_prefix` parameter (MEDIUM) — FIXED

**File**: `src/tools/optic.ts:118`

The Optic query call hardcoded `true` for the strip prefix argument: `clients.optic.query(plan, database, true)`. The user-supplied parameter was not referenced.

**Fix**: Now passes `strip_schema_prefix ?? true` so the default behaviour (strip) is preserved but callers can opt out.

---

## 3. Sync Issues — Instructions & Prompts vs Actual Tools

Per CLAUDE.md, `INSTRUCTIONS_TEXT` and the `problem_advisor` prompt must stay in sync with registered tools. Several discrepancies exist:

| Issue | Location | Detail |
|-------|----------|--------|
| Semaphore tool count | INSTRUCTIONS_TEXT line ~510 | Lists 12 tools; actually 14+ registered (missing: `semaphore_concept_get`, `semaphore_concept_search`, `semaphore_concept_labels_update`, `semaphore_kmm_model_delete`, `semaphore_cls_languages`, `semaphore_publish_diagnose`) |
| Graph tools | INSTRUCTIONS_TEXT | Lists 2 tools; actually 3 (`ml_graph_put` missing) |
| Document tools | INSTRUCTIONS_TEXT | `ml_document_sample` not mentioned |
| `ml_suggest_approach` | INSTRUCTIONS_TEXT | Listed under "Prompts" but is actually a tool |
| `problem_advisor` | `src/prompts/index.ts` Section 4 | Missing same tools as INSTRUCTIONS_TEXT |

---

## 4. Client Layer Review

### Base Client (`base.ts`) — Solid

- Digest auth with retry-once logic prevents infinite loops
- Error mapping extracts MarkLogic-specific codes from HTML error pages
- Separate Axios instances for REST (port 8000) and management (port 8002)

**Minor concern**: HTML error parsing uses regex (`<dt>/<dd>` extraction), which is fragile if MarkLogic changes its error page format. Consider a lightweight HTML parser if this causes maintenance issues.

### Semaphore Client (`semaphore.ts`) — Too Large (1,664 lines)

This single file handles three distinct subsystems (CLS classification, KMM taxonomy management, KMM publishing) with 25+ public methods. It includes:

- Manual cookie-based auth for KMM (JSESSIONID + API token)
- XML parsing via regex helpers (`xmlText`, `xmlAll`, `xmlAttrs`)
- Multipart form-data construction
- Async job polling with timeout
- Publisher config XML templating

**Recommendation**: Split into `semaphore-cls.ts`, `semaphore-kmm.ts`, and `semaphore-publish.ts`. The XML regex helpers should move to `utils/xml.ts`. The regex XML parsers don't handle escaped quotes in attributes — e.g., `attr="foo\"bar"` will break `/"[^"]*"/`.

### Schema Client (`schema.ts`) — Complex but Functional (684 lines)

- Hardcodes `database: "Schemas"` for TDE templates (standard MarkLogic convention, but should be configurable)
- `collectFields()` loses type precision: a field seen as `["string", "number", "string"]` becomes `"mixed"` after the second value, losing frequency info
- TDE column generation uses three skip-list arrays populated inside `.filter()` chains — hard to follow

### Other Clients — Clean

`admin.ts`, `documents.ts`, `search.ts`, `eval.ts`, `graphs.ts`, `optic.ts`, `flux.ts`, `fasttrack.ts` are well-structured with consistent patterns. Notable:

- `flux.ts` uses native `http.request()` for SSE streaming — good for avoiding pipe-buffer deadlock
- `flux.ts` builds connection strings with plain-text credentials — ensure these never reach logs
- `optic.ts` buffers all rows in memory — no streaming or cursor support for large result sets
- `graphs.ts` fetches all named graphs then slices in JS — scalability concern for large triple stores

---

## 5. Tools Layer Review

### Strengths

- **Universal Zod validation** with `.describe()` on every parameter
- **Actionable error hints**: Almost every tool appends `\nHint:` or `\nNOTE:` with the next step when a known error occurs (flux.ts is particularly good with `buildTdeNote` and `condenseWriteErrors`)
- **Prerequisites in descriptions**: Most tools document required indexes, TDE templates, or config flags
- **Safety gating**: Write tools conditionally registered (`if (!readonly)`), eval tools entirely skipped when disabled
- **No silent no-ops**: Disabled tools don't appear in the tool list at all

### Tool Description Length

Several tools embed extensive multi-section guidance in their descriptions:

- `ml_eval_javascript`: ~78 lines (tips, permissions, bulk ops, RDF, Optic gotchas)
- `flux_import`: ~100+ lines (recipes, warnings, JDBC, S3, TDE, Socrata, RDF, Semaphore)
- `ml_sparql_query`: ~48 lines (storage patterns, return formats, multi-model joins)

This is intentional and appropriate — agents need this context to use complex tools correctly. However, it increases token consumption per tool list fetch. Consider whether the longest descriptions could be shortened with references to the `marklogic://instructions` resource.

### Readonly/Eval Gating — Consistent

| Pattern | Files | Method |
|---------|-------|--------|
| Readonly write tools | documents.ts, fasttrack.ts | `if (!readonly)` at registration |
| Eval tools | eval.ts | Early return if `!allowEval` |
| Semaphore write tools | semaphore.ts | Runtime check (`!kmmConfigured`) |

The eval.ts pattern (skip registration entirely) is better than runtime checks. Consider migrating semaphore write tools to the same pattern.

---

## 6. Resources & Prompts Review

### INSTRUCTIONS_TEXT (527 lines) — Excellent

The machine-readable problem→solution map is comprehensive and well-structured:
- 10 problem-first decision principles
- 18-row problem→solution table
- URI design rules with examples
- Multi-model design patterns
- Optic vs CTS.Search selection guide
- Complete tool group inventory (needs sync fixes noted above)

### Prompts (19) — High Quality

All prompts follow a consistent numbered-section format with explicit output instructions. Standouts:
- `problem_advisor`: Structured 6-section planning template
- `flux_import` guidance embedded in tool descriptions is excellent
- Code generation prompts end with "Generate the code now." for direct usability

---

## 7. Test Coverage

### Current State

| Area | Test Files | Coverage |
|------|-----------|----------|
| Config loading & schemas | 2 files, 417 lines | Good |
| Error classes & formatting | 1 file, 137 lines | Good |
| Digest auth | 1 file, 160 lines | Good |
| Base HTTP client | 1 file, 225 lines | Good |
| Document tools | 1 file, 334 lines | Good |
| Eval tools | 1 file, 220 lines | Good |
| HTTP transport | 1 file, ~100 lines | Basic |
| **All other tools (11 groups)** | **None** | **None** |
| **All prompts (19)** | **None** | **None** |
| **All resources (5)** | **None** | **None** |
| **All clients (except base)** | **None** | **None** |

**Only 2 of 13 tool groups have tests.** The tested groups (documents, eval) demonstrate good patterns: tool registration gating, handler mocking, error condition testing. These patterns should be replicated across all tool groups.

### Priority Test Additions

1. **Search tools** — most commonly used, complex response normalization
2. **Optic tools** — confirm parameter passthrough (fixes BUG-2, BUG-3)
3. **Schema tools** — complex logic in `discoverSchema()`, TDE validation
4. **Flux tools** — SSE streaming, error condensation, TDE note generation
5. **Semaphore tools** — async job polling, XML parsing edge cases

---

## 8. Security Considerations

| Area | Status | Notes |
|------|--------|-------|
| Auth (Digest/Basic) | Good | RFC 2617 compliant, retry-once on 401 |
| Readonly gating | Good | Defaults true, conditionally registers write tools |
| Eval gating | Good | Defaults false, entirely skips registration |
| HTTP transport auth | Good | Optional Bearer token, rate limiting (500 req/min) |
| Credential logging | Caution | `flux.ts` builds `user:pass@host` connection strings — ensure no logging |
| SSL/TLS | Good | Configurable `rejectUnauthorized` for self-signed certs |
| Input validation | Good | Zod schemas on all tool parameters |
| XSS/injection | Good | No HTML rendering; tools return plain text |

---

## 9. Recommendations Summary

### Must Fix (Bugs) — all fixed 2026-03-19

1. ~~**BUG-1**: Wire `bucket`/`from`/`to` params in `ml_timeseries_query`~~ — finding was incorrect; already implemented
2. ~~**BUG-2**: Pass `database` param through in `ml_views_list`~~ — **FIXED** (`optic.ts:145`)
3. ~~**BUG-3**: Use `strip_schema_prefix` param in `ml_vector_search`~~ — **FIXED** (`optic.ts:118`)
4. ~~**ml_aggregate_query group_by stub**~~ — **FIXED**: now returns an explicit error with guidance to use `ml_optic_query` or `ml_values_query`

### Infrastructure — fixed 2026-03-19

5. ~~**CORS fully open**~~ — **FIXED**: optional `MCP_CORS_ORIGIN` env var / `config.corsOrigin`; when set, CORS is restricted to that origin
6. ~~**Session memory leak**~~ — **FIXED**: 30-minute idle TTL with 5-minute cleanup sweep via `setInterval`
7. ~~**`server.connect()` uncaught error**~~ — **FIXED**: wrapped in try/catch; returns `HTTP 500` with JSON-RPC error
8. ~~**Digest auth params type cast**~~ — **FIXED**: `Record<string, unknown>` with explicit `String(v)` coercion instead of unsafe cast

### Should Fix (Sync & Docs)

9. Update `INSTRUCTIONS_TEXT` tool inventory to match all ~70 registered tools
10. Update `problem_advisor` Section 4 tool list to match
11. Move `ml_suggest_approach` from "Prompts" to correct section in instructions

### Should Improve (Code Quality)

12. Split `semaphore.ts` client (1,664 lines) into 3 focused files
13. Extract XML regex helpers to `utils/xml.ts`; add escaped-quote handling
14. Consider streaming/pagination for `optic.ts` and `graphs.ts` large result sets
15. Sanitize credential strings in `flux.ts` connection builder

### Should Improve (Testing)

16. Add tests for search, optic, schema, flux, semaphore tool groups
17. Add prompt output validation tests
18. Add resource content tests (verify INSTRUCTIONS_TEXT contains all tool names)

### Nice to Have

19. Add response schema validation (Zod) to client API responses
20. Add request correlation IDs for debugging
21. Add batch document operations to `documents.ts` client
22. Consider shortening the longest tool descriptions with resource references
