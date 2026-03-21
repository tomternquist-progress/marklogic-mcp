import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerAdminTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_databases_list",
    "List all databases in the MarkLogic cluster.",
    {},
    async () => {
      try {
        const databases = await clients.admin.listDatabases();
        return { content: [{ type: "text", text: JSON.stringify(databases, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_database_properties",
    "Get detailed configuration properties of a MarkLogic database (indexes, merge policy, etc.).",
    { database: z.string().describe("Database name") },
    async ({ database }) => {
      try {
        const props = await clients.admin.getDatabaseProperties(database);
        return { content: [{ type: "text", text: JSON.stringify(props, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_database_statistics",
    "Get document counts, forest sizes, and index sizes for a MarkLogic database.",
    { database: z.string().describe("Database name") },
    async ({ database }) => {
      try {
        const stats = await clients.admin.getDatabaseStatistics(database);
        return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_forests_list",
    "List forests attached to the MarkLogic cluster or a specific database. Set include_details=true to also return each forest's host assignment, state (open/unmounted/sync-replicating), and attached database — useful for diagnosing forest hangs where offline hosts are blocking a database.",
    {
      database: z.string().optional().describe("Filter by database name (optional)"),
      include_details: z.boolean().optional().describe("Include host, state, and database info for each forest (default: false)"),
    },
    async ({ database, include_details }) => {
      try {
        const forests = await clients.admin.listForests(database, include_details ?? false);
        return { content: [{ type: "text", text: JSON.stringify(forests, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_database_set_forests",
    "Set the list of forests attached to a MarkLogic database. Use this to restrict a database to only forests on available hosts when cluster nodes are offline — the primary fix for the forest-hang pattern where HTTP connections are accepted but never respond. Pass only the names of forests on running hosts.",
    {
      database: z.string().describe("Database name"),
      forests: z.array(z.string()).describe("Forest names to attach — replaces the current list"),
    },
    async ({ database, forests }) => {
      try {
        await clients.admin.setDatabaseForests(database, forests);
        return { content: [{ type: "text", text: `Forest list updated for database "${database}": [${forests.join(", ")}]` }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_servers_list",
    "List App Servers (HTTP, XDBC, WebDAV, ODBC) in a MarkLogic group.",
    { group: z.string().optional().describe("Server group name — omit to list all groups") },
    async ({ group }) => {
      try {
        const servers = await clients.admin.listServers(group);
        return { content: [{ type: "text", text: JSON.stringify(servers, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_server_properties",
    "Get configuration properties of a specific MarkLogic App Server.",
    {
      server_name: z.string().describe("App server name"),
      group: z.string().optional().describe("Server group (default: Default)"),
    },
    async ({ server_name, group }) => {
      try {
        const props = await clients.admin.getServerProperties(server_name, group ?? "Default");
        return { content: [{ type: "text", text: JSON.stringify(props, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_cluster_status",
    "Get MarkLogic cluster health status — version, host info, and cluster configuration.",
    {},
    async () => {
      try {
        const status = await clients.admin.getClusterStatus();
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_logs_list",
    "List available MarkLogic log files (ErrorLog.txt, AccessLog.txt, port-specific logs like 8002_AccessLog.txt, etc.). Use this to discover which log files exist before calling ml_logs_read.",
    {
      host: z.string().optional().describe("Filter to a specific cluster host (optional — defaults to primary host)"),
    },
    async ({ host }) => {
      try {
        const files = await clients.admin.listLogFiles(host);
        return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_logs_read",
    "Read a MarkLogic server log file via the Management API. Use ml_logs_list first to discover available filenames. Key files: ErrorLog.txt (server errors), 8002_AccessLog.txt (Management API), 8000_AccessLog.txt (App-Services), 8020_AccessLog.txt (DHF Staging), 8021_AccessLog.txt (DHF Final). Supports server-side filtering by time range and regex pattern.",
    {
      filename: z.string().describe("Log filename, e.g. 'ErrorLog.txt' or '8020_AccessLog.txt'"),
      host: z.string().optional().describe("Cluster host name to read logs from (optional — defaults to primary)"),
      start: z.string().optional().describe("Start time filter in ISO 8601 format, e.g. '2026-03-21T00:00:00'"),
      end: z.string().optional().describe("End time filter in ISO 8601 format"),
      regex: z.string().optional().describe("Filter log lines matching this regex pattern"),
      tail: z.number().int().positive().optional().describe("Return only the last N lines (default: all lines)"),
    },
    async ({ filename, host, start, end, regex, tail }) => {
      try {
        const result = await clients.admin.readLogs({ filename, host, start, end, regex, tail });
        return { content: [{ type: "text", text: result.content }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_reindex_status",
    "Check whether a MarkLogic database has finished reindexing after a TDE template was installed or an index configuration was changed. Returns ready=true when it is safe to query TDE views with ml_optic_query or run ml_tde_validate. Use this after flux_import with generate_tde=true to avoid SQL-TABLEREINDEXING errors.",
    {
      database: z.string().describe("Database name to check, e.g. 'Documents'"),
    },
    async ({ database }) => {
      try {
        const status = await clients.admin.getReindexStatus(database);
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
