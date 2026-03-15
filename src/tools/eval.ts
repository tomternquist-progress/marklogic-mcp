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
    "Execute Server-Side JavaScript (SJS) on the MarkLogic server and return results. Requires ML_ALLOW_EVAL=true. Tips: use Array.from() instead of .toArray() on MarkLogic sequences; xdmp.httpGet() requires outbound network access from the MarkLogic host and may not reach external URLs; inline large data (e.g. column name arrays) as variables via the vars parameter rather than literals in the script to stay under the ~10 KB payload limit. Prefer XQuery eval for collection/metadata operations.",
    {
      javascript: z.string().describe("Server-Side JavaScript code to execute. Keep scripts concise — large inline literals can exceed the ~10 KB payload limit and return a bare HTTP 500. Pass large values via the vars parameter instead."),
      vars: z.record(z.unknown()).optional().describe("Variable bindings available in the script as top-level variables. Prefer this over inlining large arrays or strings into the script to stay within payload size limits."),
      database: z.string().optional().describe("Target database"),
    },
    async ({ javascript, vars, database }) => {
      try {
        const results = await clients.eval.evalJavaScript(javascript, vars as Record<string, unknown> | undefined, database);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        const msg = toToolError(err);
        // HTTP 500 with no body typically means the payload was too large for the eval endpoint
        const is500 = err instanceof Error && msg.includes("500");
        if (is500) {
          const scriptKb = Math.round(Buffer.byteLength(javascript, "utf8") / 1024);
          return {
            content: [{
              type: "text",
              text: `${msg}\n\nIf the response body was empty, the script payload may be too large (current script: ~${scriptKb} KB). Move large inline values (arrays, strings) into the vars parameter and reference them by variable name in the script.`,
            }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: msg }], isError: true };
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
