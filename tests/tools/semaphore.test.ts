import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerSemaphoreTools } from "../../src/tools/semaphore.js";
import { MarkLogicError } from "../../src/utils/errors.js";

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

function createMockSemaphore(opts: {
  configured?: boolean;
  kmmBaseUrl?: string | null;
  kmmConfigured?: boolean;
  baseUrl?: string;
} = {}) {
  return {
    configured: opts.configured ?? true,
    kmmBaseUrl: "kmmBaseUrl" in opts ? (opts.kmmBaseUrl as string | null) : "http://semaphore:5080",
    kmmConfigured: opts.kmmConfigured ?? true,
    baseUrl: opts.baseUrl ?? "http://semaphore:5058",
    healthCheck: vi.fn(),
    kmmHealthCheck: vi.fn(),
    listPublishSets: vi.fn(),
    listClasses: vi.fn(),
    listClsLanguages: vi.fn(),
    listKmmModels: vi.fn(),
    createKmmModel: vi.fn(),
    loadSkosContent: vi.fn(),
    sparqlQuery: vi.fn(),
    sparqlUpdate: vi.fn(),
    kmmPublish: vi.fn(),
    classify: vi.fn(),
    kmmPatchPublishConfigForPlainSkos: vi.fn(),
  };
}

function createMockClients(semaphoreOpts?: Parameters<typeof createMockSemaphore>[0]) {
  return { semaphore: createMockSemaphore(semaphoreOpts) };
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("registerSemaphoreTools – registration", () => {
  it("registers all semaphore tools", () => {
    const { server, tools } = createMockServer();
    registerSemaphoreTools(server as never, createMockClients() as never);

    const expectedTools = [
      "semaphore_status",
      "semaphore_studio_status",
      "semaphore_publish_sets",
      "semaphore_classes",
      "semaphore_cls_languages",
      "semaphore_kmm_models_list",
      "semaphore_kmm_model_create",
      "semaphore_kmm_skos_load",
      "semaphore_kmm_sparql",
      "semaphore_kmm_sparql_update",
      "semaphore_publish",
      "semaphore_publish_config_fix_plain_skos",
      "semaphore_classify",
    ];

    for (const name of expectedTools) {
      expect(tools.has(name), `Expected tool ${name} to be registered`).toBe(true);
    }
  });
});

// ── semaphore_status ──────────────────────────────────────────────────────────

describe("semaphore_status handler", () => {
  it("returns error when semaphore is not configured", async () => {
    const { server, tools } = createMockServer();
    registerSemaphoreTools(server as never, createMockClients({ configured: false }) as never);

    const result = await tools.get("semaphore_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not configured");
    expect(result.content[0].text).toContain("SEMAPHORE_URL");
  });

  it("returns error when health check fails", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    clients.semaphore.healthCheck.mockResolvedValue({ healthy: false });
    registerSemaphoreTools(server as never, clients as never);

    const result = await tools.get("semaphore_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not reachable");
  });

  it("returns healthy status with version", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    clients.semaphore.healthCheck.mockResolvedValue({ healthy: true, version: "5.10.1" });
    registerSemaphoreTools(server as never, clients as never);

    const result = await tools.get("semaphore_status")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("healthy");
    expect(result.content[0].text).toContain("5.10.1");
  });

  it("shows (unknown) when version is not available", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    clients.semaphore.healthCheck.mockResolvedValue({ healthy: true, version: null });
    registerSemaphoreTools(server as never, clients as never);

    const result = await tools.get("semaphore_status")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("(unknown)");
  });
});

// ── semaphore_studio_status ───────────────────────────────────────────────────

describe("semaphore_studio_status handler", () => {
  it("returns error when semaphore is not configured", async () => {
    const { server, tools } = createMockServer();
    registerSemaphoreTools(server as never, createMockClients({ configured: false }) as never);

    const result = await tools.get("semaphore_studio_status")!({});
    expect(result.isError).toBe(true);
  });

  it("returns error when kmmBaseUrl is null", async () => {
    const { server, tools } = createMockServer();
    registerSemaphoreTools(server as never, createMockClients({ kmmBaseUrl: null }) as never);

    const result = await tools.get("semaphore_studio_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("SEMAPHORE_HOST");
  });

  it("returns error when KMM health check fails", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    clients.semaphore.kmmHealthCheck.mockResolvedValue({ healthy: false, statusCode: 503 });
    registerSemaphoreTools(server as never, clients as never);

    const result = await tools.get("semaphore_studio_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not reachable");
  });

  it("returns healthy status when KMM is reachable", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    clients.semaphore.kmmHealthCheck.mockResolvedValue({ healthy: true, statusCode: 200 });
    registerSemaphoreTools(server as never, clients as never);

    const result = await tools.get("semaphore_studio_status")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("reachable");
  });
});

// ── semaphore_publish_sets ────────────────────────────────────────────────────

describe("semaphore_publish_sets handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSemaphoreTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns error when not configured", async () => {
    const mock = createMockServer();
    registerSemaphoreTools(mock.server as never, createMockClients({ configured: false }) as never);
    const result = await mock.tools.get("semaphore_publish_sets")!({});
    expect(result.isError).toBe(true);
  });

  it("returns message when no publish sets found", async () => {
    clients.semaphore.listPublishSets.mockResolvedValue([]);
    const result = await tools.get("semaphore_publish_sets")!({});
    expect(result.content[0].text).toContain("No publish sets found");
  });

  it("lists publish sets with active/inactive markers", async () => {
    clients.semaphore.listPublishSets.mockResolvedValue([
      { name: "iptcmediatopics", type: "classification", active: true },
      { name: "unescothesaurus", type: "classification", active: false },
    ]);
    const result = await tools.get("semaphore_publish_sets")!({});
    expect(result.content[0].text).toContain("iptcmediatopics");
    expect(result.content[0].text).toContain("ACTIVE");
    expect(result.content[0].text).toContain("inactive");
  });

  it("returns isError on API failure", async () => {
    clients.semaphore.listPublishSets.mockRejectedValue(new MarkLogicError("error", 500));
    const result = await tools.get("semaphore_publish_sets")!({});
    expect(result.isError).toBe(true);
  });
});

// ── semaphore_classes ─────────────────────────────────────────────────────────

describe("semaphore_classes handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSemaphoreTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns message when no classes found", async () => {
    clients.semaphore.listClasses.mockResolvedValue([]);
    const result = await tools.get("semaphore_classes")!({});
    expect(result.content[0].text).toContain("No classification classes found");
  });

  it("lists classes with rule counts", async () => {
    clients.semaphore.listClasses.mockResolvedValue([
      { name: "IPTCMediaTopics", ruleCount: 1500 },
      { name: "UNESCOThesaurus", ruleCount: 4408 },
    ]);
    const result = await tools.get("semaphore_classes")!({});
    expect(result.content[0].text).toContain("IPTCMediaTopics");
    expect(result.content[0].text).toContain("1500");
    expect(result.content[0].text).toContain("UNESCOThesaurus");
  });
});

// ── semaphore_cls_languages ───────────────────────────────────────────────────

describe("semaphore_cls_languages handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerSemaphoreTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("lists language packs with default marker", async () => {
    clients.semaphore.listClsLanguages.mockResolvedValue([
      { id: "en1", name: "English", default: true, hasRules: true },
      { id: "fr1", name: "French", default: false, hasRules: false },
    ]);
    const result = await tools.get("semaphore_cls_languages")!({});
    expect(result.content[0].text).toContain("en1");
    expect(result.content[0].text).toContain("DEFAULT");
    expect(result.content[0].text).toContain("fr1");
  });

  it("returns message when no languages installed", async () => {
    clients.semaphore.listClsLanguages.mockResolvedValue([]);
    const result = await tools.get("semaphore_cls_languages")!({});
    expect(result.content[0].text).toContain("No languages found");
  });
});

// ── semaphore_kmm_models_list ─────────────────────────────────────────────────

describe("semaphore_kmm_models_list handler", () => {
  it("returns error when kmmBaseUrl is null", async () => {
    const { server, tools } = createMockServer();
    registerSemaphoreTools(server as never, createMockClients({ kmmBaseUrl: null }) as never);
    const result = await tools.get("semaphore_kmm_models_list")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("KMM is not configured");
  });

  it("returns error when credentials are missing", async () => {
    const { server, tools } = createMockServer();
    registerSemaphoreTools(server as never, createMockClients({ kmmConfigured: false }) as never);
    const result = await tools.get("semaphore_kmm_models_list")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("credentials not configured");
  });

  it("lists models when available", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    clients.semaphore.listKmmModels.mockResolvedValue([
      { id: "urn:x-evn-master:IPTCMediaTopics" },
      { id: "urn:x-evn-master:UNESCOThesaurus" },
    ]);
    registerSemaphoreTools(server as never, clients as never);

    const result = await tools.get("semaphore_kmm_models_list")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("IPTCMediaTopics");
    expect(result.content[0].text).toContain("UNESCOThesaurus");
  });

  it("returns message when no models exist", async () => {
    const { server, tools } = createMockServer();
    const clients = createMockClients();
    clients.semaphore.listKmmModels.mockResolvedValue([]);
    registerSemaphoreTools(server as never, clients as never);

    const result = await tools.get("semaphore_kmm_models_list")!({});
    expect(result.content[0].text).toContain("No models found");
  });
});
