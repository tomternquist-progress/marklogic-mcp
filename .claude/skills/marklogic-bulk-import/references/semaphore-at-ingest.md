# Classifying with Semaphore at ingest time

## Flux-first principle

Classifying during import is the preferred approach: Flux classifies every document
inline with no separate reprocess step. It works with all import subcommands, including
`import-aggregate-json-files --json-lines`.

Prefer this over `flux_reprocess` with an `xdmp.httpPost()` transform — that path can
silently no-op (see `reprocess-transforms.md`).

## Enabling it

```
flux_import(..., classify_with_semaphore=true)
```

Requires `SEMAPHORE_HOST` (and optionally `SEMAPHORE_SCS_PORT`, default 5058) in the
MCP server `.env`. The tool injects `--classifier-host`, `--classifier-port`, and
`--classifier-path /`; it adds `--classifier-http` automatically when the CLS endpoint
is plain HTTP.

Run `semaphore_status` to verify connectivity before importing.

## Scoping to specific taxonomies

Without scoping, **all active publish sets are combined**, which grows noisier as
models are added.

```
classifier_publish_sets=["iptcmediatopics","unescothesaurus"]
```

This injects `--classifier-prop publish_set_name_list=iptcmediatopics|unescothesaurus`.
Names are the lowercase model names — list them with `semaphore_publish_sets`.

Note that `classifier_path` does **not** filter results; only
`classifier_publish_sets` does.

## Output structure

Semaphore adds a nested object to each document:

```
classification.STRUCTUREDDOCUMENT.META  →  {name, value, id, score} per concept
```

- `name` — taxonomy class, e.g. `IPTCMediaTopics-http://cv.iptc.org/newscodes/mediatopic/`
- `value` — matched concept label
- `id` — concept UUID
- `score` — float 0–1

## ⚠ META is an array *or* an object

When a document yields 2+ results, `META` is a JSON array. When it yields exactly one
result (or only the Type metadata), `META` is a plain object. Always normalise:

```javascript
const meta = Array.isArray(META) ? META : [META];
```

Short records (under ~50 words) often produce only the Type metadata entry with no
taxonomy concepts. Concatenate all text fields before classifying for best results.

## TDE for classified documents

To build a view with one row per (document × category):

```
context: 'classification/STRUCTUREDDOCUMENT/META'      # iterates each tag
```

To reach the parent document's fields from inside a META element, navigate up four
levels (elem → array → SD-obj → class-obj → root):

```
parent 'id':      '../../../../id'
parent 'section': '../../../../section'
```

Direct META element fields are `name`, `value`, `id`, `score`. Declare `score` as
**float**, not string.
