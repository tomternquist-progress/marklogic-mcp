import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerSearchTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_search",
    "Full-text and structured search across MarkLogic documents. Supports string queries and JSON structured queries.\n\n" +
    "RESULT FORMAT: Returns URIs, relevance scores, confidence, and fitness for each match — NOT document content.\n" +
    "To inspect content of matching documents: call ml_document_get on specific URIs, or use ml_document_sample\n" +
    "to preview a collection without a search query. To add field extracts (snippets) to results, create search\n" +
    "options with extract-document-data via ml_search_options_put and pass the options name here.\n\n" +
    "SNIPPET PATTERN (inline content preview via search options):\n" +
    "  ml_search_options_put name='my-opts' options={'options':{'extract-document-data':{'extract-path':'/*'}}}\n" +
    "  then ml_search q='...' options='my-opts'  ← results will include extracted fields",
    {
      q: z.string().optional().describe("Full-text query string (Google-style syntax supported)"),
      structured_query: z.record(z.unknown()).optional().describe("MarkLogic structured query JSON object"),
      collection: z.string().optional().describe("Limit search to this collection URI"),
      directory: z.string().optional().describe("Limit search to documents under this directory path"),
      start: z.number().int().positive().optional().describe("Pagination start position (default: 1)"),
      page_length: z.number().int().positive().max(100).optional().describe("Results per page (default: 10)"),
      options: z.string().optional().describe("Named search options node configured on the server"),
      database: z.string().optional().describe("Database to search. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ q, structured_query, collection, directory, start, page_length, options, database }) => {
      try {
        const result = await clients.search.search({
          q,
          structuredQuery: structured_query,
          collection,
          directory,
          start,
          pageLength: page_length,
          options,
          database,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_search_qbe",
    "Query By Example — find MarkLogic documents that match an example document structure.",
    {
      qbe: z.record(z.unknown()).describe("Example document structure to match against"),
      start: z.number().int().positive().optional().describe("Pagination start (default: 1)"),
      page_length: z.number().int().positive().max(100).optional().describe("Results per page (default: 10)"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ qbe, start, page_length, database }) => {
      try {
        const result = await clients.search.qbe(qbe, { start, pageLength: page_length, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_values_query",
    "Return distinct values (plus frequency and optional aggregate) from a single range-indexed field. " +
    "Use this for: value-frequency lists (\"top 20 categories by count\"), simple numeric aggregates on a " +
    "field (sum/avg/min/max/stddev over a range index), and fast counting without scanning documents.\n\n" +
    "WHEN TO PICK THIS vs ALTERNATIVES:\n" +
    "  • ml_values_query  → no TDE needed; one field; fastest for simple frequency / 1D aggregate.\n" +
    "  • ml_facets_query  → multiple facets at once; requires search options with facet constraints.\n" +
    "  • ml_optic_query   → GROUP BY across multiple columns, joins, or tabular SELECT — requires TDE view.\n" +
    "  • ml_aggregate_query → single-row totals across filtered documents (no grouping).\n\n" +
    "PREREQUISITES:\n" +
    "  1. Range index on the target field — check with ml_indexes_list.\n" +
    "  2. A named values definition in a search-options set that references the index.\n" +
    "     Inspect with ml_search_options_get; create with ml_search_options_put.\n" +
    "  3. If options is omitted, the default app-services options set is used (which typically has\n" +
    "     no values defined — you'll get an empty result). Always pass an explicit options name.",
    {
      values_name: z.string().describe("Named values/tuples definition configured in search options"),
      query: z.string().optional().describe("Constraining search query to filter values"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum values to return (default: 20)"),
      direction: z.enum(["ascending", "descending"]).optional().describe("Sort direction (default: descending by frequency)"),
      aggregate: z.string().optional().describe("Aggregate function: sum, count, avg, min, max, stddev"),
      options: z.string().optional().describe("Named search options node that contains the values definition (deploy via ml_search_options_put)"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ values_name, query, limit, direction, aggregate, options, database }) => {
      try {
        const result = await clients.search.values(values_name, { query, limit, direction, aggregate, options, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_geospatial_search",
    "Find MarkLogic documents within a geospatial region — circle (radius from a point), bounding box, or polygon. " +
    "For JSON documents: requires a geospatial JSON property pair index (geospatial-json-property-pair type in ml_indexes_list). " +
    "For XML documents: requires a geospatial element pair index. " +
    "Call ml_indexes_list with index_type='geospatial' first to confirm the index type and property names.",
    {
      region_type: z.enum(["circle", "box", "polygon"]).describe("Shape of the search region"),
      // Circle params
      center_lat: z.number().min(-90).max(90).optional().describe("Center latitude (required for circle)"),
      center_lon: z.number().min(-180).max(180).optional().describe("Center longitude (required for circle)"),
      radius_km: z.number().positive().optional().describe("Search radius in kilometres (required for circle)"),
      // Box params
      south: z.number().min(-90).max(90).optional().describe("Southern latitude bound (required for box)"),
      west: z.number().min(-180).max(180).optional().describe("Western longitude bound (required for box)"),
      north: z.number().min(-90).max(90).optional().describe("Northern latitude bound (required for box)"),
      east: z.number().min(-180).max(180).optional().describe("Eastern longitude bound (required for box)"),
      // Polygon params
      points: z.array(z.object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      })).optional().describe("Polygon vertices as [{lat, lon}] array (required for polygon; first and last point should be the same to close the ring)"),
      // Index parameters
      parent_property: z.string().optional().describe("JSON property name of the parent object containing lat/lon (default: 'location'). Must match the geospatial element pair index."),
      lat_property: z.string().optional().describe("JSON property name for latitude within parent (default: 'latitude'). Must match the index."),
      lon_property: z.string().optional().describe("JSON property name for longitude within parent (default: 'longitude'). Must match the index."),
      // Scope
      collection: z.string().optional().describe("Limit search to this collection URI"),
      page_length: z.number().int().positive().max(100).optional().describe("Max results to return (default: 10)"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ region_type, center_lat, center_lon, radius_km, south, west, north, east, points,
             parent_property, lat_property, lon_property, collection, page_length, database }) => {
      try {
        const parentName = parent_property ?? "location";
        const latName = lat_property ?? "latitude";
        const lonName = lon_property ?? "longitude";

        // Build the geo-elem-pair-query region
        let region: Record<string, unknown>;
        if (region_type === "circle") {
          if (center_lat == null || center_lon == null || radius_km == null) {
            return { content: [{ type: "text", text: "circle requires center_lat, center_lon, and radius_km" }], isError: true };
          }
          region = { circle: { radius: radius_km, point: [{ latitude: center_lat, longitude: center_lon }] } };
        } else if (region_type === "box") {
          if (south == null || west == null || north == null || east == null) {
            return { content: [{ type: "text", text: "box requires south, west, north, and east" }], isError: true };
          }
          region = { box: [{ s: south, w: west, n: north, e: east }] };
        } else {
          if (!points?.length) {
            return { content: [{ type: "text", text: "polygon requires a points array" }], isError: true };
          }
          region = { polygon: [{ point: points.map(p => ({ latitude: p.lat, longitude: p.lon })) }] };
        }

        // Use JSON property pair query — the correct type for JSON documents.
        // If documents are XML, use "geo-elem-pair-query" with {ns:"", name:...} syntax instead.
        const geoQuery = {
          "geo-json-property-pair-query": {
            "parent-property": parentName,
            "lat-property": latName,
            "lon-property": lonName,
            ...region,
          },
        };

        const structuredQuery = collection
          ? { "and-query": { queries: [{ "collection-query": { uri: [collection] } }, geoQuery] } }
          : geoQuery;

        const result = await clients.search.search({
          structuredQuery,
          pageLength: page_length,
          database,
        });

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: toToolError(err) +
              "\nHint: ml_geospatial_search requires a geospatial element pair index on the parent/lat/lon properties. " +
              "Run ml_indexes_list with index_type='geospatial' to verify the index exists. " +
              "If no index exists, create one with ml_eval_javascript using the Admin module.",
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "ml_parse_query",
    "Parse a MarkLogic string-grammar query into a structured cts.query JSON object WITHOUT executing it.\n\n" +
    "PRIMARY USE: chat → MarkLogic translation pipeline. Given a natural-language question, an LLM " +
    "writes a string-grammar query (e.g. \"diabetes AND state:TX AND age:GE:65\"); ml_parse_query " +
    "validates and returns the equivalent structured-query JSON; ml_search executes it.\n\n" +
    "RETURN VALUE: the parsed cts.query is serialized in the SAME JSON shape that ml_search accepts via " +
    "the structured_query parameter — you can pipe it straight through, store it, or modify it before executing.\n\n" +
    "WHEN TO USE:\n" +
    "  • Preview how a user's free-text query is interpreted (operators, phrases, tag bindings)\n" +
    "  • Detect grammar parse errors before running an expensive search\n" +
    "  • Convert a string query into a structured query for storage or programmatic manipulation\n" +
    "  • Round-trip an LLM-written query through MarkLogic's parser to canonicalise it\n\n" +
    "BINDINGS map tag names that appear in qtext to indexed fields. Without bindings, only boolean " +
    "operators (AND, OR, NOT), quoted phrases, and bare words are recognised — a tag like 'state:TX' " +
    "becomes a literal word query for the string 'state:TX'.\n\n" +
    "  Example:\n" +
    "    qtext='state:TX AND age:GE:65 AND diabetes'\n" +
    "    bindings={\n" +
    "      state: { type: 'json-property',       name: 'state' },\n" +
    "      age:   { type: 'json-property-range', name: 'age', scalar_type: 'int' }\n" +
    "    }\n\n" +
    "  Binding types:\n" +
    "    json-property        — bareword equality against a JSON property (universal index)\n" +
    "    json-property-range  — range comparison (LT/LE/EQ/GE/GT) on a JSON property — requires range index\n" +
    "    element              — XML element equality\n" +
    "    element-range        — XML element range — requires range index\n" +
    "    path                 — path equality — requires path range index when used with range ops\n" +
    "    path-range           — path range — requires path range index\n" +
    "    field                — equality against a configured field\n" +
    "    field-range          — range against a configured field — requires field range index\n\n" +
    "DISCOVERY: run ml_search_surface (or ml_indexes_list + ml_schema_discover) first to learn which " +
    "fields are indexed and what scalar types they hold; mis-typed bindings cause XDMP-CTSDIRQUERY at " +
    "parse time or wrong results.\n\n" +
    "NO ML_ALLOW_EVAL REQUIRED — the parser script is fixed; only qtext and bindings flow in as data.",
    {
      qtext: z.string().describe("String-grammar query text to parse, e.g. 'diabetes AND state:TX'"),
      bindings: z.record(z.object({
        type: z.enum([
          "json-property",
          "json-property-range",
          "element",
          "element-range",
          "path",
          "path-range",
          "field",
          "field-range",
        ]).describe("Reference type — see tool description for selection guidance"),
        name: z.string().describe("Indexed field name (or path expression for path types)"),
        scalar_type: z.string().optional().describe("Scalar type for range bindings: 'int', 'long', 'double', 'decimal', 'dateTime', 'date', 'string', etc."),
        namespace: z.string().optional().describe("XML namespace URI for element bindings (default: empty)"),
      })).optional().describe(
        "Tag→reference map. Keys are the tag names that appear in qtext before a colon. " +
        "Values describe the indexed field. Omit for boolean-only parsing."
      ),
      database: z.string().optional().describe("Database context for index resolution. Default: server's content DB. Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ qtext, bindings, database }) => {
      try {
        const results = await clients.eval.parseCtsQuery(qtext, bindings, database);
        // evalJavaScript returns an array of EvalResult entries; the cts.query payload is the first/only item.
        const first = results[0];
        const payload = first?.value ?? first;
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        const msg = toToolError(err);
        const hint = msg.includes("XDMP-QUERY") || msg.includes("XDMP-PARSE")
          ? "\nHint: a grammar parse error usually means an unmatched quote, an unknown operator (only AND/OR/NOT/NEAR/-/+ are built in), or a tag without a matching binding. Run ml_parse_query without bindings to confirm the boolean structure parses, then add bindings one at a time."
          : msg.includes("CTSDIRQUERY") || msg.includes("scalar")
          ? "\nHint: a binding scalar_type may not match the underlying range index. Verify with ml_indexes_list — find the index and read its scalar-type. Common types: int, long, double, decimal, dateTime, date, string."
          : "";
        return { content: [{ type: "text", text: msg + hint }], isError: true };
      }
    }
  );

  server.tool(
    "ml_suggest",
    "Get search query autocomplete suggestions from MarkLogic based on a partial query string.",
    {
      partial_q: z.string().describe("Partial query string to complete"),
      limit: z.number().int().positive().max(50).optional().describe("Max suggestions to return (default: 10)"),
      options: z.string().optional().describe("Named search options node"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ partial_q, limit, options, database }) => {
      try {
        const suggestions = await clients.search.suggest(partial_q, options, database, limit);
        return { content: [{ type: "text", text: JSON.stringify(suggestions, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
