---
name: semaphore-taxonomy
description: Author, load, validate, and publish SKOS taxonomies in Semaphore KMM for use with MarkLogic content classification. Use when creating a new taxonomy or concept scheme, writing or editing SKOS Turtle, loading plain SKOS vocabularies (UNESCO, EuroVoc, AGROVOC, IPTC), fixing "No preferred labels" in Semaphore Studio, managing concept labels (prefLabel/altLabel/hiddenLabel), or publishing a model so the Classification Server can use it. Covers the semaphore_kmm_*, semaphore_concept_*, semaphore_taxonomy_validate, and semaphore_publish tools.
---

# Semaphore Taxonomy Authoring

## Build order (follow exactly — steps 5 and 6 are the ones people miss)

1. **Create the model** — `semaphore_kmm_model_create`
2. **Author the SKOS Turtle** — start from `templates/taxonomy-skeleton.ttl`
3. **Load it** — `semaphore_kmm_skos_load` with `skos_content=<turtle>`
4. **Validate structure** — `semaphore_taxonomy_validate`
5. **⚠ Add SKOS-XL reification — REQUIRED, immediately after loading**
6. **Fix plain-SKOS publish config** — `semaphore_publish_config_fix_plain_skos`
7. **Publish** — `semaphore_publish`
8. **Verify** — `semaphore_classify` on representative text

## Step 5: SKOS-XL reification (the "No preferred labels" fix)

Semaphore Studio manages **SKOS-XL** labels, not plain `skos:prefLabel` triples.
Without this step Studio shows *"No preferred labels"* / *"Create a preferred label"*
even though your `skos:prefLabel` triples loaded correctly.

```
semaphore_kmm_sparql_update  model_uri='<your-model>'
sparql='PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        PREFIX skosxl: <http://www.w3.org/2008/05/skos-xl#>
        INSERT { ?c skosxl:prefLabel ?n . ?n a skosxl:Label . ?n skosxl:literalForm ?l . }
        WHERE  { { ?c a skos:Concept } UNION { ?c a skos:ConceptScheme }
                 ?c skos:prefLabel ?l .
                 BIND(IRI(CONCAT(STR(?c),"/xlabels/",LANG(?l),"/pref/",ENCODE_FOR_URI(STR(?l)))) AS ?n)
                 FILTER NOT EXISTS { ?n a skosxl:Label } }'
```

This is idempotent — the `FILTER NOT EXISTS` guard makes re-running safe.

## Authoring rules

### ⚠ No `dcterms:*` on the ConceptScheme

KMM's domain/range validation rejects Dublin Core properties on
`skos:ConceptScheme` with *"Definition incomplete — domain or range not valid"*.

| Instead of | Use |
|---|---|
| `dcterms:description` | `skos:definition` |
| general notes | `skos:note` |
| `dcterms:created` | nothing — KMM tracks creation internally |

### Hierarchy vs synonyms

- `skos:narrower` / `skos:broader` = hierarchy (the child **is-a** the parent). Always
  write both directions.
- `skos:altLabel` = synonyms and abbreviations **for that concept only**.
- `skos:related` = cross-cutting association between sibling branches.

**Do not list narrower concept names as altLabels on the parent.** This is the single
most common authoring error and it produces false positives at classification time —
the parent concept fires on any document mentioning a child.

```turtle
WRONG:
  ex:Compute skos:altLabel "Virtual Machines", "Serverless" .

CORRECT:
  ex:Compute          skos:narrower ex:VirtualMachines .
  ex:VirtualMachines  skos:broader  ex:Compute ;
                      skos:altLabel "VM", "Virtual Machine" .
```

### Labels and language tags

Tag every label with a BCP 47 language (`@en`, `@fr`, `@de`, `@nl`). Untagged
literals are treated as a distinct language by Studio and will not match.

Every concept needs exactly one `skos:prefLabel` per language. Put synonyms,
abbreviations, and spelling variants in `skos:altLabel`; put disqualifying-context or
never-display terms in `skos:hiddenLabel`.

## Starting a new taxonomy

`templates/taxonomy-skeleton.ttl` is a working two-branch example with the correct
structure: a `skos:ConceptScheme` with `skos:hasTopConcept`, top concepts with
`skos:topConceptOf` + `skos:narrower`, and children with `skos:broader` + `skos:altLabel`.

Copy it, replace the namespace and prefix, and build out the branches. Then fill in
**meaningful** altLabels on each child — the skeleton's are placeholders, and a
taxonomy with no synonyms classifies poorly.

## Plain-SKOS vocabularies (UNESCO, EuroVoc, AGROVOC, IPTC)

Public SKOS files load without modification, but they arrive as plain SKOS and need
the same steps 5–7 as hand-authored taxonomies:

1. `semaphore_kmm_skos_load` the file
2. SKOS-XL reification (step 5 above)
3. `semaphore_publish_config_fix_plain_skos`
4. `semaphore_publish`

Skipping step 3 gives a model that publishes but returns no classification results.

## Editing an existing taxonomy

- `semaphore_concept_search` — find a concept URI by label
- `semaphore_concept_get` — inspect all labels on a concept
- `semaphore_concept_labels_update` — add/remove `altLabel` / `hiddenLabel`
- `semaphore_kmm_sparql` / `semaphore_kmm_sparql_update` — bulk changes

**Every label change requires a re-`semaphore_publish` before it affects
classification.** Verify with `semaphore_classify` afterwards.

If classification quality is the problem rather than structure, use the
**semaphore-classification-tuning** skill instead — label edits are only the first of
three fix levels.

## Authentication

KMM uses a separate credential path from the Classification Server. If
`semaphore_kmm_*` tools fail while `semaphore_classify` works, check
`SEMAPHORE_USERNAME` / `SEMAPHORE_PASSWORD` and the KMM port
(`SEMAPHORE_KMM_PORT`) rather than the CLS settings.
