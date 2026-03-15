import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerSearchTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_search",
    "Full-text and structured search across MarkLogic documents. Supports string queries and JSON structured queries.",
    {
      q: z.string().optional().describe("Full-text query string (Google-style syntax supported)"),
      structured_query: z.record(z.unknown()).optional().describe("MarkLogic structured query JSON object"),
      collection: z.string().optional().describe("Limit search to this collection URI"),
      directory: z.string().optional().describe("Limit search to documents under this directory path"),
      start: z.number().int().positive().optional().describe("Pagination start position (default: 1)"),
      page_length: z.number().int().positive().max(100).optional().describe("Results per page (default: 10)"),
      options: z.string().optional().describe("Named search options node configured on the server"),
      database: z.string().optional().describe("Database to search (uses server default if omitted)"),
    },
    async ({ q, structured_query, collection, directory, start, page_length, options, database }) => {
      try {
        const result = await clients.search.search({
          q,
          structuredQuery: structured_query,
          collection,
          directory,
          start,
          pageLength: page_length,
          options,
          database,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_search_qbe",
    "Query By Example — find MarkLogic documents that match an example document structure.",
    {
      qbe: z.record(z.unknown()).describe("Example document structure to match against"),
      start: z.number().int().positive().optional().describe("Pagination start (default: 1)"),
      page_length: z.number().int().positive().max(100).optional().describe("Results per page (default: 10)"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ qbe, start, page_length, database }) => {
      try {
        const result = await clients.search.qbe(qbe, { start, pageLength: page_length, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_values_query",
    "Query MarkLogic lexicons and range indexes to get facet values, counts, and aggregates.",
    {
      values_name: z.string().describe("Named values/tuples definition configured in search options"),
      query: z.string().optional().describe("Constraining search query to filter values"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum values to return (default: 20)"),
      direction: z.enum(["ascending", "descending"]).optional().describe("Sort direction (default: descending by frequency)"),
      aggregate: z.string().optional().describe("Aggregate function: sum, count, avg, min, max, stddev"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ values_name, query, limit, direction, aggregate, database }) => {
      try {
        const result = await clients.search.values(values_name, { query, limit, direction, aggregate, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_suggest",
    "Get search query autocomplete suggestions from MarkLogic based on a partial query string.",
    {
      partial_q: z.string().describe("Partial query string to complete"),
      limit: z.number().int().positive().max(50).optional().describe("Max suggestions to return (default: 10)"),
      options: z.string().optional().describe("Named search options node"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ partial_q, options, database }) => {
      try {
        const suggestions = await clients.search.suggest(partial_q, options, database);
        return { content: [{ type: "text", text: JSON.stringify(suggestions, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
