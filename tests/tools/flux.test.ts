import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerFluxTools } from "../../src/tools/flux.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function createMockFlux(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    authType: "digest",
    connectionString: vi.fn((db?: string) => `admin:admin@ml:8000/${db ?? "Documents"}`),
    run: vi.fn(),
    upload: vi.fn(),
    healthCheck: vi.fn(),
    ...overrides,
  };
}

function createMockClients(fluxOverrides?: Record<string, unknown>) {
  return {
    flux: createMockFlux(fluxOverrides),
    schema: {
      findTdesByCollection: vi.fn().mockResolvedValue([]),
      generateTdeTemplate: vi.fn(),
    },
    documents: {
      put: vi.fn(),
    },
    semaphore: {
      configured: true,
      scsHost: "semaphore",
      scsPort: 5058,
      baseUrl: "http://semaphore:5058",
    },
  };
}

function successResult(output = "Success count: 10") {
  return { exitCode: 0, output, success: true };
}

function failResult(output = "Error: something failed") {
  return { exitCode: 1, output, success: false };
}

function setup(fluxOverrides?: Record<string, unknown>, authType: "digest" | "basic" | "oauth" = "digest") {
  const { server, tools } = createMockServer();
  const clients = createMockClients(fluxOverrides);
  registerFluxTools(server as never, clients as never, authType);
  return { tools, clients };
}

// ─── OAuth mode stubs ─────────────────────────────────────────────────────────

describe("registerFluxTools – OAuth mode", () => {
  const FLUX_TOOLS = ["flux_import", "flux_export", "flux_copy", "flux_reprocess", "flux_preview", "flux_help", "flux_status"] as const;

  it("registers all 7 flux tools even in OAuth mode", () => {
    const { tools } = setup({}, "oauth");
    for (const name of FLUX_TOOLS) {
      expect(tools.has(name), `expected ${name} to be registered`).toBe(true);
    }
  });

  it.each(FLUX_TOOLS)("%s returns isError=true in OAuth mode", async (toolName) => {
    const { tools } = setup({}, "oauth");
    const result = await tools.get(toolName)!({
      subcommand: "import-files",
      args: [],
      invoke_module: "/transforms/test.sjs",
      output_connection_string: "admin:admin@host:8000/DB",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("oauth");
  });
});

// ─── flux_status ─────────────────────────────────────────────────────────────

describe("flux_status handler", () => {
  it("returns error when flux is not configured", async () => {
    const { tools } = setup({ configured: false });
    const result = await tools.get("flux_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not configured");
  });

  it("returns error when health check fails", async () => {
    const { tools, clients } = setup();
    (clients.flux.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const result = await tools.get("flux_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not reachable");
  });

  it("returns healthy status with version output", async () => {
    const { tools, clients } = setup();
    (clients.flux.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, output: "Flux 1.2.3", success: true });
    const result = await tools.get("flux_status")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("healthy");
    expect(result.content[0].text).toContain("Flux 1.2.3");
  });
});

// ─── flux_help ───────────────────────────────────────────────────────────────

describe("flux_help handler", () => {
  it("passes help subcommand to flux.run", async () => {
    const { tools, clients } = setup();
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, output: "Usage: import-delimited-files ...", success: true });

    const result = await tools.get("flux_help")!({ subcommand: "import-delimited-files" });
    expect(clients.flux.run).toHaveBeenCalledWith(["help", "import-delimited-files"]);
    expect(result.content[0].text).toContain("Usage:");
  });

  it("passes --help when no subcommand given", async () => {
    const { tools, clients } = setup();
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, output: "Flux CLI help...", success: true });

    await tools.get("flux_help")!({});
    expect(clients.flux.run).toHaveBeenCalledWith(["--help"]);
  });
});

// ─── flux_preview ────────────────────────────────────────────────────────────

describe("flux_preview handler", () => {
  it("injects connection args and --preview when not in args", async () => {
    const { tools, clients } = setup();
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue({ exitCode: 0, output: "preview output", success: true });

    await tools.get("flux_preview")!({
      args: ["import-delimited-files", "--path", "/data/file.csv"],
      preview_rows: 5,
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs[0]).toBe("import-delimited-files");
    expect(calledArgs).toContain("--connection-string");
    expect(calledArgs).toContain("--preview");
    expect(calledArgs).toContain("5");
  });

  it("returns isError when flux run fails", async () => {
    const { tools, clients } = setup();
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(failResult("Connection refused"));
    const result = await tools.get("flux_preview")!({ args: ["import-files", "--path", "/x"] });
    expect(result.isError).toBe(true);
  });
});

// ─── flux_export ─────────────────────────────────────────────────────────────

describe("flux_export handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    ({ tools, clients } = setup());
  });

  it("runs export-files with correct args", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult("Exported 100 files"));

    await tools.get("flux_export")!({
      subcommand: "export-files",
      path: "/output/",
      collections: ["my-data"],
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs[0]).toBe("export-files");
    expect(calledArgs).toContain("--path");
    expect(calledArgs).toContain("/output/");
    expect(calledArgs).toContain("--collections");
    expect(calledArgs).toContain("my-data");
  });

  it("passes thread_count and batch_size", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult());

    await tools.get("flux_export")!({
      subcommand: "export-parquet-files",
      path: "/out/",
      thread_count: 8,
      batch_size: 200,
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs).toContain("--thread-count");
    expect(calledArgs).toContain("8");
    expect(calledArgs).toContain("--batch-size");
    expect(calledArgs).toContain("200");
  });

  it("returns isError=true on failed export", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(failResult());
    const result = await tools.get("flux_export")!({ subcommand: "export-files" });
    expect(result.isError).toBe(true);
  });
});

// ─── flux_copy ───────────────────────────────────────────────────────────────

describe("flux_copy handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    ({ tools, clients } = setup());
  });

  it("runs copy with output connection string", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult("Copied 50 docs"));

    await tools.get("flux_copy")!({
      output_connection_string: "admin:admin@target:8000/Staging",
      collections: ["source-col"],
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs[0]).toBe("copy");
    expect(calledArgs).toContain("--output-connection-string");
    expect(calledArgs).toContain("admin:admin@target:8000/Staging");
    expect(calledArgs).toContain("--collections");
  });

  it("passes output_collections override", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult());

    await tools.get("flux_copy")!({
      output_connection_string: "user:pass@host:8000/DB",
      output_collections: ["new-col"],
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs).toContain("--output-collections");
    expect(calledArgs).toContain("new-col");
  });
});

// ─── flux_reprocess ──────────────────────────────────────────────────────────

describe("flux_reprocess handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    ({ tools, clients } = setup());
  });

  it("builds reprocess args with write-invoke and read_module", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult());

    await tools.get("flux_reprocess")!({
      invoke_module: "/transforms/build-entity.sjs",
      read_module: "/transforms/collect-uris.sjs",
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs[0]).toBe("reprocess");
    expect(calledArgs).toContain("--write-invoke");
    expect(calledArgs).toContain("/transforms/build-entity.sjs");
    expect(calledArgs).toContain("--read-invoke");
    expect(calledArgs).toContain("/transforms/collect-uris.sjs");
    expect(calledArgs).toContain("--external-variable-name");
    expect(calledArgs).toContain("URI");
  });

  it("inlines a cts.uris() read-javascript from collections array", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult());

    await tools.get("flux_reprocess")!({
      invoke_module: "/transforms/my.sjs",
      collections: ["my-collection"],
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs).toContain("--read-javascript");
    const jsIdx = calledArgs.indexOf("--read-javascript");
    expect(calledArgs[jsIdx + 1]).toContain("cts.uris");
    expect(calledArgs[jsIdx + 1]).toContain("my-collection");
  });

  it("coerces collections string to array", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult());

    await tools.get("flux_reprocess")!({
      invoke_module: "/transforms/my.sjs",
      collections: "single-collection",
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    const jsIdx = calledArgs.indexOf("--read-javascript");
    expect(calledArgs[jsIdx + 1]).toContain("single-collection");
  });

  it("prefers read_javascript over collections", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult());

    await tools.get("flux_reprocess")!({
      invoke_module: "/transforms/my.sjs",
      read_javascript: "Sequence.from(['/doc/a.json'])",
      collections: ["ignored-col"],
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    const jsIdx = calledArgs.indexOf("--read-javascript");
    expect(calledArgs[jsIdx + 1]).toContain("Sequence.from");
  });
});

// ─── flux_import ─────────────────────────────────────────────────────────────

describe("flux_import handler – basic args", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    ({ tools, clients } = setup());
  });

  it("builds args with subcommand, connection-string, and http-url", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult());

    await tools.get("flux_import")!({
      subcommand: "import-delimited-files",
      http_url: "https://example.com/data.csv",
      collections: ["my-data"],
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs[0]).toBe("import-delimited-files");
    expect(calledArgs).toContain("--connection-string");
    expect(calledArgs).toContain("--http-url");
    expect(calledArgs).toContain("https://example.com/data.csv");
    expect(calledArgs).toContain("--collections");
    expect(calledArgs).toContain("my-data");
  });

  it("passes uri_template and thread_count and batch_size", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult());

    await tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data/",
      uri_template: "/import/{id}.json",
      thread_count: 4,
      batch_size: 50,
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs).toContain("--uri-template");
    expect(calledArgs).toContain("/import/{id}.json");
    expect(calledArgs).toContain("--thread-count");
    expect(calledArgs).toContain("4");
    expect(calledArgs).toContain("--batch-size");
    expect(calledArgs).toContain("50");
  });

  it("returns isError=true when import fails", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(failResult("FAILED (exit 1)\nConnection refused"));
    const result = await tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data/",
    });
    expect(result.isError).toBe(true);
  });

  it("returns SUCCESS output when import succeeds", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult("Success count: 500"));
    const result = await tools.get("flux_import")!({
      subcommand: "import-delimited-files",
      http_url: "https://example.com/data.csv",
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("SUCCESS");
  });
});

describe("flux_import handler – permissions validation", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    ({ tools, clients } = setup());
  });

  it("accepts valid permissions format", async () => {
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult());

    const result = await tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data/",
      permissions: "rest-reader:read,rest-writer:update",
    });
    expect(result.isError).not.toBe(true);
    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs).toContain("--permissions");
  });

  it("returns isError for invalid capability in permissions", async () => {
    const result = await tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data/",
      permissions: "rest-reader:admin",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid capability");
  });

  it("returns isError for malformed permissions (missing colon)", async () => {
    const result = await tools.get("flux_import")!({
      subcommand: "import-files",
      path: "/data/",
      permissions: "rest-reader",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid permissions format");
  });
});

describe("flux_import handler – RDF guard", () => {
  it("returns isError when generate_tde=true is used with import-rdf-files", async () => {
    const { tools } = setup();
    const result = await tools.get("flux_import")!({
      subcommand: "import-rdf-files",
      http_url: "https://example.org/vocab.ttl",
      generate_tde: true,
      collections: ["rdf-data"],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no effect for import-rdf-files");
  });
});

describe("flux_import handler – Semaphore classification injection", () => {
  it("injects classifier flags when classify_with_semaphore=true", async () => {
    const { tools, clients } = setup();
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult());

    await tools.get("flux_import")!({
      subcommand: "import-delimited-files",
      http_url: "https://example.com/data.csv",
      classify_with_semaphore: true,
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs).toContain("--classifier-host");
    expect(calledArgs).toContain("semaphore");
    expect(calledArgs).toContain("--classifier-port");
    expect(calledArgs).toContain("--classifier-path");
    expect(calledArgs).toContain("/");
  });

  it("returns error when classify_with_semaphore=true but SEMAPHORE_HOST not set", async () => {
    const { tools } = setup({});
    // Override semaphore mock — not configured
    const { server, tools: t2 } = createMockServer();
    const clients2 = createMockClients();
    (clients2.semaphore as Record<string, unknown>).configured = false;
    (clients2.semaphore as Record<string, unknown>).scsHost = null;
    registerFluxTools(server as never, clients2 as never, "digest");

    const result = await t2.get("flux_import")!({
      subcommand: "import-delimited-files",
      http_url: "https://example.com/data.csv",
      classify_with_semaphore: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("SEMAPHORE_HOST");
  });

  it("appends classifier_publish_sets as pipe-separated list", async () => {
    const { tools, clients } = setup();
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(successResult());

    await tools.get("flux_import")!({
      subcommand: "import-delimited-files",
      http_url: "https://example.com/data.csv",
      classify_with_semaphore: true,
      classifier_publish_sets: ["iptcmediatopics", "unescothesaurus"],
    });

    const calledArgs = (clients.flux.run as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(calledArgs).toContain("--classifier-prop");
    const propIdx = calledArgs.indexOf("--classifier-prop");
    expect(calledArgs[propIdx + 1]).toContain("iptcmediatopics|unescothesaurus");
  });
});

describe("flux_import handler – error message enrichment", () => {
  it("appends 404 hint when http_url returns 404", async () => {
    const { tools, clients } = setup();
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue(
      failResult("FAILED (exit 1)\nHTTP 404 Not Found")
    );

    const result = await tools.get("flux_import")!({
      subcommand: "import-delimited-files",
      http_url: "https://example.com/bad.csv",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
    expect(result.content[0].text).toContain("Hint:");
  });

  it("appends TDE note when output contains TDE- errors", async () => {
    const { tools, clients } = setup();
    (clients.flux.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0,
      output: "Success count: 100\nTDE-CAST error on column price",
      success: true,
    });

    const result = await tools.get("flux_import")!({
      subcommand: "import-delimited-files",
      http_url: "https://example.com/data.csv",
      collections: ["sales"],
    });
    expect(result.content[0].text).toContain("TDE ERROR NOTE");
  });
});
