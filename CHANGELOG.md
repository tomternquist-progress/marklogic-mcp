# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added

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
