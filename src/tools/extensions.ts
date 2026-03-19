import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerExtensionTools(
  server: McpServer,
  clients: MarkLogicClients,
  readonly: boolean
): void {
  // ── Read tools (always available) ─────────────────────────────────────────

  server.tool(
    "ml_extension_list",
    "List all REST resource extensions deployed to MarkLogic. " +
    "Extensions live at /v1/resources/{name} and are managed at /v1/config/resources/{name}. " +
    "Use ml_extension_get to retrieve source code, ml_extension_call to invoke an extension.",
    {},
    async () => {
      try {
        const result = await clients.extensions.listExtensions();
        if (result.length === 0) {
          return { content: [{ type: "text", text: "No REST extensions deployed." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_extension_get",
    "Retrieve the source code of a deployed REST resource extension. " +
    "Use ml_extension_list first to see available extension names.",
    {
      name: z.string().describe("Extension name (as shown by ml_extension_list)"),
    },
    async ({ name }) => {
      try {
        const code = await clients.extensions.getExtension(name);
        return { content: [{ type: "text", text: code }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_extension_call",
    "Invoke a deployed REST resource extension at /v1/resources/{name}. " +
    "GET extensions are read-safe; POST extensions may perform writes. " +
    "Use ml_extension_list first to see available extension names.\n\n" +
    "SJS EXTENSION CONTRACT:\n" +
    "  exports.GET = function(context, params) { ... }\n" +
    "  exports.POST = function(context, params, input) { ... }\n" +
    "  context.outputTypes = ['application/json']  — set before returning\n" +
    "  params  — plain object; this tool automatically adds the required rs: prefix to all keys\n" +
    "  Return a plain JS object for JSON, or a Node for XML/binary\n\n" +
    "rs: PREFIX — MarkLogic requires all extension query params prefixed with 'rs:' on the wire.\n" +
    "  This tool handles that automatically. Pass params without the prefix:\n" +
    "  {department:'Engineering'} is sent as ?rs:department=Engineering on the URL.\n\n" +
    "EXAMPLE — employee search extension:\n" +
    "  name='employee-search', method='GET', params={department:'Engineering', 'salary-min':'100000'}",
    {
      name: z.string().describe("Extension name"),
      method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method to use"),
      params: z.record(z.string()).optional().describe(
        "URL query parameters as key/value string pairs, e.g. {department: 'Engineering', 'salary-min': '100000'}"
      ),
      body: z.record(z.unknown()).optional().describe(
        "Request body for POST extensions (sent as JSON)"
      ),
    },
    async ({ name, method, params, body }) => {
      try {
        const result = await clients.extensions.callExtension(name, method, params ?? {}, body);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: toToolError(err) +
              "\nNOTE: Check that the extension is deployed (ml_extension_list) and that " +
              "the module has no syntax errors (try ml_extension_get to inspect source code). " +
              "REST extensions run in the App Server's database context — ensure indexes " +
              "referenced in the extension exist (ml_indexes_list).",
          }],
          isError: true,
        };
      }
    }
  );

  // ── Write tools (gated on readonly) ───────────────────────────────────────

  if (!readonly) {
    server.tool(
      "ml_extension_put",
      "Deploy (or replace) a REST resource extension on MarkLogic. Requires ML_READONLY=false. " +
      "PUTs the source code to /v1/config/resources/{name} which writes three files to the Modules DB:\n" +
      "  /marklogic.rest.resource/{name}/assets/metadata.xml  — declares source-format (javascript|xquery)\n" +
      "  /marklogic.rest.resource/{name}/assets/resource.sjs  — your SJS handler\n" +
      "  /marklogic.rest.resource/{name}/assets/resource.xqy  — stub (auto-generated)\n" +
      "The metadata.xml source-format field controls which file MarkLogic loads. The REST PUT endpoint " +
      "handles all three files automatically — never write them manually.\n\n" +
      "SJS MODULE TEMPLATE:\n" +
      "  'use strict';\n" +
      "  function get(context, params) {\n" +
      "    context.outputTypes = ['application/json'];\n" +
      "    return { message: 'hello' };\n" +
      "  }\n" +
      "  exports.GET = get;\n\n" +
      "KEY PATTERNS:\n" +
      "  • params is a plain object — all values are strings from the URL query string\n" +
      "  • Use cts.search(), cts.values(), cts.estimate() for data access\n" +
      "  • Use fn.subsequence(cts.search(query), start, pageSize) for pagination\n" +
      "  • Use cts.frequency(v) on values from cts.values(ref, null, ['frequency-order','item-frequency'], query) for facet counts\n" +
      "  • cts.pathReference('//field', ['type=string','collation=...']) — type/collation options go HERE (index ref)\n" +
      "  • cts.pathRangeQuery('//field', '=', value) — NO type/collation options; uses the index definition automatically\n" +
      "  • Numeric params arrive as strings — parseFloat(params['salary-min']) before range queries\n" +
      "  • No declareUpdate() needed for read-only GET extensions\n" +
      "  • Use the rest_extension_generator prompt to generate a complete module from a schema",
      {
        name: z.string().describe(
          "Extension name — becomes the URL path segment: /v1/resources/{name}"
        ),
        code: z.string().describe(
          "Complete SJS or XQuery module source code. SJS must export handlers via exports.GET, exports.POST, etc."
        ),
        language: z.enum(["javascript", "xquery"]).default("javascript").describe(
          "Module language (default: javascript)"
        ),
      },
      async ({ name, code, language }) => {
        try {
          await clients.extensions.putExtension(name, code, language);
          return {
            content: [{
              type: "text",
              text: `Extension '${name}' deployed successfully.\n` +
                    `Invoke with ml_extension_call: name='${name}', method='GET', params={...}\n` +
                    `REST URL: /v1/resources/${name}`,
            }],
          };
        } catch (err) {
          return {
            content: [{
              type: "text",
              text: toToolError(err) +
                "\nNOTE: Syntax errors in the module will cause a 400 or 500 on deployment. " +
                "Check the error message for line numbers. Use the rest_extension_generator " +
                "prompt to generate a well-formed starting module.",
            }],
            isError: true,
          };
        }
      }
    );

    server.tool(
      "ml_extension_delete",
      "Remove a deployed REST resource extension from MarkLogic. Requires ML_READONLY=false. " +
      "Deletes both the module from the Modules database and its registration. " +
      "Any client calling /v1/resources/{name} will receive 404 after deletion.",
      {
        name: z.string().describe("Extension name to delete"),
      },
      async ({ name }) => {
        try {
          await clients.extensions.deleteExtension(name);
          return { content: [{ type: "text", text: `Extension '${name}' deleted.` }] };
        } catch (err) {
          return { content: [{ type: "text", text: toToolError(err) }], isError: true };
        }
      }
    );
  }
}
