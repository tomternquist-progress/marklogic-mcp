# Architecture & Code Review — marklogic-mcp

**Date**: 2026-03-18
**Scope**: Full codebase review (~20,900 lines TypeScript across 30+ source files)

---

## Addendum — 2026-06-10 Review Pass

Full architecture and code review (~22,850 lines across `src/`, plus tests, config,
Docker, and the flux-runner sidecar). Baseline at review time: **build clean, lint
clean, 792 tests passing across 40 unit-test files** (plus 36 live-integration files
that skip without `ML_HOST`).

Overall assessment: the architecture remains sound and has improved since the
2026-05-30 pass. The layering (transport → server factory → tools/resources/prompts →
typed clients → base client) is consistently respected; per-session server instances
keep HTTP transport state isolated; readonly/eval gating is uniform, including the
`effectiveAllowEval = allowEval && !readonly` belt-and-suspenders in
`src/tools/index.ts` and startup security-posture warnings. A parameter-by-parameter
sweep of every tool handler found **zero unused Zod parameters** — the bug class that
produced BUG-2/BUG-3 in earlier passes appears to be eliminated, and per-group unit
tests now guard it.

### Confirmed bugs

1. **`time_bounded_events` recipe builds a structured query that cannot work**
   (`src/utils/recipes.ts:98-110`, reachable via the registered `ml_query_recipe`
   tool in `src/tools/answer.ts:780`). Two independent problems:
   - It emits a `range-constraint-query` whose `constraint-name` is the raw date
     field name. `range-constraint-query` resolves against a **named constraint
     defined in search options**; `ml_search` does not define one, so the query
     fails (or silently matches nothing) unless the user happens to have matching
     named options — contradicting the recipe's "fully-formed invocation" contract.
   - Even with a valid constraint, a single `"range-operator": "GE"` over
     `value: [start_date, end_date]` ORs the two values — it never applies the
     upper bound. A date range needs an `and-query` of two range queries
     (`GE start` and `LE end`).
   **Severity: medium-high** (user-facing recipe produces a broken query).
   Fix: build an `and-query` of two `range-query`/`element-range-query` clauses, or
   route this recipe through `ml_optic_query`; add a unit test that asserts the
   generated structured-query shape.

2. **Wrong escaping for XQuery string literals in `getForestCounts`**
   (`src/client/performance.ts:76`). `forestName.replace(/"/g, '\\"')` assumes
   backslash escaping, but XQuery escapes a quote inside a string literal by
   **doubling it** (`""`). A forest name containing `"` therefore produces a
   malformed (and technically injectable) query rather than an escaped one.
   **Severity: low** (eval-gated; forest names rarely contain quotes) but the
   escape is semantically wrong. Fix: `replace(/"/g, '""')`, or pass the name via
   `/v1/eval` external variables instead of interpolation.

### Security & hardening (no exploitable issue in the default compose topology)

3. **Flux credential handling** (`src/client/flux.ts:48-51`,
   `src/tools/flux.ts:277,561,600,744,838`, `flux-runner/FluxServer.java:44-53`):
   `connectionString()` embeds `user:password@host:port/db`; it is sent as JSON over
   plain HTTP to the flux-runner, where it becomes a CLI argv element via
   `ProcessBuilder` — visible to `ps` inside the runner container and potentially
   echoed back in Flux error output (which is returned in tool results). The runner
   itself exposes `/run`, `/run-stream`, and `/upload` with **no authentication**:
   anything that can reach the runner port can execute arbitrary Flux jobs against
   arbitrary connection strings and write files into the container. This is
   acceptable on an isolated compose network (and `ProcessBuilder` with a `List`
   argv means there is no shell-injection vector), but it should be hardened for
   any shared network: add a shared-secret header check to the runner, never
   publish its port, and consider redacting `--connection-string` values from any
   echoed argv in error paths. Also note: a password containing `@`, `:`, or `/`
   will garble the connection string — there is no escaping or validation.

4. **MCP Dockerfile runs as root and has no HEALTHCHECK** (`Dockerfile`). The
   flux-runner image has a healthcheck; the MCP image does not, and neither sets a
   non-root `USER`. Severity: medium for container best practice.

5. **Semaphore client interpolation robustness** (`src/client/semaphore.ts`):
   `postXmlOp()` (line ~2006) interpolates `op`/`publishSet` into XML without
   escaping (all current call sites pass hardcoded or server-derived values, so not
   exploitable today); multipart `Content-Disposition` filenames are unescaped and
   the boundary derives from `Date.now()` (line ~330) — use a crypto-random
   boundary and escape quotes in filenames. Severity: low; cheap to harden.

### Documentation drift — the CLAUDE.md sync mandate is not being met

6. The codebase now registers **108 tools**, but `INSTRUCTIONS_TEXT`
   (`src/resources/index.ts`) mentions only ~88 and the `problem_advisor` prompt's
   Section 4 lists ~87. Missing from both, among others: `ml_suggest`,
   `semaphore_classify_batch`, `semaphore_kid_template_get/set/diagnose`,
   `semaphore_task_create/list/commit`; additionally missing from `problem_advisor`:
   `ml_export_tabular` and `dhf_flow_run_jar`. The Semaphore group count annotation
   "(27)" is stale. No references to nonexistent tools were found (no typos —
   purely additive drift). **Recommendation**: beyond updating the two artifacts,
   add a unit test that extracts registered tool names (the de-facto list already
   exists in test helpers) and asserts each appears in `INSTRUCTIONS_TEXT` and the
   `problem_advisor` text — this drift has now recurred across three review passes
   and only a test will stop it.

### Test & config gaps (minor)

7. Coverage is now strong across all 18+ tool groups (792 unit tests, behavior-
   driven, no tautological tests found in spot-checks), with two remaining holes:
   **`src/prompts/index.ts` and `src/resources/index.ts` have zero tests** — which
   is exactly where the sync drift in item 6 lives.
8. Config validation gaps that surface only at runtime: Semaphore
   username/password accepted without a host; DHF staging/jobs port relationship
   unvalidated (`src/config/schema.ts`). Severity: very low.

### Verified non-issues (checked and confirmed correct)

- Digest auth (`src/utils/digest.ts`) is RFC 2617-compliant (qop/nc/cnonce quoting).
- KMM token refresh single-flight guard (added 2026-05-30) is correct; failed
  refreshes do not poison subsequent attempts.
- HTTP transport session handling: token-binding (SHA-256) is enforced on POST,
  GET/SSE, and DELETE; idle TTL eviction works; unknown session IDs get an
  actionable 404. Rate limiting and optional CORS restriction are in place.
- No committed secrets; `.env` is gitignored; README claims match the codebase.
- Tools layer: all write tools readonly-gated at registration; all eval tools
  skip registration when disabled; every handler wraps client calls in try/catch
  with the standard `toToolError` envelope.

### Structural observations (unchanged recommendations)

- Size hotspots persist: `src/tools/semaphore.ts` (3,273 lines),
  `src/prompts/index.ts` (3,127), `src/client/semaphore.ts` (2,022). The
  2026-03-18 recommendation to split the Semaphore client into CLS / KMM /
  publishing modules remains open and remains the right call.
- `src/utils/eval-lint.ts` regexes don't handle nested parentheses
  (false negatives only — advisory lint, acceptable).
- `src/utils/security-posture.ts` admin-username regex is exact-match only
  (`admin|root|superuser|sysadmin`) and misses e.g. "Administrator" — acceptable
  for a documented best-effort heuristic.

---

## Addendum — 2026-05-30 Review Pass

A follow-up correctness review (~22,900 lines) found and fixed the following.
Baseline before the pass: build clean, lint reporting 5 warnings, 788 tests passing.
After: build clean, **0 lint warnings, 792 tests passing**.

### Bugs fixed

1. **`ml_vector_search` ignored `strip_schema_prefix` (regression).** Section 2 / item 3
   above marked this "FIXED" on 2026-03-19, but the handler at `src/tools/optic.ts:110`
   had regressed: the parameter was declared in the Zod schema but not destructured, and
   the call to `clients.optic.query(plan, database, true)` hardcoded `true`. Callers could
   not opt out of prefix stripping. **Fixed**: the handler now destructures the parameter
   and passes `strip_schema_prefix ?? true`. A regression test that supplies `false`
   (`tests/tools/optic.test.ts`) now guards it — the pre-existing default-case test passed
   even while the bug was live, which is how the regression slipped through.

2. **KMM token refresh had no single-flight guard (concurrency).** `SemaphoreClient.kmmApiKey()`
   (`src/client/semaphore.ts`) performed a full two-step form login + token exchange per
   call when the cache was cold. Concurrent Semaphore tool calls at startup each triggered
   a redundant login. **Fixed**: refresh logic extracted to `refreshKmmToken()` behind a
   single-flight promise (`kmmTokenRefresh`), cleared in `finally` so a failed refresh does
   not poison later attempts. Token expiry is now anchored to refresh-completion time.
   Covered by `tests/client/semaphore-token.test.ts` (nock-based: 3 concurrent calls → 1 login).

### Cleanups

3. **Removed a redundant SPARQL round-trip** in `semaphore_taxonomy_validate`
   (`src/tools/semaphore.ts`): the depth-1 query was identical to the already-computed
   `topConcepts` query; its result (`d1`) was never used in the report.
4. **Removed dead code** flagged by lint: stale `renderSecurityPosture` import in
   `src/index.ts`, and unused `extractMgmtNumber` / `extractNumber` functions and a
   `resultCount` variable in `src/tools/performance.ts`.

### Investigated, not bugs (rejected findings)

- **`ml_document_sample` default `count`** — a destructuring default (`count = 3`) does
  fire on `undefined`, which is exactly what Zod `.optional()` passes; behaviour is correct.
- **XML attribute regex "escaped quote" handling** in `src/client/semaphore.ts` — valid XML
  encodes quotes as `&quot;` entities, not backslash escapes, so the existing regex is
  correct for well-formed input; the proposed `\"` handling would be semantically wrong.

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
