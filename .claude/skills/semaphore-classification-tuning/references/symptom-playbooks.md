# Symptom playbooks

Step-by-step remediation plans for each Semaphore classification quality symptom.
Each follows the cheapest-fix-first order: labels, then threshold, then template.
After any change: semaphore_publish, then semaphore_classify to verify.

## symptom: false_positives

```
DIAGNOSIS: false_positives — concept fires on irrelevant documents
────────────────────────────────────────────────────────────
ROOT CAUSE CANDIDATES (in order of likelihood):
  1. An overly-broad altLabel or hiddenLabel matches unrelated text
  2. nearlist is firing on scattered constituent words in unrelated content
  3. Associative evidence is propagating score from a related concept
RECOMMENDED ACTION PLAN:
  Step 1 — Inspect the concept labels (cheapest fix first)
    semaphore_concept_get  model_uri="<model>"  concept_uri="<concept>"
    Look for altLabels / hiddenLabels that are common words or short phrases.
    → If found: semaphore_concept_labels_update  action=remove  label_type=altLabel
    → Then: semaphore_publish → semaphore_classify to verify
  Step 2 — Check if nearlist is the source (if Step 1 doesn't fix it)
    semaphore_classify  content="<false-positive example>"  threshold=0
    If the false-positive score is < phrase_weight threshold and no exact phrase is present,
    nearlist is likely contributing. Try:
    semaphore_kid_template_set  model_uri="<model>"  preset=precision
    (reduces nearlist_weight to 20, disables hierarchy/associative)
  Step 3 — Check associative evidence (if Steps 1–2 don't fix it)
    semaphore_kid_template_set  model_uri="<model>"  associative_cap=0
    This disables associative propagation entirely for this model.
  Step 4 — Absence-firing disambiguation (advanced, when Steps 1–3 are insufficient)
    Add skos:hiddenLabel disqualifying-context words to the problem concept via
    semaphore_kmm_sparql_update, then add a not="1" phraselist rule via
    semaphore_kid_template_set  model_uri="<model>"  content="<custom XML with not=\"1\" rule>"
    This boosts true-positive scores so threshold can be raised above false-positives.
    Use semaphore_classify with this text + threshold=0 to see all firing evidence.
────────────────────────────────────────────────────────────
GENERAL DECISION HIERARCHY:
  1. Label edit (semaphore_concept_labels_update)  — cheapest, isolated fix
  2. Threshold adjust (semaphore_classify threshold)  — zero model changes, test first
  3. Template weight tuning (semaphore_kid_template_set preset=...)  — global, affects all concepts
  4. Raw template customisation (semaphore_kid_template_set content=...)  — advanced, surgical
  Always publish after ANY change: semaphore_publish → semaphore_classify to verify.
```

## symptom: missing_matches

```
DIAGNOSIS: missing_matches — concept fails to fire on relevant documents
────────────────────────────────────────────────────────────
ROOT CAUSE CANDIDATES:
  1. The taxonomy concept lacks altLabels for common synonyms / domain phrasings
  2. The threshold is too high — document contains correct vocabulary but scores below cutoff
  3. The concept has never been published (no CLS rules exist for it)
  4. nearlist_weight is too low for multi-word concepts in long documents
RECOMMENDED ACTION PLAN:
  Step 1 — Test with threshold=0 to see if the concept fires at all
    semaphore_classify  content="<relevant text>"  threshold=0
    If the concept fires at a low score: the concept + rules are working but threshold is too high.
    → Lower the pipeline threshold, or add more altLabels to boost score.
  Step 2 — Inspect concept labels and add synonyms
    semaphore_concept_get  model_uri="<model>"  concept_uri="<concept>"
    Add domain-specific synonyms as altLabels or abbreviations as hiddenLabels:
    semaphore_concept_labels_update  model_uri="<model>"  concept_uri="<concept>"  action=add  label_type=altLabel  label_value="<synonym>"
    → Then: semaphore_publish → semaphore_classify to verify
  Step 3 — Boost nearlist if multi-word phrases appear split in long documents
    semaphore_kid_template_set  model_uri="<model>"  nearlist_weight=70
  Step 4 — Verify the concept has been published
    semaphore_publish_diagnose  model_uri="<model>"
    Checks that the expected number of rules were generated (should be 1+ per concept).
────────────────────────────────────────────────────────────
GENERAL DECISION HIERARCHY:
  1. Label edit (semaphore_concept_labels_update)  — cheapest, isolated fix
  2. Threshold adjust (semaphore_classify threshold)  — zero model changes, test first
  3. Template weight tuning (semaphore_kid_template_set preset=...)  — global, affects all concepts
  4. Raw template customisation (semaphore_kid_template_set content=...)  — advanced, surgical
  Always publish after ANY change: semaphore_publish → semaphore_classify to verify.
```

## symptom: score_too_uniform

```
DIAGNOSIS: score_too_uniform — all matching concepts score identically
────────────────────────────────────────────────────────────
ROOT CAUSE: This is almost always caused by ALL concepts having single-word labels.
  • nearlist requires multi-word labels to fire — single-word concepts score only via
    phraselist, which gives the same weight to every match → all concepts score equally.
  • Threshold-based separation becomes impossible when scores are uniform.
RECOMMENDED ACTION PLAN:
  Option A — Add multi-word altLabels to key concepts (preferred)
    Identify the most important concepts. Add descriptive phrase altLabels:
    semaphore_concept_labels_update  model_uri="<model>"  action=add  label_type=altLabel  label_value="<descriptive phrase>"
    Multi-word labels will then generate nearlist rules, differentiating scores.
  Option B — Raise phraselist_weight and lower nearlist_weight to 0
    This makes phrase-match count (not just presence) drive the score:
    semaphore_kid_template_set  model_uri="<model>"  preset=exact_only
    Documents mentioning a concept multiple times will score proportionally higher.
  Option C — Enable zone-biasing (if documents have reliable title/body structure)
    semaphore_kid_template_set  model_uri="<model>"  preset=balanced  title_weight=80  body_weight=20
    Title mentions then outweigh body mentions, providing natural score differentiation.
────────────────────────────────────────────────────────────
GENERAL DECISION HIERARCHY:
  1. Label edit (semaphore_concept_labels_update)  — cheapest, isolated fix
  2. Threshold adjust (semaphore_classify threshold)  — zero model changes, test first
  3. Template weight tuning (semaphore_kid_template_set preset=...)  — global, affects all concepts
  4. Raw template customisation (semaphore_kid_template_set content=...)  — advanced, surgical
  Always publish after ANY change: semaphore_publish → semaphore_classify to verify.
```

## symptom: hierarchy_not_firing

```
DIAGNOSIS: hierarchy_not_firing — parent concept does not fire when child fires
────────────────────────────────────────────────────────────
ROOT CAUSE CANDIDATES:
  1. lower_hierarchy_weight is 0 or too low in the current template
  2. The hierarchy relationship is not modelled in the KMM (missing skos:broader link)
  3. The child concept itself is not generating enough evidence to propagate
RECOMMENDED ACTION PLAN:
  Step 1 — Check current template hierarchy weight
    semaphore_kid_template_get  model_uri="<model>"
    Look for the linklist with relationshiptypes="LowerInHierarchy" — check its weight.
    → If weight is 0: semaphore_kid_template_set  model_uri="<model>"  preset=hierarchy_heavy
  Step 2 — Verify the hierarchy relationship exists in KMM
    semaphore_concept_get  model_uri="<model>"  concept_uri="<concept>"
    Check 'broader' and 'narrower' links. If missing, the SPARQL doesn't have skos:broader triples.
    Add via: semaphore_kmm_sparql_update  INSERT DATA { <child-uri> skos:broader <parent-uri> }
  Step 3 — Tune the hierarchy weight specifically
    semaphore_kid_template_set  model_uri="<model>"  lower_hierarchy_weight=90
    Then: semaphore_publish → semaphore_classify to verify parent now fires.
────────────────────────────────────────────────────────────
GENERAL DECISION HIERARCHY:
  1. Label edit (semaphore_concept_labels_update)  — cheapest, isolated fix
  2. Threshold adjust (semaphore_classify threshold)  — zero model changes, test first
  3. Template weight tuning (semaphore_kid_template_set preset=...)  — global, affects all concepts
  4. Raw template customisation (semaphore_kid_template_set content=...)  — advanced, surgical
  Always publish after ANY change: semaphore_publish → semaphore_classify to verify.
```

## symptom: nearlist_noise

```
DIAGNOSIS: nearlist_noise — concepts fire because constituent words appear scattered
────────────────────────────────────────────────────────────
ROOT CAUSE: nearlist matches when the individual words of a multi-word label appear
  near each other (within a CLS proximity window). Long documents with broad vocabulary
  will naturally contain these word combinations by chance.
RECOMMENDED ACTION PLAN:
  Step 1 — Quick check: does the false positive disappear with nearlist_weight=0?
    semaphore_kid_template_set  model_uri="<model>"  preset=exact_only
    Publish and test. If the false positive disappears, nearlist was the cause.
  Step 2 — Find a balanced nearlist weight that reduces noise without losing recall
    semaphore_kid_template_set  model_uri="<model>"  nearlist_weight=20
    (or use preset=precision: phrase=70, near=20, no hierarchy/associative)
  Step 3 — If nearlist noise is from specific concepts, add altLabels for exact phrases
    This allows the concept to rely on phraselist rather than nearlist for those matches.
    semaphore_concept_labels_update  model_uri="<model>"  action=add  label_type=altLabel  label_value="<exact phrase>"
────────────────────────────────────────────────────────────
GENERAL DECISION HIERARCHY:
  1. Label edit (semaphore_concept_labels_update)  — cheapest, isolated fix
  2. Threshold adjust (semaphore_classify threshold)  — zero model changes, test first
  3. Template weight tuning (semaphore_kid_template_set preset=...)  — global, affects all concepts
  4. Raw template customisation (semaphore_kid_template_set content=...)  — advanced, surgical
  Always publish after ANY change: semaphore_publish → semaphore_classify to verify.
```

## symptom: short_text_poor

```
DIAGNOSIS: short_text_poor — classification unreliable on short text
────────────────────────────────────────────────────────────
ROOT CAUSE: Short text (headlines, metadata, ~10–50 words) provides little evidence.
  • nearlist can fire on coincidental proximity in short windows
  • hierarchy + associative propagation adds noise relative to direct signal
  • Low token count means ALL weights are reduced proportionally
RECOMMENDED ACTION PLAN:
  Step 1 — Switch to short_text preset
    semaphore_kid_template_set  model_uri="<model>"  preset=short_text
    (phrase=60, near=20, hierarchy=40, assoc=0)
    This gives exact phrase matches the dominant weight and suppresses associative noise.
  Step 2 — Or use exact_only for maximum precision
    semaphore_kid_template_set  model_uri="<model>"  preset=exact_only
    Use this when you prefer zero false positives over recall.
  Step 3 — Ensure concept labels include exact phrasings used in your short texts
    Short texts often use specific jargon, acronyms, or abbreviated forms.
    semaphore_concept_labels_update  model_uri="<model>"  action=add  label_type=hiddenLabel  label_value="<abbreviation>"
  Step 4 — Lower the threshold for short-text pipelines
    Short texts generate weaker signals. A threshold of 30–40 may be more appropriate than 48.
    Test: semaphore_classify  content="<short headline>"  threshold=0
    Observe score distribution before setting pipeline threshold.
────────────────────────────────────────────────────────────
GENERAL DECISION HIERARCHY:
  1. Label edit (semaphore_concept_labels_update)  — cheapest, isolated fix
  2. Threshold adjust (semaphore_classify threshold)  — zero model changes, test first
  3. Template weight tuning (semaphore_kid_template_set preset=...)  — global, affects all concepts
  4. Raw template customisation (semaphore_kid_template_set content=...)  — advanced, surgical
  Always publish after ANY change: semaphore_publish → semaphore_classify to verify.
```

## symptom: zone_ignored

```
DIAGNOSIS: zone_ignored — title content not weighted more than body content
────────────────────────────────────────────────────────────
ROOT CAUSE: The default template does not use zone-biasing — all pos=0 (body zone).
  Title/heading text is structurally more significant but treated identically to body.
RECOMMENDED ACTION PLAN:
  Step 1 — Verify your documents have reliable title/body zone structure
    The Semaphore CLS zones are populated from the structured document input.
    For Flux-imported documents, the JSON/XML field mapping determines zone assignment.
    Title zone = pos=1 in the CLS rule; body zone = pos=0.
    Confirm with: semaphore_classify  content="<title text>" → check scores
                  semaphore_classify  content="<body text>"  → compare scores
  Step 2 — Apply zone-biased template
    semaphore_kid_template_set  model_uri="<model>"  preset=balanced  title_weight=80  body_weight=20
    This generates a template where title-zone phrase/near evidence counts 4× body evidence.
    Tune title_weight/body_weight based on your document structure (e.g. 70/30 is more subtle).
  Step 3 — Publish and validate
    semaphore_publish  model_uri="<model>"  wait_for_completion=true
    semaphore_classify with both a title-heavy and body-heavy example — verify score difference.
────────────────────────────────────────────────────────────
GENERAL DECISION HIERARCHY:
  1. Label edit (semaphore_concept_labels_update)  — cheapest, isolated fix
  2. Threshold adjust (semaphore_classify threshold)  — zero model changes, test first
  3. Template weight tuning (semaphore_kid_template_set preset=...)  — global, affects all concepts
  4. Raw template customisation (semaphore_kid_template_set content=...)  — advanced, surgical
  Always publish after ANY change: semaphore_publish → semaphore_classify to verify.
```

## symptom: associative_overfiring

```
DIAGNOSIS: associative_overfiring — related concepts inflating scores of unrelated concepts
────────────────────────────────────────────────────────────
ROOT CAUSE: The linklist Associative contribution (skos:related links) is adding weight
  to parent/sibling concepts when only a distantly related concept has direct evidence.
RECOMMENDED ACTION PLAN:
  Step 1 — Disable associative evidence entirely (cleanest fix)
    semaphore_kid_template_set  model_uri="<model>"  associative_cap=0
    This removes associative propagation without changing phrase/near/hierarchy weights.
    Publish and test — this usually resolves over-broad associative firing immediately.
  Step 2 — If you want to preserve SOME associative contribution, lower the cap
    semaphore_kid_template_set  model_uri="<model>"  associative_cap=10  associative_weight=30
    (cap=10 means associative can contribute at most 10% of the final score)
  Step 3 — Inspect the skos:related links on the problem concept
    semaphore_concept_get  model_uri="<model>"  concept_uri="<concept>"
    If the related link itself is the problem (wrong semantic relation), remove it:
    semaphore_kmm_sparql_update  DELETE DATA { <concept-uri> skos:related <related-uri> }
────────────────────────────────────────────────────────────
GENERAL DECISION HIERARCHY:
  1. Label edit (semaphore_concept_labels_update)  — cheapest, isolated fix
  2. Threshold adjust (semaphore_classify threshold)  — zero model changes, test first
  3. Template weight tuning (semaphore_kid_template_set preset=...)  — global, affects all concepts
  4. Raw template customisation (semaphore_kid_template_set content=...)  — advanced, surgical
  Always publish after ANY change: semaphore_publish → semaphore_classify to verify.
```
