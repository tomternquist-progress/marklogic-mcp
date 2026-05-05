/**
 * ml-gradle scaffolding tool.
 *
 * Emits a complete, deploy-ready ml-gradle project layout as a file map. The
 * agent can then write the files to disk, run `gradle mlDeploy`, and iterate.
 *
 * Why a tool (not a prompt): scaffolding is deterministic — given the same
 * inputs, the output should be identical. A tool gives the agent a structured
 * file map it can stream directly to Write tools, without LLM token sampling
 * inserting subtle errors into JSON or properties files.
 *
 * The output bakes in the lessons learned from sandbox deployments:
 *   1. Pre-emptive Basic auth (mlAuthentication=basic and the four sub-keys)
 *      avoids the "unsupported auth scheme: [Basic realm=public]" failure on
 *      clusters whose Manage server responds with Basic challenges.
 *   2. schemas-database.json and triggers-database.json are emitted whenever
 *      content-database.json references %%SCHEMAS_DATABASE%% / %%TRIGGERS_DATABASE%%,
 *      so CMA-INVALIDPROPERTIES (ADMIN-NOSUCHDATABASE) does not fire on first deploy.
 *   3. ml-data collections/permissions properties files use the documented
 *      per-file `filename=values` syntax, not a global `collections=` key.
 *   4. TDE templates use the .tdej extension (JSON) under ml-schemas/tde so they
 *      auto-join http://marklogic.com/xdmp/tde.
 *   5. REST resource extensions include rs:-prefixed parameter examples.
 *   6. Environment switching scaffolding includes net.saliman.properties +
 *      mlConfigPaths overlay pattern.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface ScaffoldFile {
  path: string;
  content: string;
}

interface ScaffoldArgs {
  app_name: string;
  rest_port: number;
  ml_host?: string;
  test_rest_port?: number;
  include_tde?: boolean;
  include_rest_extension?: boolean;
  include_role?: boolean;
  include_data?: boolean;
  include_environments?: boolean;
  ml_gradle_version?: string;
}

function buildScaffold(args: ScaffoldArgs): ScaffoldFile[] {
  const {
    app_name,
    rest_port,
    ml_host = "localhost",
    test_rest_port,
    include_tde = true,
    include_rest_extension = true,
    include_role = false,
    include_data = true,
    include_environments = false,
    ml_gradle_version = "6.1.0",
  } = args;

  const files: ScaffoldFile[] = [];

  // ── build.gradle ──────────────────────────────────────────────────────────
  const buildGradleLines: string[] = [
    "plugins {",
    ...(include_environments
      ? [
          "  // Reads gradle-${environmentName}.properties on top of gradle.properties.",
          "  // Switch environments with: gradle -PenvironmentName=dev mlDeploy",
          '  id "net.saliman.properties" version "1.5.2"',
          "",
        ]
      : []),
    `  id "com.marklogic.ml-gradle" version "${ml_gradle_version}"`,
    "}",
    "",
    "repositories {",
    "  mavenCentral()",
    "}",
    "",
  ];
  files.push({ path: "build.gradle", content: buildGradleLines.join("\n") });

  // ── settings.gradle ───────────────────────────────────────────────────────
  files.push({ path: "settings.gradle", content: `rootProject.name = '${app_name}'\n` });

  // ── gradle.properties ─────────────────────────────────────────────────────
  const gpLines: string[] = [
    `mlHost=${ml_host}`,
    `mlAppName=${app_name}`,
    `mlRestPort=${rest_port}`,
    ...(test_rest_port ? [`mlTestRestPort=${test_rest_port}`] : []),
    "",
    "mlUsername=admin",
    "mlPassword=admin",
    "mlManageUsername=admin",
    "mlManagePassword=admin",
    "",
    "# Pre-emptive Basic auth across Manage / Admin / App-Services.",
    "# Required when the cluster's Manage server responds with",
    '#   WWW-Authenticate: Basic realm=public',
    '# The default ml-java-client interceptor cannot complete a Basic challenge-response',
    '# and throws "unsupported auth scheme: [Basic realm=public]". Setting these forces',
    "# pre-emptive Basic so no challenge round-trip is needed.",
    "mlAuthentication=basic",
    "mlManageAuthentication=basic",
    "mlAdminAuthentication=basic",
    "mlAppServicesAuthentication=basic",
    "# REST API server uses digest by default; keep it that way.",
    "mlRestAuthentication=digest",
    "",
    "# 1 forest per host is a safe default for dev / single-host clusters.",
    "# For production write-heavy workloads, raise to 2 (one merges while the other serves queries).",
    "mlContentForestsPerHost=1",
    "",
    "# Default permissions applied to /ext and /root modules. Override per-file with",
    "# a permissions.properties next to the module if needed.",
    "mlModulePermissions=rest-admin,read,rest-admin,update,rest-extension-user,execute",
    "",
    ...(include_environments
      ? [
          "# Multi-environment overlay: switch with -PenvironmentName=dev|prod.",
          "# gradle-dev.properties / gradle-prod.properties will replace mlConfigPaths",
          "# to layer dev-config / prod-config directories on top of ml-config.",
          "mlConfigPaths=src/main/ml-config",
          "",
        ]
      : []),
  ];
  files.push({ path: "gradle.properties", content: gpLines.join("\n") });

  if (include_environments) {
    files.push({
      path: "gradle-dev.properties",
      content: "mlConfigPaths=src/main/ml-config,src/main/dev-config\n",
    });
    files.push({
      path: "gradle-prod.properties",
      content: "mlConfigPaths=src/main/ml-config,src/main/prod-config\n",
    });
    files.push({
      path: "src/main/dev-config/databases/content-database.json",
      content:
        JSON.stringify(
          {
            "database-name": "%%DATABASE%%",
            "word-searches": true,
            "stemmed-searches": "advanced",
          },
          null,
          2
        ) + "\n",
    });
  }

  // ── .gitignore ────────────────────────────────────────────────────────────
  files.push({
    path: ".gitignore",
    content: [".gradle/", "build/", "*.local", "gradle-local.properties", ""].join("\n"),
  });

  // ── content-database.json ─────────────────────────────────────────────────
  files.push({
    path: "src/main/ml-config/databases/content-database.json",
    content:
      JSON.stringify(
        {
          "database-name": "%%DATABASE%%",
          "schema-database": "%%SCHEMAS_DATABASE%%",
          "triggers-database": "%%TRIGGERS_DATABASE%%",
          "maintain-last-modified": true,
          "uri-lexicon": true,
          "collection-lexicon": true,
          "range-element-index": [
            {
              "scalar-type": "string",
              "namespace-uri": "",
              localname: "category",
              collation: "http://marklogic.com/collation/codepoint",
              "range-value-positions": false,
              "invalid-values": "reject",
            },
          ],
        },
        null,
        2
      ) + "\n",
  });

  // CMA fails with ADMIN-NOSUCHDATABASE if content-database.json references
  // schema-database / triggers-database without these stubs being present in
  // the same deploy. Always emit them.
  files.push({
    path: "src/main/ml-config/databases/schemas-database.json",
    content: JSON.stringify({ "database-name": "%%SCHEMAS_DATABASE%%" }, null, 2) + "\n",
  });
  files.push({
    path: "src/main/ml-config/databases/triggers-database.json",
    content: JSON.stringify({ "database-name": "%%TRIGGERS_DATABASE%%" }, null, 2) + "\n",
  });

  // ── role (optional) ───────────────────────────────────────────────────────
  if (include_role) {
    files.push({
      path: `src/main/ml-config/security/roles/1-${app_name}-reader.json`,
      content:
        JSON.stringify(
          {
            "role-name": `${app_name}-reader`,
            description: `Read-only access to ${app_name} content`,
            role: ["rest-reader"],
          },
          null,
          2
        ) + "\n",
    });
    files.push({
      path: `src/main/ml-config/security/roles/2-${app_name}-writer.json`,
      content:
        JSON.stringify(
          {
            "role-name": `${app_name}-writer`,
            description: `Read/write access to ${app_name} content`,
            role: ["rest-writer", `${app_name}-reader`],
          },
          null,
          2
        ) + "\n",
    });
  }

  // ── REST extension (optional) ─────────────────────────────────────────────
  if (include_rest_extension) {
    // Resource service: /v1/resources/echo
    files.push({
      path: "src/main/ml-modules/services/echo.sjs",
      content: [
        "'use strict';",
        "",
        "// REST resource extension deployed to /v1/resources/echo by mlLoadModules.",
        '// Custom params MUST be invoked with the "rs:" prefix from the client side, e.g.',
        "//   GET /v1/resources/echo?rs:text=hello",
        "// Without the prefix MarkLogic returns",
        '//   REST-UNSUPPORTEDPARAM: invalid parameters: text for echo',
        "// (The accompanying services/metadata/echo.xml file declares title, description,",
        "//  and parameter docs — those declarations are advisory; the rs: prefix is still",
        "//  enforced at runtime regardless.)",
        "function get(context, params) {",
        "  const text = params['rs:text'] || 'hello from ml-gradle';",
        "  return { ok: true, echoed: text, host: xdmp.host() };",
        "}",
        "",
        "exports.GET = get;",
        "",
      ].join("\n"),
    });

    // Metadata for the resource service. ml-gradle reads this at deploy time
    // and posts it as the multipart-metadata part of PUT /v1/config/resources/echo.
    // Visible afterwards via GET /v1/config/resources?format=json.
    files.push({
      path: "src/main/ml-modules/services/metadata/echo.xml",
      content: [
        "<metadata>",
        "  <title>Echo Service</title>",
        "  <description>",
        "    <p>Returns the input <b>text</b> echoed back as JSON.</p>",
        "  </description>",
        '  <method name="GET">',
        '    <param name="text" type="xs:string"/>',
        "  </method>",
        "</metadata>",
        "",
      ].join("\n"),
    });

    // Transform: invoked via ?transform=identity on /v1/documents calls.
    files.push({
      path: "src/main/ml-modules/transforms/identity.sjs",
      content: [
        "'use strict';",
        "",
        "// REST transform — runs on the request/response stream of the REST API.",
        "// Invoke with: ?transform=identity (custom transform args use trans: prefix)",
        "function transform(context, params, content) {",
        "  return content;",
        "}",
        "",
        "exports.transform = transform;",
        "",
      ].join("\n"),
    });

    // Optional metadata for the transform — same XML format as services/metadata/.
    files.push({
      path: "src/main/ml-modules/transforms/metadata/identity.xml",
      content: [
        "<metadata>",
        "  <title>Identity Transform</title>",
        "  <description>",
        "    <p>Pass-through transform that returns the input unchanged.</p>",
        "  </description>",
        "</metadata>",
        "",
      ].join("\n"),
    });

    // Search options: /v1/search?options=default
    files.push({
      path: "src/main/ml-modules/options/default.xml",
      content: [
        '<options xmlns="http://marklogic.com/appservices/search">',
        '  <constraint name="category">',
        '    <range type="xs:string" facet="true">',
        '      <element ns="" name="category"/>',
        "    </range>",
        "  </constraint>",
        "  <return-results>true</return-results>",
        "  <return-facets>true</return-facets>",
        "</options>",
        "",
      ].join("\n"),
    });
  }

  // ── TDE template (optional) ───────────────────────────────────────────────
  if (include_tde) {
    files.push({
      path: "src/main/ml-schemas/tde/items.tdej",
      content:
        JSON.stringify(
          {
            template: {
              context: "/item",
              collections: [`${app_name}-items`],
              rows: [
                {
                  schemaName: app_name.replace(/-/g, "_"),
                  viewName: "items",
                  columns: [
                    { name: "id", scalarType: "string", val: "id", nullable: false },
                    { name: "category", scalarType: "string", val: "category" },
                    { name: "name", scalarType: "string", val: "name", nullable: true },
                  ],
                },
              ],
            },
          },
          null,
          2
        ) + "\n",
    });
  }

  // ── seed data (optional) ──────────────────────────────────────────────────
  if (include_data) {
    files.push({
      path: "src/main/ml-data/items/item-001.json",
      content:
        JSON.stringify(
          { item: { id: "item-001", category: "demo", name: "First item" } },
          null,
          2
        ) + "\n",
    });
    files.push({
      path: "src/main/ml-data/items/item-002.json",
      content:
        JSON.stringify(
          { item: { id: "item-002", category: "demo", name: "Second item" } },
          null,
          2
        ) + "\n",
    });

    // collections.properties / permissions.properties use a per-file format:
    //   <filename>=<values>
    // A global "collections=..." key is silently ignored — the file is read
    // but no per-document overrides are derived from it.
    files.push({
      path: "src/main/ml-data/items/collections.properties",
      content: [`item-001.json=${app_name}-items`, `item-002.json=${app_name}-items`, ""].join("\n"),
    });

    if (include_role) {
      files.push({
        path: "src/main/ml-data/items/permissions.properties",
        content: [
          `item-001.json=${app_name}-reader,read,${app_name}-writer,update`,
          `item-002.json=${app_name}-reader,read,${app_name}-writer,update`,
          "",
        ].join("\n"),
      });
    }
  }

  // ── README ────────────────────────────────────────────────────────────────
  const restPort = rest_port;
  files.push({
    path: "README.md",
    content: [
      `# ${app_name}`,
      "",
      "An ml-gradle MarkLogic project scaffolded by the marklogic-mcp `ml_gradle_scaffold` tool.",
      "",
      "## Deploy",
      "",
      "```bash",
      "gradle mlDeploy",
      include_data ? "gradle mlLoadData     # load src/main/ml-data into the content DB" : "",
      "```",
      "",
      "## Common tasks",
      "",
      "| Task | Purpose |",
      "|------|---------|",
      "| `gradle mlDeploy` | Full deploy (databases, servers, security, modules, schemas) |",
      "| `gradle mlReloadModules` | Clear modules DB and reload from `src/main/ml-modules` |",
      "| `gradle mlReloadSchemas` | Clear schemas DB and reload TDE templates |",
      "| `gradle mlLoadData` | Load `src/main/ml-data` into the content database |",
      "| `gradle mlPrintTokens` | Show all `%%TOKEN%%` replacements applied to JSON/XML config |",
      "| `gradle mlPreviewDeploy` | Show what would change without applying it |",
      "| `gradle mlWatch` | Hot-reload modules whenever a file changes |",
      "| `gradle mlUndeploy -Pconfirm=true` | Tear down the entire app (destructive) |",
      "",
      include_rest_extension
        ? [
            "## Try the REST extension",
            "",
            "```bash",
            `curl -u admin:admin --digest "http://${ml_host}:${restPort}/v1/resources/echo?rs:text=hello"`,
            "```",
            "",
            "Note: custom params must use the `rs:` prefix.",
            "",
          ].join("\n")
        : "",
      include_environments
        ? [
            "## Environment switching",
            "",
            "```bash",
            "gradle -PenvironmentName=dev  mlDeploy",
            "gradle -PenvironmentName=prod mlDeploy",
            "```",
            "",
            "`gradle-{env}.properties` overrides values from `gradle.properties`. The pattern",
            "shipped here uses `mlConfigPaths` to layer `src/main/{env}-config/` on top of",
            "`src/main/ml-config/` so each environment can patch the database/server JSON.",
            "",
          ].join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  });

  return files;
}

export function registerMlGradleTools(server: McpServer): void {
  server.tool(
    "ml_gradle_scaffold",
    "Generate a deploy-ready ml-gradle MarkLogic project as a file map (paths + contents). " +
      "The agent should write each file to disk, then run `gradle mlDeploy` to deploy it. " +
      "Bakes in the gotchas you would otherwise hit on first try:\n" +
      "  • Pre-emptive Basic auth across Manage/Admin/App-Services (avoids the \n" +
      '    "unsupported auth scheme: [Basic realm=public]" challenge-response failure)\n' +
      "  • schemas-database.json + triggers-database.json stubs (avoids CMA-INVALIDPROPERTIES /\n" +
      "    ADMIN-NOSUCHDATABASE on first deploy when content-database.json references them)\n" +
      "  • Per-file `filename=value` syntax in collections.properties / permissions.properties\n" +
      "    (a global `collections=` key is silently ignored)\n" +
      "  • .tdej extension under ml-schemas/tde so the template auto-joins\n" +
      "    http://marklogic.com/xdmp/tde\n" +
      "  • REST extension stub plus a note that custom params must use the rs: prefix\n" +
      "  • Optional environment overlay (gradle-{env}.properties + dev-config/prod-config dirs)\n" +
      "\n" +
      "Returns a JSON object: { files: [{ path, content }, ...], next_steps: [...] }. The paths\n" +
      "are relative to the project root the agent intends to create.",
    {
      app_name: z
        .string()
        .min(1)
        .max(60)
        .describe(
          'Application name (becomes mlAppName). Used as a prefix for resources like "<name>-content", "<name>-modules".'
        ),
      rest_port: z
        .number()
        .int()
        .min(1024)
        .max(65535)
        .describe("Port for the REST API app server. Pick something not already in use on the cluster."),
      ml_host: z
        .string()
        .optional()
        .describe('Hostname or IP of a MarkLogic node (default: "localhost"). Use the same host the agent will run gradle from.'),
      test_rest_port: z
        .number()
        .int()
        .min(1024)
        .max(65535)
        .optional()
        .describe("If set, ml-gradle creates a parallel REST server for automated tests."),
      include_tde: z.boolean().optional().describe("Emit a starter TDE template under ml-schemas/tde/ (default: true)."),
      include_rest_extension: z
        .boolean()
        .optional()
        .describe("Emit a REST resource extension, transform, and search options (default: true)."),
      include_role: z.boolean().optional().describe("Emit two app-specific roles (reader/writer) under security/roles (default: false)."),
      include_data: z.boolean().optional().describe("Emit sample seed data under ml-data with collections.properties (default: true)."),
      include_environments: z
        .boolean()
        .optional()
        .describe("Emit gradle-dev.properties / gradle-prod.properties + dev-config / prod-config overlay dirs (default: false)."),
      ml_gradle_version: z
        .string()
        .optional()
        .describe('ml-gradle plugin version (default: "6.1.0"). 6.x requires Gradle 8.4+ and Java 17+.'),
    },
    async (args) => {
      const a = args as ScaffoldArgs;
      const files = buildScaffold(a);

      // Apply the same defaults buildScaffold uses, so next_steps reflects the
      // actually-emitted file set rather than the raw input.
      const includeData = a.include_data ?? true;
      const includeTde = a.include_tde ?? true;
      const includeRestExtension = a.include_rest_extension ?? true;
      const host = a.ml_host ?? "localhost";

      const next_steps: string[] = [
        "Write each entry from `files` to disk (relative paths from the project root).",
        "Run `gradle mlDeploy` from the project root.",
        "After deploy, run `gradle mlPrintTokens` to inspect token replacements.",
      ];
      if (includeData) {
        next_steps.push("Run `gradle mlLoadData` to load src/main/ml-data into the content DB.");
      }
      if (includeTde) {
        next_steps.push(
          "Use ml_views_list to confirm the TDE view registered after deploy."
        );
      }
      if (includeRestExtension) {
        next_steps.push(
          `Smoke-test: curl --digest -u admin:admin "http://${host}:${a.rest_port}/v1/resources/echo?rs:text=hi"`
        );
      }
      next_steps.push(
        "Tear down with `gradle mlUndeploy -Pconfirm=true` when finished (irreversible — destroys data)."
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ files, next_steps }, null, 2),
          },
        ],
      };
    }
  );
}
