# SPARQL and triple storage in MarkLogic

`ml_sparql_query` runs SPARQL 1.1 SELECT, CONSTRUCT, ASK, and DESCRIBE against the
triple store. All three storage layouts below are queryable by the same tool.

## Return formats

- **SELECT / ASK** → SPARQL results JSON: `{ head: { vars }, results: { bindings } }`
- **CONSTRUCT / DESCRIBE** → raw Turtle text

## The three storage layouts

### 1. Embedded (unmanaged) triples

Triples live inside the source document. SPARQL finds them automatically — there is no
separate load step.

**XML** — `<sem:triple>` elements, namespace `http://marklogic.com/semantics`.

**JSON** — a `triples` array (plural key) whose elements are each wrapped in `triple`:

```json
{ "triples": [ { "triple": { "subject": "...", "predicate": "...", "object": "..." } } ] }
```

⚠ **`sem:triples` as the JSON root key creates MANAGED triples, not embedded ones.**
Different key, different semantics.

#### Object encoding rules — the silent-failure zone

| Object kind | Encoding |
|---|---|
| IRI/URI | plain string: `"http://example.org/thing"` |
| String literal | `{"datatype":"http://www.w3.org/2001/XMLSchema#string","value":"hello"}` |
| Language-tagged | `{"datatype":"http://www.w3.org/1999/02/22-rdf-syntax-ns#langString","value":"hello@en"}` |
| Typed literal | `{"datatype":"http://www.w3.org/2001/XMLSchema#integer","value":"42"}` |

⚠ **A bare string object is treated as an IRI, not a literal.** This is the most common
cause of "my triples loaded but nothing matches" — a literal written as
`"object": "hello"` becomes the IRI `hello`, and every `FILTER(?o = "hello")` misses.

MarkLogic encodes language tags by appending `@lang` to the `value` field, not as a
separate key.

### 2. Named graphs

Standalone RDF documents loaded via `flux_import(subcommand="import-rdf-files")` or
`ml_document_put`. Query with `FROM NAMED <graph-uri>`. Best for ontologies and
taxonomies.

Discover graph URIs with `ml_graphs_list` before writing the query.

### 3. Hybrid (most powerful for knowledge graphs)

The document holds entity properties; a named graph holds cross-entity relationships;
they are linked by **subject URI = document URI**. This lets you filter documents with
`cts` queries and traverse relationships with SPARQL over the same entities.

The `flux_reprocess` RDF recipe (see the marklogic-bulk-import skill) builds exactly
this shape.

## ⚠ Always add LIMIT

Omitting `LIMIT` on queries with `FILTER` or broad patterns can return thousands of
rows. Cross-graph joins — two or more `GRAPH <uri>` clauses — are especially prone to
cartesian explosions when predicate patterns overlap.

```sparql
SELECT ... WHERE { GRAPH <g1> { ... } GRAPH <g2> { ... } } LIMIT 100
```

## Debugging empty SPARQL results after installing a TDE

TDE templates can extract triples from documents. If SPARQL returns nothing after
installing a template with a `triples` section, check all four of these before
concluding the query is wrong:

**1. Is the triple index on?**
```javascript
xdmp.databaseTripleIndex(xdmp.database())   // via ml_eval_javascript
```
If `false`: Admin UI → Databases → `<db>` → `triple-index=true` → OK.

**2. Is a reindex still running?**
TDE triple extraction requires a full reindex after the template is installed. Check
`ml_reindex_status` and wait for completion.

**3. Is the triple syntax right?**
Triple subject/predicate/object must use `{"val": "<XPath-expr>"}`. Using
`{"column": "<name>"}` in a triples section **installs silently but extracts nothing**.

**4. Are there any triples at all?**
```sparql
SELECT * WHERE { ?s ?p ?o } LIMIT 10
```
An empty result confirms nothing has been materialised — an index or reindex problem,
not a query problem.

## Writing triples

- `ml_graph_put` — small RDF string (< ~1 MB) into a named graph
- `flux_import(subcommand="import-rdf-files")` — bulk RDF files (Turtle, N-Triples,
  JSON-LD, RDF/XML), with `extra_args: ["--graph","<uri>"]`
- `ml_sparql` (eval-gated) — SPARQL UPDATE
