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
      database: z.string().optional().describe("Database to search (uses server default if omitted)"),
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
      database: z.string().optional().describe("Database name"),
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
    "Query MarkLogic lexicons and range indexes to get facet values, counts, and aggregates. " +
    "Requires a named values definition in search options (deploy via ml_search_options_put) that references a range index. " +
    "Pass the options name to target a specific values config; omit it to use the default app-services options.",
    {
      values_name: z.string().describe("Named values/tuples definition configured in search options"),
      query: z.string().optional().describe("Constraining search query to filter values"),
      limit: z.number().int().positive().max(1000).optional().describe("Maximum values to return (default: 20)"),
      direction: z.enum(["ascending", "descending"]).optional().describe("Sort direction (default: descending by frequency)"),
      aggregate: z.string().optional().describe("Aggregate function: sum, count, avg, min, max, stddev"),
      options: z.string().optional().describe("Named search options node that contains the values definition (deploy via ml_search_options_put)"),
      database: z.string().optional().describe("Database name"),
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
      database: z.string().optional().describe("Database name"),
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
    "ml_suggest",
    "Get search query autocomplete suggestions from MarkLogic based on a partial query string.",
    {
      partial_q: z.string().describe("Partial query string to complete"),
      limit: z.number().int().positive().max(50).optional().describe("Max suggestions to return (default: 10)"),
      options: z.string().optional().describe("Named search options node"),
      database: z.string().optional().describe("Database name"),
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
