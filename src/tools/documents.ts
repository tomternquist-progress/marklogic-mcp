import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerDocumentTools(server: McpServer, clients: MarkLogicClients, readonly: boolean): void {
  server.tool(
    "ml_document_get",
    "Retrieve a document from MarkLogic by URI. Returns content and optionally metadata (collections, permissions).",
    {
      uri: z.string().describe("Document URI, e.g. /data/customers/cust-001.json"),
      database: z.string().optional().describe("Database name (uses server default if omitted)"),
      include_metadata: z.boolean().optional().describe("Include collections, permissions, and properties"),
    },
    async ({ uri, database, include_metadata }) => {
      try {
        const doc = await clients.documents.get(uri, database, include_metadata ?? false);
        const text = typeof doc.content === "string"
          ? doc.content
          : JSON.stringify(doc.content, null, 2);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_document_list",
    "List document URIs in a MarkLogic collection or directory.",
    {
      collection: z.string().optional().describe("Filter by collection URI"),
      directory: z.string().optional().describe("Filter by directory prefix, e.g. /data/customers/"),
      start: z.number().int().positive().optional().describe("Pagination start (default: 1)"),
      page_length: z.number().int().positive().max(500).optional().describe("Page size (default: 20)"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ collection, directory, start, page_length, database }) => {
      try {
        const result = await clients.documents.list({ collection, directory, start, pageLength: page_length, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  if (!readonly) {
    server.tool(
      "ml_document_put",
      "Create or replace a document in MarkLogic at a specific URI. Requires ML_READONLY=false. NOTE: TDE templates must be stored in the 'Schemas' database (set database='Schemas') with the collection 'http://marklogic.com/xdmp/tde'.",
      {
        uri: z.string().describe("Document URI"),
        content: z.string().describe("Document content as string (JSON, XML, or plain text)"),
        content_type: z.enum(["application/json", "application/xml", "text/plain"]).describe("Content type"),
        collections: z.array(z.string()).optional().describe("Collection URIs to add document to. For TDE templates use 'http://marklogic.com/xdmp/tde'. Each entry becomes a separate collection."),
        database: z.string().optional().describe("Database name. Use 'Schemas' for TDE templates."),
      },
      async ({ uri, content, content_type, collections, database }) => {
        try {
          await clients.documents.put(uri, content, content_type, { collections, database });
          return { content: [{ type: "text", text: `Document created/updated: ${uri}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: toToolError(err) }], isError: true };
        }
      }
    );

    server.tool(
      "ml_document_delete",
      "Delete a document from MarkLogic by URI. Requires ML_READONLY=false.",
      {
        uri: z.string().describe("Document URI to delete"),
        database: z.string().optional().describe("Database name"),
      },
      async ({ uri, database }) => {
        try {
          await clients.documents.del(uri, database);
          return { content: [{ type: "text", text: `Document deleted: ${uri}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: toToolError(err) }], isError: true };
        }
      }
    );

    server.tool(
      "ml_document_patch",
      "Partially update a document using MarkLogic's patch descriptor. Requires ML_READONLY=false.",
      {
        uri: z.string().describe("Document URI to patch"),
        patch: z.record(z.unknown()).describe("MarkLogic patch descriptor object"),
        database: z.string().optional().describe("Database name"),
      },
      async ({ uri, patch, database }) => {
        try {
          await clients.documents.patchDocument(uri, patch, database);
          return { content: [{ type: "text", text: `Document patched: ${uri}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: toToolError(err) }], isError: true };
        }
      }
    );
  }
}
