import type { MarkLogicBaseClient } from "./base.js";

export interface DatabaseSummary {
  name: string;
  id: string;
}

export interface DatabaseProperties {
  "database-name": string;
  enabled: boolean;
  "forest": string[];
  uri: string;
  [key: string]: unknown;
}

export interface DatabaseStatistics {
  "database-name": string;
  "document-count": number;
  "forests": ForestStatus[];
}

export interface ForestStatus {
  name: string;
  id: string;
  state: string;
  "document-count"?: number;
  "data-size"?: number;
}

export interface ServerSummary {
  name: string;
  id: string;
  type: string;
  group: string;
  port?: number;
}

export interface ClusterStatus {
  "local-host": string;
  version: string;
  "cluster-id": string;
  [key: string]: unknown;
}

export interface ReindexStatus {
  database: string;
  ready: boolean;
  indexing: boolean;
  reindexCount: number;
  message: string;
}

export class AdminClient {
  constructor(private readonly base: MarkLogicBaseClient) {}

  async listDatabases(): Promise<DatabaseSummary[]> {
    const data = await this.base.get<{ "database-default-list": { "list-items": { "list-item": Array<{ nameref: string; idref: string }> } } }>(
      this.base.mgmt,
      "/manage/v2/databases",
      { params: { format: "json" } }
    );
    const items = data?.["database-default-list"]?.["list-items"]?.["list-item"] ?? [];
    return items.map((i) => ({ name: i.nameref, id: i.idref }));
  }

  async getDatabaseProperties(database: string): Promise<DatabaseProperties> {
    return this.base.get<DatabaseProperties>(
      this.base.mgmt,
      `/manage/v2/databases/${encodeURIComponent(database)}/properties`,
      { params: { format: "json" } }
    );
  }

  async getDatabaseStatistics(database: string): Promise<Record<string, unknown>> {
    return this.base.get<Record<string, unknown>>(
      this.base.mgmt,
      `/manage/v2/databases/${encodeURIComponent(database)}`,
      { params: { format: "json", view: "status" } }
    );
  }

  async listForests(database?: string): Promise<ForestStatus[]> {
    const params: Record<string, string> = { format: "json" };
    if (database) params["database-name"] = database;
    const data = await this.base.get<{ "forest-default-list": { "list-items": { "list-item": Array<{ nameref: string; idref: string }> } } }>(
      this.base.mgmt,
      "/manage/v2/forests",
      { params }
    );
    const items = data?.["forest-default-list"]?.["list-items"]?.["list-item"] ?? [];
    return items.map((i) => ({ name: i.nameref, id: i.idref, state: "unknown" }));
  }

  async listServers(group?: string): Promise<ServerSummary[]> {
    const params: Record<string, string> = { format: "json" };
    if (group) params["group-id"] = group;
    const data = await this.base.get<{ "server-default-list": { "list-items": { "list-item": Array<{ nameref: string; idref: string; "server-type"?: string; groupnameref?: string }> } } }>(
      this.base.mgmt,
      "/manage/v2/servers",
      { params }
    );
    const items = data?.["server-default-list"]?.["list-items"]?.["list-item"] ?? [];
    return items.map((i) => ({ name: i.nameref, id: i.idref, type: i["server-type"] ?? "unknown", group: i.groupnameref ?? group ?? "" }));
  }

  async getServerProperties(serverName: string, group = "Default"): Promise<Record<string, unknown>> {
    return this.base.get<Record<string, unknown>>(
      this.base.mgmt,
      `/manage/v2/servers/${encodeURIComponent(serverName)}/properties`,
      { params: { format: "json", "group-id": group } }
    );
  }

  async getClusterStatus(): Promise<ClusterStatus> {
    const data = await this.base.get<{ "local-cluster-status": ClusterStatus }>(
      this.base.mgmt,
      "/manage/v2",
      { params: { format: "json" } }
    );
    return (data?.["local-cluster-status"] as ClusterStatus) ?? (data as unknown as ClusterStatus);
  }

  async getReindexStatus(database: string): Promise<ReindexStatus> {
    const data = await this.base.get<Record<string, unknown>>(
      this.base.mgmt,
      `/manage/v2/databases/${encodeURIComponent(database)}`,
      { params: { format: "json", view: "status" } }
    );
    const dbStatus = (data?.["database-status"] as Record<string, unknown>) ?? data;
    const props = (dbStatus?.["status-properties"] as Record<string, unknown>) ?? {};

    // status-properties values may be wrapped as { units, value } objects
    const unwrap = (v: unknown): unknown =>
      v && typeof v === "object" && "value" in (v as object) ? (v as { value: unknown }).value : v;

    const indexing = String(unwrap(props["indexing-state"])) === "true";
    const reindexCount = Number(unwrap(props["reindex-count"]) ?? 0);

    const ready = !indexing && reindexCount === 0;
    const message = ready
      ? `Database "${database}" is ready — no reindexing in progress. TDE views are safe to query.`
      : `Database "${database}" is reindexing (reindex-count: ${reindexCount}). TDE views may be unavailable until complete — retry in a few seconds.`;

    return { database, ready, indexing, reindexCount, message };
  }
}
