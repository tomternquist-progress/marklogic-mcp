import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerGraphTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_sparql_query",
    "Execute a SPARQL 1.1 SELECT, CONSTRUCT, ASK, or DESCRIBE query against the MarkLogic triple store.\n\n" +
    "TRIPLE STORAGE PATTERNS — MarkLogic supports three layouts, all queryable by this tool:\n" +
    "  Embedded (co-location): triples live inside the source document as sem:triple elements (XML)\n" +
    "  or a 'sem:triples' JSON array. SPARQL finds them automatically — no separate load step.\n" +
    "  Named graphs: standalone RDF documents loaded via flux_import (subcommand: import-rdf-files)\n" +
    "  or ml_document_put. Query with FROM NAMED <graph-uri>. Use for ontologies and taxonomies.\n" +
    "  Hybrid: document holds entity properties + named graph holds cross-entity relationships,\n" +
    "  linked via subject URI = document URI. Most powerful pattern for knowledge graphs.\n\n" +
    "DISCOVERY: Use ml_graphs_list to find named graph URIs before writing your query.\n\n" +
    "COMBINING WITH DOCUMENTS (multi-model): For joining SPARQL results with TDE row views\n" +
    "(e.g. enrich graph results with document fields), use ml_optic_query with op:from-sparql\n" +
    "as the source, joined to op:from-view via a shared URI column.",
    {
      sparql: z.string().describe("SPARQL query string (SELECT, CONSTRUCT, ASK, or DESCRIBE)"),
      default_graph: z.string().optional().describe("Default named graph URI"),
      base: z.string().optional().describe("Base URI for resolving relative URIs in the query"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ sparql, default_graph, base, database }) => {
      try {
        const result = await clients.graphs.sparqlQuery(sparql, { defaultGraph: default_graph, database, base });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_graphs_list",
    "List named graphs stored in the MarkLogic triple store. Use this to discover named graph URIs " +
    "before querying with ml_sparql_query. Each URI typically corresponds to an imported RDF file or " +
    "a group of related triples. Also reveals managed-triple graphs (loaded as raw RDF) that may " +
    "be candidates for reprocessing into entity-oriented documents via flux_reprocess.",
    {
      start: z.number().int().positive().optional().describe("Pagination start (default: 1)"),
      page_length: z.number().int().positive().max(200).optional().describe("Results per page (default: 20)"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ start, page_length, database }) => {
      try {
        const result = await clients.graphs.listGraphs({ start, pageLength: page_length, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
