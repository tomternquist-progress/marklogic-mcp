# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

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
