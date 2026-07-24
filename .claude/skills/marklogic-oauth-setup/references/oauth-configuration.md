# OAuth configuration — working XQuery and API calls

Every XQuery block runs via `ml_eval_xquery` with `database="Security"`.

`<ext-sec-name>` is a slug derived from the issuer URL — host and path with
non-alphanumerics replaced by hyphens, e.g. `login-example-com-realms-myrealm`.

## 1. Create the external security object

`sec:create-external-security()` guarantees the element ordering ML 12 requires. Never
build this document by hand.

```xquery
xquery version "1.0-ml";
import module namespace sec = "http://marklogic.com/xdmp/security"
  at "/MarkLogic/security.xqy";

let $ext-sec-name := "<ext-sec-name>"

(: If it already exists, remove it first :)
let $_ := try { sec:remove-external-security($ext-sec-name) } catch ($e) { () }

let $oauth-server :=
  <sec:oauth-server xmlns:sec="http://marklogic.com/xdmp/security">
    <sec:oauth-vendor>Other</sec:oauth-vendor>
    <sec:oauth-flow-type>Resource server</sec:oauth-flow-type>
    <sec:oauth-client-id><client-id></sec:oauth-client-id>
    <sec:oauth-jwt-issuer-uri><issuer-url></sec:oauth-jwt-issuer-uri>
    <sec:oauth-token-type>JSON Web Tokens</sec:oauth-token-type>
    <sec:oauth-username-attribute>sub</sec:oauth-username-attribute>
    <sec:oauth-role-attribute><role-claim></sec:oauth-role-attribute>
    <sec:oauth-privilege-attribute/>
    <sec:oauth-jwt-alg>RS256</sec:oauth-jwt-alg>
    <sec:oauth-jwks-uri><issuer-url>/jwks/</sec:oauth-jwks-uri>
  </sec:oauth-server>

return sec:create-external-security(
  $ext-sec-name,
  "OIDC external security for <issuer-url>",
  "oauth",            (: authentication :)
  xs:unsignedInt(0),  (: cache-timeout: 0 = no caching during setup/testing :)
  "<oauth|internal>",    (: authorization mode :)
  (),                 (: ldap-server :)
  (),                 (: saml-server :)
  $oauth-server
)
```

## 2. App server configuration (Management API)
Run ml_servers_list first to confirm server name and group-id values, then apply to ALL groups:
```bash
# Repeat for each group (apps, enode, Default, etc.)
curl -u admin:password -X PUT \
  "http://<ML_HOST>:8002/manage/v2/servers/App-Services/properties?group-id=<GROUP>" \
  -H "Content-Type: application/json" \
  -d '{
    "authentication": "oauth",
    "internal-security": true,
    "API-token-authentication": false,
    "default-user": "nobody",
    "external-security": ["<ext-sec-name>"]
  }'
```
Note: "external-security" is an **array** in the JSON body. "default-user": "nobody" means requests without a valid Bearer token receive an error (no anonymous access).

## 3. Role / user mapping
**authorization: "oauth" mode** — JWT claim "<role-claim>" values are matched against role **external-names**.

For each role you want to grant via the "<role-claim>" claim, register the JWT claim value as an external-name on that role:
```xquery
xquery version "1.0-ml";
import module namespace sec = "http://marklogic.com/xdmp/security"
  at "/MarkLogic/security.xqy";
(: Example: JWT has "<role-claim>": "rest-reader" — register "rest-reader" as external-name on the rest-reader role :)
sec:role-set-external-names("rest-reader", ("rest-reader")),
sec:role-set-external-names("rest-writer", ("rest-writer")),
sec:role-set-external-names("admin", ("admin"))
(: Add one call per role you want to map. The external-name string must EXACTLY match the JWT claim value. :)
```
Run via ml_eval_xquery with database: "Security".

If the JWT "<role-claim>" claim is a **string** (not an array), only one role is mapped per token. If it is a **JSON array**, MarkLogic maps all values.

---

**authorization: "internal" mode** — JWT "sub" claim value is matched against user **external-names**.

Create a MarkLogic user and set its external-name to the JWT sub value:
```xquery
xquery version "1.0-ml";
import module namespace sec = "http://marklogic.com/xdmp/security"
  at "/MarkLogic/security.xqy";
(: Create the user with desired roles :)
let $uid := sec:create-user(
  "<JWT-sub-value>",
  "OIDC user",
  xdmp:random(),
  "OIDC user via <issuer-url>",
  ("rest-reader", "rest-writer"),
  (), ()
)
(: Set the external-name to the JWT sub value :)
return sec:user-set-external-names("<JWT-sub-value>", ("<JWT-sub-value>"))
```
The username and external-name must both equal the exact JWT sub string.

## 4. Verification

1. Verify the external security document structure (run via ml_eval_xquery, database: "Security"):
```xquery
xquery version "1.0-ml";
for $doc in cts:search(fn:doc(),
  cts:collection-query("http://marklogic.com/xdmp/external-securities"))
return $doc
```
Confirm: authentication → cache-timeout → authorization appear in that order BEFORE oauth-server.

2. Decode a test JWT to check claim names and values:
```xquery
xquery version "1.0-ml";
let $token := "<YOUR_BEARER_TOKEN>"
return xdmp:jwt-decode($token)
```
Verify the "iss" matches oauth-jwt-issuer-uri exactly, and the role/sub claim values match what you configured in Section 4.

3. Test MarkLogic directly:
```bash
# With valid Bearer token — expect HTTP 200
curl -H "Authorization: Bearer <YOUR_JWT>" \
  http://<ML_HOST>:8000/v1/search?format=json

# Check access log for role assignment (Kubernetes example)
kubectl exec <ml-pod> -n <namespace> -- tail -5 /var/opt/MarkLogic/Logs/8000_AccessLog.txt
# Expected log line: External User(...) is Mapped to Temp User(...) with Role(s): <role-name>
```

4. If roles are still empty after confirming all configuration, clear the external security cache:
```xquery
xquery version "1.0-ml";
import module namespace sec = "http://marklogic.com/xdmp/security"
  at "/MarkLogic/security.xqy";
sec:external-security-clear-cache("<ext-sec-name>")
```
