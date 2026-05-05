import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerFastTrackTools(
  server: McpServer,
  clients: MarkLogicClients,
  readonly: boolean
): void {
  server.tool(
    "ml_search_options_list",
    "List all named search-options configurations stored in MarkLogic. " +
    "Search options define constraints (facets), result snippeting, and extracted fields " +
    "that power FastTrack SearchBar and FacetFilters widgets. " +
    "Use ml_search_options_get to retrieve a specific configuration. " +
    "Use ml_search_options_put to create or update a configuration (requires ML_READONLY=false).",
    {
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ database }) => {
      try {
        const result = await clients.fasttrack.listSearchOptions(database);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_search_options_get",
    "Retrieve a named search-options configuration from MarkLogic as JSON. " +
    "Search options drive FastTrack widgets: " +
    "'constraint' entries become FacetFilters facets, " +
    "'extract-document-data' defines which fields appear in SearchBar result cards, " +
    "'geo-elem-pair' constraint configures the Geospatial Map widget, " +
    "date range constraints configure the Timeline widget. " +
    "Call ml_search_options_list first to see available option set names.",
    {
      name: z.string().describe("Name of the search options configuration to retrieve"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ name, database }) => {
      try {
        const result = await clients.fasttrack.getSearchOptions(name, database);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  if (!readonly) {
    server.tool(
      "ml_search_options_put",
      "Create or replace a named search-options configuration in MarkLogic. Requires ML_READONLY=false. " +
      "Search options control the behavior of ml_search and are the central configuration for FastTrack widgets:\n" +
      "  • 'constraint' entries → FacetFilters facets (range constraints need a pre-existing range index)\n" +
      "  • 'extract-document-data' → SearchBar result card fields\n" +
      "  • 'geo-elem-pair' constraint → Geospatial Map widget (requires geospatial element pair index)\n" +
      "  • date/dateTime range constraint → Timeline widget\n" +
      "  • 'return-facets: true' → enables facet counts\n" +
      "NOTE: Range-type constraints require pre-existing range indexes — call ml_indexes_list first. " +
      "After saving, verify with ml_search using options=<name>. " +
      "Use the fasttrack_search_designer prompt to generate the options JSON from a schema.\n\n" +
      "CONSTRAINT PATTERNS FOR JSON DOCUMENTS:\n" +
      "  PREFERRED — path-index (requires range-path-index created via admin:database-add-range-path-index):\n" +
      "    {\"name\":\"dept\",\"range\":{\"type\":\"xs:string\",\"facet\":true,\"path-index\":{\"text\":\"//department\"}}}\n" +
      "  ALTERNATIVE — json-property (requires range-json-property-index via Management API on port 8002):\n" +
      "    {\"name\":\"dept\",\"range\":{\"type\":\"xs:string\",\"facet\":true,\"json-property\":\"department\"}}\n\n" +
      "BUCKET SYNTAX — use 'name' (NOT 'label') on every bucket or MarkLogic will throw XDMP-VALIDATEMISSINGATTR:\n" +
      "  CORRECT:   {\"name\":\"Under 80k\",\"lt\":\"80000\"}\n" +
      "  CORRECT:   {\"name\":\"80-100k\",\"ge\":\"80000\",\"lt\":\"100000\"}\n" +
      "  WRONG:     {\"label\":\"Under 80k\",\"lt\":\"80000\"}  ← will be rejected\n\n" +
      "COLLECTION SCOPE — to restrict facets to one collection, embed additional-query in the options via\n" +
      "  ml_eval_xquery (patching the stored XML) or pass collection= to ml_search at query time.\n" +
      "  The JSON additional-query collection-query format is NOT supported by the REST API options parser.",
      {
        name: z.string().describe("Name for this search options set, referenced in ml_search options= and FastTrack optionsName prop"),
        options: z.record(z.unknown()).describe(
          "Full search options JSON object. Must include a top-level 'options' key. " +
          "Example: { \"options\": { \"return-facets\": true, \"constraint\": [...], \"extract-document-data\": {...} } }"
        ),
        database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
      },
      async ({ name, options, database }) => {
        try {
          await clients.fasttrack.putSearchOptions(name, options, database);
          return {
            content: [{
              type: "text",
              text: `Search options '${name}' saved successfully.\n` +
                    `Verify with ml_search using options='${name}' and q='' to confirm facets and result fields.`,
            }],
          };
        } catch (err) {
          return { content: [{ type: "text", text: toToolError(err) }], isError: true };
        }
      }
    );

    server.tool(
      "ml_search_options_delete",
      "Delete a named search-options configuration from MarkLogic. Requires ML_READONLY=false. " +
      "Any FastTrack app component or ml_search call that references this options name will fall back to default search options.",
      {
        name: z.string().describe("Name of the search options configuration to delete"),
        database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
      },
      async ({ name, database }) => {
        try {
          await clients.fasttrack.deleteSearchOptions(name, database);
          return { content: [{ type: "text", text: `Search options '${name}' deleted.` }] };
        } catch (err) {
          return { content: [{ type: "text", text: toToolError(err) }], isError: true };
        }
      }
    );
  }
}
