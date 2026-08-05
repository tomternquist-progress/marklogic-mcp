# Natural language → MarkLogic query

The pipeline: **`ml_search_surface` → write a string-grammar query → `ml_parse_query`
to validate → `ml_search` to execute.**

Never skip the surface call. Without it you are guessing field names, and a wrong field
name produces empty results rather than an error.

## 1. Extract intent

For each searchable concept in the question, classify it:

| Concept | Kind | Field |
|---|---|---|
| "diabetes mentioned" | TEXT | (universal index) |
| "location is Texas" | FIELD-EQUALITY | `state` |
| "age over 65" | RANGE | `age` |
| "not in Puerto Rico" | NEGATION | `state` |

Then map each to a real field from the surface's `inferredFields` / `rangeIndexes`.
**Do not invent fields that are not in the surface.**

## 2. String grammar

- **Barewords** hit the universal index — use them for genuine free-text concepts only.
- **Phrases** in double quotes: `"type 2 diabetes"`
- **Booleans**: `AND`, `OR`, `NOT`, `NEAR/k`
- **Grouping**: `( … )`
- **Negation**: `-` prefix or `NOT`
- **Tagged constraints**, only for fields in `suggestedBindings`:
  ```
  importedAt:2026-01-01        equality via a range index reference
  age >= 65                    range; < <= = != > >= or LT LE EQ NE GE GT
  enrolledOn GE 2024-01-01     dateTime binding; date strings auto-coerce
  ```

### Strict grammar rules (cts.parse rejects otherwise)

- Comparison operators need **spaces on both sides**: `age >= 65`, never `age:>=65`.
- `age:GE:65` is invalid — `XDMP-UNEXPECTED`.
- The **only** legal colon is the equality delimiter in `tag:value`.

### The trap: fields without a range index

`cts.parse` requires a range index for **every** tag. For a field in
`valueQueryableFields` / `wordQueryableFields` with no range index:

- **Do not tag it** — `cts.parse` will reject the query.
- **Do not fall back to a bareword either** — a bareword matches anywhere in the
  document, so "state is TX" would also match a document merely mentioning TX in prose.

Instead, capture that constraint as a structured query and AND it with the parsed string
query:

```json
{ "and-query": { "queries": [
    <parsed string query>,
    { "value-query": { "json-property": "state", "text": ["TX"] } }
] } }
```

Use barewords only for concepts the user did not pin to a specific field.

## 3. When to skip the string grammar entirely

Go straight to a structured query when the question needs:

- geospatial regions
- nested boolean precedence beyond simple grouping
- custom collection or directory scoping
- a WHERE-NOT pattern with multiple range constraints

Recipes are in `structured-query-cookbook.md`.

## 4. Bindings

The minimum `bindings` map so every tag resolves. Pull entries from the surface's
`suggestedBindings`:

```json
{
  "state": { "type": "json-property",       "name": "state" },
  "age":   { "type": "json-property-range", "name": "age", "scalar_type": "int" }
}
```

No tags in the query → no bindings needed.

## 5. Validate, then execute

```
ml_parse_query  qtext="<query>"  bindings=<from step 4>
ml_search       q="<query>"  [collection="…"]  [options="…"]
```

If an options set is in play, prefer tag syntax for any field that set binds.

## 6. State your assumptions

Every translation makes assumptions worth surfacing concretely:

- "Assumed `state` is a top-level JSON property — verify with `ml_schema_discover` if
  results are empty."
- "No range index on `age` in the surface — the range tag may fall back to filtered
  evaluation; consider adding one."
- "User said *recently* — interpreted as the last 90 days; confirm the window."

Reference actual field names from the surface. Vague hedging is not useful; a specific,
checkable assumption is.
