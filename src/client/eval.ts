import type { MarkLogicBaseClient } from "./base.js";
import { EvalDisabledError } from "../utils/errors.js";

export interface EvalResult {
  primitive: string;
  value: unknown;
}

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

function parseMultipartMixed(body: string, contentType: string): EvalResult[] {
  // Extract boundary from content-type header
  const boundaryMatch = contentType?.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return [{ primitive: "string", value: body }];

  const boundary = boundaryMatch[1].replace(/^"(.*)"$/, "$1");
  const parts = body.split(`--${boundary}`).slice(1); // skip preamble
  const results: EvalResult[] = [];

  for (const part of parts) {
    if (part.trim() === "--" || part.trim() === "") continue;
    const [headerSection, ...bodyParts] = part.split("\r\n\r\n");
    const bodyText = bodyParts.join("\r\n\r\n").replace(/\r\n$/, "");

    const primitiveMatch = headerSection?.match(/X-Primitive:\s*([^\r\n]+)/i);
    const primitive = primitiveMatch?.[1]?.trim() ?? "string";

    let value: unknown = bodyText;
    if (primitive === "integer" || primitive === "decimal" || primitive === "double" || primitive === "float") {
      value = Number(bodyText);
    } else if (primitive === "boolean") {
      value = bodyText === "true";
    } else if (primitive === "null-node()" || primitive === "null") {
      value = null;
    } else {
      // Try JSON parse for objects/arrays
      try {
        value = JSON.parse(bodyText);
      } catch {
        value = bodyText;
      }
    }

    results.push({ primitive, value });
  }

  return results;
}
