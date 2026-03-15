import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FluxClient } from "../client/flux.js";

function formatResult(result: { exitCode: number; output: string; success: boolean; timedOut?: boolean }): string {
  const status = result.success ? "SUCCESS" : result.timedOut ? "TIMED OUT" : `FAILED (exit ${result.exitCode})`;
  return `[${status}]\n\n${result.output || "(no output)"}`;
}

export function registerFluxTools(server: McpServer, flux: FluxClient): void {
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
      http_url: z.string().url().optional().describe("HTTP/HTTPS URL to download before importing. The file is fetched by the flux-runner, saved to /tmp, then passed as --path. Use this when the data lives at a public URL (e.g. GDELT exports, open data portals)."),
      collections: z.array(z.string()).optional().describe("MarkLogic collections to assign to imported documents"),
      permissions: z.string().optional().describe("Comma-separated role:capability pairs, e.g. 'rest-reader:read,rest-writer:update'"),
      uri_template: z.string().optional().describe("URI template for document naming, e.g. '/import/{filename}'"),
      database: z.string().optional().describe("Target MarkLogic database (defaults to configured database)"),
      jdbc_url: z.string().optional().describe("JDBC URL for import-jdbc, e.g. 'jdbc:postgresql://host/db'"),
      jdbc_driver: z.string().optional().describe("JDBC driver class, e.g. 'org.postgresql.Driver'"),
      query: z.string().optional().describe("SQL query for import-jdbc"),
      thread_count: z.number().int().positive().optional().describe("Parallel writer threads (default: 4)"),
      batch_size: z.number().int().positive().optional().describe("Documents per batch (default: 100)"),
      extra_args: z.array(z.string()).optional().describe("Additional Flux CLI flags passed verbatim, e.g. ['--delimiter', '|', '--header-line', '1']"),
    },
    async ({ subcommand, path, http_url, collections, permissions, uri_template, database, jdbc_url, jdbc_driver, query, thread_count, batch_size, extra_args }) => {
      const args: string[] = [
        subcommand,
        "--connection-string", flux.connectionString(database),
      ];

      if (http_url) args.push("--http-url", http_url);
      else if (path) args.push("--path", path);
      if (collections?.length) args.push("--collections", collections.join(","));
      if (permissions) args.push("--permissions", permissions);
      if (uri_template) args.push("--uri-template", uri_template);
      if (jdbc_url) args.push("--jdbc-url", jdbc_url);
      if (jdbc_driver) args.push("--jdbc-driver", jdbc_driver);
      if (query) args.push("--query", query);
      if (thread_count) args.push("--thread-count", String(thread_count));
      if (batch_size) args.push("--batch-size", String(batch_size));
      if (extra_args?.length) args.push(...extra_args);

      const result = await flux.run(args);
      return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
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
    "Preview what a Flux command would process without writing to MarkLogic. Uses --preview <N> to show the first N records. Pass the same args you would use for flux_import, flux_export, etc.",
    {
      args: z.array(z.string()).describe("Full Flux CLI args, e.g. ['import-delimited-files', '--path', '/data/events.csv', '--connection-string', 'admin:admin@marklogic:8000/Documents']. --preview is added automatically. Use --http-url instead of --path to download from a URL first."),
      preview_rows: z.number().int().positive().optional().describe("Number of rows to preview (default: 10)"),
    },
    async ({ args, preview_rows }) => {
      const previewArgs = [...args, "--preview", String(preview_rows ?? 10)];
      // --http-url is resolved by the runner sidecar, no extra handling needed here
      const result = await flux.run(previewArgs);
      return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
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
      // Get version by running flux --version
      const result = await flux.run(["version"]);
      return {
        content: [{ type: "text", text: `Flux runner is healthy.\n\n${result.output}` }],
      };
    }
  );
}
