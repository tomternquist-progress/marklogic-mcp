import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";

/**
 * Refusal payload returned when a Flux write subcommand is invoked under
 * ML_READONLY=true. Kept consistent so agents/clients can detect it
 * structurally without parsing prose.
 */
function refuseFluxWrite(toolName: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const body = {
    error: {
      code: "UNSUPPORTED_IN_BUILD",
      class: "runtime_capability",
      message: `${toolName} is disabled because ML_READONLY=true.`,
      hint:
        `${toolName} writes to MarkLogic (Flux import/copy/reprocess bypass the document-write tools but ` +
        `still ingest documents). To enable, restart the MCP server with ML_READONLY=false. For true ` +
        `read-only protection use a MarkLogic user with a read-only role — the readonly flag is a ` +
        `tool-layer safety belt, not a credential-level restriction.`,
    },
  };
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
}

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

export function registerFluxTools(
  server: McpServer,
  clients: MarkLogicClients,
  authType: "digest" | "basic" | "oauth" = "digest",
  readonly: boolean = false
): void {
  if (authType === "oauth") {
    // Flux embeds username:password in its connection string — incompatible with OAuth
    // token passthrough. Register a stub that returns a clear error so agents know why.
    for (const toolName of ["flux_import", "flux_export", "flux_copy", "flux_reprocess", "flux_preview", "flux_help", "flux_status"] as const) {
      server.tool(toolName, `Flux tool — not available in ML_AUTH_TYPE=oauth mode.`, {}, async () => ({
        content: [{
          type: "text" as const,
          text: `${toolName} is not supported when ML_AUTH_TYPE=oauth. The Flux runner embeds ` +
                `username:password credentials in its connection string, which are not available in OAuth mode. ` +
                `Use ML_AUTH_TYPE=digest or ML_AUTH_TYPE=basic with a dedicated service account for Flux operations.`,
        }],
        isError: true,
      }));
    }
    return;
  }
  const { flux, schema, documents, semaphore } = clients;

  // ── flux_import ──────────────────────────────────────────────────────────────
  server.tool(
    "flux_import",
    "Bulk-load data into MarkLogic via the Flux pipeline. FIRST-CHOICE tool for any bulk or URL-based load — prefer over ml_eval_javascript (~10 KB payload cap) or ml_document_put (one doc at a time) beyond ~10 documents.\n\n" +
    "CAP ABILITIES: bulk-import, http-fetch, csv, tsv, json, json-lines, parquet, avro, orc, jdbc, s3, zip-extract, gzip-extract, tde-generation, column-mapping, headerless-csv, uri-template, rdf-turtle, rdf-ntriples, rdf-jsonld\n\n" +
    "SUBCOMMAND SELECTION: delimited/CSV -> import-delimited-files; individual JSON/XML files -> import-files; a JSON array or JSONL -> import-aggregate-json-files (NOT import-files, which treats each line as a file path); Parquet/Avro/ORC -> import-<fmt>-files; relational -> import-jdbc; RDF -> import-rdf-files.\n\n" +
    "PREREQUISITES: the Flux runner sidecar must be reachable (check flux_status). generate_tde requires collections. classify_with_semaphore requires SEMAPHORE_HOST configured.\n\n" +
    "USE ml_graph_put INSTEAD for a small RDF string (< ~1 MB). USE ml_document_put INSTEAD for fewer than ~10 documents or for writing a TDE template / SJS module. USE ml_eval_javascript INSTEAD for server-side logic — not bulk insert.\n\n" +
    "GUIDANCE: the marklogic-bulk-import skill holds the canonical recipes (Socrata, GDELT, JDBC, S3, JSONL), the nested-API-wrapper workaround, path/volume-mount caveats, and URI-template rules. Consult it before composing a non-trivial import.",
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
      ]).describe("Flux import subcommand. 'import-aggregate-json-files' for a JSON array of records or JSONL (add '--json-lines' via extra_args); 'import-files' for individual JSON/XML files — it does NOT parse JSONL. See the marklogic-bulk-import skill for selection guidance."),
      path: z.string().optional().describe("Source path — an S3 URI (s3a://bucket/key) or a path on the flux-runner filesystem. Volume-mounted files are often NOT visible to Flux; prefer http_url for local data. Omit for import-jdbc."),
      http_url: z.string().url().optional().describe("HTTP/HTTPS URL fetched by the runner to /tmp, then passed as --path. Must be reachable from the runner host, not your machine. .gz passes through to Spark; .zip is extracted automatically."),
      collections: z.array(z.string()).optional().describe("MarkLogic collections to assign to imported documents"),
      permissions: z.string().optional().describe("Comma-separated role:capability pairs, e.g. 'rest-reader:read,rest-writer:update'. Valid MarkLogic capabilities: read, insert, update, execute, node-update. Must be lowercase."),
      uri_template: z.string().optional().describe("URI template, e.g. '/import/{filename}'. Variables must exactly match source field names; names containing spaces silently produce malformed URIs. With import-files, variables resolve from file metadata ({filename}, {filepath}), NOT document content. See the marklogic-bulk-import skill."),
      database: z.string().optional().describe("Target MarkLogic database (defaults to configured database)"),
      jdbc_url: z.string().optional().describe("JDBC URL for import-jdbc, e.g. 'jdbc:postgresql://host/db'"),
      jdbc_driver: z.string().optional().describe("JDBC driver class, e.g. 'org.postgresql.Driver'"),
      query: z.string().optional().describe("SQL query for import-jdbc"),
      thread_count: z.number().int().positive().optional().describe("Parallel writer threads (default: 4)"),
      batch_size: z.number().int().positive().optional().describe("Documents per batch (default: 100)"),
      column_names: z.array(z.string()).optional().describe("Header names for headerless delimited files — prepended as a header row so fields get real names instead of _c0, _c1. Use with import-delimited-files (e.g. GDELT, many government exports)."),
      local_file: z.string().optional().describe("⚠ Absolute path on the MCP SERVER HOST — not your machine and not the runner container. Files written by shell commands usually land outside the server container and will fail with 'File not found'. Prefer http_url. Cannot combine with http_url or path."),
      extra_args: z.array(z.string()).optional().describe("Flux CLI flags passed verbatim, e.g. ['--delimiter','|'], ['--encoding','ISO-8859-1'], ['--json-lines']. Run flux_help with a subcommand to list accepted flags."),
      generate_tde: z.boolean().optional().describe("After a successful import, auto-generate a TDE template by sampling the imported collection and writing it to the Schemas database. Requires collections to be set. The template is written to /tde/<tde_schema>/<tde_view>.json."),
      tde_schema: z.string().optional().describe("Schema name for the auto-generated TDE view (used with generate_tde). Defaults to the first collection name with non-alphanumeric chars replaced by underscores."),
      tde_view: z.string().optional().describe("View name for the auto-generated TDE view (used with generate_tde). Defaults to the last segment of the first collection name."),
      skip_preview: z.boolean().optional().describe("Deprecated — previews no longer run automatically. Kept for backwards compatibility; has no effect."),
      classify_with_semaphore: z.boolean().optional().describe(
        "Classify every document at ingest via the Semaphore CLS (injects --classifier-host/-port/-path). " +
        "Requires SEMAPHORE_HOST in the MCP server .env; verify with semaphore_status. Preferred over a " +
        "separate flux_reprocess pass. The marklogic-bulk-import skill documents the output structure and " +
        "the META array-vs-object trap."
      ),
      classifier_publish_sets: z.array(z.string()).optional().describe(
        "Restrict classification to named publish sets, e.g. ['iptcmediatopics','unescothesaurus']. " +
        "Only used with classify_with_semaphore=true. List names via semaphore_publish_sets. " +
        "Omitting this combines all active publish sets, which grows noisy."
      ),
      classifier_path: z.string().optional().describe(
        "CLS URL path (default '/'), used only with classify_with_semaphore=true. Does not filter " +
        "results — use classifier_publish_sets for that."
      ),
    },
    async ({ subcommand, path, http_url, local_file, column_names, collections, permissions, uri_template, database, jdbc_url, jdbc_driver, query, thread_count, batch_size, extra_args, generate_tde, tde_schema, tde_view, skip_preview: _skip_preview, classify_with_semaphore, classifier_publish_sets, classifier_path }) => {
      if (readonly) {
        return refuseFluxWrite("flux_import");
      }
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
          "\n\nHint: The URL returned 404 (Not Found). Possible causes:" +
          "\n  • The Socrata resource ID may be wrong — find the correct ID on the dataset's API page (look for the '?' docs button on the portal page)." +
          "\n  • The dataset may have moved or been deprecated — try searching the portal for an updated resource ID." +
          "\n  • Try running flux_preview with the same URL to debug the fetch before importing.";
        return { content: [{ type: "text", text: preflightNote + formatResult({ ...result, output: enhanced }) }], isError: true };
      }
      if (!result.success && http_url && condensedOutput.includes("HTTP 403")) {
        const enhanced = condensedOutput +
          "\n\nHint: The URL returned 403 (Forbidden). The resource may require an API key or authentication." +
          "\n  • Some Socrata portals require an app token in the X-App-Token header — pass it via extra_args: ['--header', 'X-App-Token: <your-token>']." +
          "\n  • Check whether the dataset requires account registration or a license agreement." +
          "\n  • Try opening the URL in a browser to see the access requirements.";
        return { content: [{ type: "text", text: preflightNote + formatResult({ ...result, output: enhanced }) }], isError: true };
      }

      // ── PATH_NOT_FOUND: explain runner-local paths ──
      if (!result.success && condensedOutput.includes("PATH_NOT_FOUND")) {
        const enhanced = condensedOutput +
          "\n\nHint: The Flux runner's HTTP API spawns Flux as a Spark subprocess that does NOT " +
          "inherit Docker volume mounts or docker-cp'd files — even if 'docker exec ls' shows the file.\n" +
          "  ➜ RECOMMENDED: Serve the file over HTTP and use http_url instead of path.\n" +
          "    This is the most reliable approach for local data.\n" +
          "  • path works reliably only for S3 URIs (s3a://...) or files baked into the runner image.\n" +
          "  • If you must use a local file: run Flux directly via 'docker exec <runner> /flux/bin/flux ...'\n" +
          "    (bypasses the HTTP API and sees the container filesystem).";
        return { content: [{ type: "text", text: preflightNote + formatResult({ ...result, output: enhanced }) }], isError: true };
      }

      // ── Pre-processing failed: runner tried to download http_url but got null ──
      if (!result.success && condensedOutput.includes("Pre-processing failed")) {
        const enhanced = condensedOutput +
          "\n\nHint: The flux runner's pre-processor failed to download the http_url.\n" +
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
        colNote = "\n\nHint: Output contains unnamed columns (_c0, _cN…). " +
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
            `\n  Run ml_tde_validate with tde_uri="${generated.uri}" and collection="${targetCollection}" to verify.` +
            `\n  ⚠ TYPE CHECK: Numeric-looking string IDs (e.g. Socrata unique_key "59484184") may be inferred` +
            `\n    as 'float' instead of 'string'. Verify with ml_document_sample and fix via ml_document_put` +
            `\n    if the TDE column type is wrong (it affects sort order and join correctness).`;
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
          "  classification.STRUCTUREDDOCUMENT.META  — {name, value, id, score} per concept\n" +
          "  'name'  = taxonomy class string (e.g. 'IPTCMediaTopics-...' or 'UNESCOThesaurus-...')\n" +
          "  'value' = matched concept label\n" +
          "  'id'    = stable concept UUID\n" +
          "  'score' = confidence float (0–1); threshold 0.48+ is production-quality\n\n" +
          "⚠ META ARRAY vs OBJECT: When only 1 result is returned, META is a plain object {}, NOT an\n" +
          "  array []. Normalise in all code: const meta = Array.isArray(META) ? META : [META];\n" +
          "  Records with < ~50 words of text typically produce only Type metadata, no taxonomy hits.\n\n" +
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
      if (readonly) {
        return refuseFluxWrite("flux_copy");
      }
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
    "Reprocess existing MarkLogic documents through a server-side transform module using Flux. PREFERRED over ml_invoke_module / xdmp.invoke for bulk transforms — Flux batches and parallelises, whereas a single xdmp.invoke transaction times out past ~1,000 documents.\n\n" +
    "TWO-PHASE PATTERN (required): a READER (read_module / collections / read_javascript) returns the URI list, and a TRANSFORM (invoke_module) receives ONE URI per invocation in the injected variable URI.\n\n" +
    "PREREQUISITES: both modules must already exist in the Modules database (write them with ml_document_put, database='Modules'). The Flux runner must be reachable — check flux_status.\n\n" +
    "WARNING: a reported 'Success count: N' means N invocations returned without throwing, NOT that N documents changed. Always spot-check with ml_document_get afterwards.\n\n" +
    "GUIDANCE: the marklogic-bulk-import skill (references/reprocess-transforms.md) holds the module templates, the declareUpdate() placement trap that silently discards every write, single-URI testing, and the outbound-HTTP no-op warning. Read it before writing a transform module.",
    {
      invoke_module: z.string().describe("URI of the transform module in the Modules database (Phase 2, --write-invoke). Receives one URI per invocation via the injected 'var URI' variable (Flux flag: --external-variable-name URI). e.g. /transforms/build-entity.sjs"),
      read_module: z.string().optional().describe("URI of the reader/collector module in the Modules database (Phase 1, --read-invoke). Must return a Sequence or Array of URI strings. Use this instead of 'collections' when URIs come from SPARQL or custom logic rather than an existing collection. e.g. /transforms/gather-subject-uris.sjs"),
      read_javascript: z.string().optional().describe("Inline JavaScript expression (Phase 1, --read-javascript) that returns a Sequence or Array of URI strings for Flux to distribute. Use this to scope reprocessing to a subset without a separate read_module file and without creating a temporary collection. Example: \"cts.uris(null, null, cts.andQuery([cts.collectionQuery('federal-register'), cts.jsonPropertyRangeQuery('year', '=', 2024)]))\" or \"Sequence.from(['/doc/a.json', '/doc/b.json'])\" for single-URI testing. Takes priority over 'collections' if both are provided. Ignored if 'read_module' is set."),
      collections: z.union([z.string(), z.array(z.string())]).optional().describe("Reprocess documents in these collections (Phase 1 alternative to read_module — generates --read-javascript with cts.uris(). Use when the URIs to reprocess already exist as MarkLogic documents in a known collection). Accepts a single collection name as a string or an array of names."),
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
        "Classification is stored in classification.STRUCTUREDDOCUMENT.META[]. " +
        "Score in META @score is a 0.0–1.0 float (e.g. 0.84 = 84% confidence). " +
        "Declare the score TDE column as scalarType 'float', not 'string'."
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
    async ({ invoke_module, read_module, read_javascript, collections, query, database, thread_count, batch_size, extra_args, classify_with_semaphore, classifier_publish_sets, classifier_path }) => {
      if (readonly) {
        return refuseFluxWrite("flux_reprocess");
      }
      // Coerce collections: accept string or array
      const collectionsArr: string[] | undefined = collections === undefined
        ? undefined
        : typeof collections === "string"
          ? [collections]
          : collections;

      const args: string[] = [
        "reprocess",
        "--connection-string", flux.connectionString(database),
        "--auth-type", flux.authType,
        "--write-invoke", invoke_module,
        "--external-variable-name", "URI",
      ];

      if (read_module) {
        args.push("--read-invoke", read_module);
      } else if (read_javascript) {
        // Explicit read_javascript takes priority over collections
        args.push("--read-javascript", read_javascript);
      } else if (collectionsArr?.length) {
        // flux reprocess does not support --collections; generate inline --read-javascript using cts.uris()
        const colQuery = collectionsArr.length === 1
          ? `cts.collectionQuery(${JSON.stringify(collectionsArr[0])})`
          : `cts.orQuery([${collectionsArr.map(c => `cts.collectionQuery(${JSON.stringify(c)})`).join(",")}])`;
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

      // ── Detect potential silent no-op: Flux reports success but modules may have not written ──
      let reprocessNote = "";
      if (result.success) {
        const successMatch = result.output.match(/Success count:\s*(\d+)/i);
        const successCount = successMatch ? parseInt(successMatch[1], 10) : undefined;
        if (successCount !== undefined && successCount > 0) {
          reprocessNote =
            "\n\nNOTE: 'Success count' means the transform module ran without throwing — it does NOT\n" +
            "guarantee documents were updated. If your module calls xdmp.httpPost() (e.g. Semaphore\n" +
            "CLS) or writes back to the same URI, verify changes with ml_document_get on a sample URI.\n" +
            "Silent no-ops can occur when write-invoke modules use outbound HTTP or when declareUpdate()\n" +
            "is misplaced (see tool description).";
        }
      }

      const finalOutput = result.output + reprocessNote;
      return { content: [{ type: "text", text: formatResult({ ...result, output: finalOutput }) }], isError: !result.success };
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
    "Show the help text for a Flux subcommand, listing all accepted CLI flags. Use this to discover valid options before calling flux_import or flux_export — especially for flags like --delimiter, --encoding, --header-line, or --spark-prop.\n\n" +
    "NOTE: --http-url will NOT appear in this output because it is a flux-runner extension, " +
    "not a native Flux CLI flag. The runner intercepts --http-url, downloads the file to /tmp, " +
    "and passes --path /tmp/<file> to Flux. Use the flux_import tool's http_url parameter " +
    "(which maps to --http-url) for URL-based imports — it is the recommended approach for " +
    "loading data from HTTP/HTTPS sources.",
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
    "Check whether the Flux runner sidecar is reachable and return its version. Reports the configured runner URL so you can verify it points to the correct host.",
    {},
    async () => {
      const runnerUrl = flux.runnerUrl;
      if (!flux.configured) {
        return {
          content: [{ type: "text", text: `Flux runner is not configured. Set the FLUX_RUNNER_URL environment variable.\nConfigured URL: ${runnerUrl}` }],
          isError: true,
        };
      }
      const healthy = await flux.healthCheck();
      if (!healthy) {
        return {
          content: [{
            type: "text",
            text:
              `Flux runner is not reachable at ${runnerUrl}.\n\n` +
              "TO START THE RUNNER (docker compose):\n" +
              "  docker compose --profile flux up -d flux-runner\n\n" +
              "TO CHECK IF IT'S RUNNING:\n" +
              "  docker compose ps flux-runner\n" +
              "  docker compose logs --tail=50 flux-runner\n\n" +
              "Once the container reports healthy, re-run flux_status to confirm.\n\n" +
              "COMMON CAUSES IF IT'S ALREADY RUNNING:\n" +
              "  • Docker hostname (e.g. 'flux-runner') not resolvable — if the MCP server runs outside\n" +
              "    Docker, set FLUX_RUNNER_URL=http://localhost:<port> in the MCP server .env file.\n" +
              "  • Port mismatch — the runner may be on a different port than configured (check FLUX_PORT\n" +
              "    in docker-compose.yml).\n" +
              "  • Network isolation — the MCP server container may not share a Docker network with the runner.\n\n" +
              "WITHOUT THE RUNNER: bulk import is unavailable. Small datasets (<10 docs) can use ml_document_put\n" +
              "directly, but for CSV / JSON / Parquet ingestion or reprocessing pipelines, the runner is required.",
          }],
          isError: true,
        };
      }
      const result = await flux.run(["version"]);
      if (!result.success) {
        return {
          content: [{
            type: "text",
            text: `Flux runner HTTP health check passed but command execution failed.\nRunner URL: ${runnerUrl}\n\n${result.output}`,
          }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Flux runner is healthy.\nRunner URL: ${runnerUrl}\n\n${result.output}` }],
      };
    }
  );
}
