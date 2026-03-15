import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerGraphTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_sparql_query",
    "Execute a SPARQL SELECT or CONSTRUCT query against the MarkLogic triple store (semantic graph database).",
    {
      sparql: z.string().describe("SPARQL query string (SELECT, CONSTRUCT, ASK, or DESCRIBE)"),
      default_graph: z.string().optional().describe("Default named graph URI"),
      base: z.string().optional().describe("Base URI for resolving relative URIs in the query"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ sparql, default_graph, base, database }) => {
      try {
        const result = await clients.graphs.sparqlQuery(sparql, { defaultGraph: default_graph, database, base });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_graphs_list",
    "List named graphs stored in the MarkLogic triple store.",
    {
      start: z.number().int().positive().optional().describe("Pagination start (default: 1)"),
      page_length: z.number().int().positive().max(200).optional().describe("Results per page (default: 20)"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ start, page_length, database }) => {
      try {
        const result = await clients.graphs.listGraphs({ start, pageLength: page_length, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
