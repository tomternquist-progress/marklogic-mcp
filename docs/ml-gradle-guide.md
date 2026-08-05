# ml-gradle: A Hands-On Guide

This is a practitioner's guide for the [ml-gradle](https://github.com/marklogic/ml-gradle)
plugin. It covers the project layout, the deploy lifecycle, and the gotchas you'll hit on
your first deploy. Everything below was verified end-to-end against MarkLogic 12.0.1
during the development of this MCP server.

For a deploy-ready starter project, use the `marklogic-project-setup` skill — its
`templates/` tree is a complete project with every gotcha here already addressed.

---

## What ml-gradle is

ml-gradle is a thin Gradle plugin around `ml-app-deployer`, a Java library that talks to
MarkLogic's Management REST API (`/manage/v2`, `/manage/v3`). The plugin gives you ~120
Gradle tasks that:

- Deploy databases, app servers, security (roles/users/privileges/amps), forests, REST
  options, REST services/transforms, schemas, triggers, scheduled tasks, mimetypes, etc.
- Load JSON/XML modules into the modules database
- Load TDE templates into the schemas database
- Load seed data into the content database
- Watch a directory and hot-reload modules during development

Configuration is **as code**: every resource is a JSON or XML file under
`src/main/ml-config/` or `src/main/ml-modules/`, with `%%TOKEN%%` replacement so the
same project can target multiple environments.

**Versions and prerequisites:**
- ml-gradle 6.x: Gradle ≥ 8.4 (9.x recommended for 6.2.0+), Java ≥ 17
- ml-gradle 5.x: Gradle ≥ 6.x, Java 8/11/17
- MarkLogic ≥ 8.0-4

---

## Project layout (the conventional Maven structure)

```
project_root/
├── build.gradle                           ← plugin declaration, custom tasks
├── gradle.properties                      ← mlHost, mlAppName, ports, auth
├── gradle-dev.properties                  ← optional environment overlay
├── settings.gradle                        ← rootProject.name = '...'
└── src/main/
    ├── ml-config/                         ← Management API resources
    │   ├── databases/
    │   │   ├── content-database.json      ← indexes, lexicons, triggers/schema refs
    │   │   ├── schemas-database.json
    │   │   └── triggers-database.json
    │   ├── servers/
    │   │   └── rest-api-server.json       ← auth, port, modules-db
    │   ├── security/
    │   │   ├── roles/
    │   │   ├── users/
    │   │   ├── privileges/
    │   │   └── amps/
    │   ├── forests/                       ← optional explicit forests
    │   └── tasks/                         ← scheduled tasks
    ├── ml-modules/                        ← deploys to <app>-modules DB
    │   ├── root/                          ← assets imported as /lib/foo.sjs
    │   ├── ext/                           ← assets at /ext/foo.sjs
    │   ├── services/                      ← REST resource extensions
    │   ├── transforms/                    ← REST transforms
    │   └── options/                       ← REST search options
    ├── ml-schemas/                        ← deploys to <app>-schemas DB
    │   └── tde/                           ← TDE templates (.tdej, .tde)
    └── ml-data/                           ← seed data, loaded by mlLoadData
        └── <subdir>/
            ├── <docs>.json
            ├── collections.properties     ← per-file collection assignment
            └── permissions.properties     ← per-file role/capability
```

---

## Minimal viable build.gradle

```groovy
plugins {
  id "com.marklogic.ml-gradle" version "6.1.0"
}

repositories {
  mavenCentral()
}
```

That's it. With matching credentials in `gradle.properties`, `gradle mlDeploy` creates a
content database, modules database, schemas database, triggers database, a REST app
server with `mlAppName` as its name, and three forests by default.

---

## The four first-deploy gotchas

These each cost ~30 minutes to discover the first time. The `marklogic-project-setup`
skill's template tree has all four already fixed.

### 1. Basic auth challenge → "unsupported auth scheme"

Some MarkLogic clusters configure their Manage server (port 8002) with `authentication=basic`.
The default `ml-java-client` interceptor (OkHttp + burgstaller) cannot complete a Basic
challenge-response and throws:

```
unsupported auth scheme: [Basic realm=public]
```

**Fix:** force pre-emptive Basic in `gradle.properties`:

```properties
mlAuthentication=basic
mlManageAuthentication=basic
mlAdminAuthentication=basic
mlAppServicesAuthentication=basic
mlRestAuthentication=digest   # REST API server stays on digest by default
```

### 2. CMA-INVALIDPROPERTIES → schemas/triggers DB stubs missing

If `content-database.json` references the schema or triggers database via:

```json
{
  "schema-database": "%%SCHEMAS_DATABASE%%",
  "triggers-database": "%%TRIGGERS_DATABASE%%"
}
```

…you must also have `schemas-database.json` and `triggers-database.json` files in the
same `databases/` directory. Without them, ml-gradle uses CMA (Configuration Management
API) to deploy in a single transaction and CMA fails with:

```
CMA-INVALIDPROPERTIES: ADMIN-NOSUCHDATABASE: No such database <app>-schemas,
denote schema-database after it has been created
```

**Fix:** stub them out with one line each:

```json
{ "database-name": "%%SCHEMAS_DATABASE%%" }
```

### 3. collections.properties syntax → silently ignored

The `mlLoadData` task reads `collections.properties` and `permissions.properties` files
inside data directories. The format is **per-file**, not a global key:

```properties
# Right — one entry per filename:
item-001.json=catalog,demo
item-002.json=catalog

# Wrong — silently ignored:
collections=catalog,demo
```

For directory-wide settings, use `mlCascadeCollections=true` /
`mlCascadePermissions=true` in `gradle.properties` (ml-gradle 4.6.0+).

### 4. REST extension params → must use `rs:` prefix

Custom parameters on REST resource extensions reach the server only when the client uses
the `rs:` prefix:

```bash
# Wrong — REST API rejects "text" as unknown parameter:
curl '.../v1/resources/echo?text=hi'
# → REST-UNSUPPORTEDPARAM: invalid parameters: text for echo

# Right:
curl '.../v1/resources/echo?rs:text=hi'
```

Inside the extension, read the value as `params['rs:text']` (SJS) or
`map:get($params, "rs:text")` (XQuery).

> **Note (verified 2026-05-05):** declaring parameters in a `services/metadata/<name>.xml`
> file (covered below) does **not** relax this requirement. The declarations are
> registered server-side (visible via `GET /v1/config/resources?format=json`) and used by
> documentation tools / generated SDKs, but the REST API runtime still requires the `rs:`
> prefix on every custom parameter. The framework reserves the bare-namespace for its
> own params (database, transform, format, etc.).

---

## Deploy lifecycle (what `mlDeploy` actually does)

`mlDeploy` is a façade. It delegates to a `SimpleAppDeployer` that runs ~80 commands
in a fixed order — the plugin doesn't model them as Gradle task dependencies. To see
the full ordered list:

```bash
gradle mlPrintCommands
```

The most important order constraints:
1. Security commands (roles, then users, then privileges) come first.
2. Databases are created before app servers (servers reference databases).
3. Forests attach during database creation (or via explicit `forests/` files).
4. Modules and schemas load after their owning DBs exist.
5. `mlPostDeploy` is an empty task hook the user can attach extra steps to.

If a command fails, `mlDeploy` aborts unless `mlCatchDeployExceptions=true`. There is
no rollback — partially deployed resources stay.

---

## The 30 most-used tasks

| Task | What it does |
|------|--------------|
| `mlDeploy` | Full deploy of the entire app (databases, servers, security, modules, schemas, data) |
| `mlUndeploy -Pconfirm=true` | Tear down everything that `mlDeploy` created (irreversible) |
| `mlRedeploy` | Clear modules DB, then full mlDeploy |
| `mlPreviewDeploy` | Show JSON of what would change (limited — POSTs to /manage/v3 cannot be previewed) |
| `mlTestConnections` | Validate Manage / Admin / App-Services / REST credentials |
| `mlPrintTokens` | List every active `%%TOKEN%%` and its replacement value |
| `mlPrintProperties` | Dump the resolved property set (all `ml*` properties) |
| `mlPrintCommands` | List the ordered command list `mlAppDeployer` will execute |
| `mlLoadModules` | Load src/main/ml-modules into modules DB (incremental — uses timestamps) |
| `mlReloadModules` | Clear modules DB and reload everything |
| `mlClearModulesDatabase` | Wipe the modules DB |
| `mlWatch` | Hot-reload modules whenever a file changes (dev loop) |
| `mlLoadSchemas` | Load src/main/ml-schemas into schemas DB |
| `mlReloadSchemas` | Clear and reload schemas DB |
| `mlLoadData` | Load src/main/ml-data into the content DB |
| `mlClearContentDatabase -Pconfirm=true` | Wipe the content DB |
| `mlDeployDatabases` | Deploy only the databases |
| `mlDeployServers` | Deploy only the app servers |
| `mlDeploySecurity` | Deploy roles + users + privileges + amps + protected paths |
| `mlDeployRoles` / `mlDeployUsers` / `mlDeployPrivileges` | Deploy one security resource type |
| `mlDeployTriggers` | Deploy triggers (required before first DHF flow run, but not for plain ml-gradle) |
| `mlDeployTasks` | Deploy scheduled tasks |
| `mlCreateResource -PresourceName=<n>` | Scaffold a new REST resource extension stub |
| `mlCreateTransform -PtransformName=<n>` | Scaffold a new REST transform stub |
| `mlNewProject` | Interactive wizard for a fresh project |
| `mlNewRole` / `mlNewUser` / `mlNewDatabase` | Scaffold a new resource JSON |
| `mlExportResources` | Pull resources back from the cluster as JSON files |
| `mlExportModules` | Pull modules back from the cluster |
| `mlPrintForestPlan` | Show what forests would be created without creating them |
| `mlReindexContentDatabase` | Trigger a reindex (also enable `reindexer-enable=true`) |

---

## Token replacement

Any `%%KEY%%` sequence in JSON/XML config or SJS/XQuery modules (unless
`mlReplaceTokensInModules=false`) is substituted at deploy time. The defaults:

| Token | Replacement |
|-------|-------------|
| `%%NAME%%` | mlAppName (or rest-api-server / xdbc-server name) |
| `%%PORT%%` | mlRestPort |
| `%%DATABASE%%` | mlContentDatabaseName (default `<app>-content`) |
| `%%MODULES_DATABASE%%` | mlModulesDatabaseName (default `<app>-modules`) |
| `%%SCHEMAS_DATABASE%%` | mlSchemasDatabaseName (default `<app>-schemas`) |
| `%%TRIGGERS_DATABASE%%` | mlTriggersDatabaseName (default `<app>-triggers`) |
| `%%GROUP%%` | mlGroupName (default `Default`) |

Every Gradle property auto-becomes a `%%`-wrapped token (ml-gradle 3.2.0+).

To add custom tokens:

```groovy
ext {
  mlAppConfig {
    customTokens.put("%%CATALOG_REGION%%", project.hasProperty('catalogRegion') ? catalogRegion : 'us-east')
  }
}
```

Verify with `gradle mlPrintTokens`.

---

## Multi-environment configuration

The standard pattern uses the `net.saliman.properties` plugin (NOT a built-in feature
of ml-gradle):

```groovy
plugins {
  // MUST be applied BEFORE ml-gradle so its property loading runs first
  id "net.saliman.properties" version "1.5.2"
  id "com.marklogic.ml-gradle" version "6.1.0"
}
```

The plugin reads `gradle-${environmentName}.properties` on top of `gradle.properties`.
A common setup:

```
gradle.properties               ← shared defaults
gradle-dev.properties           ← dev overrides
gradle-qa.properties            ← qa overrides
gradle-prod.properties          ← prod overrides
```

Switch environments:

```bash
gradle -PenvironmentName=dev  mlDeploy
gradle -PenvironmentName=prod mlDeploy
```

For per-environment **resource** files (not just properties), use `mlConfigPaths` to
add overlay directories that deep-merge on top of the base:

```properties
# in gradle-dev.properties:
mlConfigPaths=src/main/ml-config,src/main/dev-config
```

A `dev-config/databases/content-database.json` containing only the overrides will be
merged into the base `ml-config/databases/content-database.json` at deploy time.

---

## REST extensions: services, transforms, options

The REST API at `mlRestPort` exposes three kinds of extensions, each with a distinct
on-disk location and on-server URL. ml-gradle's `mlLoadModules` task uploads them
all in one pass — there are no separate `mlDeploy*RestApiExtensions` tasks; the REST
API's own configuration endpoints (`/v1/config/resources/<name>`,
`/v1/config/transforms/<name>`, `/v1/config/query/<name>`) handle the registration.

### Resource services (the most common kind)

A resource service is a custom REST endpoint exposed at
`/v1/resources/<name>` that handles its own request lifecycle.

| Item | Path |
|------|------|
| Source | `src/main/ml-modules/services/<name>.sjs` (or `.xqy`) |
| Optional metadata | `src/main/ml-modules/services/metadata/<name>.xml` |
| Lives at | `/v1/resources/<name>` after deploy |
| Stored at | `/marklogic.rest.resource/<name>/assets/resource.{sjs,xqy}` in the modules DB |

The source file exports one function per HTTP method. Signatures (SJS):
```javascript
exports.GET    = function (context, params)              { /* return doc-or-object */ };
exports.POST   = function (context, params, input)       { /* return doc-or-object */ };
exports.PUT    = function (context, params, input)       { /* return doc-or-object */ };
exports.DELETE = function (context, params)              { /* return doc-or-object */ };
```

Per-method XQuery prologue (one of these per file):
```xquery
declare function get($context as map:map, $params as map:map) as document-node()*  { ... };
declare function post($context as map:map, $params as map:map, $input as document-node()*) as document-node()*  { ... };
declare function put($context as map:map, $params as map:map, $input as document-node()*) as document-node()*  { ... };
declare function delete($context as map:map, $params as map:map) as document-node()*  { ... };
```

`context` carries the response output type (`output-types`), `accept-types`, and any
`input-types`. `params` is a map of query-string parameters (use `rs:` prefix on every
custom param at the client side, see Gotcha #4 above).

#### Metadata file (optional but recommended)

Put `services/metadata/<name>.xml` next to the source. ml-gradle reads it via
`DefaultExtensionMetadataProvider` and posts it as the multipart-metadata part of the
PUT to `/v1/config/resources/<name>`. Example:

```xml
<metadata>
  <title>Echo Service</title>
  <description>
    <p>Returns the input <b>text</b> echoed back as JSON.</p>
  </description>
  <method name="GET">
    <param name="text" type="xs:string"/>
    <param name="loud" type="xs:boolean"/>
  </method>
  <method name="POST">
    <param name="id" type="xs:string"/>
  </method>
</metadata>
```

After deploy, inspect what registered:
```bash
curl --digest -u admin:admin "http://<host>:<port>/v1/config/resources?format=json"
```

If you do NOT supply a metadata file, ml-gradle falls back to `setDefaults()`:
title = filename, no description, no per-method param declarations. SJS files also
get `version=1.0` and `script-language=javascript`.

#### Scaffolding a new resource service

ml-gradle's `mlCreateResource` task generates the SJS or XQuery stub for you:
```bash
gradle mlCreateResource -PresourceName=catalog -PresourceType=sjs
# also writes the right SJS exports skeleton
```
Then add `services/metadata/catalog.xml` by hand and re-run `gradle mlLoadModules`.

### REST transforms

A transform sits in front of the REST document API and rewrites a document on the
way in (PUT, POST) or out (GET).

| Item | Path |
|------|------|
| Source | `src/main/ml-modules/transforms/<name>.sjs` (or `.xqy`, `.xsl`) |
| Optional metadata | `src/main/ml-modules/transforms/metadata/<name>.xml` |
| Invoked at | `?transform=<name>` on any `/v1/documents` call |
| Stored at | `/marklogic.rest.transform/<name>/assets/transform.{sjs,xqy,xsl}` |

Signature (SJS):
```javascript
exports.transform = function (context, params, content) { /* return modified content */ };
```

Used at call time: `PUT /v1/documents?uri=/x.json&transform=normalize` runs the
`normalize.sjs` transform. Pass extra args to the transform via
`?trans:fieldName=value` (note the `trans:` prefix, the transform-equivalent of `rs:`).

Scaffold with: `gradle mlCreateTransform -PtransformName=normalize -PtransformType=sjs`.

### Search options

Named option sets that configure faceted search, snippets, return-fields, etc.

| Item | Path |
|------|------|
| Source | `src/main/ml-modules/options/<name>.xml` (or `.json`) |
| Invoked at | `?options=<name>` on `/v1/search` |
| Stored at | `/Default/<server-name>/rest-api/options/<name>.xml` |

Search options have no metadata file — they're just XML or JSON. Example:
```xml
<options xmlns="http://marklogic.com/appservices/search">
  <constraint name="category">
    <range type="xs:string" facet="true"><element ns="" name="category"/></range>
  </constraint>
  <return-results>true</return-results>
  <return-facets>true</return-facets>
</options>
```

### What about plain "library" modules?

Modules that aren't REST extensions but are imported by REST extensions (or other code)
go under one of:

| Path | URI on the modules DB |
|------|----------------------|
| `src/main/ml-modules/root/lib/foo.sjs` | `/lib/foo.sjs` |
| `src/main/ml-modules/ext/foo/bar.sjs` | `/ext/foo/bar.sjs` |
| `src/main/ml-modules/<custom>/foo.sjs` | `/<custom>/foo.sjs` |

These are loaded via the App-Services port (8000), not the REST API config endpoints.
They get the permissions from `mlModulePermissions` in `gradle.properties`, with optional
per-file overrides via a `permissions.properties` file in the same directory.

**Permission requirement:** the deploying user needs the `xdmp-eval-in` privilege (the
`rest-evaluator` role grants this) to load library modules through port 8000.

### How to check which modules deployed

```bash
# List all REST resource extensions registered with this server:
curl --digest -u admin:admin "http://<host>:<port>/v1/config/resources?format=json"

# List all transforms:
curl --digest -u admin:admin "http://<host>:<port>/v1/config/transforms?format=json"

# List option sets:
curl --digest -u admin:admin "http://<host>:<port>/v1/config/query?format=json"

# Inspect a specific module document in the modules DB:
curl --digest -u admin:admin \
  "http://<host>:8000/v1/documents?uri=/lib/foo.sjs&database=<app>-modules&format=text"
```

The MCP tools `ml_extension_list`, `ml_extension_get`, and `ml_extension_call` provide
the same access without raw curl.

---

## TDE templates

Place templates under `src/main/ml-schemas/tde/`. The file extension matters:

| Extension | Format | Notes |
|-----------|--------|-------|
| `.tde` | XML | The classic format — most expressive |
| `.tdej` | JSON | Concise; supported on ML 9+ |

Any URI starting with `/tde` auto-joins the `http://marklogic.com/xdmp/tde` collection
on ML 12 (ml-gradle 4.3.5+ uses `tde.templateBatchInsert` to validate the whole batch
in one transaction). The deploying user needs the **`tde-admin`** role.

After deploy, verify the view registered:

```javascript
// via ml_eval_javascript on the content DB
var op = require('/MarkLogic/optic');
op.fromView('mySchema','myView').limit(0).result();  // throws if view is missing
```

If a view doesn't appear after deploy:
- `ml_views_list` shows what TDE templates are registered.
- `ml_reindex_status` shows whether reindexing is still in progress.
- A wrong-shape `collections` field (object instead of array) installs silently but the
  view never registers — see ML-11/14 in the project friction log.

---

## Bundles (third-party module dependencies)

Bundles are a Maven-distribution mechanism for shared MarkLogic assets. Declare them in
`build.gradle`:

```groovy
repositories { mavenCentral() }

dependencies {
  mlBundle "com.marklogic:marklogic-unit-test-modules:1.3.0"
}
```

Bundle ZIPs may contain `ml-modules`, `ml-config`, `ml-data`, `ml-plugins`, or
`ml-schemas` directories. The `mlPrepareBundles` task extracts them under
`build/mlBundle/<name>/` and ml-gradle loads bundle modules **before** application
modules, so app code can `require` libraries from the bundle.

---

## Worked examples in this repo's sandbox

Two end-to-end test projects were built and deployed against a live cluster while writing this
guide. Both layouts are reproducible from the `marklogic-project-setup` skill's `templates/` tree.

### minimal-app

- 4 files of config (build.gradle, gradle.properties, settings.gradle, content-database.json)
- 1 REST extension (`echo.sjs`), 1 transform (`upper.sjs`), 1 search options (`by-country.xml`)
- 2 sample documents in ml-data with collections.properties
- Range element index on `country`, range path index on `/sample/year`

After `gradle mlDeploy`:
```
$ curl --digest -u admin:admin "http://progress.ternquist.com:8040/v1/resources/echo?rs:text=ml-gradle-works"
{"ok":true, "echoed":"ml-gradle-works", "host":"..."}
```

### advanced-app

Demonstrates the rest of ml-gradle's surface area:
- TDE template (`.tdej`) → registers `advanced.products` Optic view
- Custom token (`%%CATALOG_DEFAULT_REGION%%`) replaced into a REST extension at deploy
- Custom roles (`mlg-app-reader`, `mlg-app-writer`)
- `net.saliman.properties` plugin for environment switching
- `dev-config/databases/content-database.json` overlay (adds `word-searches`,
  `stemmed-searches=advanced` only on the dev environment)

After `gradle mlDeploy` and `gradle mlLoadData`:
```javascript
op.fromView('advanced','products').result()
// → 3 rows with id, name, category, price, region columns
```

After `gradle -PenvironmentName=dev mlDeploy`, the content DB picks up
`stemmed-searches: advanced` and `word-searches: true` while keeping all base settings.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `unsupported auth scheme: [Basic realm=public]` | Manage server uses Basic; set `mlManageAuthentication=basic` (and the other three sub-keys) |
| `CMA-INVALIDPROPERTIES: ADMIN-NOSUCHDATABASE: No such database <app>-schemas` | `content-database.json` references `%%SCHEMAS_DATABASE%%` but `schemas-database.json` is missing |
| `REST-UNSUPPORTEDPARAM: invalid parameters: text for echo` | Client called the REST extension with `?text=...` instead of `?rs:text=...` |
| `mlLoadData` loaded the docs but no collections were applied | `collections.properties` used the global `collections=` form instead of per-file `<filename>=...` |
| `op.fromView('schema','view')` returns SQL-TABLENOTFOUND | TDE template did not register: check the `collections` field shape, run `ml_views_list`, check `ml_reindex_status` |
| `IllegalAccessError: class LoadUserModulesCommand tried to access private method java.net.URLDecoder.<init>()` | DHF 5.8.1 + Java 21 incompatibility; use individual hub tasks instead of `hubDeploy` (see `dhf-session-retrospective.md`) |
| Deploy hangs after a few seconds with no error | Cluster has offline hosts; databases reference unavailable forests. Use `ml_database_set_forests` to restrict to running hosts |

---

## Further reading

- [ml-gradle wiki](https://github.com/marklogic/ml-gradle/wiki) — official reference
- [ml-app-deployer](https://github.com/marklogic-community/ml-app-deployer) — the underlying library
- [Property reference](https://github.com/marklogic/ml-gradle/wiki/Property-reference)
- [Task reference](https://github.com/marklogic/ml-gradle/wiki/Task-reference)
- [Examples](https://github.com/marklogic/ml-gradle/tree/master/examples) — 42 worked example projects
