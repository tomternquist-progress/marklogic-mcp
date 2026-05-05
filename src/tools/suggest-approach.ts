import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── Intent patterns → tool recommendations ────────────────────────────────────

interface ToolRecipe {
  tool: string;
  description: string;
  use_when: string[];
  recipe: Record<string, unknown>;
  rationale: string;
  not_this_tool?: string;
  warnings?: string[];
}

function classify(task: string): ToolRecipe[] {
  const t = task.toLowerCase();
  const results: ToolRecipe[] = [];

  // ── Bulk import / URL fetch / file ingestion ────────────────────────────────
  const isBulkImport =
    /import|load|ingest|csv|tsv|parquet|avro|orc|jdbc|s3\b|http url|download|open data|socrata|gdelt|data\.gov|bulk|thousand|million|records|rows|dataset/.test(t);
  const isUrlFetch =
    /http[s]?:\/\/|url|download|fetch|public data|open data|api endpoint|socrata|gdelt/.test(t);
  const isFileFormat =
    /\.csv|\.tsv|\.json|\.parquet|\.avro|\.orc|\.zip|\.gz|delimited|comma.separated|tab.separated/.test(t);

  if (isBulkImport || isUrlFetch || isFileFormat) {
    const isSocrata = /socrata|data\.gov|city.*data|resource\/.*\.json/.test(t);
    const isJdbc = /jdbc|postgres|mysql|oracle|sql server|database table/.test(t);
    const isS3 = /s3[a]?:\/\/|amazon s3|s3 bucket/.test(t);
    const isHeaderless = /no header|headerless|column.names|gdelt/.test(t);
    const isJson = /\.json|json.lines|ndjson/.test(t) && !isSocrata;

    const subcommand = isJdbc ? "import-jdbc"
      : isS3 && isJson ? "import-files"
      : isJson ? "import-files"
      : "import-delimited-files";

    const recipe: Record<string, unknown> = {
      subcommand,
      collections: ["<collection-name>"],
      generate_tde: true,
      tde_schema: "<schema>",
      tde_view: "<view>",
    };

    if (isJdbc) {
      recipe.jdbc_url = "jdbc:<driver>://<host>/<database>";
      recipe.jdbc_driver = "<driver-class>";
      recipe.query = "SELECT * FROM <table>";
      delete recipe.generate_tde;
    } else if (isS3) {
      recipe.path = "s3a://<bucket>/<prefix>/";
    } else if (isUrlFetch || isBulkImport) {
      recipe.http_url = isSocrata
        ? "https://<domain>/resource/<id>.csv?$limit=10000"
        : "<https://example.com/data.csv>";
      recipe.uri_template = "/data/{<id-field>}.json";
    }

    if (isHeaderless) {
      recipe.column_names = ["Col1", "Col2", "..."];
      recipe.extra_args = ["--delimiter", "\\t", "--ignore-null-fields"];
    }

    const warnings: string[] = [];
    if (isSocrata) {
      warnings.push(
        "Use /rows.csv (not /rows.json) — Socrata's /rows.json returns an array-of-arrays format, not an array of objects. " +
        "URL pattern: https://<domain>/resource/<id>.csv?$limit=<n>"
      );
    }
    if (isJdbc) {
      warnings.push("JDBC driver JAR must be present in the flux-runner classpath.");
    }

    results.push({
      tool: "flux_import",
      description: "Bulk data import from URL, file, JDBC, or S3",
      use_when: ["bulk-import", "http-fetch", "csv", "json", "parquet", "jdbc", "s3", "tde-generation"],
      recipe,
      rationale:
        "flux_import handles HTTP fetch, format parsing, parallel batching, and optional TDE view generation in a single tool call. " +
        "It is 10–100× faster than manual approaches for bulk loads and avoids the ~10 KB eval payload limit entirely.",
      not_this_tool:
        "Do NOT use ml_eval_javascript (10 KB payload cap, no parallelism) or ml_document_put (one document at a time) for bulk loads.",
      warnings: warnings.length ? warnings : undefined,
    });
  }

  // ── Analytics / aggregation / reporting ────────────────────────────────────
  const isAnalytics =
    /aggregat|count|group.?by|sum\b|avg\b|average|max\b|min\b|analytic|report|dashboard|top \d|rank|totals?/.test(t);
  const isTimeSeries = /time.?series|over time|trend|daily|weekly|monthly|by (date|month|year)/.test(t);

  if (isAnalytics && !isTimeSeries) {
    results.push({
      tool: "ml_optic_query",
      description: "Aggregation and analytics over a TDE view",
      use_when: ["analytics-aggregation", "tde-view", "group-by", "sql-like"],
      recipe: {
        plan: {
          $optic: {
            ns: "op", fn: "operators", args: [
              { ns: "op", fn: "from-view", args: ["<schema>", "<view>"] },
              { ns: "op", fn: "group-by", args: [
                { ns: "op", fn: "col", args: ["<dimension-column>"] },
                [{ ns: "op", fn: "count", args: ["count", { ns: "op", fn: "col", args: ["<any-col>"] }] }]
              ]},
              { ns: "op", fn: "order-by", args: [{ ns: "op", fn: "desc", args: [{ ns: "op", fn: "col", args: ["count"] }] }] },
              { ns: "op", fn: "limit", args: [20] },
            ],
          },
        },
      },
      rationale:
        "ml_optic_query runs SQL-like row operations over TDE views — ideal for GROUP BY, aggregations, and multi-table joins. " +
        "Requires a TDE template in the Schemas database (use flux_import with generate_tde=true, or ml_schema_discover to find existing views).",
      warnings: [
        "Run ml_schema_discover or ml_indexes_list first to confirm TDE views exist.",
        "TDE template must be in the Schemas database under collection 'http://marklogic.com/xdmp/tde'.",
      ],
    });
  }

  if (isTimeSeries) {
    results.push({
      tool: "ml_timeseries_query",
      description: "Time-bucketed aggregation over a date/time field",
      use_when: ["time-series", "trend", "date-bucketing"],
      recipe: {
        schema: "<schema>",
        view: "<view>",
        time_field: "<date-or-datetime-column>",
        metric_field: "<numeric-column>",
        aggregation: "count",
        bucket: "day",
      },
      rationale:
        "ml_timeseries_query produces date-bucketed counts or sums in a single call, returning chart-ready data without manual Optic GROUP BY construction.",
      warnings: ["Requires a TDE view with a date/dateTime column for the time_field."],
    });
  }

  // ── Full-text / keyword search ──────────────────────────────────────────────
  const isSearch =
    /search|find|query|full.?text|keyword|word|contains|mention|document.*about/.test(t) &&
    !/import|ingest|load/.test(t);

  if (isSearch) {
    results.push({
      tool: "ml_search",
      description: "Full-text and structured document search",
      use_when: ["full-text-search", "keyword-search", "document-retrieval"],
      recipe: {
        q: "<search terms>",
        collection: "<collection-name>",
        page_length: 20,
      },
      rationale:
        "ml_search uses MarkLogic's Universal Index — no TDE or range index required for basic word queries. " +
        "Use ml_optic_query for exact-match structured filtering or aggregations.",
    });
  }

  // ── Hybrid: full-text search + aggregation ──────────────────────────────────
  // Detect goals that combine content scoping with aggregation — these need
  // Optic fromSearch, not a choice between ml_search OR ml_optic_query.
  const isHybrid =
    isSearch && isAnalytics && !isTimeSeries;

  if (isHybrid) {
    // Remove the standalone ml_search suggestion added above — the hybrid plan supersedes it
    const searchIdx = results.findIndex(r => r.tool === "ml_search");
    if (searchIdx !== -1) results.splice(searchIdx, 1);
    // Remove any standalone ml_optic_query suggestion too
    const opticIdx = results.findIndex(r => r.tool === "ml_optic_query");
    if (opticIdx !== -1) results.splice(opticIdx, 1);

    results.unshift({
      tool: "ml_optic_query (fromSearch + Optic pipeline)",
      description: "Hybrid: full-text content scoping followed by aggregation or GROUP BY",
      use_when: ["hybrid-search-aggregate", "search-then-count", "search-then-group"],
      recipe: {
        plan: {
          $optic: {
            ns: "op", fn: "operators", args: [
              {
                ns: "op", fn: "from-search",
                args: [{ ns: "cts", fn: "word-query", args: ["<search term>"] }],
              },
              {
                ns: "op", fn: "join-inner",
                args: [
                  { ns: "op", fn: "from-view", args: ["<schema>", "<view>"] },
                  { ns: "op", fn: "on", args: [
                    { ns: "op", fn: "fragment-id-col", args: [] },
                    { ns: "op", fn: "fragment-id-col", args: [] },
                  ]},
                ],
              },
              { ns: "op", fn: "group-by", args: [
                { ns: "op", fn: "col", args: ["<dimension-column>"] },
                [{ ns: "op", fn: "count", args: ["count", { ns: "op", fn: "col", args: ["<any-col>"] }] }],
              ]},
              { ns: "op", fn: "order-by", args: [{ ns: "op", fn: "desc", args: [{ ns: "op", fn: "col", args: ["count"] }] }] },
              { ns: "op", fn: "limit", args: [20] },
            ],
          },
        },
        strip_schema_prefix: true,
      },
      rationale:
        "When you need to BOTH filter by document content (full-text) AND aggregate/group results, " +
        "use Optic fromSearch as the source with a cts query for scoping, then join to a TDE view to access " +
        "structured columns for GROUP BY. This is faster than fetching all search results and post-processing them. " +
        "Requires a TDE view — verify with ml_views_list.",
      not_this_tool:
        "Do NOT use ml_search for aggregation (returns documents, not counts). " +
        "Do NOT use ml_optic_query fromView alone if you need content-based filtering.",
      warnings: [
        "Requires a TDE view in the Schemas database — use flux_import with generate_tde=true or ml_schema_get_tde to verify.",
        "fromSearch joins via fragment IDs — the TDE view must cover the same documents as the search collection.",
        "Run ml_views_list and ml_indexes_list before building this query.",
        "Use the query_approach_advisor prompt to get a complete, filled-in plan for your specific goal.",
      ],
    });
  }

  // ── Schema / TDE discovery ──────────────────────────────────────────────────
  const isSchemaDiscovery =
    /schema|tde|view|template|what.*fields|what.*columns|structure|discover|indexes?/.test(t) &&
    !/generate|create|build|install|write|store/.test(t);

  if (isSchemaDiscovery) {
    results.push({
      tool: "ml_schema_discover",
      description: "Discover existing TDE schemas and views",
      use_when: ["schema-discovery", "tde-exploration"],
      recipe: {
        database: "<database-name>",
      },
      rationale:
        "ml_schema_discover lists all TDE schemas and views already installed in the Schemas database. " +
        "Run this before ml_optic_query to confirm view names.",
      not_this_tool: "If no views exist yet, use flux_import with generate_tde=true to auto-generate a TDE from an imported collection.",
    });
  }

  // ── Single document write / TDE install / module install ───────────────────
  const isSingleWrite =
    /write|insert|create|update|put|store|install/.test(t) &&
    /document|tde|template|module|schema|config/.test(t) &&
    !isBulkImport;

  if (isSingleWrite) {
    results.push({
      tool: "ml_document_put",
      description: "Write a single document, TDE template, or module",
      use_when: ["single-document-write", "tde-template-install", "module-install"],
      recipe: {
        uri: "/path/to/document.json",
        content: "<JSON or XML string>",
        content_type: "application/json",
        collections: ["<collection>"],
        database: "<database>",
      },
      rationale:
        "ml_document_put is the right tool for installing TDE templates (database=Schemas), SJS/XQuery modules (database=Modules), or writing a small number of individual documents.",
      not_this_tool: "Do NOT use ml_document_put in a loop for bulk loads — use flux_import instead.",
    });
  }

  // ── Project setup / ml-gradle / DHF ────────────────────────────────────────
  // Detect intent to CREATE a new project, set up infrastructure, add indexes, or deploy config.
  // Broadened to also catch "build me an app", "deploy", "production", "REST extension",
  // "scaffold", "what should the project look like", and similar phrasings — anything that
  // implies repeatable / source-controlled / multi-environment work, not one-off exploration.
  const isProjectSetup =
    /\b(new|create|set.?up|scaffold|bootstrap|build.out|structure|initializ|start|begin|template).*\b(project|app|application|repo|repository|service|backend|api)\b/.test(t) ||
    /\b(build|create|develop|stand.?up|spin.?up)\b.{0,30}?\b(a|an|my|our|the|new)\b.*\b(app|application|service|backend|api|endpoint|project|repo)\b/.test(t) ||
    /\bml.?gradle\b|\bdhf\b|\bdata.hub\b|\bproject.structure\b|\bproject.layout\b/.test(t) ||
    /\bdeploy(?!ed).*\b(index|indexes|tde|module|schema|extension|app|application|production|prod\b)/.test(t) ||
    /\badd.*\b(index|range.index|geospatial)|\bcontent-database\.json\b|\brange.index\b|\bgeopatial.index\b/.test(t) ||
    /\b(rest.extension|resource.extension|rest.transform|rest.service|services\/|transforms\/|metadata.xml)\b/.test(t) ||
    /\b(production|prod|staging|environment|multi.environment|repeatable|ci\/cd|pipeline|source.control|version.control)\b.*\b(deploy|app|project|config)/.test(t);

  // Don't suggest project setup for pure query / search / import-once work.
  // But DO suggest it when the user mentions both query-ish words AND project words —
  // e.g. "I want to build an app that searches my docs" — the project intent dominates.
  const isPureExploration =
    /^\s*(query|search|find|import|load|fetch|get|show|list|count|aggregate)\b/.test(t) &&
    !/\b(project|app|application|repo|deploy|scaffold|extension|production|environment)\b/.test(t);

  if (isProjectSetup && !isPureExploration) {
    results.push({
      tool: "ml_gradle_scaffold (TOOL — call this first for new projects)",
      description: "Generate a deploy-ready ml-gradle project as a JSON file map (paths + contents)",
      use_when: ["new-project", "scaffold", "ml-gradle", "starter", "bootstrap"],
      recipe: {
        tool: "ml_gradle_scaffold",
        app_name: "<lowercase-hyphenated-name>",
        rest_port: "<unused-port-on-the-cluster, e.g. 8040>",
        ml_host: "<ML hostname or IP>",
        include_tde: true,
        include_rest_extension: true,
        include_role: false,
        include_data: true,
        include_environments: false,
        next_steps: [
          "Write each entry from the returned `files` array to disk under a project root.",
          "Run `gradle mlDeploy` from that root.",
          "Run `gradle mlLoadData` if include_data was true.",
          "Iterate: edit modules, run `gradle mlReloadModules` (or `gradle mlWatch` for hot reload).",
        ],
      },
      rationale:
        "Use `ml_gradle_scaffold` (not the prompt, not raw ml_document_put / ml_extension_put) any time " +
        "the user is starting a new project, building a custom REST endpoint, or putting MarkLogic config under " +
        "version control. The tool returns a JSON file map with the four most common first-deploy gotchas " +
        "already addressed: pre-emptive Basic auth, schemas/triggers DB stubs, per-file collections.properties " +
        "syntax, and the rs:-prefix nuance for REST extensions. After scaffolding, the project_setup_advisor " +
        "prompt covers deeper customization (custom roles, env overlays, multi-DB topologies, DHF migration).",
      not_this_tool:
        "Do NOT scaffold via ad-hoc ml_document_put / ml_extension_put / flux_import calls when the user " +
        "needs a repeatable, source-controlled deployment. Those tools are for exploration; ml_gradle_scaffold " +
        "produces a checked-in artifact you can deploy from CI/CD without the MCP server.",
      warnings: [
        "Pick `rest_port` carefully — collisions with existing servers cause cryptic deploy failures. " +
          "Run ml_servers_list first to see what's already configured.",
        "If your cluster's Manage server uses Basic auth (returns WWW-Authenticate: Basic), the scaffold's " +
          "`mlAuthentication=basic` block handles it. If it uses Digest, replace with `mlManageAuthentication=digest`.",
      ],
    });

    results.push({
      tool: "project_setup_advisor (prompt)",
      description: "Deeper guidance after scaffolding — DHF vs plain ml-gradle, indexes, custom roles",
      use_when: ["project-customization", "dhf", "indexes", "security", "post-scaffold"],
      recipe: {
        step1: "First run ml_gradle_scaffold to get a working starter project.",
        step2: "Invoke the project_setup_advisor prompt with your domain and requirements for deeper guidance.",
        step3: "The prompt covers: framework choice (ml-gradle vs DHF), index design for query patterns, " +
          "TDE template authoring, security config, and deployment checklist.",
        standard_layout: {
          "src/main/ml-config/databases/content-database.json": "range/geospatial indexes, triple-index, collection-lexicon",
          "src/main/ml-config/databases/{schemas,triggers}-database.json": "REQUIRED stubs if content-db references them",
          "src/main/ml-config/security/roles/": "custom app roles (e.g. <app>-reader, <app>-writer)",
          "src/main/ml-modules/services/<name>.{sjs,xqy}": "REST resource extensions → /v1/resources/<name>",
          "src/main/ml-modules/services/metadata/<name>.xml": "optional title/description/param docs",
          "src/main/ml-modules/transforms/<name>.{sjs,xqy,xsl}": "REST transforms → ?transform=<name>",
          "src/main/ml-modules/options/<name>.xml": "named search options → /v1/search?options=<name>",
          "src/main/ml-modules/root/lib/foo.sjs": "library modules at /lib/foo.sjs",
          "src/main/ml-schemas/tde/<view>.tdej": "TDE templates — deploy via 'gradle mlLoadSchemas'",
          "src/main/ml-data/<dir>/<doc>.json": "seed data — collections.properties is per-file: <filename>=...",
          "gradle.properties": "mlHost, mlRestPort, mlUsername, mlPassword, mlAppName, mlAuthentication",
          "gradle-{env}.properties": "per-environment overrides (with net.saliman.properties plugin)",
          "build.gradle": "ml-gradle plugin + optional Flux Exec tasks for data loading",
        },
        load_data_via_flux: {
          rdf_graphs: "flux import-rdf-files --path data/ontology/*.ttl --graph <uri> --connection-string user:pass@host:port",
          entity_docs: "flux import-files --path data/seed/{type}/ --collections kg-entity,kg-{type} --uri-template /kg/{type}/{id}.json",
          gradle_task: "tasks.create('loadMovies', Exec) { commandLine([fluxBin, 'import-files', '--path', ...] + connArgs) }",
        },
      },
      rationale:
        "After scaffolding, use this prompt for the parts ml_gradle_scaffold can't decide for you: " +
        "what indexes to add, whether to use DHF, how to structure security roles, and how to wire " +
        "Flux data-loading commands into the Gradle build. " +
        "Indexes live in content-database.json and require a reindex after deployment " +
        "(check ml_reindex_status). TDE templates in ml-schemas/tde/ are deployed via 'gradle mlLoadSchemas' " +
        "and are immediately queryable without reimporting data.",
      warnings: [
        "MCP tools (flux_import, ml_document_put) are for exploration and prototyping. " +
          "For a repeatable project pipeline, wire Flux CLI commands into Gradle Exec tasks in build.gradle.",
        "TDE deployment via ml_document_put works for prototyping, but 'gradle mlLoadSchemas' is the " +
          "canonical deploy path — it picks up all templates in src/main/ml-schemas/tde/ automatically.",
        "Never manually edit hub-internal-config/ in DHF projects — it is managed by DHF tooling.",
        // DHF-specific operational gotchas (learned from DHF 5.8.1 + Java 21 + Kubernetes session)
        "DHF + Java 21: 'gradle mlDeployApp' and 'gradle hubDeploy' fail with IllegalAccessError on " +
          "URLDecoder (bytecode-level access violation, --add-opens cannot fix it). " +
          "Use individual tasks instead: hubInstallModules → hubDeployAsSecurityAdmin → " +
          "mlDeployDatabases → mlDeployTriggers → hubDeployArtifacts → hubDeployUserArtifacts.",
        "DHF port defaults conflict with other MarkLogic servers. Always override in gradle.properties: " +
          "mlStagingPort=8020, mlFinalPort=8021, mlJobsPort=8022.",
        "DHF auth: mlAuthentication=basic (ml-gradle 4.5.0+) sets all four auth sub-properties at once " +
          "and is sufficient — DHF does not require Digest auth.",
        "DHF in Kubernetes / single-host clusters: DHF creates one forest per cluster host per database. " +
          "If cluster nodes are offline, every DHF database hangs (TCP connects but HTTP never responds). " +
          "Fix: use ml_database_set_forests to restrict each database to only forests on running hosts.",
        "DHF mapping XSLT: the compiled XSLT for each mapping step is generated by a MarkLogic trigger, " +
          "not by Gradle. Run 'gradle mlDeployTriggers' before the first flow run. If the XSLT is still " +
          "missing, touch the step document in STAGING to re-fire the trigger: " +
          "declareUpdate(); xdmp.nodeReplace(cts.doc(uri), cts.doc(uri));",
      ],
    });
  }

  // ── Graph / semantic / SPARQL ───────────────────────────────────────────────
  const isGraph =
    /sparql|triple|graph|semantic|rdf|owl|ontolog|subject|predicate|object/.test(t);

  if (isGraph) {
    results.push({
      tool: "ml_sparql_query",
      description: "Query the MarkLogic semantic triple store",
      use_when: ["graph-query", "sparql", "rdf", "semantic"],
      recipe: {
        sparql: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 20",
        database: "<database>",
      },
      rationale: "ml_sparql_query executes SPARQL 1.1 against MarkLogic's built-in triple store.",
      warnings: [
        "Run ml_graphs_list first to discover named graph URIs.",
        "For raw RDF file imports, use flux_import (subcommand=import-rdf-files) then flux_reprocess " +
          "to convert managed triples into entity-oriented documents (one doc per subject IRI).",
      ],
    });
  }

  // ── RDF / knowledge graph modelling ─────────────────────────────────────────
  // Detect goals about DESIGNING or LOADING entity/relationship data, not just querying.
  const isRdfModeling =
    /knowledge.?graph|entity.*relation|ontolog|link.*data|rdf.*import|turtle|n.?triple|rdf.*model|load.*rdf|import.*rdf/.test(t) &&
    !/sparql|select|where|query/.test(t);

  if (isRdfModeling) {
    results.push({
      tool: "data_modeling_advisor (prompt) + flux_import + flux_reprocess",
      description: "Design and load entity-oriented RDF data into MarkLogic",
      use_when: ["rdf-modeling", "knowledge-graph-design", "entity-oriented-documents"],
      recipe: {
        step1_design: "Call data_modeling_advisor prompt with your domain description",
        step2_import: {
          tool: "flux_import",
          subcommand: "import-rdf-files",
          path: "<local-path-or-url-to-turtle-or-ntriples>",
          collections: ["managed-triples"],
        },
        step3_inspect: {
          tool: "ml_sparql_query",
          sparql: "SELECT DISTINCT ?type (COUNT(?s) AS ?count) WHERE { ?s a ?type } GROUP BY ?type ORDER BY DESC(?count)",
        },
        step4_reprocess: {
          tool: "flux_reprocess",
          collections: ["managed-triples"],
          javascript_transform: "// Group triples by IRI, write one entity doc per subject",
        },
      },
      rationale:
        "MarkLogic's preferred pattern is entity-oriented: one document per entity, " +
        "with subject IRI = document URI, and triples embedded inside the document using the 'triple' JSON key (unmanaged format). " +
        "This co-locates structured properties and graph edges in one fragment — cts.search and SPARQL " +
        "both find the entity. Raw RDF files are best imported as managed triples first (fast, lossless), " +
        "then reprocessed into entity documents grouped by subject IRI.",
      warnings: [
        "Do NOT import raw RDF and leave it as managed triples — cts.search will not find entity documents.",
        "Group triples by IRI where reasonable. Do not create documents with thousands of triples from unrelated subjects.",
        "Use the data_modeling_advisor prompt to design the entity document structure before importing.",
      ],
    });
  }

  // ── Vector similarity search / embeddings / RAG ─────────────────────────────
  const isVector =
    /vector|embedding|similar|nearest.neighbor|knn\b|semantic.search|rag\b|cosine|retrieval.augment|recommend.*based.*on|find.*like/.test(t);

  if (isVector) {
    results.push({
      tool: "ml_vector_search",
      description: "Find k nearest neighbours by cosine similarity over a TDE vec:vector column",
      use_when: ["vector-search", "knn", "rag", "embeddings", "semantic-similarity"],
      recipe: {
        schema: "<schema>",
        view: "<view>",
        vector_column: "<embedding-column-name>",
        query_vector: ["<float>", "..."],
        k: 10,
      },
      rationale:
        "ml_vector_search uses Optic vec:cosine-similarity over a TDE view — no eval required. " +
        "Store your embeddings as a JSON float array in each document, then define a TDE column " +
        "with scalar type 'vec:vector'. For hybrid queries (filter by category THEN find similar), " +
        "use ml_optic_query directly with bind(vec:cosine-similarity(...)) + where() + order-by. " +
        "MarkLogic 12+ required.",
      not_this_tool:
        "Do NOT use ml_eval_javascript for vector search — use ml_vector_search (Optic path) instead.",
      warnings: [
        "Requires a TDE view with a vec:vector column — use ml_views_list to verify.",
        "query_vector dimensions must match stored vector dimensions exactly.",
        "Use the data_modeling_advisor prompt to design the embedding storage and TDE schema.",
        "For large collections, add a where() pre-filter before the cosine similarity computation.",
      ],
    });
  }

  // ── Multi-model design (Documents + Triples + Vectors) ───────────────────────
  const isMultiModel =
    (isGraph || isRdfModeling || isVector) &&
    (isBulkImport || isSearch || isAnalytics) &&
    !isHybrid;

  if (isMultiModel) {
    results.push({
      tool: "data_modeling_advisor (prompt)",
      description: "Multi-model architecture design for Documents + Triples + Vectors",
      use_when: ["multi-model", "knowledge-graph", "rag-architecture", "combined-models"],
      recipe: {
        prompt: "data_modeling_advisor",
        domain: "<describe your entities, relationships, and query goals>",
        models: ["documents", "triples", "vectors"],
        query_goals: "<search, graph traversal, similarity search, aggregation>",
      },
      rationale:
        "When your problem combines full-text search, entity graph traversal, and vector similarity, " +
        "start with data_modeling_advisor to design the combined architecture before importing any data. " +
        "This prevents costly re-imports caused by a mismatched data model.",
      warnings: [
        "Design the entity document structure before importing — the reprocess step is avoidable with upfront design.",
        "Vectors require MarkLogic 12+; triples and documents work on all ML versions.",
      ],
    });
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  const isExport =
    /export|extract|download from marklogic|dump|backup|send.*to|push.*to/.test(t) &&
    !/import|load|ingest/.test(t);

  if (isExport) {
    results.push({
      tool: "flux_export",
      description: "Export documents from MarkLogic to file, S3, or JDBC",
      use_when: ["export", "extract", "bi-integration"],
      recipe: {
        subcommand: "export-files",
        collections: ["<source-collection>"],
        path: "/tmp/export-output/",
      },
      rationale:
        "flux_export reads from MarkLogic in parallel batches and writes to local disk, S3, Parquet, Avro, or a JDBC target. " +
        "Use subcommand='export-parquet-files' for BI/analytics downstream consumption.",
    });
  }

  // ── Server-side logic / custom transformation ───────────────────────────────
  const isEval =
    /custom logic|transformation|xdmp|cts\.|built.?in|server.?side|xquery|sjs|javascript|compute|calculate|server.*function/.test(t) &&
    !isBulkImport;

  if (isEval) {
    results.push({
      tool: "ml_eval_javascript",
      description: "Server-side JavaScript for custom logic and MarkLogic built-ins",
      use_when: ["server-side-logic", "xdmp-access", "cts-access", "custom-transformation"],
      recipe: {
        javascript: "// Your SJS here\n'result';",
        vars: { myVar: "<value>" },
        database: "<database>",
      },
      rationale:
        "ml_eval_javascript is the right tool for calling MarkLogic built-ins (xdmp.*, cts.*) not exposed by other tools, " +
        "running custom in-database transformations, or one-off read/write operations on a small number of documents.",
      not_this_tool:
        "Do NOT use for bulk inserts or URL-fetched data — use flux_import for anything beyond ~5 documents.",
      warnings: [
        "~10 KB script payload limit — pass large arrays/strings via the vars parameter.",
        "xdmp.httpGet() requires outbound network access from the MarkLogic host — may be blocked.",
      ],
    });
  }

  // ── Semaphore classification / content enrichment ───────────────────────────
  const isClassification =
    /classif|semaphore|categori|tag|taxonom|concept|label|automat.*tag|enrichment|metadata.*enrich|nlp|named.entity|annotation/.test(t);
  const isTaxonomyLoad =
    /load.*taxon|import.*skos|skos.*load|import.*vocab|vocab.*import|publish.*taxon|taxon.*publish|iptc|eurovoc|agrovoc|unesco.*thesaur|media.*topic/.test(t);
  const isTaxonomyCreate =
    /create.*taxon|new.*taxon|build.*taxon|generat.*taxon|taxon.*creat|taxon.*from.scratch|scaffold.*taxon|taxon.*scaffold/.test(t);
  const isBulkClassification =
    isClassification && (isBulkImport || /bulk|all docs|collection|reprocess|pipeline/.test(t));
  const isTemplateDesign =
    /kid|velocity.*templ|templ.*velocity|rule.*templ|templ.*rule|templ.*design|design.*templ|weight.*tun|tun.*weight|false.positive|missing.match|classif.*qualit|qualit.*classif|classif.*tun|tun.*classif|zone.*bias|bias.*zone|short.text|headline.*classif|classif.*headline/.test(t);

  // ── Velocity template design / classification quality tuning ────────────────
  if (isTemplateDesign) {
    results.push({
      tool: "semaphore_kid_template_diagnose → semaphore_kid_template_set → semaphore_publish → semaphore_classify",
      description: "Diagnose a classification quality problem and tune the Semaphore velocity template",
      use_when: ["template-tuning", "classification-quality", "false-positives", "missing-matches", "weight-tuning", "zone-biasing"],
      recipe: {
        step1_diagnose: {
          tool: "semaphore_kid_template_diagnose",
          symptom: "<false_positives | missing_matches | score_too_uniform | hierarchy_not_firing | nearlist_noise | short_text_poor | zone_ignored | associative_overfiring>",
          model_uri: "model:<ModelName>",
          concept_uri: "<optional — concept that is misfiring>",
          example_text: "<optional — text that misbehaves>",
          note: "Returns a ranked action plan. Try label editing first before template changes.",
        },
        step2_inspect_current_template: {
          tool: "semaphore_kid_template_get",
          model_uri: "model:<ModelName>",
          note: "See current weights before changing them.",
        },
        step3_apply_preset_or_weights: {
          tool: "semaphore_kid_template_set",
          model_uri: "model:<ModelName>",
          preset: "<balanced | short_text | exact_only | precision | hierarchy_heavy | entity>",
          note: "Use preset first; override individual weights if needed. Add title_weight/body_weight for zone-biasing.",
        },
        step4_rebuild_rules: {
          tool: "semaphore_publish",
          model_uri: "model:<ModelName>",
          wait_for_completion: true,
        },
        step5_verify: {
          tool: "semaphore_classify",
          content: "<sample text>",
          threshold: 0,
          note: "Compare scores before/after to validate the change.",
        },
      },
      rationale:
        "The .kid file is a Velocity template that controls HOW the Semaphore publisher generates CLS rules " +
        "from each taxonomy concept. It defines scoring weights for: exact phrase matches (phraselist), " +
        "near-word matches (nearlist), child-to-parent hierarchy propagation (LowerInHierarchy linklist), " +
        "and associative-link propagation. Tuning these weights is a GLOBAL change affecting every concept " +
        "in the model — always prefer fixing individual concept labels first (semaphore_concept_labels_update) " +
        "before reaching for template tuning. Use semaphore_kid_template_diagnose to identify whether the " +
        "problem is label-level (surgical fix) or systematic (template fix).",
      warnings: [
        "Template changes affect ALL concepts in the model — test on both true-positive and false-positive examples.",
        "nearlist_weight has NO effect on single-word concept labels; those always score via phraselist only.",
        "Zone-biasing (title_weight/body_weight) only works if your documents have reliable title/body CLS zones.",
        "Always run semaphore_publish after any template change — the CLS rule set must be rebuilt.",
        "Use preset=exact_only first when debugging: it isolates phrase-match behaviour, removing nearlist/hierarchy noise.",
      ],
    });

    // Add label-first reminder if symptoms suggest it might be a label issue
    results.push({
      tool: "semaphore_concept_get → semaphore_concept_labels_update → semaphore_publish",
      description: "Fix classification quality at the label level (cheaper than template tuning)",
      use_when: ["false-positives", "missing-matches", "label-edit", "synonym-add"],
      recipe: {
        step1_find_concept: {
          tool: "semaphore_concept_search",
          model_uri: "model:<ModelName>",
          query: "<concept label>",
        },
        step2_inspect_labels: {
          tool: "semaphore_concept_get",
          model_uri: "model:<ModelName>",
          concept_uri: "<from search results>",
          note: "Look for overly broad altLabels causing false positives, or missing synonyms causing missed matches.",
        },
        step3_edit_label: {
          tool: "semaphore_concept_labels_update",
          model_uri: "model:<ModelName>",
          concept_uri: "<concept uri>",
          action: "<add | remove>",
          label_type: "<altLabel | hiddenLabel | prefLabel>",
          label_value: "<the label text>",
        },
        step4_publish_verify: {
          tool: "semaphore_publish → semaphore_classify",
        },
      },
      rationale:
        "Label edits are surgical — they fix one concept without affecting others. Always try this before " +
        "changing the velocity template. Common patterns: (1) false positive → remove the overly-broad altLabel; " +
        "(2) missed match → add altLabel synonyms; (3) abbreviation matching → add hiddenLabel for the abbreviation.",
      not_this_tool:
        "If the quality problem is systematic (affects most/all concepts, not just one), use template tuning instead.",
    });
  }

  // ── Create new taxonomy from scratch ────────────────────────────────────────
  if (isTaxonomyCreate) {
    results.push({
      tool: "semaphore_taxonomy_scaffold → semaphore_kmm_model_create → semaphore_kmm_skos_load → semaphore_kmm_sparql_update (SKOS-XL) → semaphore_publish_config_fix_plain_skos → semaphore_publish",
      description: "End-to-end pipeline to create a new taxonomy from scratch and publish it to the Classification Server",
      use_when: ["create-taxonomy", "new-taxonomy", "build-taxonomy", "scaffold-taxonomy"],
      recipe: {
        step1_scaffold: {
          tool: "semaphore_taxonomy_scaffold",
          scheme_name: "<e.g. 'AWS Services Taxonomy'>",
          scheme_id: "<CamelCase e.g. 'AWSServices'>",
          namespace: "<e.g. 'http://example.com/taxonomy/aws/'>",
          top_concepts: "<array of { id, label, narrower: [{ id, label, alt_labels }] }>",
          note: "Generates SKOS Turtle with skos:prefLabel and skos:altLabel stubs on every concept. Edit the output to add real synonyms before loading.",
        },
        step2_create_model: {
          tool: "semaphore_kmm_model_create",
          name: "<same as scheme_id>",
          default_namespace: "<same namespace as scaffold>",
        },
        step3_load_skos: {
          tool: "semaphore_kmm_skos_load",
          model_uri: "model:<ModelName>",
          skos_content: "<Turtle from step 1>",
        },
        step4_skosxl_backfill: {
          tool: "semaphore_kmm_sparql_update",
          model_uri: "model:<ModelName>",
          sparql: "PREFIX skos: <http://www.w3.org/2004/02/skos/core#> PREFIX skosxl: <http://www.w3.org/2008/05/skos-xl#> INSERT { ?c skosxl:prefLabel ?n . ?n a skosxl:Label . ?n skosxl:literalForm ?l . } WHERE { { ?c a skos:Concept } UNION { ?c a skos:ConceptScheme } ?c skos:prefLabel ?l . BIND(IRI(CONCAT(STR(?c),\"/xlabels/\",LANG(?l),\"/pref/\",ENCODE_FOR_URI(STR(?l)))) AS ?n) FILTER NOT EXISTS { ?n a skosxl:Label } }",
          note: "REQUIRED — without this, Studio shows 'No preferred labels' / 'Create a preferred label' on every concept even though skos:prefLabel triples exist. Studio's Preferred Labels panel manages SKOS-XL labels, not plain SKOS.",
        },
        step5_fix_publisher_config: {
          tool: "semaphore_publish_config_fix_plain_skos",
          model_uri: "model:<ModelName>",
          note: "Adds GRAPH clause + plain SKOS label queries. Required to avoid the '1 rule only' silent failure.",
        },
        step6_publish: {
          tool: "semaphore_publish",
          model_uri: "model:<ModelName>",
          wait_for_completion: true,
        },
        step7_test: {
          tool: "semaphore_classify",
          content: "<sample text mentioning concepts from the taxonomy>",
          threshold: 0,
        },
      },
      rationale:
        "Creating a taxonomy from scratch requires the SKOS-XL backfill (step 4) immediately after loading. " +
        "This is the most commonly skipped step: the scaffold generates correct skos:prefLabel triples, " +
        "but Semaphore Studio's 'Preferred Labels' panel displays SKOS-XL labels (skosxl:prefLabel), not plain skos:prefLabel. " +
        "Without the backfill, Studio shows 'No preferred labels' / 'Create a preferred label' on every concept " +
        "even though the data is correct — leading to the false impression that the taxonomy was not generated properly. " +
        "The SKOS-XL backfill SPARQL creates skosxl:Label nodes from the existing skos:prefLabel triples.",
      warnings: [
        "SKOS-XL backfill (step 4) is MANDATORY for new taxonomies — do not skip it.",
        "If you see 'Create a preferred label' in Studio after loading, run the SKOS-XL backfill SPARQL.",
        "semaphore_publish_config_fix_plain_skos is also required to avoid the '1 rule only' publish failure.",
      ],
    });
  }

  // ── Taxonomy loading pipeline ────────────────────────────────────────────────
  if (isTaxonomyLoad) {
    results.push({
      tool: "semaphore_kmm_model_create → semaphore_kmm_skos_load → semaphore_publish_config_fix_plain_skos → semaphore_publish",
      description: "End-to-end pipeline to load a SKOS taxonomy into Semaphore and publish it to the Classification Server",
      use_when: ["load-taxonomy", "skos-import", "publish-taxonomy", "iptc", "eurovoc", "agrovoc"],
      recipe: {
        step1_create_model: {
          tool: "semaphore_kmm_model_create",
          name: "<ModelName e.g. IPTCMediaTopics>",
          default_namespace: "<e.g. http://cv.iptc.org/newscodes/mediatopic/>",
        },
        step2_load_skos: {
          tool: "semaphore_kmm_skos_load",
          model_uri: "model:<ModelName>",
          skos_url: "<public RDF URL — must return RDF/XML, Turtle, or JSON-LD>",
        },
        step3_fix_publisher_config: {
          tool: "semaphore_publish_config_fix_plain_skos",
          model_uri: "model:<ModelName>",
          note: "Adds GRAPH clause + plain SKOS label queries. Bootstraps workspace automatically if needed. Fixes the '1 rule only' silent failure.",
        },
        step4_publish: {
          tool: "semaphore_publish",
          model_uri: "model:<ModelName>",
          wait_for_completion: true,
          note: "After publish, the tool compares estimated rules vs KMM concept count and warns if disproportionately low.",
        },
        step5_diagnose_if_needed: {
          tool: "semaphore_publish_diagnose",
          model_uri: "model:<ModelName>",
          note: "Run this if rule count looks wrong — it compares KMM concepts vs CLS rules and explains the fix.",
        },
        step6_test: {
          tool: "semaphore_classify",
          content: "<sample text mentioning concepts from the taxonomy>",
          threshold: 0,
        },
      },
      rationale:
        "Loading a SKOS taxonomy into Semaphore requires 5 steps (all via API, no Studio interaction needed). " +
        "The critical non-obvious one is semaphore_publish_config_fix_plain_skos: the publisher's SPARQL " +
        "endpoint is a global store where each model's data lives in a named graph (urn:x-evn-master:{ModelName}). " +
        "Without the GRAPH clause fix, ALL label queries return empty → only 1 rule is published (the " +
        "ConceptScheme root) → classification returns nothing. This silent failure is the most common issue. " +
        "The tool also auto-bootstraps the publisher workspace (triggering an initial publish as a side effect) " +
        "so no manual Studio interaction is needed. " +
        "NOTE: sem:guid is auto-generated by KMM when loading via semaphore_kmm_skos_load — no manual step needed.",
      warnings: [
        "ONE-TIME GLOBAL SETUP: A CLS environment must be configured in Studio Admin once " +
        "(Administration → Publisher → Classification Server Environments → Add). After that, all " +
        "subsequent model publishes auto-discover it — no per-model Studio steps needed.",
        "After publish, if classification returns nothing, run semaphore_publish_diagnose for root-cause analysis.",
        "Publishing 1000+ concepts takes ~30 seconds. Use wait_for_completion=true to block until done.",
      ],
    });
  }

  if (isClassification) {
    if (isBulkClassification) {
      // Bulk path: use Flux's built-in classification support
      results.push({
        tool: "flux_import / flux_reprocess (with Semaphore classification)",
        description: "Bulk classification via Flux + Semaphore at ingest or reprocess time",
        use_when: ["bulk-classify", "classify-on-ingest", "semaphore", "taxonomy-tagging"],
        recipe: {
          // Inline classification during import
          option_A_ingest_time: {
            tool: "flux_import",
            subcommand: "import-files",
            http_url: "<source-url>",
            collections: ["raw-content"],
            extra_args: [
              "--classifier-host", "<semaphore-host>",
              "--classifier-port", "<semaphore-port>",
              "--classifier-path", "/api/v1/classify",
            ],
          },
          // OR: reprocess existing documents through Semaphore
          option_B_reprocess: {
            tool: "flux_reprocess",
            collections: ["raw-content"],
            invoke_module: "/transforms/enrich-with-semaphore.sjs",
            thread_count: 4,
          },
        },
        rationale:
          "Flux has built-in Semaphore Classification Server support via --classifier-host/port/path flags. " +
          "Pass these via extra_args on flux_import to classify every document at ingest time. " +
          "For documents already in MarkLogic, use flux_reprocess with an SJS module that calls " +
          "Semaphore's REST API (xdmp.httpPost) and patches each document with the returned categories. " +
          "This is the Progress Data Platform pattern: Flux handles scale, Semaphore handles classification.",
        warnings: [
          "Semaphore must be reachable from the flux-runner host (not just the MCP server host).",
          "Run semaphore_status to confirm connectivity before designing the pipeline.",
          "Use semaphore_classify to test category output on sample text before running bulk classification.",
          "Run semaphore_publish_sets and semaphore_classes to confirm what taxonomies and rules are active.",
        ],
      });
    } else {
      // Single-document / exploratory classification
      results.push({
        tool: "semaphore_classify",
        description: "Classify text content against a Semaphore taxonomy",
        use_when: ["classify-text", "semaphore", "taxonomy", "concept-extraction"],
        recipe: {
          content: "<text to classify>",
          threshold: 0,
        },
        rationale:
          "semaphore_classify sends text to the Semaphore Classification Server and returns scored taxonomy categories. " +
          "Use threshold=0 to see all candidate categories regardless of confidence. " +
          "Run semaphore_publish_sets and semaphore_classes first to understand the loaded taxonomies.",
        not_this_tool:
          "For bulk classification of an existing collection, use flux_reprocess with an SJS transform instead — " +
          "semaphore_classify is for interactive/exploratory use only.",
        warnings: [
          "Requires SEMAPHORE_URL to be set in the MCP server .env.",
          "Run semaphore_status first to confirm connectivity.",
        ],
      });
    }

    // Always add the integration advisor prompt when classification intent is detected
    results.push({
      tool: "semaphore_integration_advisor (prompt)",
      description: "Architectural guidance for Semaphore + MarkLogic integration patterns",
      use_when: ["integration-design", "semaphore-architecture", "progress-data-platform"],
      recipe: {
        prompt: "semaphore_integration_advisor",
        pattern: "<ingest-and-classify | reprocess-enrich | dhf-pipeline>",
        content_type: "<describe your content: news articles, contracts, product descriptions, etc.>",
        taxonomy: "<describe your taxonomy/classification model>",
      },
      rationale:
        "Use the semaphore_integration_advisor prompt to get a full architectural plan for combining " +
        "Semaphore and MarkLogic — covering ingest strategy, transform design, canonical model mapping, " +
        "Data Hub Framework considerations, and how to surface Semaphore categories as MarkLogic search facets.",
    });
  }

  // ── Fallback: if nothing matched, suggest problem_advisor prompt ────────────
  if (results.length === 0) {
    results.push({
      tool: "problem_advisor (prompt)",
      description: "General MarkLogic solution advisor",
      use_when: ["unknown-intent", "multi-step-planning"],
      recipe: {
        goal: task,
      },
      rationale:
        "The task did not match a specific tool pattern. Call the problem_advisor prompt with your goal to get a " +
        "structured 6-section analysis: problem classification, MarkLogic-native approach, discovery sequence, " +
        "recommended tool chain, pitfalls, and simpler alternatives.",
    });
  }

  return results;
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerSuggestApproachTool(server: McpServer): void {
  server.tool(
    "ml_suggest_approach",
    "PLANNING TOOL — call this first for any non-trivial task. Returns ranked tool chains with ready-to-use parameters, rationale, and warnings.\n\n" +
    "COVERS ALL PROBLEM DOMAINS:\n" +
    "  • Bulk data loading → Flux import pipeline\n" +
    "  • Content classification / auto-tagging / concept extraction → Semaphore tools\n" +
    "  • Full-text search, faceted navigation → ml_search, ml_facets_query\n" +
    "  • Analytics, GROUP BY, joins → ml_optic_query over TDE views\n" +
    "  • Graph / entity relationships → ml_sparql_query\n" +
    "  • Vector similarity / RAG → ml_vector_search\n" +
    "  • Schema, indexes, TDE discovery → ml_schema_discover, ml_indexes_list\n\n" +
    "Call this instead of guessing when the right tool is not immediately obvious (e.g. use this for 'tag my articles by topic' → it will route to Semaphore, not eval). Returns 1–3 ranked suggestions.",
    {
      task: z.string().describe(
        "Natural-language description of what you want to accomplish, e.g. 'import a CSV from a public URL into MarkLogic and create a view', 'find all documents mentioning climate change', 'export the sales collection to Parquet'."
      ),
    },
    async ({ task }) => {
      const suggestions = classify(task);

      const lines: string[] = [
        `APPROACH RECOMMENDATIONS FOR: "${task}"`,
        `${"─".repeat(60)}`,
        "",
        "PROJECT TOPOLOGY NOTE: MarkLogic projects each have their own content database",
        "(e.g. 'myapp-content'), distinct from the built-in 'Documents' database which is for",
        "ad-hoc sandbox use. If this task is for a named project, run ml_databases_list and",
        "ml_servers_list first to discover the correct database and app server before querying.",
        "",
      ];

      suggestions.forEach((s, i) => {
        lines.push(`## ${i + 1}. ${s.tool}`);
        lines.push(`   ${s.description}`);
        lines.push("");
        lines.push(`   CAPABILITIES: ${s.use_when.join(", ")}`);
        lines.push("");
        lines.push(`   RATIONALE: ${s.rationale}`);
        lines.push("");
        lines.push("   RECIPE:");
        lines.push("   ```json");
        lines.push(JSON.stringify(s.recipe, null, 4).split("\n").map(l => `   ${l}`).join("\n"));
        lines.push("   ```");
        if (s.not_this_tool) {
          lines.push("");
          lines.push(`   ⚠ AVOID: ${s.not_this_tool}`);
        }
        if (s.warnings?.length) {
          lines.push("");
          lines.push("   WARNINGS:");
          s.warnings.forEach(w => lines.push(`   - ${w}`));
        }
        lines.push("");
      });

      if (suggestions.length > 1) {
        lines.push(`${"─".repeat(60)}`);
        lines.push(`${suggestions.length} approaches matched. The first entry is the strongest match for your task.`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
