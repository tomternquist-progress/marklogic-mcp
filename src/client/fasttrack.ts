import type { MarkLogicBaseClient } from "./base.js";

export interface SearchOptionsSummary {
  name: string;
  uri: string;
}

export class FastTrackClient {
  constructor(
    private readonly base: MarkLogicBaseClient,
    private readonly readonly: boolean,
  ) {}

  async listSearchOptions(database?: string): Promise<SearchOptionsSummary[]> {
    const qp: Record<string, string> = { format: "json" };
    if (database) qp.database = database;
    const raw = await this.base.get<Record<string, unknown>>(
      this.base.http,
      "/v1/config/query",
      { params: qp }
    );
    // MarkLogic returns {"query-options-list": {"options": [{"name":..., "uri":...}, ...]}}
    const list = raw?.["query-options-list"] as Record<string, unknown> | undefined;
    const opts = (list?.["options"] ?? raw?.["options"]) as Array<Record<string, string>> | undefined;
    if (Array.isArray(opts)) {
      return opts.map((o) => ({ name: o.name ?? "", uri: o.uri ?? "" }));
    }
    // Fallback: some ML versions return a flat name array
    const names = raw?.["options-name"] as string[] | string | undefined;
    if (names) {
      const arr = Array.isArray(names) ? names : [names];
      return arr.map((n) => ({ name: n, uri: `/v1/config/query/${encodeURIComponent(n)}` }));
    }
    return [];
  }

  async getSearchOptions(name: string, database?: string): Promise<Record<string, unknown>> {
    const qp: Record<string, string> = { format: "json" };
    if (database) qp.database = database;
    return this.base.get<Record<string, unknown>>(
      this.base.http,
      `/v1/config/query/${encodeURIComponent(name)}`,
      { params: qp }
    );
  }

  async putSearchOptions(
    name: string,
    options: Record<string, unknown>,
    database?: string
  ): Promise<void> {
    if (this.readonly) {
      throw new Error("Server is in readonly mode.\nNOTE: Set ML_READONLY=false to write search options.");
    }
    const qp: Record<string, string> = {};
    if (database) qp.database = database;
    await this.base.put(
      this.base.http,
      `/v1/config/query/${encodeURIComponent(name)}`,
      options,
      { params: qp, headers: { "Content-Type": "application/json" } }
    );
  }

  async deleteSearchOptions(name: string, database?: string): Promise<void> {
    if (this.readonly) {
      throw new Error("Server is in readonly mode.\nNOTE: Set ML_READONLY=false to delete search options.");
    }
    const qp: Record<string, string> = {};
    if (database) qp.database = database;
    await this.base.delete(
      this.base.http,
      `/v1/config/query/${encodeURIComponent(name)}`,
      { params: qp }
    );
  }
}
