# Structured query cookbook

MarkLogic REST `search:query` JSON, as accepted by `ml_search`'s `structured_query`
parameter. Everything goes under a top-level `query` key.

## String vs structured — pick correctly

| Form | Behaviour | Range index? |
|---|---|---|
| `q='hurricane'` | universal-index word match anywhere in the document | no |
| `value-query` on a property | exact match scoped to that field | **no** |
| `word-query` on a property | tokenised free text scoped to that field | no |
| `range-query` | comparison (`GE`, `LT`, …) | **yes** |

A bare `q='Hurricane'` is convenient but over-matches — it pulls any document
mentioning the word in *any* field. For field-scoped exact matching, always prefer a
structured `value-query`.

## Recipes

**Exact value on a JSON property** (no range index needed):
```json
{ "query": { "value-query": { "json-property": "incidentType", "text": ["Hurricane"] } } }
```

**Exact value on an XML element:**
```json
{ "query": { "value-query": { "element": { "ns": "", "name": "state" }, "text": ["TX"] } } }
```

**Exact value on a server-defined field:**
```json
{ "query": { "value-query": { "field": { "name": "titleField" }, "text": ["Helene"] } } }
```

**Tokenised free text in one JSON property:**
```json
{ "query": { "word-query": { "json-property": "description", "text": ["hurricane"] } } }
```

**Multi-value OR** — matches any listed value:
```json
{ "query": { "value-query": { "json-property": "incidentType",
                              "text": ["Hurricane","Tornado","Flood"] } } }
```

**Range comparison** — requires a range index on the bound field:
```json
{ "query": { "range-query": { "json-property": "fyDeclared", "value": ["2024"],
                              "range-operator": "GE", "range-option": ["cached"] } } }
```

**Collection / directory scoping** — usually the cheapest narrowing available:
```json
{ "query": { "collection-query": { "uri": ["fema-disasters"] } } }
{ "query": { "directory-query": { "uri": ["/insurance/fema-disasters/"], "infinite": true } } }
```

**Combining clauses:**
```json
{ "query": { "and-query": { "queries": [
    { "value-query": { "json-property": "incidentType", "text": ["Hurricane"] } },
    { "value-query": { "json-property": "state",        "text": ["FL"] } }
] } } }
```

**Negation:**
```json
{ "query": { "not-query": { "value-query": { "json-property": "state", "text": ["PR"] } } } }
```

## Projection and inline aggregation

`ml_search` can return field values directly, avoiding follow-up `ml_document_get` calls.

- `select_fields=['declarationTitle','incidentType','state']` — project those fields into
  each result row. Paths support dot navigation (`envelope.instance.id`) and a leading
  `*` for recursive search at any depth (`*.declarationTitle`).
- `distinct='declarationTitle'` — one row per distinct value with its document count.
- `group_by='incidentType'` + `count=true` — frequency table over matched documents.
- `normalize_whitespace=true` — collapse whitespace runs before grouping or projection.
- `response_mode='inline_summary'` (default) — keeps chat-scale answers inline.

Server-side snippets via the `options` parameter still work, but `select_fields` is
preferred for ad-hoc questions because it needs no pre-deployed search-options node.

## Choosing projection vs a dedicated tool

- One-off field extraction alongside results → `select_fields`
- Distinct values / counts as the *primary* answer → `ml_values_query` (needs a range
  index, but is far cheaper than paging)
- Facet counts beside results → `ml_facets_query`
- GROUP BY across joined entities → `ml_optic_query` over a TDE view
