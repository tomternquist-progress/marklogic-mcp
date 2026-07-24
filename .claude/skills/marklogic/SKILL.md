---
name: marklogic
description: Router for working with MarkLogic through this MCP server — maps a user goal to the MarkLogic-native capability and the tools that implement it. Use at the start of any MarkLogic task when the right approach is not obvious: loading or importing data, searching, analytics and aggregation, graph and RDF work, semantic/vector search, schema and index discovery, content classification, performance diagnosis, or building a deployable project. Also covers the discovery steps to run before querying and the safety flags (ML_READONLY, ML_ALLOW_EVAL) that gate which tools exist.
---

# MarkLogic — problem → capability router

Identify the MarkLogic-native approach **before** reaching for a tool. Picking the
wrong one wastes round-trips and produces worse results.

## Problem → approach → tools

| Problem | Native approach | Primary tools | Discover first |
|---|---|---|---|
| Bulk load / URL / file / JDBC | Flux pipeline | `flux_import` | `flux_status` |
| A few documents | REST document API | `ml_document_put`, `ml_document_patch` | — |
| Full-text search | Universal index | `ml_search`, `ml_search_qbe`, `ml_suggest` | `ml_collections_list`, `ml_schema_discover` |
| Exact-value filter | Value index (on by default) | `ml_search` + `structured_query` | `ml_schema_discover` |
| Distinct values / counts / buckets | Range index / Values API | `ml_values_query`, `ml_facets_query` | `ml_indexes_list` |
| GROUP BY, joins, aggregates | Optic over TDE views | `ml_optic_query`, `ml_aggregate_query` | `ml_schema_get_tde`, `ml_views_list` |
| Time series | Optic + date range index | `ml_timeseries_query` | `ml_indexes_list` |
| Graph / relationships | Triple store | `ml_sparql_query`, `ml_graphs_list` | `ml_graphs_list` |
| Semantic / RAG similarity | Vector index (ML 12+) | `ml_vector_search` | `ml_indexes_list` |
| One-shot NL question | Question parser + projection | `ml_answer_query` | `ml_collections_list` |
| NL → query pipeline | grammar → parse → execute | `ml_search_surface`, `ml_parse_query`, `ml_search` | `ml_search_surface` **first** |
| Classify / auto-tag content | Semaphore CLS + KMM | `semaphore_classify`, `flux_import(classify_with_semaphore)` | `semaphore_status` |
| Install a TDE template | Schemas database | `ml_tde_install`, `ml_tde_validate` | `ml_schema_get_tde` |
| Bulk server-side transform | Flux reprocess | `flux_reprocess` | — |
| Export data out | Flux export | `flux_export`, `ml_export_tabular` | — |
| Slow query | Index + plan analysis | `ml_explain_optic`, `ml_search_query_plan`, `ml_profile_query` | `ml_indexes_list` |
| Cluster / database admin | Manage API | `ml_databases_list`, `ml_servers_list`, `ml_cluster_status` | — |
| Users / roles / permissions | Security API | `ml_users_list`, `ml_roles_list`, `ml_document_permissions` | — |

## Deeper skills

| Skill | Covers |
|---|---|
| **marklogic-bulk-import** | Flux import recipes, Socrata/GDELT, JSONL wrappers, reprocess transforms |
| **marklogic-query-authoring** | search vs structured vs Optic vs SPARQL, index requirements, empty-result triage |
| **marklogic-project-setup** | ml-gradle project template, multi-environment, deploy failures |
| **semaphore-taxonomy** | SKOS authoring, SKOS-XL reification, publish workflow |
| **semaphore-classification-tuning** | classification quality: labels → threshold → .kid template |

## Always discover before querying

The most common cause of a wrong answer is querying the wrong database or guessing a
field name.

1. **`ml_databases_list`** — projects have their own content database
   (e.g. `myapp-content`). The built-in `Documents` database is for ad-hoc sandbox use
   only. Do not assume `Documents`.
2. **`ml_collections_list`** — what is actually loaded.
3. **`ml_schema_discover`** — real field names, nesting, and types.
4. **`ml_indexes_list`** — which fields are range-indexed. Tools that need a range
   index fail or return empty without one.

For query building specifically, `ml_search_surface` does fields + indexes + options in
one call.

## Choosing between overlapping tools

- **`ml_search` vs `ml_optic_query`** — documents vs rows. Search returns documents
  ranked by relevance; Optic returns tabular rows and can GROUP BY and join, but needs
  a TDE view.
- **`ml_values_query` vs paging `ml_search`** — for counts and distinct values, never
  page through search results.
- **`flux_import` vs `ml_document_put`** — over ~10 documents, always Flux.
- **`ml_eval_javascript` vs everything else** — eval is for server-side logic, not bulk
  insert. It has a ~10 KB payload cap and no parallelism.
- **`ml_graph_put` vs `flux_import(import-rdf-files)`** — under ~1 MB of RDF, use
  `ml_graph_put`.

## Starting a project rather than exploring

If the goal implies anything repeatable, source-controlled, or deployed elsewhere —
"build an app", "add a REST endpoint", "deploy to production", "version-controlled" —
use the **marklogic-project-setup** skill instead of the MCP write tools. Write tools
change a running database and leave nothing on disk.

## Safety flags change which tools exist

- **`ML_READONLY=true`** — write tools are not registered at all. If a write tool is
  missing, this is why. It is a tool-layer safety belt, not a credential restriction;
  for real protection use a read-only MarkLogic role.
- **`ML_ALLOW_EVAL=false`** — `ml_eval_xquery`, `ml_eval_javascript`, `ml_sparql`, and
  `ml_invoke_module` are not registered. Eval is also force-disabled whenever
  `ML_READONLY=true`, since eval can perform any server-side write.
- **`ML_AUTH_TYPE=oauth`** — Flux tools return an explicit error; the Flux runner needs
  username/password in its connection string.

## Reading results critically

- A Flux `Success count: N` means N invocations did not throw — not that N documents
  changed. Spot-check with `ml_document_get`.
- An installed TDE template can extract zero rows. Confirm with `ml_tde_validate`.
- Index and TDE changes need a full reindex. Check `ml_reindex_status` before
  concluding a query is wrong.
