import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerOpticTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_optic_query",
    "Execute an Optic query against MarkLogic using a serialized plan (the $optic JSON format). Returns rows and column names.",
    {
      plan: z.record(z.unknown()).describe(
        "Serialized Optic plan as a JSON object. Must be the $optic plan format, e.g. {\"$optic\":{\"ns\":\"op\",\"fn\":\"operators\",\"args\":[...]}}"
      ),
      database: z.string().optional().describe("Target database (uses server default if omitted)"),
    },
    async ({ plan, database }) => {
      try {
        const result = await clients.optic.query(plan, database);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        let msg = toToolError(err);
        if (msg.includes("SQL-TABLENOTFOUND") || (msg.includes("Table") && msg.includes("not found"))) {
          msg += "\nHint: TDE templates must be stored in the Schemas database with collection 'http://marklogic.com/xdmp/tde'. Use ml_document_put with database='Schemas' to register your template, then use ml_schema_get_tde to verify it was applied.";
        }
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    }
  );
}
