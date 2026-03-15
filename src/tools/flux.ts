import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";

function formatResult(result: { exitCode: number; output: string; success: boolean; timedOut?: boolean }): string {
  const status = result.success ? "SUCCESS" : result.timedOut ? "TIMED OUT" : `FAILED (exit ${result.exitCode})`;
  return `[${status}]\n\n${result.output || "(no output)"}`;
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
  const { flux, schema, documents } = clients;

  // ── flux_import ──────────────────────────────────────────────────────────────
  server.tool(
    "flux_import",
    "Import data into MarkLogic using Flux. Supports delimited files (CSV/TSV), JSON/XML files, Parquet, Avro, JDBC databases, and S3. Uses the configured MarkLogic connection by default.",
    {
      subcommand: z.enum([
        "import-delimited-files",
        "import-files",
        "import-parquet-files",
        "import-avro-files",
        "import-orc-files",
        "import-jdbc",
        "import-mlcp-archive",
      ]).describe("Flux import subcommand"),
      path: z.string().optional().describe("Local path or S3 URI (s3a://bucket/key) to read from. For import-jdbc, omit this. Use http_url instead to download from a URL first."),
      http_url: z.string().url().optional().describe("HTTP/HTTPS URL to download before importing. The file is fetched by the flux-runner, saved to /tmp, then passed as --path. Use this when the data lives at a public URL (e.g. GDELT exports, open data portals). NOTE: The URL must be reachable from the flux runner host, not your local machine. .gz files are passed to Flux as-is and decompressed by Spark natively. ZIP (.zip) files are automatically extracted by the runner — all files inside the ZIP are extracted to a temp directory and that directory is passed as --path. WARNING: Socrata /rows.json endpoints return an array-of-arrays format (not an array of objects) — use /rows.csv with import-delimited-files instead for one-document-per-record imports."),
      collections: z.array(z.string()).optional().describe("MarkLogic collections to assign to imported documents"),
      permissions: z.string().optional().describe("Comma-separated role:capability pairs, e.g. 'rest-reader:read,rest-writer:update'. Valid MarkLogic capabilities: read, insert, update, execute, node-update. Must be lowercase."),
      uri_template: z.string().optional().describe("URI template for document naming, e.g. '/import/{filename}'"),
      database: z.string().optional().describe("Target MarkLogic database (defaults to configured database)"),
      jdbc_url: z.string().optional().describe("JDBC URL for import-jdbc, e.g. 'jdbc:postgresql://host/db'"),
      jdbc_driver: z.string().optional().describe("JDBC driver class, e.g. 'org.postgresql.Driver'"),
      query: z.string().optional().describe("SQL query for import-jdbc"),
      thread_count: z.number().int().positive().optional().describe("Parallel writer threads (default: 4)"),
      batch_size: z.number().int().positive().optional().describe("Documents per batch (default: 100)"),
      column_names: z.array(z.string()).optional().describe("Column names for headerless delimited files. When set, the runner prepends these as a header row before importing — so each document gets proper field names instead of _c0, _c1, etc. Use with import-delimited-files when the source has no header (e.g. GDELT events, many government open-data exports)."),
      local_file: z.string().optional().describe("Absolute path to a file on the host where the MCP server process is running — NOT the flux runner container and NOT your local development machine if you are connecting remotely. The MCP server reads this path and uploads it to the flux runner over HTTP. If the file lives on your laptop or a machine other than the MCP server host, use http_url instead (serve the file over HTTP or use a public URL). Cannot be combined with http_url or path."),
      extra_args: z.array(z.string()).optional().describe("Additional Flux CLI flags passed verbatim. Common flags for import-delimited-files: ['--delimiter', '|'] for pipe-delimited, ['--encoding', 'ISO-8859-1'] for non-UTF-8 files. To force compression: ['--spark-prop', 'compression=gzip']. Run flux_help with subcommand='import-delimited-files' to see all accepted flags."),
      generate_tde: z.boolean().optional().describe("After a successful import, auto-generate a TDE template by sampling the imported collection and writing it to the Schemas database. Requires collections to be set. The template is written to /tde/<tde_schema>/<tde_view>.json."),
      tde_schema: z.string().optional().describe("Schema name for the auto-generated TDE view (used with generate_tde). Defaults to the first collection name with non-alphanumeric chars replaced by underscores."),
      tde_view: z.string().optional().describe("View name for the auto-generated TDE view (used with generate_tde). Defaults to the last segment of the first collection name."),
      skip_preview: z.boolean().optional().describe("Deprecated — previews no longer run automatically. Kept for backwards compatibility; has no effect."),
    },
    async ({ subcommand, path, http_url, local_file, column_names, collections, permissions, uri_template, database, jdbc_url, jdbc_driver, query, thread_count, batch_size, extra_args, generate_tde, tde_schema, tde_view, skip_preview: _skip_preview }) => {
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
          return { content: [{ type: "text", text: `Failed to upload local file to flux runner: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
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

      const result = await flux.run(args);

      // Condense repetitive write-error floods before surfacing output
      const condensedOutput = condenseWriteErrors(result.output);

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
          tdeGenNote =
            `\n\nTDE AUTO-GENERATED: ${generated.uri}\n` +
            `  Schema: ${schemaName}, View: ${viewName}\n` +
            `  Run ml_tde_validate with tde_uri="${generated.uri}" and collection="${targetCollection}" to verify.`;
        } catch (tdeErr) {
          tdeGenNote = `\n\nWARNING: Could not auto-generate TDE: ${tdeErr instanceof Error ? tdeErr.message : String(tdeErr)}`;
        }
      }

      const finalOutput = condensedOutput + colNote + tdeGenNote;
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
    "Reprocess existing MarkLogic documents through a custom transformation module using Flux.",
    {
      invoke_module: z.string().describe("URI of the transformation module in the Modules database, e.g. /transforms/enrich.sjs"),
      collections: z.array(z.string()).optional().describe("Reprocess documents in these collections"),
      query: z.string().optional().describe("CTS query to select documents to reprocess"),
      database: z.string().optional().describe("MarkLogic database (defaults to configured database)"),
      thread_count: z.number().int().positive().optional().describe("Parallel threads"),
      batch_size: z.number().int().positive().optional().describe("Documents per batch"),
      extra_args: z.array(z.string()).optional().describe("Additional Flux CLI flags passed verbatim"),
    },
    async ({ invoke_module, collections, query, database, thread_count, batch_size, extra_args }) => {
      const args: string[] = [
        "reprocess",
        "--connection-string", flux.connectionString(database),
        "--auth-type", flux.authType,
        "--invoke", invoke_module,
      ];

      if (collections?.length) args.push("--collections", collections.join(","));
      if (query) args.push("--query", query);
      if (thread_count) args.push("--thread-count", String(thread_count));
      if (batch_size) args.push("--batch-size", String(batch_size));
      if (extra_args?.length) args.push(...extra_args);

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
      return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
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
