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
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => body.append(`vars[${k}]`, JSON.stringify(v)));
    }
    return this.evalRequest(body, database);
  }

  async evalJavaScript(javascript: string, vars?: Record<string, unknown>, database?: string): Promise<EvalResult[]> {
    if (!this.allowEval) throw new EvalDisabledError();
    const body = new URLSearchParams();
    body.append("javascript", javascript);
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => body.append(`vars[${k}]`, JSON.stringify(v)));
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

  async invokeModule(moduleUri: string, vars?: Record<string, unknown>, database?: string, modulesDb?: string): Promise<EvalResult[]> {
    if (!this.allowEval) throw new EvalDisabledError();
    const body = new URLSearchParams();
    body.append("module", moduleUri);
    if (modulesDb) body.append("modules-database", modulesDb);
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => body.append(`vars[${k}]`, JSON.stringify(v)));
    }
    return this.evalRequest(body, database);
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
