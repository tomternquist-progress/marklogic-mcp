# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Security

- **Semaphore write tools now respect `ML_READONLY`** (`src/tools/semaphore.ts`,
  `src/tools/index.ts`)
  `registerSemaphoreTools()` never received the readonly flag, so all 10 Semaphore
  write tools stayed callable under `ML_READONLY=true` — including
  `semaphore_kmm_model_delete` (irreversible model deletion) and
  `semaphore_kmm_sparql_update` (arbitrary `INSERT`/`DELETE`/`CLEAR` on a model graph),
  plus `semaphore_publish`, `semaphore_kmm_model_create`, `semaphore_kmm_skos_load`,
  `semaphore_task_create`, `semaphore_task_commit`, `semaphore_concept_labels_update`,
  `semaphore_kid_template_set`, and `semaphore_publish_config_fix_plain_skos`.
  Every other write-capable tool group was already gated, and the startup security
  posture reported "tool-layer writes are blocked" while these were live.
  Each write handler now refuses with the structured `UNSUPPORTED_IN_BUILD` /
  `runtime_capability` envelope (`refuseSemaphoreWrite()`), matching the `flux.ts`
  pattern. Read-only Semaphore tools are unaffected. Covered by
  `tests/tools/security-gating.test.ts`.

### Fixed

- **`ml_answer_query` free-text rescue could never fire** (`src/tools/answer.ts`)
  Rescue Layer 3 re-sent the structured filter alongside the free-text `q`. The REST
  API ANDs the two, so re-sending a filter that had just matched zero documents
  guaranteed zero again — the layer was unreachable by construction, not merely
  rarely hit. It now drops the filter, clears `trace.cts`, sets
  `ctsKind: "free-text"`, and records an assumption that the returned rows are no
  longer field-scoped. `next_actions` is built from the query that actually ran, so
  "Run this query as-is" reproduces the rows shown. Covered by
  `tests/tools/answer-rescue.test.ts`.

- **HTTP transport disabled the MCP SDK's session teardown**
  (`src/transport/http.ts`)
  Assigning `transport.onclose` after `server.connect()` overwrote the handler the
  SDK installs there, so `Protocol._onclose` — which aborts in-flight request
  handlers and clears the pending-response maps — never ran. TTL eviction or a
  client `DELETE` mid-request left long tool calls (Flux jobs, large Optic queries)
  running with no cancellation path. New exported `chainOnClose()` preserves and
  chains the SDK handler. Covered by `tests/transport/http.test.ts`.

- **`top_n_by_field` recipe emitted an invocation `ml_search` rejects**
  (`src/utils/recipes.ts`)
  It defaulted `page_length` to 500 against `ml_search`'s
  `.max(200)` schema, so the "fully-formed invocation" the recipe hands back failed
  validation as soon as an agent ran it. Executing in-process masked this because
  `executeRecipe` calls the client directly. All five recipes now clamp via
  `clampPageLength()` / exported `MAX_SEARCH_PAGE_LENGTH`, including
  caller-supplied `limit` / `sample_size`, with explanations rendered from the
  clamped value. Covered by `tests/utils/recipes.test.ts`.

- **Flux SSE requests had no timeout** (`src/client/flux.ts`)
  `runStream()` uses raw `http.request`, which does not inherit the Axios instance's
  35-minute timeout — that applied only to the legacy `/run` fallback and `/upload`.
  An unresponsive runner hung the request and the MCP tool call behind it
  indefinitely. Both transports now share `FLUX_RUN_TIMEOUT_MS`, with an actionable
  timeout message pointing at `flux_status`.

- **Capability manifest contradicted the code** (`src/utils/capabilities.ts`)
  `ml_answer_query.rows_unique_by` was documented as falling back to "a preset by
  collection". No such preset exists — omitting it returns `MISSING_PARAMETER`. The
  entry now matches the tool's actual contract.

### Added

- **`semaphore_publish_diagnose` tool** (`src/tools/semaphore.ts`, `src/client/semaphore.ts`)
  Triangulates KMM concept count (OE API), labeled English concept count (SPARQL with GRAPH
  clause), and CLS estimated rule count to identify the root cause of publish failures.
  Primary diagnostic: distinguishes "no concepts loaded", "labels not found", and "GRAPH
  clause missing" failure modes. Outputs a human-readable root-cause explanation and fix.

- **`kmmConceptCount(modelUri)` client method** (`src/client/semaphore.ts`)
  Public method querying the OE API for `skos:Concept` instance count in a model.
  Used by `semaphore_publish_diagnose` to compare concept count against CLS rule count.

- **`clsRuleCount(publishSetName)` client method** (`src/client/semaphore.ts`)
  Fetches the CLS `/rulenetview.html` page and parses the pak file size as a proxy for
  rule count (CLS does not expose a direct rule-count API). Size < 5 KB → 1 rule (failure
  mode); ≥ 5 KB → estimates ~200 bytes/rule.

### Fixed

- **Publisher SPARQL queries missing `GRAPH` clause** (`src/client/semaphore.ts`)
  Root cause of the "only 1 CLS rule published" silent failure for all SKOS vocabularies:
  the publisher's `SparqlEndpoint` connects to a global SPARQL endpoint shared across all
  models. Each model's data lives in a named graph `urn:x-evn-master:{ModelName}`, not the
  default graph. Without an explicit `GRAPH` clause, all label queries return 0 rows and
  the publisher generates only the auto-produced ConceptScheme root rule.
  `PLAIN_SKOS_PUBLISHER_XML_TEMPLATE` updated to wrap all `WHERE {}` clauses with
  `GRAPH <urn:x-evn-master:{{MODEL_NAME}}> { ... }`. IPTC Media Topics went from 1 rule
  to 1,391 rules after this fix.

- **`listKmmModels()` returning empty array** (`src/client/semaphore.ts`)
  The `sys:Model/rdf:instance` endpoint returns model IDs with a `.tch` suffix
  (e.g. `model:IPTCMediaTopics.tch`). The previous filter discarded these, returning
  nothing. Fixed to strip the `.tch` suffix with `.replace(/\.tch$/, "")`.

- **Workspace config endpoint double-slash URL** (`src/client/semaphore.ts`, comments)
  An earlier note documented the workspace API as `/kmm/api//{encodedUri}/...` (double
  slash). The correct URL is `/kmm/api/publisher/workspace/{encodedUri}/config` (single
  slash). The double-slash form returns HTTP 400 "invalid uris: publisher".

- **Publisher workspace initialisation — no Studio UI required** (`src/client/semaphore.ts`)
  Previous belief: the Studio Publisher tab must be opened once per model to create the
  workspace ZIP on the publisher service filesystem (HTTP 403 otherwise).
  Verified: triggering any publish via the REST API creates the workspace as a side effect,
  even for an empty model, completing in < 2 s. `kmmPatchPublishConfigForPlainSkos()` now
  auto-bootstraps the workspace by running an initial publish when GET returns 404, then
  downloads the freshly created ZIP, applies the plain-SKOS patch, and re-uploads.

- **Publisher environment discovery for new models** (`src/client/semaphore.ts`)
  Previous approach: query `sempubpermissions:ClassificationServerEnvironment/rdf:instance`
  for a global list of environments. This graph does not exist in Semaphore 5.10.1.
  Environments are stored per-model in `sys/{modelUri}/user:{username}` →
  `sempubpermissions:publishMaster` when Studio first publishes a model.
  `kmmPublish()` now falls back to scanning all other models' sys records to find an
  existing environment URI and JSON-Patch-assigns it to the new model automatically.
  One-time global prerequisite: at least one model must have been published via Studio once.

### Changed

- **`semaphore_publish` prerequisites** (`src/tools/semaphore.ts`)
  Removed "open Studio Publisher tab" as a required manual step. Updated to document that
  workspace initialisation is automatic on first publish, and environment is auto-discovered
  from sibling models.

- **`semaphore_publish_config_fix_plain_skos` prerequisites** (`src/tools/semaphore.ts`)
  Removed Studio URL prerequisite. Updated to state that workspace bootstrapping is
  automatic (no Studio interaction needed).

- **`semaphore_publish` auto-warns on 1-rule result** (`src/tools/semaphore.ts`)
  After `wait_for_completion=true` + COMPLETE status, the tool now checks the CLS rule
  count and emits a warning with the root cause (missing GRAPH clause) and fix command
  if the count is ≤ 1.

- **`suggest-approach.ts` taxonomy pipeline** (`src/tools/suggest-approach.ts`)
  Reduced from 8 steps to 5: removed manual `step4_init_workspace` (Studio Publisher tab),
  renumbered remaining steps. Updated rationale and warnings to reflect fully programmatic
  workflow. Added one-time global setup note for CLS environment config.

- **`kmmPatchPublishConfigForPlainSkos` detection logic** (`src/client/semaphore.ts`)
  Changed "already patched?" detection from checking for `LANGMATCHES` to checking for the
  `urn:x-evn-master:` graph URI — more precise and catches partially-patched configs.

- **`semaphore_publish_config_fix_plain_skos` description** (`src/tools/semaphore.ts`)
  Rewritten to explain the GRAPH clause root cause (global SPARQL endpoint / named graph
  isolation) rather than the previously described SKOS-XL vs plain-SKOS framing. The GRAPH
  clause fix affects ALL label queries regardless of SKOS flavour.

- **`semaphore_kmm_sparql_update` tool** (`src/tools/semaphore.ts`, `src/client/semaphore.ts`)
  New tool for running SPARQL UPDATE (INSERT DATA / DELETE DATA / DELETE+INSERT / LOAD)
  against a KMM model graph. Always passes `checkConstraints=false&runEditRules=false` to
  bypass Semaphore SHACL validation. Primary use case: adding `sem:guid` to every
  `skos:Concept` before publishing (required by the `ContextualCitation.kid` template).

- **`semaphore_publish` tool** (`src/tools/semaphore.ts`, `src/client/semaphore.ts`)
  Triggers a KMM publisher run via the REST API (`POST /kmm/api?path=publisher/...`),
  replacing the previous requirement to use the Studio UI. Defaults to `async=true`
  because synchronous publish times out for models with more than a few hundred concepts.
  Returns the job ID for status polling. Supports `config`, `environment`, and `language`
  parameters.

- **`semaphore_publish_config_fix_plain_skos` tool** (`src/tools/semaphore.ts`, `src/client/semaphore.ts`)
  Automates the publisher config patch required for plain-SKOS vocabularies (UNESCO
  Thesaurus, EuroVoc, AGROVOC, and any vocabulary using `skos:prefLabel` literals rather
  than SKOS-XL reification). Downloads the workspace config ZIP from the KMM workspace
  API, replaces `AllResources` with `AllConcepts` (to generate one CLS rule per
  `skos:Concept` instead of only a ConceptScheme-level rule), adds a `PlainSkosModel`
  Spring bean that overrides `getPrefLabelsSparql` and `getAltLabelsForwardSparql` for
  plain label lookup, ensures `templates/ContextualCitation.kid` is present, and
  re-uploads the patched ZIP. Idempotent — no-ops if the config is already patched.
  Uses `jszip` for in-memory ZIP editing (new dependency).

- **`kmmSparqlUpdate`, `kmmPublish`, `kmmPublishJobStatus`, `kmmDownloadPublishConfigZip`,
  `kmmUploadPublishConfigZip`, `kmmPatchPublishConfigForPlainSkos` client methods**
  (`src/client/semaphore.ts`). Backing implementation for the three new tools above.
  `kmmUploadPublishConfigZip` uses Node.js 20 built-in `FormData`/`Blob` globals for
  multipart upload. The workspace API path requires a double-slash (`/kmm/api//...`);
  this is encoded in the client implementation.

- **`PLAIN_SKOS_PUBLISHER_XML` and `CONTEXTUAL_CITATION_TEMPLATE` constants**
  (`src/client/semaphore.ts`). Canonical publisher XML with `AllConcepts` +
  `PlainSkosModel` bean, and the default `ContextualCitation.kid` rule template.
  Embedded in the client so `semaphore_publish_config_fix_plain_skos` can create
  a fresh config ZIP without requiring the user to supply these files.

- **`jszip` dependency** (`package.json`). Used by `kmmPatchPublishConfigForPlainSkos`
  for in-memory ZIP read/write.

### Changed

- **`semaphore_kmm_model_create` NEXT STEPS** (`src/tools/semaphore.ts`)
  Updated to include the full 7-step workflow: load SKOS → verify concepts → add
  `sem:guid` → fix plain SKOS config → publish → verify rules → test classification.
  Replaced "Open Semaphore Studio UI" with API-based tool calls.

- **`semaphore_kmm_skos_load` NEXT STEPS** (`src/tools/semaphore.ts`)
  Same 7-step workflow added, including the `sem:guid` SPARQL INSERT snippet and
  the `semaphore_publish_config_fix_plain_skos` + `semaphore_publish` steps.

### Fixed

- **`ml_sparql_query` HTTP 406 on CONSTRUCT/DESCRIBE** (`src/client/graphs.ts`)
  The client always sent `Accept: application/sparql-results+json`. MarkLogic
  correctly rejects that header for CONSTRUCT and DESCRIBE queries, which return
  RDF (Turtle), not SPARQL results JSON. Added `detectSparqlQueryType()` which
  strips PREFIX/BASE declarations and line comments, then inspects the leading
  keyword. CONSTRUCT/DESCRIBE now receive `Accept: text/turtle` and
  `responseType: 'text'`; the tool handler returns raw Turtle text rather than
  attempting `JSON.stringify`. SELECT and ASK behaviour is unchanged.

- **`ml_eval_javascript` Optic `plan` variable name conflict** (`src/tools/eval.ts`)
  The description's own example used `Array.from(plan.result())`. Naming a local
  variable `plan` in an SJS eval crashes with `ReferenceError: plan is not
  defined in /MarkLogic/optic/optic-amped.sjs` because the Optic module uses
  `plan` as an internal identifier. Updated the example to use `q.result()` and
  added an explicit warning bullet: *do NOT name your Optic plan variable `plan`*.

### Changed

- **`ml_graphs_list` SPARQL query** (`src/client/graphs.ts`)
  Replaced `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }` with the
  SPARQL 1.1 empty-body form `SELECT DISTINCT ?g WHERE { GRAPH ?g { } }`.
  The old pattern performs a full triple scan (O(triples)) and timed out on
  triple stores with tens of thousands of triples. The empty graph body pattern
  matches any named graph without materialising its content, allowing MarkLogic
  to use its internal graph index.

- **`ml_sparql_query` tool description** (`src/tools/graphs.ts`)
  Added a `RETURN FORMAT` section documenting that SELECT/ASK return
  `{ head: { vars }, results: { bindings } }` JSON and CONSTRUCT/DESCRIBE
  return raw Turtle text. Removes the previous silent 406 failure mode.

---

## Earlier changes (pre-changelog)

### Added

- `ml_graph_put` tool — load Turtle, N-Triples, JSON-LD, or RDF/XML into a
  named graph via `PUT /v1/graphs`. Previously required raw curl or an external
  HTTP call. (`src/client/graphs.ts`, `src/tools/graphs.ts`)

- `ml_geospatial_search` tool — geospatial bounding-box and radius queries via
  `cts.geospatialQuery`; surfaces geospatial indexes in `ml_indexes_list`.

- `import-rdf-files` subcommand added to `flux_import` enum — valid Flux
  subcommand that was previously missing from the MCP tool's schema.

### Fixed

- **Empty-string values in RDF entity documents** — absent RDF predicates now
  omit the field entirely rather than writing `""`, preventing TDE columns from
  indexing blank strings.

- **Four RDF/Optic gaps** (`ml_eval_javascript`, `ml_sparql_query` descriptions)
  - `sem.rdfGet()` does not exist in SJS (XQuery only) — documented with
    workarounds (`xdmp.httpGet` + `sem.rdfParse` + `sem.rdfStore`).
  - Optic `fromView` + `fromSPARQL` join column-naming rules documented:
    `p.schemaCol()` required on view side; SPARQL BIND columns are unqualified;
    IRI-type mismatch — use `BIND(STR(?iriVar) AS ?strVar)` to join against TDE
    string columns.
  - `xdmp.invoke()` transaction isolation requirement documented.

### Changed

- **`flux_reprocess` two-phase pattern enforced** — documentation and description
  updated to require a reader + transform module pair for at-scale reprocessing,
  preventing 500 errors from combining `declareUpdate()` with `cts.search()` in
  a single eval transaction.

- **`vars` parameter format** — MarkLogic `/v1/eval` expects `vars={"k":v}`
  (single JSON object), not PHP-style bracket notation. Fixed in `findTdesByCollection`
  and `validateTde`.
