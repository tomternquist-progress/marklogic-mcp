# Semaphore enrichment module (Pattern B)

A production `flux_reprocess` invoke module that classifies one document per invocation
and patches the result back. Deploy to the Modules database with
`ml_document_put(database="Modules")`, then reference it as `invoke_module`.

Before using this, read the Kubernetes network note in the skill — if `xdmp.httpPost()`
cannot reach the CLS from MarkLogic pods, this pattern will not work and you want
Pattern A instead.

## The module

```javascript
'use strict';
declareUpdate();
var URI; // injected by Flux — one document URI per invocation

var SEMAPHORE_HOST = '<semaphore-host>';
var SEMAPHORE_PORT = <semaphore-scs-port>;   // default: 5058
var THRESHOLD      = 48;

var doc = cts.doc(URI);
if (!doc) { xdmp.log('Document not found: ' + URI, 'warning'); }
else {
  var obj = doc.toObject();
  var textToClassify = obj.body || obj.title || obj.content || '';

  // CLS uses URL-encoded form POST to /, not JSON.
  // IMPORTANT: xdmp.httpPost() arg3 must be a Node, not a plain string.
  // Wrap the body string with fn.head(xdmp.unquote(...)) to convert.
  var bodyStr = 'body=' + encodeURIComponent(textToClassify) +
                '&threshold=' + THRESHOLD + '&singlearticle=1';
  var bodyNode = fn.head(xdmp.unquote(bodyStr, null, ['format-text']));
  var resp = Array.from(xdmp.httpPost(
    'http://' + SEMAPHORE_HOST + ':' + SEMAPHORE_PORT + '/',
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    bodyNode
  ));
  var xml = String(resp[1]);

  // Parse <META name="ClassName" value="Label" id="uuid" score="float"/>
  // CLS @score is a 0.0–1.0 float (e.g. "0.84" = 84% confidence). Do NOT divide by 100.
  // The threshold parameter sent to CLS uses a 0–100 integer scale — different from the returned score.
  var categories = [];
  var re = /<META\s+[^>]*name="([^"]+)"[^>]*value="([^"]+)"[^>]*id="([^"]+)"[^>]*score="([^"]+)"[^>]*\/>/g;
  var m;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== 'Type' && m[1] !== 'Template') {
      categories.push({ className: m[1], label: m[2], id: m[3], score: parseFloat(m[4]) });
    }
  }

  var sorted = categories.slice().sort(function(a, b) { return b.score - a.score; });
  obj.semaphore = {
    classifiedAt: (new Date()).toISOString(),
    classifiedBy: 'flux-reprocess',
    clsHost: SEMAPHORE_HOST,
    threshold: THRESHOLD,
    categoryCount: sorted.length,
    categories: sorted.map(function(c) {
      return { className: c.className, label: c.label, id: c.id, score: c.score };
    }),
    topCategory: sorted.length > 0 ? { className: sorted[0].className, label: sorted[0].label, id: sorted[0].id } : null,
  };

  xdmp.documentInsert(URI, obj, {
    permissions: xdmp.documentGetPermissions(URI),
    collections: xdmp.documentGetCollections(URI).concat(['semaphore-classified']),
  });
  xdmp.log('Classified: ' + URI + ' → ' + (sorted[0] ? sorted[0].label : 'no categories'), 'info');
}
```

## Why each awkward bit is there

**`fn.head(xdmp.unquote(bodyStr, null, ['format-text']))`** — `xdmp.httpPost()` requires a
Node as its third argument. Passing the plain string silently fails or throws depending
on version; `xdmp.unquote` with `format-text` converts it.

**`'body=' + encodeURIComponent(text) + '&threshold=' + N + '&singlearticle=1'`** — the CLS
speaks URL-encoded form POST to `/`, not JSON. `singlearticle=1` tells it to treat the
payload as one document rather than a batch.

**Two score scales.** The `threshold` sent to the CLS is a **0–100 integer**. The `score`
attribute in the response is a **0.0–1.0 float**. They are different scales — do not
divide the response by 100, and do not send a fractional threshold.

**Skipping `Type` and `Template`** — the CLS emits those as META entries alongside real
concepts. They are metadata about the classification run, not taxonomy matches.

**Regex rather than XML parsing** — the response is a small, well-formed fragment and the
regex avoids pulling in a parser inside a per-document transaction. If the CLS response
shape changes, prefer `xdmp.unquote` + XPath over extending the regex.

## Verifying

`Success count: N` from Flux means N invocations returned without throwing — not that N
documents were enriched. A suspiciously fast run (200 documents in ~6 s when each CLS
call should take 100–200 ms) means the HTTP calls are silently no-opping.

Always spot-check:

```
ml_document_get(uri="<one-of-the-uris>")
```

and confirm the `semaphore` key is present with a non-empty `categories` array.
