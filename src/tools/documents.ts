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
    "ml_document_sample",
    "Fetch a small sample of documents from a MarkLogic collection and show their content and structure. Use this to understand document shape before writing TDE templates, Optic queries, or eval scripts — it saves multiple round-trips compared to listing URIs then fetching individually.\n\nReturns up to 5 documents with their full content. Use show_keys_only=true to get just the top-level field names and value types without the full document bodies.",
    {
      collection: z.string().describe("Collection to sample documents from"),
      count: z.number().int().positive().max(5).optional().describe("Number of documents to return (default: 3, max: 5)"),
      show_keys_only: z.boolean().optional().describe("Return only top-level field names and value types instead of full document content. Useful for large documents or when you just need the schema shape."),
      database: z.string().optional().describe("Database name (uses server default if omitted)"),
    },
    async ({ collection, count = 3, show_keys_only, database }) => {
      try {
        const listing = await clients.documents.list({ collection, pageLength: count, database });
        if (!listing.uris || listing.uris.length === 0) {
          return { content: [{ type: "text", text: `No documents found in collection "${collection}".` }] };
        }
        const samples: unknown[] = [];
        for (const uri of listing.uris.slice(0, count)) {
          try {
            const doc = await clients.documents.get(uri, database, false);
            const content = typeof doc.content === "string"
              ? (() => { try { return JSON.parse(doc.content as string) as unknown; } catch { return doc.content; } })()
              : doc.content;
            if (show_keys_only && content !== null && typeof content === "object" && !Array.isArray(content)) {
              const shape: Record<string, string> = {};
              for (const [k, v] of Object.entries(content as Record<string, unknown>)) {
                const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
                shape[k] = t;
              }
              samples.push({ uri, fields: shape });
            } else {
              samples.push({ uri, content });
            }
          } catch {
            samples.push({ uri, error: "Could not retrieve document" });
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(samples, null, 2) }] };
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
      "Create or replace a document in MarkLogic at a specific URI. Requires ML_READONLY=false.\n\nCAP ABILITIES: single-document-write, tde-template-install, module-install\n\nBest for: installing TDE templates, SJS/XQuery modules, config files, or inserting a small number of individual documents (<10). NOT intended for bulk data loading — use flux_import for loading CSV, JSON, Parquet, URL-fetched data, or any dataset with more than ~10 records.\n\nNOTE: TDE templates must be stored in the 'Schemas' database (set database='Schemas'). The required collection 'http://marklogic.com/xdmp/tde' is added automatically when database='Schemas' and the URI starts with '/tde/' — you do not need to pass it in the collections parameter.\n\nMULTI-ROW TDE WARNING: A single TDE template JSON with multiple entries in its 'rows' array will cause ALL views to fail registration silently (SQL-TABLENOTFOUND for every view). ALWAYS write one TDE file per view. E.g. /tde/schema/view1.json (one row entry), /tde/schema/view2.json (another). Never combine multiple rows[] entries in one template file.\n\nTDE PATH DEPTH FROM ARRAY CONTEXT: When the TDE 'context' is an array element (e.g. 'patient/reaction'), path expressions for ancestor fields must step up through: .. (array element) → ../.. (parent object) → ../../.. (grandparent). Example: from context 'patient/reaction', reaching a document-root field 'safetyreportid' requires '../../../safetyreportid' (3 levels), NOT '../../safetyreportid'.\n\nMODULES DATABASE: Documents written to the Modules database (database='Modules') are immediately available as executable code — the URI is the require/invoke path. For example, a document at /lib/utils.sjs can be loaded with require('/lib/utils.sjs') or invoked with xdmp.invoke('/lib/utils.sjs'). No restart or reload step is needed. Use content_type='application/javascript' for .sjs files and 'application/xquery' for .xqy files. When ML_ALLOW_EVAL=true, .sjs files are automatically syntax-checked on write and any compile errors are returned as warnings.\n\nPREFERRED OVER xdmp.documentInsert IN EVAL: Do NOT use xdmp.documentInsert() in ml_eval_javascript to write modules to the Modules DB — the cross-database write arg signature (arg5 is xs:int? quality, not a database name) will throw XDMP-ARGTYPE. Always use this tool (ml_document_put with database='Modules') instead.",
      {
        uri: z.string().describe("Document URI. For Modules database, this is the require/invoke path, e.g. /lib/utils.sjs"),
        content: z.string().describe("Document content as string (JSON, XML, plain text, JavaScript, or XQuery)"),
        content_type: z.enum([
          "application/json",
          "application/xml",
          "text/plain",
          "application/javascript",
          "application/xquery",
          "application/vnd.marklogic-js-module",
        ]).describe("Content type. Use 'application/javascript' for .sjs modules (works in all versions), 'application/vnd.marklogic-js-module' for the proper MarkLogic MIME type (required in some versions for correct require() resolution), 'application/xquery' for .xqy modules."),
        collections: z.array(z.string()).optional().describe("Collection URIs to add document to. For TDE templates use 'http://marklogic.com/xdmp/tde'. Each entry becomes a separate collection."),
        database: z.string().optional().describe("Database name. Use 'Schemas' for TDE templates, 'Modules' for executable SJS/XQuery modules."),
      },
      async ({ uri, content, content_type, collections, database }) => {
        try {
          // Auto-inject the TDE collection when storing to the Schemas DB under /tde/.
          // ml_document_put does NOT auto-add this collection, so TDE templates end up without it
          // and op.fromView() returns SQL-TABLENOTFOUND even though the template file exists.
          const isTdeWrite = (database ?? "").toLowerCase() === "schemas" && uri.startsWith("/tde/");
          const TDE_COLLECTION = "http://marklogic.com/xdmp/tde";
          const effectiveCollections = isTdeWrite && !collections?.includes(TDE_COLLECTION)
            ? [...(collections ?? []), TDE_COLLECTION]
            : collections;
          await clients.documents.put(uri, content, content_type, { collections: effectiveCollections, database });

          // Static-check SJS modules written to the Modules database
          const isModulesDb = (database ?? "").toLowerCase() === "modules";
          const isSjs = uri.endsWith(".sjs") || uri.endsWith(".mjs");
          if (isModulesDb && isSjs) {
            try {
              const warning = await clients.eval.staticCheckSjs(content);
              if (warning) {
                return {
                  content: [{
                    type: "text",
                    text: `Module stored at ${uri} (immediately callable via require('${uri}') / xdmp.invoke('${uri}')).\n\nSTATIC CHECK WARNING: ${warning}\n\nVerify against the MarkLogic SJS API before use — MarkLogic's SJS environment differs from Node.js (Sequences are not Arrays, no npm modules, etc.).`,
                  }],
                };
              }
            } catch {
              // Static check unavailable (e.g. ML_ALLOW_EVAL=false) — proceed silently
            }
            return {
              content: [{
                type: "text",
                text: `Module stored at ${uri}. Immediately callable via require('${uri}') or xdmp.invoke('${uri}'). Static check passed.`,
              }],
            };
          }

          const note = isModulesDb
            ? ` Immediately callable via require('${uri}') or xdmp.invoke('${uri}').`
            : "";
          return { content: [{ type: "text", text: `Document created/updated: ${uri}.${note}` }] };
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
