import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerAllResources(server: McpServer, clients: MarkLogicClients): void {
  // List of databases
  server.resource(
    "marklogic_databases",
    "marklogic://databases",
    { mimeType: "application/json", description: "List of all MarkLogic databases in the cluster" },
    async () => {
      try {
        const databases = await clients.admin.listDatabases();
        return { contents: [{ uri: "marklogic://databases", text: JSON.stringify(databases, null, 2), mimeType: "application/json" }] };
      } catch (err) {
        return { contents: [{ uri: "marklogic://databases", text: toToolError(err) }] };
      }
    }
  );

  // Cluster status
  server.resource(
    "marklogic_cluster_status",
    "marklogic://cluster/status",
    { mimeType: "application/json", description: "MarkLogic cluster health and version information" },
    async () => {
      try {
        const status = await clients.admin.getClusterStatus();
        return { contents: [{ uri: "marklogic://cluster/status", text: JSON.stringify(status, null, 2), mimeType: "application/json" }] };
      } catch (err) {
        return { contents: [{ uri: "marklogic://cluster/status", text: toToolError(err) }] };
      }
    }
  );

  // Document by URI (static resource — agents pass the doc URI as a parameter via ml_document_get)
  server.resource(
    "marklogic_document_info",
    "marklogic://documents",
    { mimeType: "text/plain", description: "MarkLogic document access. Use the ml_document_get tool to retrieve a specific document by URI." },
    async () => ({
      contents: [{
        uri: "marklogic://documents",
        text: "Use the ml_document_get tool to retrieve a MarkLogic document by URI.\nUse ml_document_list to browse available documents by collection or directory.",
        mimeType: "text/plain",
      }],
    })
  );

  // Forests list
  server.resource(
    "marklogic_forests",
    "marklogic://forests",
    { mimeType: "application/json", description: "List of all MarkLogic forests" },
    async () => {
      try {
        const forests = await clients.admin.listForests();
        return { contents: [{ uri: "marklogic://forests", text: JSON.stringify(forests, null, 2), mimeType: "application/json" }] };
      } catch (err) {
        return { contents: [{ uri: "marklogic://forests", text: toToolError(err) }] };
      }
    }
  );
}
