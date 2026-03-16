import type { MarkLogicBaseClient } from "./base.js";

export interface SparqlBinding {
  type: "uri" | "literal" | "bnode";
  value: string;
  datatype?: string;
  "xml:lang"?: string;
}

export interface SparqlSelectResult {
  head: { vars: string[] };
  results: { bindings: Array<Record<string, SparqlBinding>> };
}

export class GraphsClient {
  constructor(private readonly base: MarkLogicBaseClient) {}

  async sparqlQuery(
    sparql: string,
    options: {
      defaultGraph?: string;
      database?: string;
      base?: string;
    } = {}
  ): Promise<SparqlSelectResult | string> {
    const params: Record<string, string> = {};
    if (options.defaultGraph) params["default-graph-uri"] = options.defaultGraph;
    if (options.database) params.database = options.database;
    if (options.base) params.base = options.base;

    // CONSTRUCT and DESCRIBE return RDF (Turtle), not SPARQL results JSON.
    // Detect the query type and set Accept/responseType accordingly so MarkLogic
    // doesn't reject with HTTP 406.
    const queryType = detectSparqlQueryType(sparql);
    const isRdfResult = queryType === "CONSTRUCT" || queryType === "DESCRIBE";

    const res = await this.base.http.post(
      "/v1/graphs/sparql",
      sparql,
      {
        params,
        headers: {
          "Content-Type": "application/sparql-query",
          Accept: isRdfResult ? "text/turtle" : "application/sparql-results+json",
        },
        // Without responseType:'text', Axios tries to JSON-parse Turtle and throws
        responseType: isRdfResult ? "text" : "json",
      }
    );
    return isRdfResult ? (res.data as string) : (res.data as SparqlSelectResult);
  }

  /**
   * PUT RDF content into a named graph via /v1/graphs.
   * content_type controls the RDF serialization format:
   *   "text/turtle"              — Turtle (.ttl)
   *   "application/n-triples"    — N-Triples (.nt)
   *   "application/ld+json"      — JSON-LD (.jsonld)
   *   "application/rdf+xml"      — RDF/XML (.rdf)
   * An HTTP PUT replaces the entire graph; PATCH would merge — using PUT here for simplicity.
   */
  async putGraph(
    graphUri: string,
    content: string,
    contentType: string,
    options: { database?: string; merge?: boolean } = {}
  ): Promise<{ graph: string; created: boolean }> {
    const params: Record<string, string> = { graph: graphUri };
    if (options.database) params.database = options.database;

    const method = options.merge ? "patch" : "put";
    const res = await this.base.http.request({
      method,
      url: "/v1/graphs",
      params,
      data: content,
      headers: { "Content-Type": contentType },
      validateStatus: (s) => s === 200 || s === 201 || s === 204,
    });

    return { graph: graphUri, created: res.status === 201 };
  }

  async listGraphs(
    options: {
      start?: number;
      pageLength?: number;
      database?: string;
    } = {}
  ): Promise<{ graphs: string[]; total: number }> {
    // The SPARQL Graph Store /v1/graphs endpoint does not accept listing params
    // (format, start, page-length) — it only supports per-graph GET/PUT/PATCH/DELETE.
    // List named graphs via SPARQL using the SPARQL 1.1 empty graph body pattern,
    // which hits MarkLogic's graph index directly rather than scanning all triples.
    // The previous { ?s ?p ?o } pattern was O(triples) and timed out on large stores.
    const sparql = "SELECT DISTINCT ?g WHERE { GRAPH ?g { } }";
    const raw = await this.sparqlQuery(sparql, { database: options.database }) as SparqlSelectResult;
    const allGraphs = (raw.results?.bindings ?? [])
      .map(b => b["g"]?.value)
      .filter((v): v is string => typeof v === "string");

    // Apply pagination in-memory (named graph counts are typically small)
    const pageStart = Math.max(0, (options.start ?? 1) - 1);
    const pageLen   = options.pageLength ?? 20;
    const page      = allGraphs.slice(pageStart, pageStart + pageLen);
    return { graphs: page, total: allGraphs.length };
  }
}

/**
 * Detect the SPARQL query form by stripping PREFIX/BASE declarations and line
 * comments, then inspecting the first keyword. Used to choose the correct
 * Accept header: SELECT/ASK → application/sparql-results+json,
 * CONSTRUCT/DESCRIBE → text/turtle.
 */
function detectSparqlQueryType(query: string): "SELECT" | "ASK" | "CONSTRUCT" | "DESCRIBE" {
  const stripped = query
    .replace(/#[^\n]*/g, "")                          // strip line comments
    .replace(/PREFIX\s+\S*\s*:\s*<[^>]*>\s*/gi, "")  // strip PREFIX declarations
    .replace(/BASE\s+<[^>]*>\s*/gi, "")               // strip BASE declaration
    .trim()
    .toUpperCase();

  if (stripped.startsWith("CONSTRUCT")) return "CONSTRUCT";
  if (stripped.startsWith("DESCRIBE"))  return "DESCRIBE";
  if (stripped.startsWith("ASK"))       return "ASK";
  return "SELECT";
}
