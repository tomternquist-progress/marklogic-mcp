import type { MarkLogicBaseClient } from "./base.js";

export interface SearchResult {
  uri: string;
  score?: number;
  confidence?: number;
  fitness?: number;
  snippet?: string;
  extracted?: unknown;
}

export interface SearchResponse {
  total: number;
  start: number;
  pageLength: number;
  results: SearchResult[];
  facets?: Record<string, FacetResult>;
}

export interface FacetResult {
  name: string;
  type?: string;
  facetValues: Array<{ name: string; count: number; value: string }>;
}

export interface ValuesResponse {
  name: string;
  total: number;
  values: Array<{ value: unknown; frequency: number }>;
}

export interface SearchParams {
  q?: string;
  structuredQuery?: unknown;
  collection?: string;
  directory?: string;
  start?: number;
  pageLength?: number;
  options?: string;
  database?: string;
  format?: string;
}

export class SearchClient {
  constructor(private readonly base: MarkLogicBaseClient) {}

  async search(params: SearchParams): Promise<SearchResponse> {
    const qp: Record<string, string | number> = {
      format: "json",
      start: params.start ?? 1,
      pageLength: params.pageLength ?? 10,
    };
    if (params.q) qp.q = params.q;
    if (params.collection) qp.collection = params.collection;
    if (params.directory) qp.directory = params.directory;
    if (params.options) qp.options = params.options;
    if (params.database) qp.database = params.database;

    let raw: Record<string, unknown>;

    if (params.structuredQuery) {
      raw = await this.base.post<Record<string, unknown>>(
        this.base.http,
        "/v1/search",
        { search: { query: params.structuredQuery } },
        { params: qp, headers: { "Content-Type": "application/json" } }
      );
    } else {
      raw = await this.base.get<Record<string, unknown>>(this.base.http, "/v1/search", { params: qp });
    }

    return normalizeSearchResponse(raw);
  }

  async qbe(example: unknown, params: { start?: number; pageLength?: number; database?: string } = {}): Promise<SearchResponse> {
    const qp: Record<string, string | number> = {
      format: "json",
      start: params.start ?? 1,
      pageLength: params.pageLength ?? 10,
    };
    if (params.database) qp.database = params.database;

    const raw = await this.base.post<Record<string, unknown>>(
      this.base.http,
      "/v1/qbe",
      { "$query": example },
      { params: qp, headers: { "Content-Type": "application/json", Accept: "application/json" } }
    );
    return normalizeSearchResponse(raw);
  }

  async suggest(partialQ: string, options?: string, database?: string): Promise<string[]> {
    const qp: Record<string, string> = { "partial-q": partialQ, format: "json" };
    if (options) qp.options = options;
    if (database) qp.database = database;
    const raw = await this.base.get<{ suggestions: string[] }>(this.base.http, "/v1/suggest", { params: qp });
    return raw?.suggestions ?? [];
  }

  async values(
    name: string,
    params: {
      query?: string;
      limit?: number;
      direction?: "ascending" | "descending";
      aggregate?: string;
      database?: string;
    } = {}
  ): Promise<ValuesResponse> {
    const qp: Record<string, string | number> = {
      format: "json",
      limit: params.limit ?? 20,
    };
    if (params.query) qp.q = params.query;
    if (params.direction) qp.direction = params.direction;
    if (params.aggregate) qp.aggregate = params.aggregate;
    if (params.database) qp.database = params.database;

    const raw = await this.base.get<Record<string, unknown>>(
      this.base.http,
      `/v1/values/${encodeURIComponent(name)}`,
      { params: qp }
    );

    const vr = (raw?.["values-response"] as Record<string, unknown> | undefined) ?? raw;
    const distinctValues = (vr?.["distinct-value"] as Array<{ _value: unknown; frequency: number }>) ?? [];
    return {
      name,
      total: (vr?.["total"] as number) ?? distinctValues.length,
      values: distinctValues.map((v) => ({ value: v._value ?? v, frequency: v.frequency ?? 0 })),
    };
  }

  async facets(query: string, facetFields: string[], database?: string): Promise<Record<string, FacetResult>> {
    // Use search with extract-document-data to get facets — requires named options with facets configured
    // For now, return raw search facets from a standard search
    const res = await this.search({ q: query, pageLength: 0, database });
    return res.facets ?? {};
  }
}

function normalizeSearchResponse(raw: Record<string, unknown>): SearchResponse {
  const results = ((raw?.results as Array<Record<string, unknown>>) ?? []).map((r) => ({
    uri: r.uri as string,
    score: r.score as number | undefined,
    confidence: r.confidence as number | undefined,
    fitness: r.fitness as number | undefined,
    snippet: extractSnippet(r),
    extracted: r["extracted-result"],
  }));

  const rawFacets = raw?.facets as Record<string, Record<string, unknown>> | undefined;
  const facets: Record<string, FacetResult> | undefined = rawFacets
    ? Object.fromEntries(
        Object.entries(rawFacets).map(([k, v]) => [
          k,
          {
            name: k,
            type: v.type as string | undefined,
            facetValues: ((v["facet-value"] as Array<Record<string, unknown>>) ?? []).map((fv) => ({
              name: fv.name as string,
              count: fv.count as number,
              value: fv._value as string ?? fv.name as string,
            })),
          },
        ])
      )
    : undefined;

  return {
    total: (raw?.total as number) ?? 0,
    start: (raw?.start as number) ?? 1,
    pageLength: (raw?.["page-length"] as number) ?? 10,
    results,
    facets,
  };
}

function extractSnippet(result: Record<string, unknown>): string | undefined {
  const snip = result?.snippet as Record<string, unknown> | undefined;
  if (!snip) return undefined;
  const matches = snip?.match as Array<Record<string, unknown>> | undefined;
  if (!matches?.length) return undefined;
  return matches.map((m) => m["match-text"] ?? m.text ?? "").join(" ... ");
}
