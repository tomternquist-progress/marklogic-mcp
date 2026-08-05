# Socrata and open-data portals

## The `/rows.json` trap

Socrata exposes two different shapes. Only one of them imports correctly.

| Endpoint | Shape | Usable? |
|---|---|---|
| `/resource/{id}.csv?$limit=N` | proper rows | **yes** — recommended for large loads |
| `/resource/{id}.json?$limit=N` | array of objects | **yes** |
| `/rows.csv` | proper rows | yes |
| `/rows.json` | **array-of-arrays**, not objects | **no** |

`/rows.json` is the bulk-export endpoint. It emits positional arrays with the column
names carried separately in metadata, so every imported document becomes an anonymous
array — field names are lost and `uri_template` variables cannot resolve.

Use the resource API (`/resource/{id}.csv` or `/resource/{id}.json`) instead.

## Recipes

```
# CSV — preferred for anything large
subcommand="import-delimited-files",
http_url="https://data.wa.gov/resource/abc123.csv?$limit=50000",
collections=["wa-data"], generate_tde=true, tde_schema="wa", tde_view="permits"
```

```
# JSON resource API — returns proper objects
subcommand="import-files",
http_url="https://data.wa.gov/resource/abc123.json?$limit=50000",
collections=["wa-data"]
```

Socrata defaults to 1,000 rows. Always set `$limit` explicitly. For very large
datasets, page with `$offset` and import each page, or raise `$limit` if the portal
permits it.

## GDELT and other headerless exports

GDELT event files ship without a header row. Without `column_names`, every field lands
as `_c0`, `_c1`, … which makes the data effectively unqueryable and produces a useless
TDE view.

```
subcommand="import-delimited-files",
http_url="http://data.gdeltproject.org/events/20240101.export.CSV.zip",
column_names=["GlobalEventID","Day","MonthYear","Year","FractionDate", ...],
extra_args=["--delimiter","\t","--ignore-null-fields"],
collections=["gdelt-events"]
```

Notes:
- GDELT is **tab**-delimited despite the `.CSV` extension.
- `.zip` is extracted by the runner automatically; the extracted directory is passed
  as `--path`.
- `--ignore-null-fields` keeps empty columns out of the documents, which matters given
  GDELT's ~58 sparse columns.

## Field names with spaces

Many government exports use human-readable headers (`State Abbreviation`, `Permit
Type`). These cannot be used in `uri_template` — Flux silently produces malformed URIs.

Fix at import time by overriding the header with `column_names`, choosing snake_case
names, rather than importing first and renaming later.

## General checklist for a new portal

1. Fetch a few rows by hand first (`curl "<url>&$limit=5"`) and look at the actual shape.
2. Confirm it is an array of *objects*, not arrays.
3. Check for a wrapper key (`results`, `data`, `records`) — if present, see
   `jsonl-and-api-wrappers.md`.
4. Pick a stable, always-present field for `uri_template`.
5. Import a small `$limit` first, verify with `ml_document_get`, then scale up.
