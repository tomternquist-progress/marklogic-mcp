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
    "Execute Server-Side JavaScript (SJS) on the MarkLogic server and return results. Requires ML_ALLOW_EVAL=true.\n\nNOT recommended for bulk data import, URL ingestion, or loading more than ~5 documents at once — use flux_import instead, which handles HTTP fetch, format parsing, batching, and optional TDE generation natively in a single call. NOT recommended for write-heavy batch operations — use ml_document_put for individual documents or flux_import for any bulk load.\n\nBest for: server-side computation, calling MarkLogic built-ins (xdmp.*, cts.*) not exposed by other tools, custom in-database transformations, and small one-off reads/writes.\n\nCAP ABILITIES: server-side-logic, xdmp-access, cts-access, custom-transformation\n\nTips:\n- Use Array.from() instead of .toArray() on MarkLogic sequences\n- xdmp.httpGet() / xdmp.httpPost() require outbound network access from the MarkLogic host and may fail for some HTTPS endpoints with SSL SNI errors (tlsv1 unrecognized name) due to MarkLogic's embedded Java SSL client — if you need to call an external HTTPS API, fetch the data via WebFetch and load it via ml_document_put or ml_eval_javascript with vars instead\n- Object literal syntax: returning { key: val } as the last expression is a SyntaxError — JavaScript parses it as a block statement. Use var r = { key: val }; r or wrap in parens: ({ key: val })\n- Inline large data (e.g. column name arrays) as variables via the vars parameter rather than literals in the script to stay under the ~10 KB payload limit\n- Prefer XQuery eval for collection/metadata operations\n- PERMISSIONS: Always use explicit xdmp.permission('role','capability') calls for writes — xdmp.defaultPermissions() is unreliable in the eval context and will cause opaque HTTP 500 errors\n- BULK TRANSFORMS: Combining declareUpdate() with cts.search() iteration in a single eval transaction can cause 500 errors for large collections. For bulk field renames or transforms, write a module to the Modules DB (ml_document_put + database='Modules') and run it via flux_reprocess (preferred for > ~1 000 docs) or ml_invoke_module\n- xdmp.invoke() TRANSACTION ISOLATION: if the invoked module starts with declareUpdate(), call it from eval as xdmp.invoke('/path.sjs', null, {isolation: 'different-transaction', update: 'true'}) — otherwise the caller's query transaction blocks the update\n- RDF SEMANTICS: sem.rdfGet() does NOT exist in SJS (only XQuery). To load RDF from a URL server-side, use xdmp.httpGet() (watch for SSL SNI errors on HTTPS) or fetch via WebFetch + inject content through vars, then call sem.rdfParse(content, ['turtle']) and sem.rdfStore(triples). For loading Turtle/N-Triples files directly into a named graph use ml_graph_put instead.\n- Use fn.subsequence(cts.search(...), start, length) to page through results — do NOT pass {limit:N} as a third arg to cts.search() (that parameter is quality, not a limit)",
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
        const is500 = err instanceof Error && msg.includes("500");
        if (is500) {
          const scriptKb = Math.round(Buffer.byteLength(javascript, "utf8") / 1024);
          // Try to extract a MarkLogic error code embedded in the response (often in an HTML body)
          // Detect JS-JAVASCRIPT SyntaxError — common when returning an object literal
          // as an expression statement: `{ key: val }` is parsed as a block, not an object.
          const isSyntaxErr = msg.includes("JS-JAVASCRIPT") && msg.includes("SyntaxError");
          if (isSyntaxErr) {
            return {
              content: [{
                type: "text",
                text: `${msg}\n\nSyntaxError hint: a bare object literal \`{ key: val }\` at the end of a script is parsed as a block statement, not a return value. Fix: assign to a variable (\`var r = {...}; r\`) or wrap in parens (\`({...})\`).`,
              }],
              isError: true,
            };
          }
          const mlCodeMatch = msg.match(/(XDMP-[A-Z][A-Z0-9]*)/);
          const mlCode = mlCodeMatch?.[1];
          if (mlCode) {
            return {
              content: [{
                type: "text",
                text: `${msg}\n\nError code detected: ${mlCode}. This is a server-side MarkLogic error — check your script for undefined variables, type mismatches, missing modules, or permission issues.`,
              }],
              isError: true,
            };
          }
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
