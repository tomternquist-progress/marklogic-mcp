import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerFluxTools } from "../../src/tools/flux.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(_name, handler);
    }),
  };
  return { server, tools };
}

const TOOL_NAMES = ["flux_import", "flux_export", "flux_copy", "flux_reprocess", "flux_preview", "flux_help", "flux_status"] as const;

function createMockClients(opts: { fluxConfigured?: boolean; semaphoreConfigured?: boolean; scsHost?: string } = {}) {
  return {
    flux: {
      configured: opts.fluxConfigured ?? true,
      connectionString: vi.fn().mockReturnValue("user:pass@localhost:8000/db"),
      authType: "digest",
      run: vi.fn(),
      upload: vi.fn(),
      scsHost: opts.scsHost,
    },
    schema: {
      findTdesByCollection: vi.fn().mockResolvedValue([]),
      generateTdeTemplate: vi.fn(),
    },
    documents: {
      put: vi.fn(),
    },
    semaphore: {
      configured: opts.semaphoreConfigured ?? false,
      scsHost: opts.scsHost ?? null,
      scsPort: 5058,
      baseUrl: "http://semaphore:5058",
      kmmBaseUrl: null,
    },
  };
}

// ── OAuth stub registration ───────────────────────────────────────────────────

describe("registerFluxTools – oauth mode", () => {
  it("registers stub tools for all flux tool names in oauth mode", () => {
    const { server, tools } = createMockServer();
    registerFluxTools(server as never, createMockClients() as never, "oauth");

    for (const name of TOOL_NAMES) {
      expect(tools.has(name)).toBe(true);
    }
    expect(tools.size).toBe(TOOL_NAMES.length);
  });

  it("stub tools return isError with an oauth message", async () => {
    const { server, tools } = createMockServer();
    registerFluxTools(server as never, createMockClients() as never, "oauth");

    for (const name of TOOL_NAMES) {
      const result = await tools.get(name)!({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("ML_AUTH_TYPE=oauth");
    }
  });
});

// ── Normal registration (digest) ──────────────────────────────────────────────

describe("registerFluxTools – digest mode registration", () => {
  it("registers all flux tools", () => {
    const { server, tools } = createMockServer();
    registerFluxTools(server as never, createMockClients() as never, "digest");

    for (const name of TOOL_NAMES) {
      expect(tools.has(name)).toBe(true);
    }
  });
});

// ── flux_import handler ───────────────────────────────────────────────────────

describe("flux_import handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerFluxTools(mock.server as never, clients as never, "digest");
    tools = mock.tools;
  });

  it("returns success result for a basic import", async () => {
    clients.flux.run.mockResolvedValue({ exitCode: 0, output: "Wrote 10 documents", success: true });

    const result = await tools.get("flux_import")!({
      subcommand: "import-delimited-files",
      http_url: "https://example.com/data.csv",
      collections: ["my-data"],
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("SUCCESS");
    expect(result.content[0].text).toContain("Wrote 10 documents");
  });

  it("passes --http-url arg when http_url is provided", async () => {
    clients.flux.run.mockResolvedValue({ exitCode: 0, output: "ok", success: true });

    await tools.get("flux_import")!({
      subcommand: "import-delimited-files",
      http_url: "https://example.com/data.csv",
    });

    const [args] = clients.flux.run.mock.calls[0];
    expect(args).toContain("--http-url");
    expect(args).toContain("https://example.com/data.csv");
  });

  it("passes --path arg when path is provided", async () => {
    clients.flux.run.mockResolvedValue({ exitCode: 0, output: "ok", success: true });

    await tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data/myfile.json",
    });

    const [args] = clients.flux.run.mock.calls[0];
    expect(args).toContain("--path");
    expect(args).toContain("/data/myfile.json");
  });

  it("passes --collections arg joined by comma", async () => {
    clients.flux.run.mockResolvedValue({ exitCode: 0, output: "ok", success: true });

    await tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data",
      collections: ["colA", "colB"],
    });

    const [args] = clients.flux.run.mock.calls[0];
    expect(args).toContain("--collections");
    expect(args).toContain("colA,colB");
  });

  it("passes --column-names arg as tab-separated", async () => {
    clients.flux.run.mockResolvedValue({ exitCode: 0, output: "ok", success: true });

    await tools.get("flux_import")!({
      subcommand: "import-delimited-files",
      path: "/data",
      column_names: ["id", "name", "value"],
    });

    const [args] = clients.flux.run.mock.calls[0];
    expect(args).toContain("--column-names");
    expect(args).toContain("id\tname\tvalue");
  });

  it("rejects invalid permissions format", async () => {
    const result = await tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data",
      permissions: "bad-format",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid permissions format");
  });

  it("rejects invalid permission capability", async () => {
    const result = await tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data",
      permissions: "rest-reader:superadmin",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid capability");
  });

  it("rejects generate_tde=true for import-rdf-files", async () => {
    const result = await tools.get("flux_import")!({
      subcommand: "import-rdf-files",
      http_url: "https://example.com/data.ttl",
      generate_tde: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("generate_tde=true has no effect");
  });

  it("returns isError when classify_with_semaphore=true but semaphore not configured", async () => {
    const result = await tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data",
      classify_with_semaphore: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("SEMAPHORE_HOST");
  });

  it("appends classifier args when classify_with_semaphore=true and configured", async () => {
    const mock = createMockServer();
    const configuredClients = createMockClients({ semaphoreConfigured: true, scsHost: "semaphore-host" });
    configuredClients.flux.run.mockResolvedValue({ exitCode: 0, output: "ok", success: true });
    registerFluxTools(mock.server as never, configuredClients as never, "digest");
    const t = mock.tools;

    await t.get("flux_import")!({
      subcommand: "import-files",
      path: "/data",
      classify_with_semaphore: true,
    });

    const [args] = configuredClients.flux.run.mock.calls[0];
    expect(args).toContain("--classifier-host");
    expect(args).toContain("semaphore-host");
    expect(args).toContain("--classifier-port");
  });

  it("adds HTTP 404 hint when URL returns 404", async () => {
    clients.flux.run.mockResolvedValue({
      exitCode: 1,
      output: "HTTP 404 Not Found",
      success: false,
    });

    const result = await tools.get("flux_import")!({
      subcommand: "import-delimited-files",
      http_url: "https://example.com/data.csv",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Hint");
    expect(result.content[0].text).toContain("404");
  });

  it("adds HTTP 403 hint when URL returns 403", async () => {
    clients.flux.run.mockResolvedValue({
      exitCode: 1,
      output: "HTTP 403 Forbidden",
      success: false,
    });

    const result = await tools.get("flux_import")!({
      subcommand: "import-delimited-files",
      http_url: "https://example.com/data.csv",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("403");
  });
});

// ── flux_status handler ───────────────────────────────────────────────────────

describe("flux_status handler", () => {
  it("returns unconfigured message when flux is not configured", async () => {
    const mock = createMockServer();
    const clients = createMockClients({ fluxConfigured: false });
    registerFluxTools(mock.server as never, clients as never, "digest");

    const result = await mock.tools.get("flux_status")!({});
    expect(result.content[0].text).toContain("not configured");
  });
});

// ── condenseWriteErrors (via flux_import output processing) ──────────────────

describe("flux_import – write error condensing", () => {
  it("condenses flood of write errors into summary", async () => {
    const mock = createMockServer();
    const clients = createMockClients();
    // Build 10 identical write-error lines
    const floodLines = Array.from({ length: 10 }, (_, i) =>
      `Unable to write document /doc/${i}.json: Server Message: XDMP-NOSUCHDB: DB not found`
    ).join("\n");
    clients.flux.run.mockResolvedValue({ exitCode: 1, output: floodLines, success: false });
    registerFluxTools(mock.server as never, clients as never, "digest");

    const result = await mock.tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data",
    });

    expect(result.isError).toBe(true);
    // Should contain condensed summary instead of 10 raw lines
    expect(result.content[0].text).toContain("documents failed to write");
  });

  it("does not condense when ≤5 write errors", async () => {
    const mock = createMockServer();
    const clients = createMockClients();
    const lines = Array.from({ length: 3 }, (_, i) =>
      `Unable to write document /doc/${i}.json: cause: some error`
    ).join("\n");
    clients.flux.run.mockResolvedValue({ exitCode: 1, output: lines, success: false });
    registerFluxTools(mock.server as never, clients as never, "digest");

    const result = await mock.tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data",
    });

    // Should still contain the raw error text (not condensed)
    expect(result.content[0].text).toContain("Unable to write document");
    expect(result.content[0].text).not.toContain("documents failed to write");
  });
});
