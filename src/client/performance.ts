import type { MarkLogicBaseClient } from "./base.js";
import { parseMultipartMixed, type EvalResult } from "../utils/multipart.js";

export class PerformanceClient {
  constructor(private readonly base: MarkLogicBaseClient) {}

  /** Optic query explain plan — no eval required. POST /v1/rows?output=explain */
  async explainOptic(plan: Record<string, unknown>, database?: string): Promise<Record<string, unknown>> {
    const params: Record<string, string> = { output: "explain" };
    if (database) params.database = database;
    return this.base.post<Record<string, unknown>>(
      this.base.http,
      "/v1/rows",
      plan,
      { params, headers: { "Content-Type": "application/json", Accept: "application/json" } }
    );
  }

  /** Search with debug=true to see the resolved CTS query. No eval required.
   *  Falls back to a plain pageLength=0 search if debug is unsupported (ML 12+). */
  async searchDebug(opts: {
    q?: string;
    structuredQuery?: Record<string, unknown>;
    collection?: string;
    database?: string;
    searchOptions?: string;
  }): Promise<Record<string, unknown>> {
    const buildParams = (includeDebug: boolean): Record<string, string> => {
      const p: Record<string, string> = { format: "json", pageLength: "0" };
      if (includeDebug) p.debug = "true";
      if (opts.q) p.q = opts.q;
      if (opts.collection) p.collection = opts.collection;
      if (opts.database) p.database = opts.database;
      if (opts.searchOptions) p.options = opts.searchOptions;
      return p;
    };

    const doRequest = (params: Record<string, string>) => {
      if (opts.structuredQuery) {
        return this.base.post<Record<string, unknown>>(
          this.base.http,
          "/v1/search",
          { search: { query: opts.structuredQuery } },
          { params, headers: { "Content-Type": "application/json", Accept: "application/json" } }
        );
      }
      return this.base.get<Record<string, unknown>>(this.base.http, "/v1/search", { params });
    };

    try {
      return await doRequest(buildParams(true));
    } catch (err: unknown) {
      // ML 12 removed the debug=true query parameter — fall back to a plain
      // pageLength=0 search which still returns total, qtext, and metrics.
      const msg = String((err as { message?: string }).message ?? "");
      if (msg.includes("UNSUPPORTEDPARAM") || msg.includes("debug")) {
        return await doRequest(buildParams(false));
      }
      throw err;
    }
  }

  /** Per-forest status from Management API (view=status). */
  async getForestStatus(forestName: string): Promise<Record<string, unknown>> {
    return this.base.get<Record<string, unknown>>(
      this.base.mgmt,
      `/manage/v2/forests/${encodeURIComponent(forestName)}`,
      { params: { view: "status", format: "json" } }
    );
  }

  /** Per-forest fragment/stand counts via xdmp:forest-counts() XQuery. Requires allowEval=true. */
  async getForestCounts(forestName: string): Promise<{ active: number; deleted: number; standCount: number; docCount: number } | null> {
    const xq = `
      declare namespace fs = "http://marklogic.com/xdmp/status/forest";
      let $id := xdmp:forest("${forestName.replace(/"/g, '\\"')}")
      let $c := xdmp:forest-counts($id)
      return xdmp:to-json(map:new((
        map:entry("active",     fn:sum($c//fs:active-fragment-count/fn:data(.))),
        map:entry("deleted",    fn:sum($c//fs:deleted-fragment-count/fn:data(.))),
        map:entry("standCount", fn:count($c//fs:stand-counts)),
        map:entry("docCount",   fn:data($c/fs:document-count))
      )))`;
    const body = new URLSearchParams();
    body.append("xquery", xq);
    try {
      const res = await this.base.http.post("/v1/eval", body.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "multipart/mixed",
        },
        responseType: "text",
      });
      const { parseMultipartMixed } = await import("../utils/multipart.js");
      const parts = parseMultipartMixed(res.data as string, res.headers["content-type"] as string);
      if (parts.length > 0) {
        const val = typeof parts[0].value === "string" ? JSON.parse(parts[0].value) : parts[0].value;
        return val as { active: number; deleted: number; standCount: number; docCount: number };
      }
    } catch { /* eval not available or failed */ }
    return null;
  }

  /** Profile XQuery code via xdmp:query-meters + elapsed time. Requires ML_ALLOW_EVAL=true. */
  async profileXQuery(code: string, database?: string): Promise<EvalResult[]> {
    return this._evalProfile("xquery", buildXQueryMetersWrapper(code), database);
  }

  /** Profile SJS code via xdmp.queryMeters + elapsed time. Requires ML_ALLOW_EVAL=true. */
  async profileJavaScript(code: string, database?: string): Promise<EvalResult[]> {
    return this._evalProfile("javascript", buildSjsMetersWrapper(code), database);
  }

  /** Profile a SPARQL query via SJS sem.sparql + xdmp.queryMeters. Requires ML_ALLOW_EVAL=true. */
  async profileSparql(sparqlQuery: string, database?: string): Promise<EvalResult[]> {
    // Escape backticks and template literal sequences so the SPARQL string can be
    // embedded inside the template-literal wrapper we send to /v1/eval.
    const escaped = sparqlQuery
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$\{/g, "\\${");
    return this._evalProfile("javascript", buildSparqlMetersWrapper(escaped), database);
  }

  private async _evalProfile(
    language: "xquery" | "javascript",
    wrappedCode: string,
    database?: string
  ): Promise<EvalResult[]> {
    const body = new URLSearchParams();
    body.append(language, wrappedCode);
    const params: Record<string, string> = {};
    if (database) params.database = database;
    const res = await this.base.http.post("/v1/eval", body.toString(), {
      params,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "multipart/mixed",
      },
      responseType: "text",
    });
    return parseMultipartMixed(res.data as string, res.headers["content-type"] as string);
  }
}

/**
 * Wrap XQuery code in a query-meters + elapsed-time measurement block.
 * The user code must be a single XQuery expression (not a full module with prolog).
 * Returns a JSON document via xdmp:to-json with elapsedMs, resultCount, and cache/filter stats.
 */
function buildXQueryMetersWrapper(userCode: string): string {
  return [
    'declare namespace qm = "http://marklogic.com/xdmp/query-meters";',
    "let $__t0 := xdmp:elapsed-time()",
    "let $__result := (",
    userCode,
    ")",
    'let $__elapsed := xs:integer((xdmp:elapsed-time() - $__t0) div xs:dayTimeDuration("PT0.001S"))',
    "let $__m := xdmp:query-meters()/*",
    "return xdmp:to-json(map:new((",
    '  map:entry("elapsedMs",                 $__elapsed),',
    '  map:entry("resultCount",               fn:count($__result)),',
    '  map:entry("listCacheHits",             xs:integer(($__m/qm:list-cache-hits,             0)[1])),',
    '  map:entry("listCacheMisses",           xs:integer(($__m/qm:list-cache-misses,           0)[1])),',
    '  map:entry("expandedTreeCacheHits",     xs:integer(($__m/qm:expanded-tree-cache-hits,    0)[1])),',
    '  map:entry("expandedTreeCacheMisses",   xs:integer(($__m/qm:expanded-tree-cache-misses,  0)[1])),',
    '  map:entry("compressedTreeCacheHits",   xs:integer(($__m/qm:compressed-tree-cache-hits,  0)[1])),',
    '  map:entry("compressedTreeCacheMisses", xs:integer(($__m/qm:compressed-tree-cache-misses,0)[1])),',
    '  map:entry("filterHits",               xs:integer(($__m/qm:filter-hits,                 0)[1])),',
    '  map:entry("filterMisses",             xs:integer(($__m/qm:filter-misses,               0)[1]))',
    ")))",
  ].join("\n");
}

/**
 * Wrap SJS code in a timing + xdmp.queryMeters block.
 * The user code is executed inside an IIFE so return statements work correctly.
 * Returns a plain JS object with elapsedMs, resultCount, querySample, and queryMeters.
 */
function buildSjsMetersWrapper(userCode: string): string {
  return [
    "const __t0 = new Date().getTime();",
    "let __cnt = 0, __sample = [];",
    "try {",
    "  const __raw = (() => {",
    userCode,
    "  })();",
    "  if (__raw !== null && __raw !== undefined) {",
    "    const __arr = typeof __raw[Symbol.iterator] === 'function' ? Array.from(__raw) : [__raw];",
    "    __cnt = __arr.length;",
    "    __sample = __arr.slice(0, 3).map(r => typeof r === 'object' && r !== null ? r : String(r));",
    "  }",
    "} catch(e) { __sample = [{error: e.toString()}]; }",
    "({elapsedMs: new Date().getTime() - __t0, resultCount: __cnt, querySample: __sample, queryMeters: xdmp.queryMeters()})",
  ].join("\n");
}

/**
 * Wrap a SPARQL query string in SJS timing + sem.sparql execution.
 * The sparqlQuery must already be backtick-escaped for embedding in a template literal.
 */
function buildSparqlMetersWrapper(escapedSparql: string): string {
  return [
    "const __t0 = new Date().getTime();",
    "let __rows = [];",
    `try { __rows = Array.from(sem.sparql(\`${escapedSparql}\`)); } catch(e) { __rows = [{error: e.toString()}]; }`,
    "({elapsedMs: new Date().getTime() - __t0, rowCount: __rows.length, sampleRows: __rows.slice(0, 3), queryMeters: xdmp.queryMeters()})",
  ].join("\n");
}
