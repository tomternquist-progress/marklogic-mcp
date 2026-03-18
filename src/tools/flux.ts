import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";

function formatResult(result: { exitCode: number; output: string; success: boolean; timedOut?: boolean }, maxOutputChars?: number): string {
  const status = result.success ? "SUCCESS" : result.timedOut ? "TIMED OUT" : `FAILED (exit ${result.exitCode})`;
  let output = result.output || "(no output)";
  if (maxOutputChars !== undefined && output.length > maxOutputChars) {
    const truncated = output.length - maxOutputChars;
    output = output.slice(0, maxOutputChars) + `\n\n[... truncated ${truncated.toLocaleString()} characters. Use a smaller preview_rows value or inspect the source data directly.]`;
  }
  return `[${status}]\n\n${output}`;
}

/**
 * Condense repetitive "Unable to write document" error floods into a compact summary.
 * When > 5 write failures appear, replaces the flood with a count + up to 3 unique reasons,
 * keeping all non-error lines intact for context.
 */
function condenseWriteErrors(output: string): string {
  const lines = output.split("\n");
  const writeErrorLines: string[] = [];
  const otherLines: string[] = [];

  for (const line of lines) {
    if (line.includes("Unable to write document")) {
      writeErrorLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  if (writeErrorLines.length <= 5) return output;

  // Deduplicate by the "Server Message: ..." portion — that's the actual ML error
  const reasonCounts = new Map<string, number>();
  for (const line of writeErrorLines) {
    const serverMsg = line.match(/Server Message: (.+)$/)?.[1]
      ?? line.match(/cause: (.+)$/)?.[1]
      ?? line.slice(0, 120);
    const key = serverMsg.slice(0, 120);
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }

  const shown: string[] = [];
  let i = 0;
  for (const [reason, count] of reasonCounts) {
    if (i >= 3) break;
    shown.push(`  [×${count}] ${reason}`);
    i++;
  }
  const remaining = reasonCounts.size - shown.length;

  const summary = [
    `${writeErrorLines.length} documents failed to write. Top unique errors (${reasonCounts.size} distinct):`,
    ...shown,
    ...(remaining > 0 ? [`  … and ${remaining} more distinct error type(s).`] : []),
  ].join("\n");

  return [...otherLines, summary].join("\n");
}

/**
 * Extract TDE-related error details from Flux output to produce actionable guidance.
 * Returns null if no TDE errors are present.
 */
function buildTdeNote(output: string, collections?: string[]): string | null {
  if (!output.includes("TDE-")) return null;

  // Collect all unique column names mentioned in cast/eval errors
  const colPattern = /Eval for Column (\w+)=|Column (\w+).*(?:XDMP-CAST|nullable)/gi;
  const badCols = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = colPattern.exec(output)) !== null) {
    const col = m[1] ?? m[2];
    if (col) badCols.add(col);
  }

  const colHint = badCols.size > 0
    ? `\n  Columns with cast errors: ${[...badCols].join(", ")} — add "nullable": true to each.`
    : "";

  const validateHint = collections?.length
    ? `\n  Run ml_tde_validate with tde_uri=<your-template-uri> and collection="${collections[0]}" to see per-document errors.`
    : `\n  Run ml_tde_validate with your TDE URI and collection name to see per-document errors.`;

  return (
    `\n\nTDE ERROR NOTE: Documents that were written before the TDE error remain in MarkLogic — ` +
    `TDEs apply at query time, so you do NOT need to re-import data to fix this.` +
    colHint +
    validateHint +
    `\n  Fix the TDE template with ml_document_put (database=Schemas), then re-run ml_tde_validate to confirm.`
  );
}

export function registerFluxTools(server: McpServer, clients: MarkLogicClients): void {
  const { flux, schema, documents, semaphore } = clients;

  // ── flux_import ──────────────────────────────────────────────────────────────
  server.tool(
    "flux_import",
    "Import data into MarkLogic using Flux. The FIRST-CHOICE tool for any bulk or URL-based data loading task — prefer this over ml_eval_javascript or ml_document_put for anything beyond ~5 documents.\n\nCAP ABILITIES: bulk-import, http-fetch, csv, tsv, json, json-lines, parquet, avro, orc, jdbc, s3, zip-extract, gzip-extract, tde-generation, column-mapping, headerless-csv, uri-template, rdf-turtle, rdf-ntriples, rdf-jsonld\n\nUSE THIS TOOL WHEN:\n- Loading data from an HTTP/HTTPS URL (open data portals, Socrata, GDELT, government datasets)\n- Importing CSV, TSV, JSON-Lines, Parquet, Avro, ORC, or MLCP archives (compressed or not)\n- Importing RDF files (Turtle, N-Triples, JSON-LD, RDF/XML) into named graphs — use subcommand='import-rdf-files'\n- Fetching from a JDBC database (PostgreSQL, MySQL, Oracle, SQL Server, etc.)\n- You need one MarkLogic document per source row/record\n- You want automatic TDE view generation (set generate_tde=true)\n- The source file has no header row — use column_names to inject field names\n- Batch size, thread count, or URI templates need configuring\n\nUSE ml_graph_put INSTEAD WHEN: you have a small RDF string (< ~1 MB) to load directly into a named graph without going through Flux.\nUSE ml_document_put INSTEAD WHEN: inserting fewer than ~10 individual documents, or writing a TDE template / SJS module to the Schemas or Modules database.\nUSE ml_eval_javascript INSTEAD WHEN: running server-side logic, calling MarkLogic built-ins, or custom in-database transforms — NOT for bulk insert.\n\nCANONICAL RECIPES:\n\n1. Import CSV from public URL with auto-TDE (most common):\n   subcommand=\"import-delimited-files\", http_url=\"https://example.com/data.csv\", collections=[\"my-data\"], generate_tde=true, tde_schema=\"myschema\", tde_view=\"myview\"\n\n2. Import Socrata open data — two valid options:\n   a) CSV (recommended for large imports): subcommand=\"import-delimited-files\", http_url=\"https://data.wa.gov/resource/abc.csv?$limit=50000\"\n   b) JSON resource API (returns proper objects): subcommand=\"import-files\", http_url=\"https://data.wa.gov/resource/abc.json?$limit=50000\"\n   WARNING: Use /resource/{id}.csv or /resource/{id}.json — NOT /rows.json (the Socrata bulk export). /rows.json returns array-of-arrays, not objects.\n\n3. Import headerless CSV (e.g. GDELT events — no column headers in source file):\n   subcommand=\"import-delimited-files\", http_url=\"https://...\", column_names=[\"Col1\",\"Col2\",...], extra_args=[\"--delimiter\",\"\\t\",\"--ignore-null-fields\"]\n\n4. Import from JDBC database:\n   subcommand=\"import-jdbc\", jdbc_url=\"jdbc:postgresql://host/db\", jdbc_driver=\"org.postgresql.Driver\", query=\"SELECT * FROM mytable\", collections=[\"my-data\"], generate_tde=true\n\n5. Import JSON or XML files from S3:\n   subcommand=\"import-files\", path=\"s3a://my-bucket/data/\", collections=[\"my-data\"]\n\n6. Import a Turtle/RDF file into a named graph:\n   subcommand=\"import-rdf-files\", http_url=\"https://example.org/data.ttl\", extra_args=[\"--graph\",\"http://example.org/mygraph\"]\n\n7. Import a JSON file that contains an array of records OR a JSONL file (one object per line):\n   Both cases use subcommand=\"import-aggregate-json-files\":\n   a) Nested JSON array (e.g. openFDA {\"results\":[...]}, Socrata .json export):\n      subcommand=\"import-aggregate-json-files\", http_url=\"https://api.fda.gov/drug/event.json?limit=100\", collections=[\"fda-events\"]\n   b) JSONL / JSON Lines (one JSON object per line — the format written by Python scripts fetching API data):\n      subcommand=\"import-aggregate-json-files\", path=\"/tmp/data.jsonl\", extra_args=[\"--json-lines\"], uri_template=\"/data/{id}.json\", collections=[\"my-data\"]\n   NOTE: import-files treats each line as a separate file URI — it does NOT parse JSON inside lines. Always use import-aggregate-json-files for multi-record JSON files.\n\nWARNING: Only the Socrata bulk export endpoint (/rows.json) returns array-of-arrays — avoid that. The resource API (/resource/{id}.csv or /resource/{id}.json?$limit=N) returns proper records and works correctly with flux_import.",
    {
      subcommand: z.enum([
        "import-delimited-files",
        "import-files",
        "import-aggregate-json-files",
        "import-parquet-files",
        "import-avro-files",
        "import-orc-files",
        "import-jdbc",
        "import-mlcp-archive",
        "import-rdf-files",
      ]).describe("Flux import subcommand. Use 'import-aggregate-json-files' for: (a) a JSON file containing an array of records (e.g. openFDA results[], Socrata JSON), or (b) JSONL / JSON Lines files (one JSON object per line) — add '--json-lines' via extra_args. Use 'import-files' for individual JSON or XML files where each file becomes one document — it does NOT parse JSONL (each line would be treated as a separate file path, not a JSON record)."),
      path: z.string().optional().describe("Path to read from — either a path on the flux-runner container filesystem or an S3 URI (s3a://bucket/key). For local files: if you wrote the file on the host (e.g. via a Python script), copy it into the flux-runner container first with 'docker cp /tmp/file.jsonl flux-runner-httpurl-test:/tmp/file.jsonl', then set path='/tmp/file.jsonl'. For import-jdbc, omit this. Use http_url instead to download from a URL directly."),
      http_url: z.string().url().optional().describe("HTTP/HTTPS URL to download before importing. The file is fetched by the flux-runner, saved to /tmp, then passed as --path. Use this when the data lives at a public URL (e.g. GDELT exports, open data portals). NOTE: The URL must be reachable from the flux runner host, not your local machine. .gz files are passed to Flux as-is and decompressed by Spark natively. ZIP (.zip) files are automatically extracted by the runner — all files inside the ZIP are extracted to a temp directory and that directory is passed as --path. WARNING: Socrata /rows.json endpoints return an array-of-arrays format (not an array of objects) — use /rows.csv with import-delimited-files instead for one-document-per-record imports."),
      collections: z.array(z.string()).optional().describe("MarkLogic collections to assign to imported documents"),
      permissions: z.string().optional().describe("Comma-separated role:capability pairs, e.g. 'rest-reader:read,rest-writer:update'. Valid MarkLogic capabilities: read, insert, update, execute, node-update. Must be lowercase."),
      uri_template: z.string().optional().describe("URI template for document naming, e.g. '/import/{filename}'. Template variables must exactly match the CSV/JSON field names. WARNING: field names with spaces (e.g. 'State Abbreviation') cannot be used in URI templates — Flux will silently produce malformed URIs. Sanitize column names first (use column_names to rename headers, or import without a uri_template and rely on auto-generated URIs). IMPORTANT — import-files limitation: with import-files, template variables resolve from file-level metadata (e.g. {filename}, {filepath}) — NOT from fields inside the JSON document content. To build URIs from a JSON document field (e.g. an 'id' field), use extra_args: ['--uri-replace', \".*/source-dir/\",\"'/target-prefix/'\",\".json$\",\"''\"] instead of uri_template."),
      database: z.string().optional().describe("Target MarkLogic database (defaults to configured database)"),
      jdbc_url: z.string().optional().describe("JDBC URL for import-jdbc, e.g. 'jdbc:postgresql://host/db'"),
      jdbc_driver: z.string().optional().describe("JDBC driver class, e.g. 'org.postgresql.Driver'"),
      query: z.string().optional().describe("SQL query for import-jdbc"),
      thread_count: z.number().int().positive().optional().describe("Parallel writer threads (default: 4)"),
      batch_size: z.number().int().positive().optional().describe("Documents per batch (default: 100)"),
      column_names: z.array(z.string()).optional().describe("Column names for headerless delimited files. When set, the runner prepends these as a header row before importing — so each document gets proper field names instead of _c0, _c1, etc. Use with import-delimited-files when the source has no header (e.g. GDELT events, many government open-data exports)."),
      local_file: z.string().optional().describe("⚠ HOST RESTRICTION: Absolute path to a file that exists on the MCP SERVER HOST — NOT your local development machine and NOT the flux runner container. If you are connecting to a remote MCP server, this path must be on that remote host; files on your laptop will cause 'File not found' errors. SANDBOX ISOLATION: The MCP server runs in its own container/process. Files written by shell commands (e.g. via Bash tool) land on the host filesystem, NOT inside the MCP server container — so local_file will fail with 'File not found' even though the file appears to exist. FALLBACKS: (1) serve the file via HTTP and use http_url instead, or (2) use ml_eval_javascript with the vars parameter to pass data inline for small payloads (<100 KB). Cannot be combined with http_url or path."),
      extra_args: z.array(z.string()).optional().describe("Additional Flux CLI flags passed verbatim. Common flags for import-delimited-files: ['--delimiter', '|'] for pipe-delimited, ['--encoding', 'ISO-8859-1'] for non-UTF-8 files. To force compression: ['--spark-prop', 'compression=gzip']. Run flux_help with subcommand='import-delimited-files' to see all accepted flags."),
      generate_tde: z.boolean().optional().describe("After a successful import, auto-generate a TDE template by sampling the imported collection and writing it to the Schemas database. Requires collections to be set. The template is written to /tde/<tde_schema>/<tde_view>.json."),
      tde_schema: z.string().optional().describe("Schema name for the auto-generated TDE view (used with generate_tde). Defaults to the first collection name with non-alphanumeric chars replaced by underscores."),
      tde_view: z.string().optional().describe("View name for the auto-generated TDE view (used with generate_tde). Defaults to the last segment of the first collection name."),
      skip_preview: z.boolean().optional().describe("Deprecated — previews no longer run automatically. Kept for backwards compatibility; has no effect."),
      classify_with_semaphore: z.boolean().optional().describe(
        "When true, automatically injects Semaphore Classification Server flags into the Flux command " +
        "(--classifier-host, --classifier-port, --classifier-path /) so that every imported document " +
        "is classified at ingest time. Requires SEMAPHORE_HOST (and optionally SEMAPHORE_SCS_PORT) " +
        "to be configured in the MCP server .env.\n\n" +
        "FLUX-FIRST PRINCIPLE: This is the preferred approach for classification — Flux classifies " +
        "every document inline during import with no separate reprocess step needed. Works with all " +
        "import subcommands including import-aggregate-json-files --json-lines.\n\n" +
        "SCOPING TO SPECIFIC TAXONOMIES: Use classifier_publish_sets to restrict results to named " +
        "publish sets (e.g. ['iptcmediatopics', 'unescothesaurus']). Flux injects " +
        "--classifier-prop publish_set_name_list=iptcmediatopics|unescothesaurus so the CLS only " +
        "returns results from those sets. Without this, all active publish sets are combined.\n\n" +
        "CLASSIFICATION OUTPUT STRUCTURE: Semaphore adds a nested object to each document:\n" +
        "  classification.STRUCTUREDDOCUMENT.META[]  — array of {name, value, id, score}\n" +
        "  name = taxonomy class (e.g. 'IPTCMediaTopics-http://cv.iptc.org/newscodes/mediatopic/')\n" +
        "  value = matched concept label, id = concept UUID, score = float 0–1\n\n" +
        "TDE FOR CLASSIFIED DOCUMENTS: To create a view with one row per (document × category):\n" +
        "  context: 'classification/STRUCTUREDDOCUMENT/META'  (iterates over each tag)\n" +
        "  To reference the parent document's fields from within a META element, navigate UP:\n" +
        "    parent field 'id':      '../../../../id'       (4 levels: elem→array→SD-obj→class-obj→root)\n" +
        "    parent field 'section': '../../../../section'\n" +
        "  Direct META element fields: 'name', 'value', 'id', 'score' (declare score as float, not string)"
      ),
      classifier_publish_sets: z.array(z.string()).optional().describe(
        "Restrict Flux classification to specific publish sets (e.g. ['iptcmediatopics', 'unescothesaurus']). " +
        "Only used when classify_with_semaphore=true. Injects --classifier-prop publish_set_name_list=<pipe-separated> " +
        "so the CLS returns results only from the named sets. " +
        "Use semaphore_publish_sets to list available names (they are the lowercase model names). " +
        "When omitted, all active publish sets are used — which produces noisy results as more models are added."
      ),
      classifier_path: z.string().optional().describe(
        "CLS URL path for Flux classification. Only used when classify_with_semaphore=true. " +
        "Default: '/'. Note: the URL path does not filter results — use classifier_publish_sets for that."
      ),
    },
    async ({ subcommand, path, http_url, local_file, column_names, collections, permissions, uri_template, database, jdbc_url, jdbc_driver, query, thread_count, batch_size, extra_args, generate_tde, tde_schema, tde_view, skip_preview: _skip_preview, classify_with_semaphore, classifier_publish_sets, classifier_path }) => {
      // Validate and convert permissions
      let fluxPermissions: string | undefined;
      if (permissions) {
        const validCapabilities = new Set(["read", "insert", "update", "execute", "node-update"]);
        const parts: string[] = [];
        for (const pair of permissions.split(",")) {
          const tokens = pair.trim().split(":");
          if (tokens.length !== 2) {
            return { content: [{ type: "text", text: `Invalid permissions format: "${pair.trim()}". Expected "role:capability" pairs separated by commas.` }], isError: true };
          }
          const capability = tokens[1].trim().toLowerCase();
          if (!validCapabilities.has(capability)) {
            return { content: [{ type: "text", text: `Invalid capability "${tokens[1].trim()}" in permissions. Valid MarkLogic capabilities are: ${[...validCapabilities].join(", ")}.` }], isError: true };
          }
          parts.push(tokens[0].trim(), capability);
        }
        fluxPermissions = parts.join(",");
      }

      // ── RDF import guard: generate_tde is not applicable for import-rdf-files ──
      if (subcommand === "import-rdf-files" && generate_tde) {
        return {
          content: [{
            type: "text",
            text:
              "WARNING: generate_tde=true has no effect for import-rdf-files.\n\n" +
              "RDF imports create managed triple store documents, not JSON/CSV entity documents with " +
              "named fields — there is nothing for the TDE generator to sample.\n\n" +
              "To get a TDE view over RDF data, use the hybrid model:\n" +
              "  1. Import RDF into a named graph (this import — remove generate_tde).\n" +
              "  2. Write an SJS module (ml_document_put, database='Modules') that queries the graph " +
              "with sem.sparql() and inserts one JSON entity document per subject.\n" +
              "  3. Run ml_invoke_module or flux_reprocess to build the entity docs into a collection.\n" +
              "  4. Call flux_import with generate_tde=true on that collection, OR write the TDE manually.\n\n" +
              "See the flux_reprocess tool description for the module contract.",
          }],
          isError: true,
        };
      }

      // ── TDE pre-flight: warn if existing TDE templates scope to these collections ──
      let preflightNote = "";
      if (collections?.length) {
        try {
          const conflicting = await schema.findTdesByCollection(collections);
          if (conflicting.length > 0) {
            preflightNote =
              `NOTE: Found ${conflicting.length} TDE template(s) scoped to your import collections ` +
              `(${conflicting.join(", ")}). If these templates have type mismatches (e.g. missing nullable:true), ` +
              `write failures will occur. Run ml_tde_validate first to check, or use generate_tde=true to auto-generate a fresh template.\n\n`;
          }
        } catch {
          // pre-flight is best-effort; don't block the import
        }
      }

      const args: string[] = [
        subcommand,
        "--connection-string", flux.connectionString(database),
        "--auth-type", flux.authType,
      ];

      if (local_file) {
        let runnerPath: string;
        try {
          runnerPath = await flux.upload(local_file);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const hint =
            detail.includes("File not found")
              ? ` The path must exist on the MCP server host, not your local machine or the flux runner container. ` +
                `If you are connecting to a remote MCP server, the file must be uploaded there first, ` +
                `or served over HTTP so the flux runner can fetch it with http_url instead.`
              : "";
          return { content: [{ type: "text", text: `Failed to upload local file to flux runner: ${detail}${hint}` }], isError: true };
        }
        args.push("--path", runnerPath);
      } else if (http_url) {
        args.push("--http-url", http_url);
      } else if (path) {
        args.push("--path", path);
      }

      if (column_names?.length) args.push("--column-names", column_names.join("\t"));
      if (collections?.length) args.push("--collections", collections.join(","));
      if (fluxPermissions) args.push("--permissions", fluxPermissions);
      if (uri_template) args.push("--uri-template", uri_template);
      if (jdbc_url) args.push("--jdbc-url", jdbc_url);
      if (jdbc_driver) args.push("--jdbc-driver", jdbc_driver);
      if (query) args.push("--query", query);
      if (thread_count) args.push("--thread-count", String(thread_count));
      if (batch_size) args.push("--batch-size", String(batch_size));
      if (extra_args?.length) {
        const hasTdeSchema = extra_args.some(a => a === "--tde-schema");
        const hasTdeCollections = extra_args.some(a => a === "--tde-collections");
        if (hasTdeSchema && !hasTdeCollections && collections?.length) {
          args.push(...extra_args, "--tde-collections", collections.join(","));
        } else {
          args.push(...extra_args);
        }
      }

      // ── Semaphore inline classification ──────────────────────────────────────
      if (classify_with_semaphore) {
        if (!semaphore.configured || !semaphore.scsHost) {
          return {
            content: [{
              type: "text",
              text:
                "classify_with_semaphore=true requires SEMAPHORE_HOST to be set in the MCP server .env.\n\n" +
                "Example:\n" +
                "  SEMAPHORE_HOST=semaphore.example.com\n" +
                "  SEMAPHORE_SCS_PORT=5058    # default\n\n" +
                "Run semaphore_status to verify connectivity before using this option.",
            }],
            isError: true,
          };
        }
        const clsPath = classifier_path ?? "/";
        args.push(
          "--classifier-host", semaphore.scsHost,
          "--classifier-port", String(semaphore.scsPort),
          "--classifier-path", clsPath
        );
        // --classifier-http is required when the CLS endpoint is plain HTTP (not HTTPS)
        if (!semaphore.baseUrl.startsWith("https")) {
          args.push("--classifier-http");
        }
        // Scope to specific publish sets via --classifier-prop publish_set_name_list
        if (classifier_publish_sets && classifier_publish_sets.length > 0) {
          args.push("--classifier-prop", `publish_set_name_list=${classifier_publish_sets.join("|")}`);
        }
      }

      const result = await flux.run(args);

      // Condense repetitive write-error floods before surfacing output
      const condensedOutput = condenseWriteErrors(result.output);

      // ── HTTP 404/403 on http_url: suggest how to fix ──
      if (!result.success && http_url && condensedOutput.includes("HTTP 404")) {
        const enhanced = condensedOutput +
          "\n\nNOTE: The URL returned 404 (Not Found). Possible causes:" +
          "\n  • The Socrata resource ID may be wrong — find the correct ID on the dataset's API page (look for the '?' docs button on the portal page)." +
          "\n  • The dataset may have moved or been deprecated — try searching the portal for an updated resource ID." +
          "\n  • Try running flux_preview with the same URL to debug the fetch before importing.";
        return { content: [{ type: "text", text: preflightNote + formatResult({ ...result, output: enhanced }) }], isError: true };
      }
      if (!result.success && http_url && condensedOutput.includes("HTTP 403")) {
        const enhanced = condensedOutput +
          "\n\nNOTE: The URL returned 403 (Forbidden). The resource may require an API key or authentication." +
          "\n  • Some Socrata portals require an app token in the X-App-Token header — pass it via extra_args: ['--header', 'X-App-Token: <your-token>']." +
          "\n  • Check whether the dataset requires account registration or a license agreement." +
          "\n  • Try opening the URL in a browser to see the access requirements.";
        return { content: [{ type: "text", text: preflightNote + formatResult({ ...result, output: enhanced }) }], isError: true };
      }

      // ── PATH_NOT_FOUND: explain runner-local paths ──
      if (!result.success && condensedOutput.includes("PATH_NOT_FOUND")) {
        const enhanced = condensedOutput +
          "\n\nNOTE: --path must exist on the flux runner host (inside the flux runner container), " +
          "not your local machine or the MCP server container.\n" +
          "  • Files written by shell commands land on the host OS, not inside either container.\n" +
          "  • Files placed via 'docker cp' into the runner container ARE visible to the runner's\n" +
          "    filesystem (docker exec ls confirms this), but the runner's HTTP API spawns the Flux\n" +
          "    subprocess with a different classpath context that may not resolve the same path.\n" +
          "    Workaround: run Flux directly with 'docker exec <runner-container> /flux/bin/flux ...'\n" +
          "  • Best alternative for local data: serve the file over HTTP and use http_url instead.";
        return { content: [{ type: "text", text: preflightNote + formatResult({ ...result, output: enhanced }) }], isError: true };
      }

      // ── Pre-processing failed: runner tried to download http_url but got null ──
      if (!result.success && condensedOutput.includes("Pre-processing failed")) {
        const enhanced = condensedOutput +
          "\n\nNOTE: The flux runner's pre-processor failed to download the http_url.\n" +
          "  'Pre-processing failed: null' typically means the Java HttpClient in the runner\n" +
          "  received a null response — even if the URL is reachable (e.g. via wget from inside\n" +
          "  the container). This is a known runner limitation for certain URL patterns.\n" +
          "  Workarounds:\n" +
          "  1. docker cp the file into the runner container, then use 'docker exec' to run\n" +
          "     /flux/bin/flux directly (bypasses the runner HTTP API).\n" +
          "  2. Use a well-known public URL (e.g. raw.githubusercontent.com) — these are known\n" +
          "     to work with the runner's Java HttpClient.\n" +
          "  3. For small datasets (<100 KB), pass data inline via ml_eval_javascript + vars.";
        return { content: [{ type: "text", text: preflightNote + formatResult({ ...result, output: enhanced }) }], isError: true };
      }

      // ── TDE errors: surface column hints and no-re-import guidance ──
      const tdeNote = buildTdeNote(condensedOutput, collections);
      if (tdeNote) {
        const annotated = condensedOutput + tdeNote;
        return {
          content: [{ type: "text", text: preflightNote + formatResult({ ...result, output: annotated }) }],
          isError: !result.success,
        };
      }

      // ── Column count mismatch hint ──
      const hasUnnamedCols = condensedOutput.includes("_c0") || / _c\d+/.test(condensedOutput);
      let colNote = "";
      if (column_names?.length && hasUnnamedCols) {
        colNote = "\n\nNOTE: Output contains unnamed columns (_c0, _cN…). " +
          `The file may have more columns than the ${column_names.length} names provided in column_names. ` +
          "Run flux_preview to see the raw column layout and adjust column_names accordingly.";
      }

      // ── Auto-generate TDE after successful import ──
      let tdeGenNote = "";
      if (generate_tde && result.success && collections?.length) {
        const targetCollection = collections[0];
        const schemaName = tde_schema ?? targetCollection.replace(/[^a-zA-Z0-9]/g, "_");
        const viewName   = tde_view   ?? (targetCollection.split("-").pop() ?? targetCollection);
        try {
          const generated = await schema.generateTdeTemplate({
            collection: targetCollection,
            schemaName,
            viewName,
            database,
          });
          await documents.put(
            generated.uri,
            JSON.stringify(generated.template, null, 2),
            "application/json",
            { collections: ["http://marklogic.com/xdmp/tde"], database: "Schemas" }
          );
          const tplRows = ((generated.template as Record<string, unknown>)?.template as Record<string, unknown>)?.rows as Array<Record<string, unknown>> | undefined;
          const cols = (tplRows?.[0]?.columns as Array<{ name: string; scalarType: string; nullable?: boolean }>) ?? [];
          // ── Detect HTML-as-CSV: single column whose name looks like an HTML tag ──
          const htmlColPattern = /^[_<]!?DOCTYPE|^__DOCTYPE|^_html|^<html/i;
          const htmlWarning = cols.length === 1 && htmlColPattern.test(cols[0]?.name ?? "")
            ? `\n\n⚠ WARNING: Only 1 column was detected and its name resembles an HTML tag ("${cols[0].name}"). ` +
              `The source URL likely returned an HTML page instead of CSV data. ` +
              `The imported documents contain HTML, not real records. ` +
              `Delete them (ml_eval_javascript with declareUpdate + cts.search on the collection), ` +
              `verify the URL in a browser, and try flux_preview before re-importing.`
            : "";

          const colSummary = cols.length > 0
            ? `\n  Columns (${cols.length}): ${cols.map((c) => `${c.name}:${c.scalarType}${c.nullable ? "?" : ""}`).join(", ")}`
            : "";
          const sanitizedNote = generated.sanitizedColumns.length > 0
            ? `\n  WARNING: ${generated.sanitizedColumns.length} column(s) had spaces/special chars in their JSON property names and were sanitized (spaces→underscores) for TDE compatibility: ${generated.sanitizedColumns.join(", ")}. Verify the view returns data with ml_tde_validate.`
            : "";
          const skippedNote = generated.skippedNullColumns.length > 0
            ? `\n  NOTE: ${generated.skippedNullColumns.length} always-null column(s) omitted from TDE (no non-null values in sample): ${generated.skippedNullColumns.join(", ")}.`
            : "";
          const skippedInvalidNote = generated.skippedInvalidColumns.length > 0
            ? `\n  NOTE: ${generated.skippedInvalidColumns.length} column(s) omitted — names start with ':' or other invalid XPath-leading chars after sanitization (e.g. Socrata ':@computed_region_*' fields) and would break the view: ${generated.skippedInvalidColumns.join(", ")}.`
            : "";
          tdeGenNote =
            `\n\nTDE AUTO-GENERATED: ${generated.uri}\n` +
            `  Schema: ${schemaName}, View: ${viewName}` +
            colSummary +
            sanitizedNote +
            skippedNote +
            skippedInvalidNote +
            htmlWarning +
            `\n  Run ml_tde_validate with tde_uri="${generated.uri}" and collection="${targetCollection}" to verify.`;
        } catch (tdeErr) {
          tdeGenNote = `\n\nWARNING: Could not auto-generate TDE: ${tdeErr instanceof Error ? tdeErr.message : String(tdeErr)}`;
        }
      }

      // ── RDF import post-note: explain success count and next steps ──
      let rdfNote = "";
      if (subcommand === "import-rdf-files" && result.success) {
        const graphArg = extra_args
          ? extra_args[extra_args.indexOf("--graph") + 1]
          : undefined;
        const graphHint = graphArg
          ? `\n  Count triples: ml_sparql_query → SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graphArg}> { ?s ?p ?o } }`
          : `\n  Count triples: ml_sparql_query → SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }`;
        rdfNote =
          `\n\nRDF IMPORT NOTE: "Success count" above is the number of managed triple store documents ` +
          `(batches), not the number of individual triples.` +
          graphHint +
          `\n  List loaded graphs: ml_graphs_list` +
          `\n  Next steps for TDE/Optic access — use the hybrid model:` +
          `\n    1. Write a module (ml_document_put, database='Modules') that reads triples via sem.sparql()` +
          `\n       and inserts one JSON entity doc per subject into a collection.` +
          `\n    2. Run flux_reprocess to execute the module over the managed triple docs.` +
          `\n    3. Generate a TDE over that collection (flux_import generate_tde=true or ml_document_put to Schemas).`;
      }

      // ── Semaphore classification post-note ──────────────────────────────────
      let classifyNote = "";
      if (classify_with_semaphore && result.success) {
        classifyNote =
          "\n\nCLASSIFICATION COMPLETE. Each document now has:\n" +
          "  classification.STRUCTUREDDOCUMENT.META[]  — array of {name, value, id, score}\n" +
          "  'name'  = taxonomy class string (e.g. 'IPTCMediaTopics-...' or 'UNESCOThesaurus-...')\n" +
          "  'value' = matched concept label\n" +
          "  'id'    = stable concept UUID\n" +
          "  'score' = confidence float (0–1); threshold 0.48+ is production-quality\n\n" +
          "TO QUERY CLASSIFICATIONS WITH OPTIC — create a TDE with:\n" +
          "  context: 'classification/STRUCTUREDDOCUMENT/META'\n" +
          "  META fields: name → 'name', label → 'value', concept_id → 'id', score → 'score' (float)\n" +
          "  Parent doc fields from META context — navigate UP 4 levels:\n" +
          "    '../../../../<fieldName>'  (META elem → META array → SD object → classification object → doc root)\n" +
          "  Filter to one taxonomy: where class_system = 'IPTCMediaTopics-http://cv.iptc.org/newscodes/mediatopic/'";
      }

      const finalOutput = condensedOutput + colNote + tdeGenNote + rdfNote + classifyNote;
      return {
        content: [{ type: "text", text: preflightNote + formatResult({ ...result, output: finalOutput }) }],
        isError: !result.success,
      };
    }
  );

  // ── flux_export ──────────────────────────────────────────────────────────────
  server.tool(
    "flux_export",
    "Export documents from MarkLogic using Flux. Supports exporting to local files, S3, Parquet, Avro, and JDBC databases.",
    {
      subcommand: z.enum([
        "export-files",
        "export-parquet-files",
        "export-avro-files",
        "export-orc-files",
        "export-jdbc",
        "export-archive",
      ]).describe("Flux export subcommand"),
      path: z.string().optional().describe("Output path or S3 URI (s3a://bucket/prefix). Not needed for export-jdbc."),
      collections: z.array(z.string()).optional().describe("Export documents in these collections"),
      query: z.string().optional().describe("CTS/structured query string to select documents to export. For export-jdbc: SQL query to run against the TDE view."),
      database: z.string().optional().describe("Source MarkLogic database (defaults to configured database)"),
      jdbc_url: z.string().optional().describe("JDBC URL for export-jdbc"),
      jdbc_driver: z.string().optional().describe("JDBC driver class for export-jdbc"),
      jdbc_table: z.string().optional().describe("Target table name for export-jdbc"),
      thread_count: z.number().int().positive().optional().describe("Parallel reader threads"),
      batch_size: z.number().int().positive().optional().describe("Documents per batch"),
      extra_args: z.array(z.string()).optional().describe("Additional Flux CLI flags passed verbatim"),
    },
    async ({ subcommand, path, collections, query, database, jdbc_url, jdbc_driver, jdbc_table, thread_count, batch_size, extra_args }) => {
      const args: string[] = [
        subcommand,
        "--connection-string", flux.connectionString(database),
        "--auth-type", flux.authType,
      ];

      if (path) args.push("--path", path);
      if (collections?.length) args.push("--collections", collections.join(","));
      if (query) args.push("--query", query);
      if (jdbc_url) args.push("--jdbc-url", jdbc_url);
      if (jdbc_driver) args.push("--jdbc-driver", jdbc_driver);
      if (jdbc_table) args.push("--table", jdbc_table);
      if (thread_count) args.push("--thread-count", String(thread_count));
      if (batch_size) args.push("--batch-size", String(batch_size));
      if (extra_args?.length) args.push(...extra_args);

      const result = await flux.run(args);
      return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
    }
  );

  // ── flux_copy ────────────────────────────────────────────────────────────────
  server.tool(
    "flux_copy",
    "Copy documents between MarkLogic databases or instances using Flux, preserving collections, permissions, and metadata.",
    {
      output_connection_string: z.string().describe("Target MarkLogic connection string: user:password@host:port/database"),
      collections: z.array(z.string()).optional().describe("Copy only documents in these source collections"),
      query: z.string().optional().describe("CTS query to select documents to copy"),
      database: z.string().optional().describe("Source MarkLogic database (defaults to configured database)"),
      output_collections: z.array(z.string()).optional().describe("Override collections on copied documents"),
      thread_count: z.number().int().positive().optional().describe("Parallel threads"),
      batch_size: z.number().int().positive().optional().describe("Documents per batch"),
      extra_args: z.array(z.string()).optional().describe("Additional Flux CLI flags passed verbatim"),
    },
    async ({ output_connection_string, collections, query, database, output_collections, thread_count, batch_size, extra_args }) => {
      const args: string[] = [
        "copy",
        "--connection-string", flux.connectionString(database),
        "--auth-type", flux.authType,
        "--output-connection-string", output_connection_string,
      ];

      if (collections?.length) args.push("--collections", collections.join(","));
      if (query) args.push("--query", query);
      if (output_collections?.length) args.push("--output-collections", output_collections.join(","));
      if (thread_count) args.push("--thread-count", String(thread_count));
      if (batch_size) args.push("--batch-size", String(batch_size));
      if (extra_args?.length) args.push(...extra_args);

      const result = await flux.run(args);
      return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
    }
  );

  // ── flux_reprocess ───────────────────────────────────────────────────────────
  server.tool(
    "flux_reprocess",
    "Reprocess existing MarkLogic documents through a custom transformation module using Flux.\n\n" +
    "PREFERRED over ml_invoke_module / xdmp.invoke for any bulk server-side transform because Flux handles\n" +
    "batching, parallel execution, and error recovery — a single xdmp.invoke transaction times out on large\n" +
    "collections (> ~1 000 docs).\n\n" +
    "TWO-PHASE PATTERN (required for scale) — always split into two modules:\n\n" +
    "  PHASE 1 — READER (read_module parameter → --read-invoke, OR collections → --read-javascript inline):\n" +
    "  Collects the URIs/IRIs that Flux will distribute across threads. No declareUpdate().\n" +
    "  Must return a Sequence or Array of URI strings.\n" +
    "    'use strict';\n" +
    "    // No declareUpdate() — this is a read-only collector\n" +
    "    var GRAPH = 'http://example.org/graph';\n" +
    "    var rows = sem.sparql('SELECT DISTINCT ?s FROM NAMED <' + GRAPH + '> WHERE { GRAPH <' + GRAPH + '> { ?s a ?type } }');\n" +
    "    Array.from(rows).map(function(r) { return String(r.s); });\n\n" +
    "  PHASE 2 — TRANSFORM MODULE (invoke_module parameter → --write-invoke):\n" +
    "  Receives ONE URI per invocation in external variable 'URI' (Flux flag: --external-variable-name URI).\n" +
    "  Must start with declareUpdate() and wrap code in an IIFE to allow early returns.\n" +
    "    'use strict';\n" +
    "    declareUpdate(); // must be at the TOP of the file\n" +
    "    var URI; // injected by Flux via --external-variable-name URI\n" +
    "    (function run() {\n" +
    "      var doc = cts.doc(URI).toObject();\n" +
    "      if (!doc) { return; } // bare return only works inside a function — IIFE required\n" +
    "      // ... build transformed doc ...\n" +
    "      xdmp.documentInsert(URI, doc, { permissions: xdmp.documentGetPermissions(URI),\n" +
    "                                      collections: Array.from(xdmp.documentGetCollections(URI)) });\n" +
    "    })();\n\n" +
    "MODULE CONSTRAINTS:\n" +
    "  ⚠ declareUpdate() POSITION: must be the very first statement in the file, BEFORE any function\n" +
    "    or IIFE. Placing it inside an IIFE compiles without error but the transaction is never marked\n" +
    "    as an update — xdmp.documentInsert() calls silently do nothing. Always write it at the top:\n" +
    "      WRONG:  (function run() { declareUpdate(); ... })();\n" +
    "      CORRECT: declareUpdate(); (function run() { ... })();\n" +
    "  - Top-level bare 'return' is a SyntaxError in strict-mode SJS — always wrap in an IIFE\n" +
    "  - 'var URI' must be declared at the top level of the module (not inside the IIFE) — Flux injects\n" +
    "    the value via --external-variable-name. Do NOT use 'external.URI' (only works in certain\n" +
    "    invocation contexts; fails with ReferenceError when called from xdmp.invoke() in eval).\n" +
    "  - batch_size defaults to 1 — each invoke gets exactly one URI in the 'URI' variable\n" +
    "  - With batch_size > 1 multiple URIs are joined by --external-variable-delimiter (\\n by default);\n" +
    "    the module must split them. Keep batch_size=1 unless you handle splitting explicitly.\n\n" +
    "TESTING A MODULE BEFORE BATCH RUN:\n" +
    "  You cannot test reprocess modules via xdmp.invoke() in ml_eval_javascript — 'var URI' and\n" +
    "  'external.URI' are not populated in that context. Test by running flux_reprocess on a single\n" +
    "  URI using a read-javascript that returns one item:\n" +
    "    read_module: omit, collections: omit\n" +
    "    extra_args: [\"--read-javascript\", \"Sequence.from(['/path/to/one/doc.json'])\"]\n" +
    "  Then check the document with ml_document_get before running the full collection.\n\n" +
    "WHY TWO MODULES MATTER:\n" +
    "  A monolithic script that queries ALL subjects and iterates them in one transaction will hit\n" +
    "  MarkLogic's transaction timeout (default 600 s) on any non-trivial dataset and cannot use\n" +
    "  Flux's parallel threads. The two-phase split lets Flux distribute work across thread_count\n" +
    "  threads with batch_size URIs per transaction — the only approach that scales.\n\n" +
    "WORKFLOW:\n" +
    "1. Write the transform module to Modules DB: ml_document_put (database='Modules').\n" +
    "2. Optionally write a reader module to Modules DB for custom URI selection logic.\n" +
    "3. Call flux_reprocess with invoke_module + (collections OR read_module).\n\n" +
    "RDF USE CASE — building hybrid entity documents from a named graph:\n" +
    "  Reader: SPARQL SELECT DISTINCT ?subject → returns subject IRIs as array.\n" +
    "  Transform: receives one IRI as URI, SPARQL for that subject's predicates, writes one JSON\n" +
    "  entity document with embedded triples (JSON 'triple' key, unmanaged format) for TDE indexing.\n\n" +
    "  OPTIONAL PREDICATE RULE — when a SPARQL variable is unbound (predicate absent for this subject),\n" +
    "  do NOT assign an empty string ''. Either omit the field entirely (preferred) or assign null:\n" +
    "    WRONG:  broaderUri: row.broader || ''\n" +
    "    CORRECT: if (row.broader) doc.broaderUri = row.broader;   // omit when absent\n" +
    "    CORRECT: broaderUri: row.broader ?? null                   // null when absent\n" +
    "  This applies to every optional predicate (skos:broader, dcterms:description, owl:sameAs, etc.).\n" +
    "  Empty-string values pollute search indexes, break range queries, and create misleading TDE rows.",
    {
      invoke_module: z.string().describe("URI of the transform module in the Modules database (Phase 2, --write-invoke). Receives one URI per invocation via the injected 'var URI' variable (Flux flag: --external-variable-name URI). e.g. /transforms/build-entity.sjs"),
      read_module: z.string().optional().describe("URI of the reader/collector module in the Modules database (Phase 1, --read-invoke). Must return a Sequence or Array of URI strings. Use this instead of 'collections' when URIs come from SPARQL or custom logic rather than an existing collection. e.g. /transforms/gather-subject-uris.sjs"),
      collections: z.array(z.string()).optional().describe("Reprocess documents in these collections (Phase 1 alternative to read_module — generates --read-javascript with cts.uris(). Use when the URIs to reprocess already exist as MarkLogic documents in a known collection)"),
      query: z.string().optional().describe("CTS query to select documents to reprocess (Phase 1 alternative to read_module)"),
      database: z.string().optional().describe("MarkLogic database (defaults to configured database)"),
      thread_count: z.number().int().positive().optional().describe("Parallel threads — set to 4–16 for large datasets; each thread processes batch_size URIs per transaction"),
      batch_size: z.number().int().positive().optional().describe("URIs per transaction per thread — keep ≤ 100 for transforms that write large documents"),
      extra_args: z.array(z.string()).optional().describe("Additional Flux CLI flags passed verbatim"),
      classify_with_semaphore: z.boolean().optional().describe(
        "When true, automatically injects Semaphore Classification Server flags " +
        "(--classifier-host, --classifier-port, --classifier-path /) so that every reprocessed document " +
        "is classified as part of the reprocess pipeline. Requires SEMAPHORE_HOST to be configured.\n\n" +
        "SCOPING TO SPECIFIC TAXONOMIES: Use classifier_publish_sets to restrict results to named " +
        "publish sets. Flux injects --classifier-prop publish_set_name_list=<pipe-separated> so the " +
        "CLS only returns results from those sets. Without this, all active publish sets are combined. " +
        "Classification is stored in classification.STRUCTUREDDOCUMENT.META[]."
      ),
      classifier_publish_sets: z.array(z.string()).optional().describe(
        "Restrict Flux classification to specific publish sets (e.g. ['iptcmediatopics', 'unescothesaurus']). " +
        "Only used when classify_with_semaphore=true. Injects --classifier-prop publish_set_name_list=<pipe-separated> " +
        "so the CLS returns results only from the named sets. " +
        "Use semaphore_publish_sets to list available names (they are the lowercase model names). " +
        "When omitted, all active publish sets are used."
      ),
      classifier_path: z.string().optional().describe(
        "CLS URL path for Flux classification. Only used when classify_with_semaphore=true. " +
        "Default: '/'. Note: the URL path does not filter results — use classifier_publish_sets for that."
      ),
    },
    async ({ invoke_module, read_module, collections, query, database, thread_count, batch_size, extra_args, classify_with_semaphore, classifier_publish_sets, classifier_path }) => {
      const args: string[] = [
        "reprocess",
        "--connection-string", flux.connectionString(database),
        "--auth-type", flux.authType,
        "--write-invoke", invoke_module,
        "--external-variable-name", "URI",
      ];

      if (read_module) args.push("--read-invoke", read_module);
      if (collections?.length) {
        // flux reprocess does not support --collections; generate inline --read-javascript using cts.uris()
        const colQuery = collections.length === 1
          ? `cts.collectionQuery(${JSON.stringify(collections[0])})`
          : `cts.orQuery([${collections.map(c => `cts.collectionQuery(${JSON.stringify(c)})`).join(",")}])`;
        args.push("--read-javascript", `cts.uris(null,null,${colQuery})`);
      }
      if (query) args.push("--query", query);
      if (thread_count) args.push("--thread-count", String(thread_count));
      if (batch_size) args.push("--batch-size", String(batch_size));
      if (extra_args?.length) args.push(...extra_args);

      // ── Semaphore inline classification ──────────────────────────────────────
      if (classify_with_semaphore) {
        if (!semaphore.configured || !semaphore.scsHost) {
          return {
            content: [{
              type: "text",
              text:
                "classify_with_semaphore=true requires SEMAPHORE_HOST to be set in the MCP server .env.\n\n" +
                "Example:\n" +
                "  SEMAPHORE_HOST=semaphore.example.com\n" +
                "  SEMAPHORE_SCS_PORT=5058    # default\n\n" +
                "Run semaphore_status to verify connectivity before using this option.",
            }],
            isError: true,
          };
        }
        const clsPath = classifier_path ?? "/";
        args.push(
          "--classifier-host", semaphore.scsHost,
          "--classifier-port", String(semaphore.scsPort),
          "--classifier-path", clsPath
        );
        // --classifier-http is required when the CLS endpoint is plain HTTP (not HTTPS)
        if (!semaphore.baseUrl.startsWith("https")) {
          args.push("--classifier-http");
        }
        // Scope to specific publish sets via --classifier-prop publish_set_name_list
        if (classifier_publish_sets && classifier_publish_sets.length > 0) {
          args.push("--classifier-prop", `publish_set_name_list=${classifier_publish_sets.join("|")}`);
        }
      }

      const result = await flux.run(args);
      return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
    }
  );

  // ── flux_preview ─────────────────────────────────────────────────────────────
  server.tool(
    "flux_preview",
    "Preview what a Flux import/export command would process without writing to MarkLogic. The configured MarkLogic connection (host, credentials, auth type) is injected automatically — do NOT include --connection-string or --auth-type yourself. Pass the subcommand and data-source args you would use with flux_import/flux_export.",
    {
      args: z.array(z.string()).describe("Flux CLI args WITHOUT connection flags, e.g. ['import-delimited-files', '--path', '/data/events.csv']. --connection-string, --auth-type, and --preview are added automatically. Use --http-url instead of --path to download from a URL first."),
      preview_rows: z.number().int().positive().optional().describe("Number of rows to preview (default: 10)"),
    },
    async ({ args, preview_rows }) => {
      const hasConn = args.some(a => a === "--connection-string" || a === "-c");
      let previewArgs: string[];
      if (hasConn) {
        previewArgs = [...args, "--preview", String(preview_rows ?? 10)];
      } else {
        const [subcommand, ...rest] = args;
        previewArgs = [
          subcommand,
          "--connection-string", flux.connectionString(),
          "--auth-type", flux.authType,
          ...rest,
          "--preview", String(preview_rows ?? 10),
        ];
      }
      const result = await flux.run(previewArgs);
      // Spark's tabular preview format can produce very wide output for datasets with
      // many/long columns. Cap at 40 KB to keep the response usable in context.
      return { content: [{ type: "text", text: formatResult(result, 40_000) }], isError: !result.success };
    }
  );

  // ── flux_help ────────────────────────────────────────────────────────────────
  server.tool(
    "flux_help",
    "Show the help text for a Flux subcommand, listing all accepted CLI flags. Use this to discover valid options before calling flux_import or flux_export — especially for flags like --delimiter, --encoding, --header-line, or --spark-prop.",
    {
      subcommand: z.string().optional().describe("Flux subcommand to get help for, e.g. 'import-delimited-files', 'import-files', 'export-files'. Omit for top-level Flux help."),
    },
    async ({ subcommand }) => {
      const args = subcommand ? ["help", subcommand] : ["--help"];
      const result = await flux.run(args);
      return { content: [{ type: "text", text: result.output || "(no output)" }] };
    }
  );

  // ── flux_status ──────────────────────────────────────────────────────────────
  server.tool(
    "flux_status",
    "Check whether the Flux runner sidecar is reachable and return its version.",
    {},
    async () => {
      if (!flux.configured) {
        return {
          content: [{ type: "text", text: "Flux runner is not configured. Set the FLUX_RUNNER_URL environment variable." }],
          isError: true,
        };
      }
      const healthy = await flux.healthCheck();
      if (!healthy) {
        return {
          content: [{ type: "text", text: "Flux runner is not reachable. Ensure the flux-runner service is running and FLUX_RUNNER_URL is correct." }],
          isError: true,
        };
      }
      const result = await flux.run(["version"]);
      return {
        content: [{ type: "text", text: `Flux runner is healthy.\n\n${result.output}` }],
      };
    }
  );
}
