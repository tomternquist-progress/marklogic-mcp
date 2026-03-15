import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerEvalTools(server: McpServer, clients: MarkLogicClients, allowEval: boolean): void {
  if (!allowEval) return; // Tools not registered at all when eval is disabled

  server.tool(
    "ml_eval_xquery",
    "Execute an XQuery expression on the MarkLogic server and return results. Requires ML_ALLOW_EVAL=true.",
    {
      xquery: z.string().describe("XQuery expression to evaluate on the server"),
      vars: z.record(z.unknown()).optional().describe("External variable bindings as key/value pairs"),
      database: z.string().optional().describe("Target database (uses server default if omitted)"),
    },
    async ({ xquery, vars, database }) => {
      try {
        const results = await clients.eval.evalXQuery(xquery, vars as Record<string, unknown> | undefined, database);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_eval_javascript",
    "Execute Server-Side JavaScript (SJS) on the MarkLogic server and return results. Requires ML_ALLOW_EVAL=true. Tips: use Array.from() instead of .toArray() on MarkLogic sequences; xdmp.httpGet() requires outbound network access from the MarkLogic host and may not reach external URLs; keep scripts concise to avoid payload size limits. Prefer XQuery eval for collection/metadata operations.",
    {
      javascript: z.string().describe("Server-Side JavaScript code to execute"),
      vars: z.record(z.unknown()).optional().describe("Variable bindings available in the script"),
      database: z.string().optional().describe("Target database"),
    },
    async ({ javascript, vars, database }) => {
      try {
        const results = await clients.eval.evalJavaScript(javascript, vars as Record<string, unknown> | undefined, database);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_invoke_module",
    "Invoke a stored XQuery or SJS module from the MarkLogic modules database. Requires ML_ALLOW_EVAL=true.",
    {
      module_uri: z.string().describe("URI of the stored module, e.g. /lib/transform.xqy"),
      vars: z.record(z.unknown()).optional().describe("Variable bindings to pass to the module"),
      database: z.string().optional().describe("Content database"),
      modules_database: z.string().optional().describe("Modules database name (uses server default if omitted)"),
    },
    async ({ module_uri, vars, database, modules_database }) => {
      try {
        const results = await clients.eval.invokeModule(module_uri, vars as Record<string, unknown> | undefined, database, modules_database);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
