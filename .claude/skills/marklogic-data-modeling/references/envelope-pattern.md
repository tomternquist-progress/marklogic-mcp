# The envelope pattern

A consistent outer structure wrapping every document, separating provenance from
business data from raw source. Worth the overhead when integrating multiple source
systems, when audit trails matter, or when you expect to re-harmonize later.

## Anatomy

```json
{
  "envelope": {
    "headers": {
      "sourceDocument":   "/raw/sap/12345",
      "sourceSystem":     "SAP",
      "sourceFormat":     "json",
      "ingestTime":       "2025-01-15T09:30:00Z",
      "datahubCreatedBy": "flux-import-pipeline",
      "datahubCreatedOn": "2025-01-15T09:30:00Z",
      "id":               "12345",
      "sourceQuery":      "SELECT * FROM ORDERS",
      "permissions":      [{ "role-name": "app-user", "capabilities": ["read", "update"] }],
      "classifications":  []
    },
    "instance": {
      "order": {
        "info":       { "title": "Order", "version": "1.0.0",
                        "baseUri": "http://example.org/order/" },
        "primaryKey": "12345",
        "canonicalField1": "<mapped value>"
      }
    },
    "attachments": { "raw": "<original source document>" },
    "triples": []
  }
}
```

Optional but recommended headers:
- `sourceQuery` — the JDBC query or file path that produced the document
- `schemaVersion` — instance model version, for schema evolution
- `mergeHash` — fingerprint for mastering / dedup (DHF mastering step)

## Collections and URIs

```
<source>-raw        raw documents per source system, pre-harmonization
<domain>            all harmonized entity documents
<domain>-envelopes  optional, to scope envelope-only queries
```

```
/entities/<domain>/{sourceSystem}-{primaryKey}.json
```

e.g. `/entities/order/sap-12345.json`

Rules: include only **immutable** key fields; keep the URI prefix aligned with the
collection so `ml_document_list` can scope by directory; never embed status, owner, or
date.

## Field mapping into `instance`

- Map every source field name onto a canonical schema. Run `ml_schema_discover` on the
  source collection first to get the real field list.
- **Conflicting values across source systems** — either keep both under source-qualified
  keys, or pick a strategy: last-writer-wins, or most-trusted-source.
- **Empty strings → omit the field.** Never store `""`; it pollutes range indexes.
- **Dates → ISO-8601 strings**, matching a `dateTime` range index scalar type.

With DHF, the mapping step performs source → instance automatically from an entity model
descriptor.

## Triples in an envelope

```json
"triples": [
  { "triple": { "subject":   "http://example.org/order/12345",
                "predicate": "http://schema.org/relatedTo",
                "object":    "http://example.org/customer/67890" } },
  { "triple": { "subject":   "http://example.org/order/12345",
                "predicate": "http://schema.org/name",
                "object":    { "datatype": "http://www.w3.org/2001/XMLSchema#string",
                               "value": "Widget order" } } }
]
```

Add them when entities relate to other entities, when graph traversal is needed
alongside document search, or when Semaphore classification produces concept URIs that
should link to a taxonomy.

Same format rules as embedded triples generally: plural `"triples"`, each element
wrapped in `"triple"`, IRI objects as plain strings, literals as `{datatype, value}`,
and **never** `"sem:triples"` as the root key — that marks a managed triple document,
not an envelope.

## Ingest sequence

1. `ml_document_sample` — inspect raw source structure
2. `ml_schema_discover` — infer canonical field names and types
3. `ml_indexes_list` — check range indexes for the canonical fields
4. `flux_import` with an SJS transform mapping source → `envelope.instance`
   (`extra_args: ["--transform", "<name>"]`; deploy the transform with
   `ml_extension_put` or ml-gradle first)
5. `ml_schema_get_tde` — verify a TDE template covers `envelope.instance.*` paths
6. `ml_tde_validate` — confirm rows extract correctly
7. `ml_optic_query` — `SELECT * FROM schema.view LIMIT 5` to prove it end to end

## Auditing existing documents

Sample 3–5 documents with `ml_document_sample`, look for a top-level `envelope` key,
then check for `headers`, `instance`, `attachments`, `triples`:

| Conformance | Meaning |
|---|---|
| **Full** | all four zones present |
| **Partial** | `headers` + `instance`; `attachments` or `triples` missing |
| **Instance-only** | only `instance` under `envelope` |
| **Non-conformant** | no `envelope` key at root |

For non-conformant documents, describe what structure *is* present before proposing a
migration — the existing shape usually maps cleanly onto `instance`, with ingest
metadata reconstructable into `headers`.

## Querying envelopes

Full-text over instance fields:
```
ml_search(q="<term>", collection="<domain>")
```

Structured filter on a canonical field:
```json
{ "query": { "value-query": { "json-property": "canonicalField1", "text": ["value"] } } }
```

TDE views should target `envelope.instance.*` paths, not the envelope root — otherwise
every column needs an `envelope/instance/` prefix in its `val` expression.
