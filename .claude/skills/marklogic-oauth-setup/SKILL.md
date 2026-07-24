---
name: marklogic-oauth-setup
description: Configure OAuth2/OIDC Bearer token authentication on a MarkLogic app server, including external security objects, JWT claim to role or user mapping, app server settings across cluster groups, and the MCP server's oauth auth mode. Use when enabling JWT/OIDC login, when tokens authenticate but get no roles (HTTP 403 with an empty role list), when debugging issuer or JWKS mismatches, or when a port has been locked out by a bad auth change. Requires MarkLogic 11+.
---

# MarkLogic OAuth2 / OIDC Setup

## The one thing that trips everyone up

MarkLogic matches JWT claims against **external-names**, not against role names or
usernames. A JWT carrying `"roles": "rest-reader"` does **not** grant the `rest-reader`
role until you explicitly register `rest-reader` as an *external-name* on that role.

Two modes, pick by token structure:

| Mode | Reads | Matches against | Register with |
|---|---|---|---|
| **`oauth`** *(JWT carries role claims)* | claim named by `oauth-role-attribute` | each **role**'s external-name list | `sec:role-set-external-names()` |
| **`internal`** *(users pre-provisioned)* | claim named by `oauth-username-attribute` (usually `sub`) | each **user**'s external-name list | `sec:user-set-external-names()` |

## ⚠ Always use `sec:create-external-security()`

Never build the external security document by hand with `xdmp:node-insert-child()` or
raw node manipulation. ML 12 requires `authentication` → `cache-timeout` →
`authorization` to appear **before** `oauth-server`; wrong ordering **silently breaks
role assignment** with no error.

Full working XQuery for the external security object, role/user mapping, and
verification is in `references/oauth-configuration.md`.

## Prerequisites

- MarkLogic **11+** for OAuth2 JWT external security with JWKS validation
- The OIDC provider has this MarkLogic server registered as an OAuth2 client
- MarkLogic can reach the JWKS endpoint over HTTPS — test server-side with
  `xdmp:http-get("<issuer>/jwks/")` via `ml_eval_xquery`
- The JWT `iss` claim matches `oauth-jwt-issuer-uri` **exactly**, including any trailing
  slash
- `ml_servers_list` first, to get the real app server name and group IDs

## Setup order

1. **Create the external security object** — `ml_eval_xquery` with `database="Security"`
2. **Configure the app server** — Management API PUT, `"authentication": "oauth"`,
   `"external-security": ["<name>"]` (an **array**), `"default-user": "nobody"`,
   `"API-token-authentication": false`
3. **Map roles or users** — `sec:role-set-external-names()` or
   `sec:user-set-external-names()`
4. **Verify** — decode a token, call an endpoint, read the access log

**Apply step 2 to every group in the cluster** (`apps`, `enode`, `Default`, …). Requests
landing on a node in an unconfigured group will fail.

## MCP server configuration

```bash
ML_HOST=<your-marklogic-host>
ML_PORT=8000
ML_AUTH_TYPE=oauth
MCP_TRANSPORT=http
# ML_USERNAME / ML_PASSWORD are NOT used in oauth mode —
# each MCP client supplies its own Bearer token in the Authorization header
```

**Note:** the Flux tools are unavailable under `ML_AUTH_TYPE=oauth`. The Flux runner
embeds `username:password` in its connection string, so it needs `digest` or `basic`
with a dedicated service account. Plan for a second connection profile if you need bulk
import alongside OAuth.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Temp User(...) with Role(s):` empty → HTTP 403 | claim value matches no role external-name (oauth mode), or no user carries the JWT `sub` as external-name (internal mode) |
| Roles empty despite correct config | stale cache — run `sec:external-security-clear-cache("<name>")` |
| Auth fails outright | `iss` mismatch — decode with `xdmp:jwt-decode()` and compare character for character, trailing slash included |
| Works on some nodes only | app server config not applied to every group |
| Intermittent or odd token errors | `API-token-authentication` set true; keep it **false** for standard OIDC JWTs |
| Element-order problems | document built manually instead of via `sec:create-external-security()` |
| JWKS unreachable | MarkLogic cannot egress to the issuer over HTTPS |

The success signal in `8000_AccessLog.txt` is:

```
External User(...) is Mapped to Temp User(...) with Role(s): <role-name>
```

An empty role list there tells you the token validated but the mapping did not — that is
always a §4 external-names problem, not a token problem.

### Locked out of port 8000

If a bad auth change breaks access, restore it through the Management API on **port
8002**:

```bash
curl -u admin:password -X PUT \
  "http://<ML_HOST>:8002/manage/v2/servers/App-Services/properties?group-id=<GROUP>" \
  -H "Content-Type: application/json" \
  -d '{"authentication":"basic","external-security":[]}'
```

Set `cache-timeout` to `0` during setup and testing so configuration changes take effect
immediately; raise it once the mapping is confirmed working.
