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

export interface SparqlConstructResult {
  triples: unknown[];
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

    const res = await this.base.http.post(
      "/v1/graphs/sparql",
      sparql,
      {
        params,
        headers: {
          "Content-Type": "application/sparql-query",
          Accept: "application/sparql-results+json",
        },
      }
    );
    return res.data as SparqlSelectResult;
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
    // List named graphs via SPARQL instead: SELECT DISTINCT ?g over all graphs.
    const sparql = "SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }";
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
