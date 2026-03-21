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
  host?: string;
  database?: string;
  "document-count"?: number;
  "data-size"?: number;
}

export interface LogEntry {
  filename: string;
  content: string;
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

  async listForests(database?: string, includeDetails = false): Promise<ForestStatus[]> {
    const params: Record<string, string> = { format: "json" };
    if (database) params["database-name"] = database;

    if (includeDetails) {
      // Use view=status to get host, state, and database info in one call
      const data = await this.base.get<Record<string, unknown>>(
        this.base.mgmt,
        "/manage/v2/forests",
        { params: { ...params, view: "status" } }
      );
      const statusList = (data?.["forest-status-list"] as Record<string, unknown>) ?? {};
      const items = (statusList?.["status-list-items"] as Record<string, unknown>) ?? {};
      const forests = (items?.["status-list-item"] as Array<Record<string, unknown>>) ?? [];
      return forests.map((f) => ({
        name: String(f["nameref"] ?? f["name"] ?? ""),
        id: String(f["idref"] ?? f["id"] ?? ""),
        state: String(f["state"] ?? "unknown"),
        host: f["host"] ? String(f["host"]) : undefined,
        database: f["database"] ? String(f["database"]) : undefined,
      }));
    }

    const data = await this.base.get<{ "forest-default-list": { "list-items": { "list-item": Array<{ nameref: string; idref: string }> } } }>(
      this.base.mgmt,
      "/manage/v2/forests",
      { params }
    );
    const items = data?.["forest-default-list"]?.["list-items"]?.["list-item"] ?? [];
    return items.map((i) => ({ name: i.nameref, id: i.idref, state: "unknown" }));
  }

  async setDatabaseForests(database: string, forests: string[]): Promise<void> {
    await this.base.put(
      this.base.mgmt,
      `/manage/v2/databases/${encodeURIComponent(database)}/properties`,
      { forest: forests },
      { params: { format: "json" } }
    );
  }

  async readLogs(options: {
    filename: string;
    host?: string;
    start?: string;
    end?: string;
    regex?: string;
    tail?: number;
  }): Promise<LogEntry> {
    const params: Record<string, string | number> = { filename: options.filename, format: "text" };
    if (options.host) params["host"] = options.host;
    if (options.start) params["start"] = options.start;
    if (options.end) params["end"] = options.end;
    if (options.regex) params["regex"] = options.regex;

    const content = await this.base.get<string>(
      this.base.mgmt,
      "/manage/v2/logs",
      { params, responseType: "text" }
    );

    // Apply tail client-side if requested
    if (options.tail && options.tail > 0) {
      const lines = content.split("\n");
      const tail = lines.slice(-options.tail).join("\n");
      return { filename: options.filename, content: tail };
    }

    return { filename: options.filename, content };
  }

  async listLogFiles(host?: string): Promise<string[]> {
    const params: Record<string, string> = { format: "json" };
    if (host) params["host"] = host;
    const data = await this.base.get<Record<string, unknown>>(
      this.base.mgmt,
      "/manage/v2/logs",
      { params }
    );
    const logList = (data?.["log-default-list"] as Record<string, unknown>) ?? {};
    const items = (logList?.["list-items"] as Record<string, unknown>) ?? {};
    const logItems = (items?.["list-item"] as Array<{ nameref: string }>) ?? [];
    return logItems.map((i) => i.nameref);
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
