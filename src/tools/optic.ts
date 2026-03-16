import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerOpticTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_optic_query",
    "Execute an Optic query against MarkLogic using a serialized plan (the $optic JSON format). Returns rows and column names.",
    {
      plan: z.union([z.record(z.unknown()), z.string()]).describe(
        "Serialized Optic plan as a JSON object (preferred) or JSON string. Must be the $optic plan format, e.g. {\"$optic\":{\"ns\":\"op\",\"fn\":\"operators\",\"args\":[...]}}.\n\n" +
        "COMMON OPERATORS:\n" +
        "- from-view: args=[\"schema\",\"view\"]\n" +
        "- where: args=[{\"ns\":\"op\",\"fn\":\"eq\",\"args\":[{col},{val}]}]\n" +
        "- select: args=[[col1, col2, ...]]\n" +
        "- order-by (SINGLE key): args=[{\"ns\":\"op\",\"fn\":\"desc\",\"args\":[\"colName\"]}]\n" +
        "- order-by (MULTIPLE keys): wrap in an array — args=[[{\"ns\":\"op\",\"fn\":\"asc\",\"args\":[\"col1\"]},{\"ns\":\"op\",\"fn\":\"desc\",\"args\":[\"col2\"]}]]\n" +
        "- group-by: args=[groupCols, [aggregates]]\n" +
        "- limit: args=[N]\n" +
        "- join-inner: args=[rightView, {\"ns\":\"op\",\"fn\":\"on\",\"args\":[leftCol,rightCol]}]"
      ),
      database: z.string().optional().describe("Target database (uses server default if omitted)"),
      strip_schema_prefix: z.boolean().optional().describe("Strip the 'schema.view.' prefix from result column names. Useful when querying a single view and the fully-qualified names are too verbose. Default: false."),
    },
    async ({ plan, database, strip_schema_prefix }) => {
      let planObj: Record<string, unknown>;
      if (typeof plan === "string") {
        try {
          planObj = JSON.parse(plan) as Record<string, unknown>;
        } catch {
          return { content: [{ type: "text", text: "Invalid plan: could not parse string as JSON. Pass the $optic plan as a JSON object, not a string." }], isError: true };
        }
      } else {
        planObj = plan;
      }
      try {
        const result = await clients.optic.query(planObj, database, strip_schema_prefix);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        let msg = toToolError(err);
        if (msg.includes("SQL-TABLENOTFOUND") || (msg.includes("Table") && msg.includes("not found"))) {
          msg += "\nHint: TDE templates must be stored in the Schemas database with collection 'http://marklogic.com/xdmp/tde'. Use ml_document_put with database='Schemas' to register your template, then use ml_schema_get_tde to verify it was applied.";
        }
        if (msg.includes("TABLEREINDEXING") || msg.includes("reindexing")) {
          msg += "\nHint: The TDE view is still being built. Use ml_reindex_status (database=\"Documents\") to check when reindex-count reaches 0, then retry.";
        }
        if (msg.includes("OPTIC-INVALARGS") && msg.includes("orderBy")) {
          msg += "\nHint: order-by accepts exactly 1 argument. For a single sort key use: {\"ns\":\"op\",\"fn\":\"order-by\",\"args\":[{\"ns\":\"op\",\"fn\":\"desc\",\"args\":[\"col\"]}]}. For MULTIPLE sort keys, wrap them in a nested array as the single argument: {\"ns\":\"op\",\"fn\":\"order-by\",\"args\":[[{\"ns\":\"op\",\"fn\":\"asc\",\"args\":[\"col1\"]},{\"ns\":\"op\",\"fn\":\"desc\",\"args\":[\"col2\"]}]]}.";
        }
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    }
  );

  server.tool(
    "ml_views_list",
    "List all Optic row views available in MarkLogic — the schema.view pairs you can query with ml_optic_query. Each entry shows the schema name, view name, TDE template URI, and the document collections it covers. Use this to discover queryable views after importing data with generate_tde=true.",
    {
      database: z.string().optional().describe("Database name (schemas are always read from the Schemas DB)"),
    },
    async () => {
      try {
        const views = await clients.schema.listViews();
        if (views.length === 0) {
          return { content: [{ type: "text", text: "No TDE views found. Import data with generate_tde=true or install a TDE template via ml_document_put (database='Schemas', collection='http://marklogic.com/xdmp/tde')." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(views, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
