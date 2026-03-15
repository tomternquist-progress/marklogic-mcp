import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerSchemaTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_schema_discover",
    "Infer the document schema/structure of a MarkLogic collection by sampling documents. Returns field names, types, cardinality, and example values.",
    {
      collection: z.string().optional().describe("Collection URI to sample from"),
      sample_size: z.number().int().positive().max(50).optional().describe("Number of documents to sample (default: 10)"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ collection, sample_size, database }) => {
      try {
        const result = await clients.schema.discoverSchema({ collection, sampleSize: sample_size, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_schema_get_tde",
    "Retrieve Template Driven Extraction (TDE) schemas registered in the MarkLogic Schemas database. TDE schemas define row views over document data. Pass schema_name as the full URI (e.g. /tde/gdelt/events.json) to retrieve the template content; omit it to list all TDE URIs.",
    {
      schema_name: z.string().optional().describe("Full URI of the TDE template to retrieve (e.g. /tde/gdelt/events.json). Omit to list all TDE template URIs."),
      database: z.string().optional().describe("Database name (schemas are in the Schemas DB)"),
    },
    async ({ schema_name, database }) => {
      try {
        const schemas = await clients.schema.getTdeSchemas(database, schema_name);
        return { content: [{ type: "text", text: JSON.stringify(schemas, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_tde_validate",
    "Validate a TDE template against sample documents from a collection. Runs tde.validate() on up to sample_size documents and reports which pass/fail, lists the exact error messages, and suggests which columns need nullable:true. Use this after writing a new TDE template to verify it works before importing data — TDEs apply at query time, so you never need to re-import data to fix a TDE.",
    {
      tde_uri: z.string().describe("URI of the TDE template in the Schemas database, e.g. /tde/gdelt/events.json"),
      collection: z.string().describe("Collection to sample documents from, e.g. gdelt-events"),
      sample_size: z.number().int().positive().max(20).optional().describe("Number of documents to validate against (default: 5)"),
    },
    async ({ tde_uri, collection, sample_size }) => {
      try {
        const result = await clients.schema.validateTde({ tdeUri: tde_uri, collection, sampleSize: sample_size });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const msg = toToolError(err);
        if (msg.includes("reindexing") || msg.includes("TABLEREINDEXING")) {
          return {
            content: [{
              type: "text",
              text: `REINDEXING_IN_PROGRESS: The TDE view is not yet queryable — MarkLogic is still reindexing documents against the new template.\n\nRetry ml_tde_validate in a few seconds. Use ml_reindex_status (database="Documents") to check when reindex-count reaches 0 before retrying.`,
            }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    }
  );

  server.tool(
    "ml_indexes_list",
    "List all configured indexes for a MarkLogic database (range element, range path, range field, geospatial).",
    {
      database: z.string().describe("Database name to inspect"),
      index_type: z.enum(["range-element", "range-path", "range-field", "all"]).optional().describe("Filter by index type (default: all)"),
    },
    async ({ database, index_type }) => {
      try {
        const indexes = await clients.schema.listIndexes(database);
        const filtered = index_type && index_type !== "all"
          ? indexes.filter((i) => i.type === index_type)
          : indexes;
        return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_collections_list",
    "List document collections in MarkLogic with their document counts.",
    {
      limit: z.number().int().positive().max(500).optional().describe("Maximum collections to return (default: 50)"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ limit, database }) => {
      try {
        const collections = await clients.schema.listCollections(database, limit ?? 50);
        return { content: [{ type: "text", text: JSON.stringify(collections, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_namespaces_list",
    "List registered XML namespaces in a MarkLogic database. Essential for writing XQuery against XML documents.",
    {
      database: z.string().optional().describe("Database name"),
    },
    async ({ database }) => {
      try {
        const namespaces = await clients.schema.listNamespaces(database);
        return { content: [{ type: "text", text: JSON.stringify(namespaces, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
