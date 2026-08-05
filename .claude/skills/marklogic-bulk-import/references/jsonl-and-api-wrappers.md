# JSONL and nested API wrappers

## The wrapper problem

Many REST APIs return records inside a wrapper object:

```json
{ "results": [ {...}, {...} ], "count": 10000 }
```

Federal Register, openFDA, and the GitHub API all do this.
`import-aggregate-json-files` treats **the entire wrapper as one record**. The
consequence is not an error — it is a silent malformation: `uri_template` variables
such as `{document_number}` resolve to `null`, producing URIs like `/data/null.json`,
and you end up with a single document instead of ten thousand.

### Symptom checklist

- Import reports success but the collection holds 1 document (or a handful).
- URIs contain `null`, or all collide on one path.
- `ml_document_get` on the imported URI returns the whole API envelope.

### Workarounds, in order of preference

**1. Pre-process to JSONL (best for any size).**
```bash
python3 -c "import json,sys; [print(json.dumps(r)) for r in json.load(sys.stdin)['results']]" \
  < wrapper.json > records.jsonl
```
Then import with:
```
subcommand="import-aggregate-json-files", path="/tmp/records.jsonl",
extra_args=["--json-lines"], uri_template="/data/{id}.json", collections=["my-data"]
```
Adjust `['results']` to whatever key holds the array.

**2. `ml_eval_javascript` with `vars`** — viable under roughly 500 records; subject to
the ~10 KB payload cap, so pass data in batches.

**3. Paginate the API** so each page returns a flat array rather than a wrapper. Only
works if the API supports it.

## JSONL essentials

JSON Lines — one complete JSON object per line, no enclosing array, no commas between
lines — is the format most Python scripts produce when fetching API data.

- Always `import-aggregate-json-files` **plus** `extra_args: ["--json-lines"]`.
- Never `import-files`: it treats each line as a separate *file path*, not a record.
- Pair with `uri_template` referencing a field present on every record. A field missing
  from even a few records yields `null` in those URIs.

## Serving a local JSONL file

The runner cannot reliably see volume-mounted files. Serve over HTTP instead:

```bash
cd /dir/holding/file && python3 -m http.server 19999 &
```
```
flux_import(subcommand="import-aggregate-json-files",
            http_url="http://localhost:19999/records.jsonl",
            extra_args=["--json-lines"], collections=["my-data"])
```

`--http-url` is a flux-runner extension, not a Flux CLI flag; it will not appear in
`flux_help` output.
