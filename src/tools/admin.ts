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
    "List forests attached to the MarkLogic cluster or a specific database.",
    { database: z.string().optional().describe("Filter by database name (optional)") },
    async ({ database }) => {
      try {
        const forests = await clients.admin.listForests(database);
        return { content: [{ type: "text", text: JSON.stringify(forests, null, 2) }] };
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
}
