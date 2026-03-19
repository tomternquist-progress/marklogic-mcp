import type { MarkLogicBaseClient } from "./base.js";

export interface ExtensionInfo {
  name: string;
  language: string;
  version?: string;
  provider?: string;
}

export class ExtensionsClient {
  constructor(private readonly base: MarkLogicBaseClient) {}

  /** List all deployed REST resource extensions. */
  async listExtensions(): Promise<ExtensionInfo[]> {
    const raw = await this.base.get<Record<string, unknown>>(
      this.base.http,
      "/v1/config/resources",
      { params: { format: "json" } }
    );
    // MarkLogic returns { "resources": [...] } or an empty object when none are deployed
    const resources = (raw?.["resources"] as Array<Record<string, unknown>>) ?? [];
    return resources.map((r) => ({
      name: r.name as string,
      language: r.language as string,
      version: r.version as string | undefined,
      provider: r.provider as string | undefined,
    }));
  }

  /** Retrieve the source code of a deployed extension. */
  async getExtension(name: string): Promise<string> {
    return this.base.get<string>(
      this.base.http,
      `/v1/config/resources/${encodeURIComponent(name)}`,
      { responseType: "text" }
    );
  }

  /**
   * Deploy (or replace) a REST resource extension.
   * Writes the module to /v1/config/resources/{name} and registers it as a resource.
   * SJS modules must export handlers: exports.GET = function(context, params) { ... }
   */
  async putExtension(
    name: string,
    code: string,
    language: "javascript" | "xquery" = "javascript"
  ): Promise<void> {
    const contentType =
      language === "javascript"
        ? "application/vnd.marklogic-javascript"
        : "application/xquery";
    await this.base.put(
      this.base.http,
      `/v1/config/resources/${encodeURIComponent(name)}`,
      code,
      { headers: { "Content-Type": contentType } }
    );
  }

  /** Remove a deployed REST resource extension. */
  async deleteExtension(name: string): Promise<void> {
    await this.base.delete(
      this.base.http,
      `/v1/config/resources/${encodeURIComponent(name)}`
    );
  }

  /**
   * Invoke a deployed REST resource extension.
   * GET extensions are read-safe; POST extensions may write data.
   * Returns the parsed JSON response body.
   */
  async callExtension(
    name: string,
    method: "GET" | "POST",
    params: Record<string, string> = {},
    body?: unknown
  ): Promise<unknown> {
    const url = `/v1/resources/${encodeURIComponent(name)}`;
    // MarkLogic REST extensions require all custom query parameters to be prefixed
    // with "rs:" — the framework strips the prefix before passing to params object
    const rsParams = Object.fromEntries(
      Object.entries(params).map(([k, v]) => [`rs:${k}`, v])
    );
    if (method === "GET") {
      return this.base.get<unknown>(this.base.http, url, { params: rsParams });
    }
    return this.base.post<unknown>(this.base.http, url, body ?? {}, {
      params: rsParams,
      headers: { "Content-Type": "application/json" },
    });
  }
}
