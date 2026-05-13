import type { MarkLogicBaseClient } from "./base.js";
import { EvalDisabledError } from "../utils/errors.js";
import { parseMultipartMixed, type EvalResult } from "../utils/multipart.js";

export type { EvalResult } from "../utils/multipart.js";

export class EvalClient {
  constructor(
    private readonly base: MarkLogicBaseClient,
    private readonly allowEval: boolean
  ) {}

  async evalXQuery(xquery: string, vars?: Record<string, unknown>, database?: string): Promise<EvalResult[]> {
    if (!this.allowEval) throw new EvalDisabledError();
    const body = new URLSearchParams();
    body.append("xquery", xquery);
    if (vars && Object.keys(vars).length > 0) {
      // MarkLogic /v1/eval expects vars as a single JSON object: vars={"key":value,...}
      // NOT individual vars[key]=value entries (which are silently ignored)
      body.append("vars", JSON.stringify(vars));
    }
    return this.evalRequest(body, database);
  }

  async evalJavaScript(javascript: string, vars?: Record<string, unknown>, database?: string): Promise<EvalResult[]> {
    if (!this.allowEval) throw new EvalDisabledError();
    const body = new URLSearchParams();
    body.append("javascript", javascript);
    if (vars && Object.keys(vars).length > 0) {
      // MarkLogic /v1/eval expects vars as a single JSON object: vars={"key":value,...}
      // NOT individual vars[key]=value entries (which are silently ignored)
      body.append("vars", JSON.stringify(vars));
    }
    return this.evalRequest(body, database);
  }

  /**
   * Run a static (compile-only) check on an SJS source string using xdmp.eval with
   * {staticCheck: true}. Does NOT execute the code. Bypasses allowEval since this is
   * a read-only syntax validation, not arbitrary code execution.
   *
   * Returns a human-readable warning string if errors are found, or null if clean.
   */
  async staticCheckSjs(source: string): Promise<string | null> {
    const escaped = source.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    const checker = `xdmp.eval(\`${escaped}\`, null, {staticCheck: true}); null`;
    const body = new URLSearchParams();
    body.append("javascript", checker);
    try {
      await this.evalRequest(body, undefined);
      return null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return msg;
    }
  }

  /**
   * Parse a MarkLogic string-grammar query into a cts.query JSON object using cts.parse().
   * The script is fixed; user input is passed via vars only — no code injection surface —
   * so this bypasses allowEval, matching the staticCheckSjs precedent.
   *
   * The bindings spec maps tag names used in the query text to indexed-field references.
   * Returns the parsed cts.query serialized as JSON (the same shape ml_search structured_query accepts).
   */
  async parseCtsQuery(
    qtext: string,
    bindingsSpec?: Record<string, { type: string; name: string; scalar_type?: string; namespace?: string }>,
    database?: string
  ): Promise<EvalResult[]> {
    const script = `
'use strict';
const bindings = {};
if (typeof bindingsSpec === 'object' && bindingsSpec !== null) {
  for (const tag of Object.keys(bindingsSpec)) {
    const b = bindingsSpec[tag];
    const opts = b.scalar_type ? ['type=' + b.scalar_type] : [];
    switch (b.type) {
      case 'json-property':
        bindings[tag] = cts.jsonPropertyReference(b.name);
        break;
      case 'json-property-range':
        bindings[tag] = cts.jsonPropertyReference(b.name, opts.length ? opts : ['type=string']);
        break;
      case 'element':
        bindings[tag] = cts.elementReference(fn.QName(b.namespace || '', b.name));
        break;
      case 'element-range':
        bindings[tag] = cts.elementReference(fn.QName(b.namespace || '', b.name), opts.length ? opts : ['type=string']);
        break;
      case 'path':
        bindings[tag] = cts.pathReference(b.name);
        break;
      case 'path-range':
        bindings[tag] = cts.pathReference(b.name, opts.length ? opts : ['type=string']);
        break;
      case 'field':
        bindings[tag] = cts.fieldReference(b.name);
        break;
      case 'field-range':
        bindings[tag] = cts.fieldReference(b.name, opts.length ? opts : ['type=string']);
        break;
      default:
        throw new Error('Unknown binding type for tag ' + tag + ': ' + b.type);
    }
  }
}
const parsed = cts.parse(qtext, bindings);
parsed;
`;
    const body = new URLSearchParams();
    body.append("javascript", script);
    body.append("vars", JSON.stringify({ qtext, bindingsSpec: bindingsSpec ?? null }));
    return this.evalRequest(body, database);
  }

  async invokeModule(moduleUri: string, vars?: Record<string, unknown>, database?: string, modulesDb?: string): Promise<EvalResult[]> {
    if (!this.allowEval) throw new EvalDisabledError();
    const body = new URLSearchParams();
    body.append("module", moduleUri);
    if (modulesDb) body.append("modules-database", modulesDb);
    if (vars && Object.keys(vars).length > 0) {
      body.append("vars", JSON.stringify(vars));
    }
    // Module invocation requires /v1/invoke — /v1/eval only accepts xquery= or javascript=
    const params: Record<string, string> = {};
    if (database) params.database = database;
    const res = await this.base.http.post("/v1/invoke", body.toString(), {
      params,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "multipart/mixed",
      },
      responseType: "text",
    });
    return parseMultipartMixed(res.data as string, res.headers["content-type"] as string);
  }

  private async evalRequest(body: URLSearchParams, database?: string): Promise<EvalResult[]> {
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
