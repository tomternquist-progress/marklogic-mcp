# myapp
An ml-gradle MarkLogic project scaffolded by the marklogic-mcp `ml_gradle_scaffold` tool.
## Deploy
```bash
gradle mlDeploy
gradle mlLoadData     # load src/main/ml-data into the content DB
```
## Common tasks
| Task | Purpose |
|------|---------|
| `gradle mlDeploy` | Full deploy (databases, servers, security, modules, schemas) |
| `gradle mlReloadModules` | Clear modules DB and reload from `src/main/ml-modules` |
| `gradle mlReloadSchemas` | Clear schemas DB and reload TDE templates |
| `gradle mlLoadData` | Load `src/main/ml-data` into the content database |
| `gradle mlPrintTokens` | Show all `%%TOKEN%%` replacements applied to JSON/XML config |
| `gradle mlPreviewDeploy` | Show what would change without applying it |
| `gradle mlWatch` | Hot-reload modules whenever a file changes |
| `gradle mlUndeploy -Pconfirm=true` | Tear down the entire app (destructive) |
## Try the REST extension

```bash
curl -u admin:admin --digest "http://localhost:8010/v1/resources/echo?rs:text=hello"
```

Note: custom params must use the `rs:` prefix.

## Environment switching

```bash
gradle -PenvironmentName=dev  mlDeploy
gradle -PenvironmentName=prod mlDeploy
```

`gradle-{env}.properties` overrides values from `gradle.properties`. The pattern
shipped here uses `mlConfigPaths` to layer `src/main/{env}-config/` on top of
`src/main/ml-config/` so each environment can patch the database/server JSON.

