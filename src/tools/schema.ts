import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError, appendTdeHint } from "../utils/errors.js";

export function registerSchemaTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_schema_discover",
    "Infer the document schema/structure of a MarkLogic collection by sampling documents. Returns field names, types, cardinality, and example values.",
    {
      collection: z.string().optional().describe("Collection URI to sample from"),
      sample_size: z.number().int().positive().max(50).optional().describe("Number of documents to sample (default: 10)"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
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
      database: z.string().optional().describe("Database name for the TDE template lookup. Schemas are always read from the Schemas DB; this param routes the content DB context. Projects have their own DBs — run ml_databases_list to discover them."),
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
    "Verify a TDE template is working by querying its Optic row view and returning sample rows. Reports row count vs document count, surfaces SQL-TABLENOTFOUND and TABLEREINDEXING errors, and shows sample rows so you can confirm the right data is being extracted. Uses Optic row queries for validation.\n\nPREREQUISITES:\n  1. Template must be in the Schemas database, collection http://marklogic.com/xdmp/tde.\n     Install via ml_tde_install (or ml_document_put with database='Schemas' and uri under /tde/).\n  2. After install, the database must finish reindexing before views are queryable.\n     Check with ml_reindex_status — wait until reindex-count reaches 0 before validating.\n  3. Use ml_views_list to confirm the schema.view pair your template defines is registered.\n\nNOTE: tde.validate([node],[]) (array-of-nodes signature) works in SJS on MarkLogic 12.0.1 and can be used for schema-level validation via ml_eval_javascript: tde.validate([cts.doc('/tde/my.json')],[])\n\nIMPORTANT — TDE JSON SYNTAX RULES (common mistakes):\n  1. Triple subject/object references must use { \"val\": \"<XPath-expression>\" }, NOT { \"column\": \"<name>\" }.\n     'column' is invalid in TDE triples and causes TDE-INVALIDTEMPLATEPROPNODE.\n     Correct: { \"subject\": { \"val\": \"sem:iri(fn:concat('http://.../', id))\" } }\n  2. Parent axis (../id) does NOT work in JSON sub-templates.\n     Use fn:root() to navigate back to the document root:\n     Correct: { \"val\": \"fn:root()/movie/id\" }\n  3. scalarType 'IRI' is NOT valid for row column definitions.\n     Row columns support: string, integer, long, float, double, decimal, dateTime, date, time, boolean, anyURI.\n     Construct IRIs only in the 'triples' section using sem:iri().\n  4. The template must be in the Schemas database with collection 'http://marklogic.com/xdmp/tde'.\n     Use ml_tde_install (or ml_document_put with database='Schemas') to deploy it correctly.",
    {
      tde_uri: z.string().describe("URI of the TDE template in the Schemas database, e.g. /tde/gdelt/events.json"),
      collection: z.string().describe("Collection to sample documents from, e.g. gdelt-events"),
      sample_size: z.number().int().positive().max(20).optional().describe("Number of documents to validate against (default: 5)"),
      database: z.string().optional().describe(
        "Content database to query for the documents and view, e.g. 'ps-forecast-content'. " +
        "REQUIRED for multi-DB topologies where the TDE's content DB is not the app server's default — " +
        "without it the validator routes to the default content DB and reports false-negative \"0 documents\". " +
        "Pass the same content DB associated with the Schemas DB where the TDE was installed."
      ),
    },
    async ({ tde_uri, collection, sample_size, database }) => {
      try {
        const result = await clients.schema.validateTde({ tdeUri: tde_uri, collection, sampleSize: sample_size, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const msg = appendTdeHint(toToolError(err));
        if (msg.includes("TDE-INVALIDTEMPLATEPROPNODE") || msg.includes("INVALIDTEMPLATEPROPNODE")) {
          return {
            content: [{
              type: "text",
              text: `${msg}\nHint: TDE-INVALIDTEMPLATEPROPNODE — an invalid property was used in the template.\n  • Using { "column": "name" } in a triple subject/predicate/object is invalid.\n    Fix: use { "val": "<XPath-expression>" } — e.g. { "subject": { "val": "sem:iri(fn:concat('http://example.org/', id))" } }\n  • scalarType "IRI" is not valid for row columns — use "string"; construct IRIs in the triples section via sem:iri().\n  • ../id does not navigate to parent in JSON sub-templates — use fn:root()/parentElement/id.`,
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
    "List all configured indexes for a MarkLogic database (range element, range path, range field, geospatial element pair, geospatial path). " +
    "Geospatial indexes are required by ml_geospatial_search — check here first to see what parent/lat/lon property names are indexed.",
    {
      database: z.string().describe("Database name to inspect"),
      index_type: z.enum(["range-element", "range-path", "range-field", "geospatial", "all"]).optional().describe("Filter by index type: 'geospatial' shows all geospatial index variants (default: all)"),
    },
    async ({ database, index_type }) => {
      try {
        const indexes = await clients.schema.listIndexes(database);
        const filtered = (!index_type || index_type === "all")
          ? indexes
          : index_type === "geospatial"
          ? indexes.filter((i) => i.type.startsWith("geospatial-"))
          : indexes.filter((i) => i.type === index_type);
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
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
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
    "ml_tde_install",
    "Install a TDE (Template Driven Extraction) template into the MarkLogic Schemas database with the correct collection. " +
    "This is a convenience wrapper around ml_document_put that automatically sets database='Schemas' and " +
    "adds the required collection 'http://marklogic.com/xdmp/tde'.\n\n" +
    "Use this instead of ml_document_put when deploying TDE templates — it removes the friction of remembering " +
    "the database name and TDE collection URI.\n\n" +
    "AFTER INSTALLING:\n" +
    "  1. Run ml_tde_validate to verify the template produces the expected rows.\n" +
    "  2. MarkLogic reindexes asynchronously — ml_tde_validate will report TABLEREINDEXING while in progress.\n" +
    "  3. Once indexed, query via ml_optic_query or ml_eval_javascript with the op.fromView() API.\n\n" +
    "TDE SYNTAX RULES (common mistakes that cause TDE-INVALIDTEMPLATEPROPNODE):\n" +
    "  1. Triple subject/object must use { \"val\": \"<XPath>\" }, NOT { \"column\": \"<name>\" }\n" +
    "     Correct: { \"subject\": { \"val\": \"sem:iri(fn:concat('http://.../', id))\" } }\n" +
    "  2. Parent axis (../id) does NOT work in JSON sub-templates — use fn:root()/parentElement/field\n" +
    "  3. scalarType 'IRI' is NOT valid for row columns — use 'string' and construct IRIs in triples section\n\n" +
    "COLLECTION-SCOPED TEMPLATES (apply TDE to a subset of documents):\n" +
    "  The 'collections' filter inside a TDE template must use an ARRAY — a bare string value silently\n" +
    "  installs without error but the view will not exist (SQL-TABLENOTFOUND on every query):\n" +
    "    WRONG: \"collections\": {\"collection\": \"my-col\"}         ← string, silently broken\n" +
    "    RIGHT: \"collections\": {\"collection\": [\"my-col\"]}       ← array required\n" +
    "  Full example:\n" +
    "    { \"template\": { \"context\": \"/\", \"collections\": {\"collection\": [\"my-col\"]},\n" +
    "                     \"rows\": [{\"schemaName\": \"s\", \"viewName\": \"v\", \"columns\": [...]}] } }",
    {
      uri: z.string().describe("URI for the TDE template in the Schemas database, e.g. /tde/my-template.json"),
      content: z.string().describe("TDE template content (JSON or XML)"),
      content_type: z.enum(["application/json", "application/xml"]).optional().describe(
        "Content type (default: application/json)"
      ),
    },
    async ({ uri, content, content_type }) => {
      try {
        const TDE_COLLECTION = "http://marklogic.com/xdmp/tde";
        await clients.documents.put(uri, content, content_type ?? "application/json", {
          collections: [TDE_COLLECTION],
          database: "Schemas",
        });

        // Run tde.validate against the freshly-written template to catch structural
        // errors that documents.put accepts silently — the most common case being a
        // mis-shaped "collections" filter that produces a TDE without any working
        // view (SQL-TABLENOTFOUND on every query). See ML-5/ML-11 in the friction log.
        // A 403 (eval-in privilege missing) means we silently skip — the install
        // itself already succeeded.
        let validationNote = "";
        try {
          const err = await clients.schema.validateTemplateSyntax(uri);
          if (err) {
            return {
              content: [{
                type: "text",
                text:
                  `TDE TEMPLATE INSTALLED BUT FAILED VALIDATION\n` +
                  "─".repeat(50) + "\n\n" +
                  `  URI:        ${uri}\n` +
                  `  Database:   Schemas\n` +
                  `  Collection: ${TDE_COLLECTION}\n\n` +
                  `tde.validate reported errors — the template was written but will not produce a working view:\n\n${err}\n\n` +
                  "Common causes:\n" +
                  "  • collections filter must be a plain JSON array — { \"collections\": {\"collection\": [\"my-col\"]} }, NOT a bare string.\n" +
                  "  • triple subject/object must use { \"val\": \"<XPath>\" }, NOT { \"column\": \"<name>\" }.\n" +
                  "  • scalarType \"IRI\" is not allowed for row columns — use \"string\" and construct IRIs in the triples section.\n" +
                  "  • parent axis (../id) does not work in JSON sub-templates — use fn:root()/parent/id.\n\n" +
                  "Fix the template and re-run ml_tde_install (the put will replace the existing document).",
              }],
              isError: true,
            };
          }
          validationNote = "Template syntax validated (tde.validate reported no errors).\n";
        } catch {
          // Eval not permitted, or eval endpoint unreachable — skip the validation
          // step silently. The install itself succeeded.
          validationNote = "Template syntax was NOT validated (eval-in privilege required for tde.validate; install itself succeeded).\n";
        }

        return {
          content: [{
            type: "text",
            text:
              `TDE TEMPLATE INSTALLED\n` +
              "─".repeat(50) + "\n\n" +
              `  URI:        ${uri}\n` +
              `  Database:   Schemas\n` +
              `  Collection: ${TDE_COLLECTION}\n\n` +
              validationNote + "\n" +
              "MarkLogic will begin reindexing documents against this template asynchronously.\n\n" +
              "NEXT STEPS:\n" +
              `  1. Validate: ml_tde_validate  tde_uri="${uri}"  collection="<your-collection>"\n` +
              "  2. Query:    ml_optic_query   schema=\"<schemaName>\"  view=\"<viewName>\"\n" +
              "     Or in ml_eval_javascript (note: op must be required):\n" +
              "       const op = require('/MarkLogic/optic');\n" +
              "       op.fromView('<schemaName>', '<viewName>').result();",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_namespaces_list",
    "List registered XML namespaces in a MarkLogic database. Essential for writing XQuery against XML documents.",
    {
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
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
