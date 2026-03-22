import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerGraphTools(server: McpServer, clients: MarkLogicClients, readonly = false): void {
  server.tool(
    "ml_sparql_query",
    "Execute a SPARQL 1.1 SELECT, CONSTRUCT, ASK, or DESCRIBE query against the MarkLogic triple store.\n\n" +
    "TRIPLE STORAGE PATTERNS — MarkLogic supports three layouts, all queryable by this tool:\n" +
    "  Embedded / unmanaged: triples live inside the source document as <sem:triple> elements (XML,\n" +
    "  namespace http://marklogic.com/semantics) or as a JSON 'triples' array (plural key) where each\n" +
    "  element is wrapped in a 'triple' key: {\"triples\":[{\"triple\":{\"subject\":\"...\",\"predicate\":\"...\",\n" +
    "  \"object\":\"...\"}}]}. Object encoding rules for JSON embedded triples:\n" +
    "    - IRI/URI object: plain string, e.g. \"http://example.org/thing\"\n" +
    "    - String literal: {\"datatype\":\"http://www.w3.org/2001/XMLSchema#string\",\"value\":\"hello\"}\n" +
    "      CAUTION: a bare string object (not wrapped in datatype/value) is treated as an IRI, not a literal.\n" +
    "    - Language-tagged literal: {\"datatype\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#langString\",\n" +
    "      \"value\":\"hello@en\"} — MarkLogic encodes the lang tag by appending @lang to the value field.\n" +
    "    - Typed literal (int, date, etc.): {\"datatype\":\"http://www.w3.org/2001/XMLSchema#integer\",\"value\":\"42\"}\n" +
    "  CAUTION: 'sem:triples' (plural) as the JSON root key creates MANAGED triples, not embedded ones.\n" +
    "  SPARQL finds embedded triples automatically — no separate load step.\n" +
    "  Named graphs: standalone RDF documents loaded via flux_import (subcommand: import-rdf-files)\n" +
    "  or ml_document_put. Query with FROM NAMED <graph-uri>. Use for ontologies and taxonomies.\n" +
    "  Hybrid: document holds entity properties + named graph holds cross-entity relationships,\n" +
    "  linked via subject URI = document URI. Most powerful pattern for knowledge graphs.\n\n" +
    "RETURN FORMAT:\n" +
    "  SELECT and ASK return SPARQL results JSON: { head: { vars }, results: { bindings } }.\n" +
    "  CONSTRUCT and DESCRIBE return raw Turtle text (the RDF graph as a Turtle string).\n\n" +
    "DISCOVERY: Use ml_graphs_list to find named graph URIs before writing your query.\n\n" +
    "COMBINING WITH DOCUMENTS (multi-model): Join op.fromSPARQL() with op.fromView() in ml_eval_javascript.\n" +
    "Use p.on(leftCol, rightCol) for equi-joins — both args must be direct column refs, not expressions.\n" +
    "Key column-naming rules after a fromView+fromSPARQL join:\n" +
    "  • fromView columns are qualified as 'schema.view.column' (e.g. 'nara.file_formats.riskLevel').\n" +
    "  • fromSPARQL BIND columns are unqualified (e.g. 'riskId').\n" +
    "  • In p.on(), use p.schemaCol('schema','view','col') for the view side to avoid SQL-NOCOLUMN errors.\n" +
    "  • In select/as, use p.schemaCol() for view cols and p.col() for SPARQL cols.\n" +
    "  • Do NOT alias a column to the same name as the underlying view column — e.g. p.as('identifier',...)\n" +
    "    when the view already has 'identifier' causes SQL-AMBCOLUMN. Use a distinct alias like 'fmt_id'.\n" +
    "  • For chained joins (fromView + riskVocab + catVocab), the second p.on() must also use p.schemaCol().\n" +
    "  • IRI TYPE MISMATCH (silent zero rows): op.fromSPARQL returns IRI-typed variables as sem.iri, NOT\n" +
    "    xsd:string. Joining a SPARQL IRI column directly against a TDE string column produces 0 rows with\n" +
    "    no error. Fix: add BIND(STR(?iriVar) AS ?strVar) in the SPARQL and join on ?strVar instead.\n" +
    "  • BIND PLACEMENT: BIND(STR(?iriVar) AS ?strVar) must be placed OUTSIDE the GRAPH {} block, not\n" +
    "    inside it. Variables bound inside a GRAPH pattern are scoped to that pattern and do NOT appear\n" +
    "    as top-level SELECT columns — op.fromSPARQL will throw SQL-NOCOLUMN on the join. Correct form:\n" +
    "    GRAPH <g> { ?s ?p ?o } BIND(STR(?s) AS ?sStr)   ← BIND after the closing brace of GRAPH.",
    {
      sparql: z.string().describe("SPARQL query string (SELECT, CONSTRUCT, ASK, or DESCRIBE)"),
      default_graph: z.string().optional().describe("Default named graph URI"),
      base: z.string().optional().describe("Base URI for resolving relative URIs in the query"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ sparql, default_graph, base, database }) => {
      try {
        const result = await clients.graphs.sparqlQuery(sparql, { defaultGraph: default_graph, database, base });
        // CONSTRUCT/DESCRIBE return raw Turtle text; SELECT/ASK return SPARQL results JSON
        const text = typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }] };
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

  // ── ml_graph_put ────────────────────────────────────────────────────────────
  server.tool(
    "ml_graph_put",
    "Load RDF content into a MarkLogic named graph via PUT /v1/graphs. This is the correct tool for loading\n" +
    "Turtle, N-Triples, JSON-LD, or RDF/XML files into the triple store — use this instead of ml_document_put\n" +
    "or ml_eval_javascript when you have RDF content to ingest.\n\n" +
    "WHEN TO USE:\n" +
    "- Loading ontologies or vocabulary files (risk levels, categories, preservation actions)\n" +
    "- Ingesting any Turtle/N-Triples/JSON-LD dataset into a named graph\n" +
    "- Building the named-graph side of the hybrid model (triples in graph + entity docs with TDE)\n\n" +
    "NOTE: PUT replaces the entire graph. Set merge=true to add triples to an existing graph (PATCH).\n" +
    "For very large RDF files (> ~1 MB), use flux_import with subcommand='import-rdf-files' instead,\n" +
    "which handles batching and multi-threaded writes via the Flux runner.\n\n" +
    "TURTLE PREFIX SYNTAX — prefixed local names CANNOT contain '/'. This is a frequent mistake:\n" +
    "  WRONG: @prefix e: <http://example.org/entity/> .  → e:movie/godfather  (slash rejected by parser)\n" +
    "  RIGHT: use one prefix per entity type so local names are slash-free:\n" +
    "    @prefix movie:  <http://example.org/entity/movie/> .\n" +
    "    @prefix person: <http://example.org/entity/person/> .\n" +
    "    movie:godfather mov:directedBy person:coppola .\n\n" +
    "After loading, query with ml_sparql_query or list loaded graphs with ml_graphs_list.",
    {
      graph_uri: z.string().describe("Named graph URI, e.g. 'http://example.org/mygraph'"),
      content: z.string().describe("RDF content as a string (Turtle, N-Triples, JSON-LD, or RDF/XML)"),
      content_type: z.enum([
        "text/turtle",
        "application/n-triples",
        "application/ld+json",
        "application/rdf+xml",
      ]).describe("RDF serialization format of the content"),
      database: z.string().optional().describe("Target database (uses server default if omitted)"),
      merge: z.boolean().optional().describe("If true, merge triples into an existing graph (PATCH) instead of replacing it (PUT). Default: false."),
    },
    async ({ graph_uri, content, content_type, database, merge }) => {
      try {
        const result = await clients.graphs.putGraph(graph_uri, content, content_type, { database, merge });
        const action = merge ? "merged into" : (result.created ? "created" : "replaced");
        return {
          content: [{
            type: "text",
            text: `Graph ${action}: ${result.graph}\nQuery it with ml_sparql_query using GRAPH <${result.graph}> { ... }.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  if (!readonly) {
    server.tool(
      "ml_graph_delete",
      "Delete a named graph and all its triples from the MarkLogic triple store (DELETE /v1/graphs).\n\n" +
      "This permanently removes every triple stored in the graph. The operation is not reversible.\n" +
      "Use ml_graphs_list to confirm the graph URI before deleting.\n\n" +
      "NOTE: This tool is disabled in readonly mode.",
      {
        graph_uri: z.string().describe("URI of the named graph to delete, e.g. 'http://example.org/mygraph'"),
        database: z.string().optional().describe("Database name (uses server default if omitted)"),
      },
      async ({ graph_uri, database }) => {
        try {
          await clients.graphs.deleteGraph(graph_uri, { database });
          return {
            content: [{
              type: "text",
              text: `Graph deleted: ${graph_uri}\nAll triples in the graph have been removed.`,
            }],
          };
        } catch (err) {
          return { content: [{ type: "text", text: toToolError(err) }], isError: true };
        }
      }
    );
  }
}
