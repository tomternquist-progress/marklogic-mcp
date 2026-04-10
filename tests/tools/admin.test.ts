import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAdminTools } from "../../src/tools/admin.js";
import { MarkLogicError } from "../../src/utils/errors.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn(
      (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
        tools.set(_name, handler);
      }
    ),
  };
  return { server, tools };
}

function createMockClients() {
  return {
    admin: {
      listDatabases: vi.fn(),
      getDatabaseProperties: vi.fn(),
      getDatabaseStatistics: vi.fn(),
      listForests: vi.fn(),
      setDatabaseForests: vi.fn(),
      listServers: vi.fn(),
      getServerProperties: vi.fn(),
      getClusterStatus: vi.fn(),
      getReindexStatus: vi.fn(),
      listLogFiles: vi.fn(),
      readLogs: vi.fn(),
    },
  };
}

// ─── Tool registration ─────────────────────────────────────────────────────

describe("registerAdminTools – tool registration", () => {
  it("registers all admin tools", () => {
    const { server, tools } = createMockServer();
    registerAdminTools(server as never, createMockClients() as never);

    expect(tools.has("ml_databases_list")).toBe(true);
    expect(tools.has("ml_database_properties")).toBe(true);
    expect(tools.has("ml_database_statistics")).toBe(true);
    expect(tools.has("ml_forests_list")).toBe(true);
    expect(tools.has("ml_database_set_forests")).toBe(true);
    expect(tools.has("ml_servers_list")).toBe(true);
    expect(tools.has("ml_server_properties")).toBe(true);
    expect(tools.has("ml_cluster_status")).toBe(true);
    expect(tools.has("ml_reindex_status")).toBe(true);
    expect(tools.has("ml_logs_list")).toBe(true);
    expect(tools.has("ml_logs_read")).toBe(true);
    expect(tools.size).toBe(11);
  });
});

// ─── ml_databases_list ──────────────────────────────────────────────────────

describe("ml_databases_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerAdminTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns JSON list of databases", async () => {
    const dbs = ["Documents", "Schemas", "Security"];
    clients.admin.listDatabases.mockResolvedValue(dbs);

    const result = await tools.get("ml_databases_list")!({});

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(dbs);
  });

  it("sets isError on failure", async () => {
    clients.admin.listDatabases.mockRejectedValue(new MarkLogicError("unauthorized", 401));
    const result = await tools.get("ml_databases_list")!({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("401");
  });
});

// ─── ml_database_properties ─────────────────────────────────────────────────

describe("ml_database_properties handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerAdminTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns database properties", async () => {
    const props = { "database-name": "Documents", "word-positions": true };
    clients.admin.getDatabaseProperties.mockResolvedValue(props);

    const result = await tools.get("ml_database_properties")!({ database: "Documents" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(props);
    expect(clients.admin.getDatabaseProperties).toHaveBeenCalledWith("Documents");
  });

  it("sets isError on failure", async () => {
    clients.admin.getDatabaseProperties.mockRejectedValue(new MarkLogicError("not found", 404));
    const result = await tools.get("ml_database_properties")!({ database: "Missing" });

    expect(result.isError).toBe(true);
  });
});

// ─── ml_database_statistics ─────────────────────────────────────────────────

describe("ml_database_statistics handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerAdminTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns database statistics", async () => {
    const stats = { docCount: 1000, forestCount: 2 };
    clients.admin.getDatabaseStatistics.mockResolvedValue(stats);

    const result = await tools.get("ml_database_statistics")!({ database: "Documents" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(stats);
  });
});

// ─── ml_forests_list ────────────────────────────────────────────────────────

describe("ml_forests_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerAdminTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("lists forests without database filter", async () => {
    const forests = [{ name: "Documents-001" }];
    clients.admin.listForests.mockResolvedValue(forests);

    const result = await tools.get("ml_forests_list")!({});

    expect(result.isError).toBeUndefined();
    expect(clients.admin.listForests).toHaveBeenCalledWith(undefined, false);
  });

  it("passes database filter", async () => {
    clients.admin.listForests.mockResolvedValue([]);
    await tools.get("ml_forests_list")!({ database: "Documents" });

    expect(clients.admin.listForests).toHaveBeenCalledWith("Documents", false);
  });
});

// ─── ml_servers_list ────────────────────────────────────────────────────────

describe("ml_servers_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerAdminTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("lists servers with optional group filter", async () => {
    clients.admin.listServers.mockResolvedValue([{ name: "App-Services" }]);

    const result = await tools.get("ml_servers_list")!({ group: "Default" });

    expect(result.isError).toBeUndefined();
    expect(clients.admin.listServers).toHaveBeenCalledWith("Default");
  });
});

// ─── ml_server_properties ───────────────────────────────────────────────────

describe("ml_server_properties handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerAdminTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("passes server name and defaults group to Default", async () => {
    clients.admin.getServerProperties.mockResolvedValue({ port: 8000 });

    await tools.get("ml_server_properties")!({ server_name: "App-Services" });

    expect(clients.admin.getServerProperties).toHaveBeenCalledWith("App-Services", "Default");
  });

  it("passes explicit group", async () => {
    clients.admin.getServerProperties.mockResolvedValue({});

    await tools.get("ml_server_properties")!({ server_name: "MyServer", group: "CustomGroup" });

    expect(clients.admin.getServerProperties).toHaveBeenCalledWith("MyServer", "CustomGroup");
  });
});

// ─── ml_cluster_status ──────────────────────────────────────────────────────

describe("ml_cluster_status handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerAdminTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns cluster status", async () => {
    const status = { version: "12.0.1", healthy: true };
    clients.admin.getClusterStatus.mockResolvedValue(status);

    const result = await tools.get("ml_cluster_status")!({});

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(status);
  });

  it("sets isError on failure", async () => {
    clients.admin.getClusterStatus.mockRejectedValue(new Error("connection refused"));
    const result = await tools.get("ml_cluster_status")!({});

    expect(result.isError).toBe(true);
  });
});

// ─── ml_reindex_status ──────────────────────────────────────────────────────

describe("ml_reindex_status handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerAdminTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns reindex status", async () => {
    const status = { ready: true, reindexCount: 0 };
    clients.admin.getReindexStatus.mockResolvedValue(status);

    const result = await tools.get("ml_reindex_status")!({ database: "Documents" });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(status);
    expect(clients.admin.getReindexStatus).toHaveBeenCalledWith("Documents");
  });
});

// ─── ml_database_set_forests ───────────────────────────────────────────────

describe("ml_database_set_forests handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerAdminTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("calls setDatabaseForests and returns success message", async () => {
    clients.admin.setDatabaseForests.mockResolvedValue(undefined);

    const result = await tools.get("ml_database_set_forests")!({
      database: "Documents",
      forests: ["Forest1", "Forest2"],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Forest list updated");
    expect(result.content[0].text).toContain("Documents");
    expect(result.content[0].text).toContain("Forest1");
    expect(result.content[0].text).toContain("Forest2");
    expect(clients.admin.setDatabaseForests).toHaveBeenCalledWith("Documents", ["Forest1", "Forest2"]);
  });

  it("sets isError on failure", async () => {
    clients.admin.setDatabaseForests.mockRejectedValue(new MarkLogicError("forbidden", 403));
    const result = await tools.get("ml_database_set_forests")!({
      database: "Documents",
      forests: ["Forest1"],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("403");
  });
});

// ─── ml_logs_list ──────────────────────────────────────────────────────────

describe("ml_logs_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerAdminTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns list of log files", async () => {
    const files = ["ErrorLog.txt", "8000_AccessLog.txt"];
    clients.admin.listLogFiles.mockResolvedValue(files);

    const result = await tools.get("ml_logs_list")!({});

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(files);
    expect(clients.admin.listLogFiles).toHaveBeenCalledWith(undefined);
  });

  it("passes host filter", async () => {
    clients.admin.listLogFiles.mockResolvedValue([]);
    await tools.get("ml_logs_list")!({ host: "ml-host-1" });

    expect(clients.admin.listLogFiles).toHaveBeenCalledWith("ml-host-1");
  });

  it("sets isError on failure", async () => {
    clients.admin.listLogFiles.mockRejectedValue(new MarkLogicError("error", 500));
    const result = await tools.get("ml_logs_list")!({});

    expect(result.isError).toBe(true);
  });
});

// ─── ml_logs_read ──────────────────────────────────────────────────────────

describe("ml_logs_read handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerAdminTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns log content", async () => {
    clients.admin.readLogs.mockResolvedValue({ filename: "ErrorLog.txt", content: "2026-04-10 INFO Server started" });

    const result = await tools.get("ml_logs_read")!({ filename: "ErrorLog.txt" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Server started");
  });

  it("passes all parameters to client", async () => {
    clients.admin.readLogs.mockResolvedValue({ filename: "ErrorLog.txt", content: "" });

    await tools.get("ml_logs_read")!({
      filename: "ErrorLog.txt",
      host: "ml-host-1",
      start: "2026-04-10T00:00:00",
      end: "2026-04-10T23:59:59",
      regex: "XDMP-.*",
      tail: 100,
    });

    expect(clients.admin.readLogs).toHaveBeenCalledWith({
      filename: "ErrorLog.txt",
      host: "ml-host-1",
      start: "2026-04-10T00:00:00",
      end: "2026-04-10T23:59:59",
      regex: "XDMP-.*",
      tail: 100,
    });
  });

  it("sets isError on failure", async () => {
    clients.admin.readLogs.mockRejectedValue(new MarkLogicError("not found", 404));
    const result = await tools.get("ml_logs_read")!({ filename: "MissingLog.txt" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
  });
});
