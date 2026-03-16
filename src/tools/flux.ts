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
    "Import data into MarkLogic using Flux. The FIRST-CHOICE tool for any bulk or URL-based data loading task — prefer this over ml_eval_javascript or ml_document_put for anything beyond ~5 documents.\n\nCAP ABILITIES: bulk-import, http-fetch, csv, tsv, json, json-lines, parquet, avro, orc, jdbc, s3, zip-extract, gzip-extract, tde-generation, column-mapping, headerless-csv, uri-template, rdf-turtle, rdf-ntriples, rdf-jsonld\n\nUSE THIS TOOL WHEN:\n- Loading data from an HTTP/HTTPS URL (open data portals, Socrata, GDELT, government datasets)\n- Importing CSV, TSV, JSON-Lines, Parquet, Avro, ORC, or MLCP archives (compressed or not)\n- Importing RDF files (Turtle, N-Triples, JSON-LD, RDF/XML) into named graphs — use subcommand='import-rdf-files'\n- Fetching from a JDBC database (PostgreSQL, MySQL, Oracle, SQL Server, etc.)\n- You need one MarkLogic document per source row/record\n- You want automatic TDE view generation (set generate_tde=true)\n- The source file has no header row — use column_names to inject field names\n- Batch size, thread count, or URI templates need configuring\n\nUSE ml_graph_put INSTEAD WHEN: you have a small RDF string (< ~1 MB) to load directly into a named graph without going through Flux.\nUSE ml_document_put INSTEAD WHEN: inserting fewer than ~10 individual documents, or writing a TDE template / SJS module to the Schemas or Modules database.\nUSE ml_eval_javascript INSTEAD WHEN: running server-side logic, calling MarkLogic built-ins, or custom in-database transforms — NOT for bulk insert.\n\nCANONICAL RECIPES:\n\n1. Import CSV from public URL with auto-TDE (most common):\n   subcommand=\"import-delimited-files\", http_url=\"https://example.com/data.csv\", collections=[\"my-data\"], generate_tde=true, tde_schema=\"myschema\", tde_view=\"myview\"\n\n2. Import Socrata open data — two valid options:\n   a) CSV (recommended for large imports): subcommand=\"import-delimited-files\", http_url=\"https://data.wa.gov/resource/abc.csv?$limit=50000\"\n   b) JSON resource API (returns proper objects): subcommand=\"import-files\", http_url=\"https://data.wa.gov/resource/abc.json?$limit=50000\"\n   WARNING: Use /resource/{id}.csv or /resource/{id}.json — NOT /rows.json (the Socrata bulk export). /rows.json returns array-of-arrays, not objects.\n\n3. Import headerless CSV (e.g. GDELT events — no column headers in source file):\n   subcommand=\"import-delimited-files\", http_url=\"https://...\", column_names=[\"Col1\",\"Col2\",...], extra_args=[\"--delimiter\",\"\\t\",\"--ignore-null-fields\"]\n\n4. Import from JDBC database:\n   subcommand=\"import-jdbc\", jdbc_url=\"jdbc:postgresql://host/db\", jdbc_driver=\"org.postgresql.Driver\", query=\"SELECT * FROM mytable\", collections=[\"my-data\"], generate_tde=true\n\n5. Import JSON or XML files from S3:\n   subcommand=\"import-files\", path=\"s3a://my-bucket/data/\", collections=[\"my-data\"]\n\n6. Import a Turtle/RDF file into a named graph:\n   subcommand=\"import-rdf-files\", http_url=\"https://example.org/data.ttl\", extra_args=[\"--graph\",\"http://example.org/mygraph\"]\n\nWARNING: Only the Socrata bulk export endpoint (/rows.json) returns array-of-arrays — avoid that. The resource API (/resource/{id}.csv or /resource/{id}.json?$limit=N) returns proper records and works correctly with flux_import.",
    {
      subcommand: z.enum([
        "import-delimited-files",
        "import-files",
        "import-parquet-files",
        "import-avro-files",
        "import-orc-files",
        "import-jdbc",
        "import-mlcp-archive",
        "import-rdf-files",
      ]).describe("Flux import subcommand"),
      path: z.string().optional().describe("Local path or S3 URI (s3a://bucket/key) to read from. For import-jdbc, omit this. Use http_url instead to download from a URL first."),
      http_url: z.string().url().optional().describe("HTTP/HTTPS URL to download before importing. The file is fetched by the flux-runner, saved to /tmp, then passed as --path. Use this when the data lives at a public URL (e.g. GDELT exports, open data portals). NOTE: The URL must be reachable from the flux runner host, not your local machine. .gz files are passed to Flux as-is and decompressed by Spark natively. ZIP (.zip) files are automatically extracted by the runner — all files inside the ZIP are extracted to a temp directory and that directory is passed as --path. WARNING: Socrata /rows.json endpoints return an array-of-arrays format (not an array of objects) — use /rows.csv with import-delimited-files instead for one-document-per-record imports."),
      collections: z.array(z.string()).optional().describe("MarkLogic collections to assign to imported documents"),
      permissions: z.string().optional().describe("Comma-separated role:capability pairs, e.g. 'rest-reader:read,rest-writer:update'. Valid MarkLogic capabilities: read, insert, update, execute, node-update. Must be lowercase."),
      uri_template: z.string().optional().describe("URI template for document naming, e.g. '/import/{filename}'. Template variables must exactly match the CSV/JSON field names. WARNING: field names with spaces (e.g. 'State Abbreviation') cannot be used in URI templates — Flux will silently produce malformed URIs. Sanitize column names first (use column_names to rename headers, or import without a uri_template and rely on auto-generated URIs)."),
      database: z.string().optional().describe("Target MarkLogic database (defaults to configured database)"),
      jdbc_url: z.string().optional().describe("JDBC URL for import-jdbc, e.g. 'jdbc:postgresql://host/db'"),
      jdbc_driver: z.string().optional().describe("JDBC driver class, e.g. 'org.postgresql.Driver'"),
      query: z.string().optional().describe("SQL query for import-jdbc"),
      thread_count: z.number().int().positive().optional().describe("Parallel writer threads (default: 4)"),
      batch_size: z.number().int().positive().optional().describe("Documents per batch (default: 100)"),
      column_names: z.array(z.string()).optional().describe("Column names for headerless delimited files. When set, the runner prepends these as a header row before importing — so each document gets proper field names instead of _c0, _c1, etc. Use with import-delimited-files when the source has no header (e.g. GDELT events, many government open-data exports)."),
      local_file: z.string().optional().describe("⚠ HOST RESTRICTION: Absolute path to a file that exists on the MCP SERVER HOST — NOT your local development machine and NOT the flux runner container. If you are connecting to a remote MCP server, this path must be on that remote host; files on your laptop will cause 'File not found' errors. FALLBACK when files are local-only: use ml_eval_javascript with the vars parameter to pass data inline (avoids the host restriction entirely). Cannot be combined with http_url or path."),
      extra_args: z.array(z.string()).optional().describe("Additional Flux CLI flags passed verbatim. Common flags for import-delimited-files: ['--delimiter', '|'] for pipe-delimited, ['--encoding', 'ISO-8859-1'] for non-UTF-8 files. To force compression: ['--spark-prop', 'compression=gzip']. Run flux_help with subcommand='import-delimited-files' to see all accepted flags."),
      generate_tde: z.boolean().optional().describe("After a successful import, auto-generate a TDE template by sampling the imported collection and writing it to the Schemas database. Requires collections to be set. The template is written to /tde/<tde_schema>/<tde_view>.json."),
      tde_schema: z.string().optional().describe("Schema name for the auto-generated TDE view (used with generate_tde). Defaults to the first collection name with non-alphanumeric chars replaced by underscores."),
      tde_view: z.string().optional().describe("View name for the auto-generated TDE view (used with generate_tde). Defaults to the last segment of the first collection name."),
      skip_preview: z.boolean().optional().describe("Deprecated — previews no longer run automatically. Kept for backwards compatibility; has no effect."),
      classify_with_semaphore: z.boolean().optional().describe(
        "When true, automatically injects Semaphore Classification Server flags into the Flux command " +
        "(--classifier-host, --classifier-port, --classifier-path /) so that every imported document " +
        "is classified at ingest time. Requires SEMAPHORE_HOST (and optionally SEMAPHORE_SCS_PORT) " +
        "to be configured in the MCP server .env. For bulk classification this is the most efficient " +
        "approach — Flux calls the SCS inline without a separate reprocess step."
      ),
    },
    async ({ subcommand, path, http_url, local_file, column_names, collections, permissions, uri_template, database, jdbc_url, jdbc_driver, query, thread_count, batch_size, extra_args, generate_tde, tde_schema, tde_view, skip_preview: _skip_preview, classify_with_semaphore }) => {
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
        args.push(
          "--classifier-host", semaphore.scsHost,
          "--classifier-port", String(semaphore.scsPort),
          "--classifier-path", "/"
        );
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
          "\n\nNOTE: --path must exist on the flux runner host, not your local machine. " +
          "Use local_file to upload a file from this machine to the runner, or use http_url to download from a URL.";
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

      const finalOutput = condensedOutput + colNote + tdeGenNote + rdfNote;
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
    "  PHASE 1 — READER MODULE (read_module parameter, --read-documents-javascript):\n" +
    "  Collects the URIs/IRIs that Flux will distribute across threads. No declareUpdate().\n" +
    "  Must return a Sequence or Array of URI strings.\n" +
    "    'use strict';\n" +
    "    // No declareUpdate() — this is a read-only collector\n" +
    "    var GRAPH = 'http://example.org/graph';\n" +
    "    var rows = sem.sparql('SELECT DISTINCT ?s FROM NAMED <' + GRAPH + '> WHERE { GRAPH <' + GRAPH + '> { ?s a ?type } }');\n" +
    "    Array.from(rows).map(function(r) { return String(r.s); });\n\n" +
    "  PHASE 2 — TRANSFORM MODULE (invoke_module parameter, --invoke):\n" +
    "  Receives ONE URI per invocation injected by Flux. Writes exactly one output document.\n" +
    "    'use strict';\n" +
    "    declareUpdate(); // must be at the TOP of the file\n" +
    "    var URI; // injected by Flux — one URI/IRI from the reader module\n" +
    "    // ... SPARQL scoped to URI, build entity doc ...\n" +
    "    xdmp.documentInsert(outputUri, doc, { permissions: [...], collections: [...] });\n\n" +
    "WHY TWO MODULES MATTER:\n" +
    "  A monolithic script that queries ALL subjects and iterates them in one transaction will hit\n" +
    "  MarkLogic's transaction timeout (default 600 s) on any non-trivial dataset and cannot use\n" +
    "  Flux's parallel threads. The two-phase split lets Flux distribute work across thread_count\n" +
    "  threads with batch_size URIs per transaction — the only approach that scales.\n\n" +
    "WORKFLOW:\n" +
    "1. Write the reader module to Modules DB: ml_document_put (database='Modules').\n" +
    "2. Write the transform module to Modules DB: ml_document_put (database='Modules').\n" +
    "3. Call flux_reprocess with read_module + invoke_module (no --collections needed when using a reader).\n\n" +
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
      invoke_module: z.string().describe("URI of the transform module in the Modules database (Phase 2). Receives one URI per invocation via the injected 'var URI' variable. e.g. /transforms/build-entity.sjs"),
      read_module: z.string().optional().describe("URI of the reader/collector module in the Modules database (Phase 1, --read-documents-javascript). Must return a Sequence or Array of URI strings. Use this instead of 'collections' when URIs come from SPARQL or custom logic rather than an existing collection. e.g. /transforms/gather-subject-uris.sjs"),
      collections: z.array(z.string()).optional().describe("Reprocess documents in these collections (Phase 1 alternative to read_module — use when the URIs to reprocess already exist as MarkLogic documents in a known collection)"),
      query: z.string().optional().describe("CTS query to select documents to reprocess (Phase 1 alternative to read_module)"),
      database: z.string().optional().describe("MarkLogic database (defaults to configured database)"),
      thread_count: z.number().int().positive().optional().describe("Parallel threads — set to 4–16 for large datasets; each thread processes batch_size URIs per transaction"),
      batch_size: z.number().int().positive().optional().describe("URIs per transaction per thread — keep ≤ 100 for transforms that write large documents"),
      extra_args: z.array(z.string()).optional().describe("Additional Flux CLI flags passed verbatim"),
      classify_with_semaphore: z.boolean().optional().describe(
        "When true, automatically injects Semaphore Classification Server flags " +
        "(--classifier-host, --classifier-port, --classifier-path /) so that every reprocessed document " +
        "is classified as part of the reprocess pipeline. Requires SEMAPHORE_HOST to be configured."
      ),
    },
    async ({ invoke_module, read_module, collections, query, database, thread_count, batch_size, extra_args, classify_with_semaphore }) => {
      const args: string[] = [
        "reprocess",
        "--connection-string", flux.connectionString(database),
        "--auth-type", flux.authType,
        "--invoke", invoke_module,
      ];

      if (read_module) args.push("--read-documents-javascript", read_module);
      if (collections?.length) args.push("--collections", collections.join(","));
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
        args.push(
          "--classifier-host", semaphore.scsHost,
          "--classifier-port", String(semaphore.scsPort),
          "--classifier-path", "/"
        );
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
