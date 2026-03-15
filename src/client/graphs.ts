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

  async listGraphs(
    options: {
      start?: number;
      pageLength?: number;
      database?: string;
    } = {}
  ): Promise<{ graphs: string[]; total: number }> {
    const params: Record<string, string | number> = {
      format: "json",
      start: options.start ?? 1,
      "page-length": options.pageLength ?? 20,
    };
    if (options.database) params.database = options.database;

    const raw = await this.base.get<Record<string, unknown>>(
      this.base.http,
      "/v1/graphs",
      { params }
    );

    const uris = (raw?.["graph-uris"] as string[]) ?? [];
    return { graphs: uris, total: (raw?.total as number) ?? uris.length };
  }
}
