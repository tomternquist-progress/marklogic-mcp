import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerSemaphoreTools } from "../../src/tools/semaphore.js";

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

function createMockSemaphore(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    baseUrl: "http://semaphore:5058",
    kmmBaseUrl: "http://semaphore:5080",
    kmmConfigured: true,
    scsHost: "semaphore",
    scsPort: 5058,
    healthCheck: vi.fn(),
    kmmHealthCheck: vi.fn(),
    listPublishSets: vi.fn(),
    listClasses: vi.fn(),
    listClsLanguages: vi.fn(),
    classify: vi.fn(),
    listKmmModels: vi.fn(),
    createKmmModel: vi.fn(),
    kmmImportSkos: vi.fn(),
    kmmWaitForAsyncJob: vi.fn(),
    kmmSparqlQuery: vi.fn(),
    kmmSparqlUpdate: vi.fn(),
    kmmPublish: vi.fn(),
    kmmGetPublishSets: vi.fn(),
    kmmPatchPublishConfigForPlainSkos: vi.fn(),
    getTdeInstalledForModel: vi.fn(),
    ...overrides,
  };
}

function createMockClients(semaphoreOverrides?: Record<string, unknown>) {
  return {
    semaphore: createMockSemaphore(semaphoreOverrides),
  };
}

function setup(semaphoreOverrides?: Record<string, unknown>) {
  const { server, tools } = createMockServer();
  const clients = createMockClients(semaphoreOverrides);
  registerSemaphoreTools(server as never, clients as never);
  return { tools, clients };
}

// ─── Tool registration ─────────────────────────────────────────────────────────

describe("registerSemaphoreTools – registration", () => {
  it("registers the expected semaphore tools", () => {
    const { tools } = setup();
    const expectedTools = [
      "semaphore_status",
      "semaphore_studio_status",
      "semaphore_publish_sets",
      "semaphore_classes",
      "semaphore_cls_languages",
      "semaphore_classify",
      "semaphore_kmm_models_list",
      "semaphore_kmm_model_create",
      "semaphore_kmm_skos_load",
      "semaphore_kmm_sparql",
      "semaphore_kmm_sparql_update",
    ];
    for (const name of expectedTools) {
      expect(tools.has(name), `expected tool ${name} to be registered`).toBe(true);
    }
  });
});

// ─── semaphore_status ────────────────────────────────────────────────────────

describe("semaphore_status handler", () => {
  it("returns error when Semaphore is not configured", async () => {
    const { tools } = setup({ configured: false });
    const result = await tools.get("semaphore_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not configured");
  });

  it("returns error when health check fails", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ healthy: false });
    const result = await tools.get("semaphore_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not reachable");
  });

  it("returns healthy status with version on success", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ healthy: true, version: "6.5.0" });
    const result = await tools.get("semaphore_status")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("healthy");
    expect(result.content[0].text).toContain("6.5.0");
  });

  it("shows (unknown) when version is not returned", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ healthy: true, version: null });
    const result = await tools.get("semaphore_status")!({});
    expect(result.content[0].text).toContain("(unknown)");
  });
});

// ─── semaphore_studio_status ─────────────────────────────────────────────────

describe("semaphore_studio_status handler", () => {
  it("returns error when Semaphore is not configured", async () => {
    const { tools } = setup({ configured: false });
    const result = await tools.get("semaphore_studio_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not configured");
  });

  it("returns error when kmmBaseUrl is not set", async () => {
    const { tools } = setup({ kmmBaseUrl: null });
    const result = await tools.get("semaphore_studio_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("SEMAPHORE_HOST");
  });

  it("returns error when KMM health check fails", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmHealthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ healthy: false, statusCode: 503 });
    const result = await tools.get("semaphore_studio_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not reachable");
  });

  it("returns reachable status with credential note when healthy and http 200", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmHealthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ healthy: true, statusCode: 200 });
    const result = await tools.get("semaphore_studio_status")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("reachable");
    expect(result.content[0].text).toContain("200");
  });

  it("notes missing credentials when kmmConfigured=false", async () => {
    const { tools, clients } = setup({ kmmConfigured: false });
    (clients.semaphore.kmmHealthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({ healthy: true, statusCode: 401 });
    const result = await tools.get("semaphore_studio_status")!({});
    expect(result.content[0].text).toContain("No credentials configured");
  });
});

// ─── semaphore_publish_sets ──────────────────────────────────────────────────

describe("semaphore_publish_sets handler", () => {
  it("returns error when not configured", async () => {
    const { tools } = setup({ configured: false });
    const result = await tools.get("semaphore_publish_sets")!({});
    expect(result.isError).toBe(true);
  });

  it("returns friendly message when no publish sets exist", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.listPublishSets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const result = await tools.get("semaphore_publish_sets")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No publish sets");
  });

  it("lists publish sets with active status and type", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.listPublishSets as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "IPTCMediaTopics", active: true, type: "RuleSet" },
      { name: "UNESCO", active: false, type: "RuleSet" },
    ]);
    const result = await tools.get("semaphore_publish_sets")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("IPTCMediaTopics");
    expect(result.content[0].text).toContain("ACTIVE");
    expect(result.content[0].text).toContain("UNESCO");
    expect(result.content[0].text).toContain("inactive");
  });

  it("sets isError on failure", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.listPublishSets as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection refused"));
    const result = await tools.get("semaphore_publish_sets")!({});
    expect(result.isError).toBe(true);
  });
});

// ─── semaphore_classes ───────────────────────────────────────────────────────

describe("semaphore_classes handler", () => {
  it("returns error when not configured", async () => {
    const { tools } = setup({ configured: false });
    const result = await tools.get("semaphore_classes")!({});
    expect(result.isError).toBe(true);
  });

  it("returns friendly message when no classes exist", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.listClasses as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const result = await tools.get("semaphore_classes")!({});
    expect(result.content[0].text).toContain("No classification classes");
  });

  it("lists classes with rule counts", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.listClasses as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "IPTCMediaTopics", ruleCount: 1427 },
      { name: "UNESCOThesaurus", ruleCount: 4023 },
    ]);
    const result = await tools.get("semaphore_classes")!({});
    expect(result.content[0].text).toContain("IPTCMediaTopics");
    expect(result.content[0].text).toContain("1427");
    expect(result.content[0].text).toContain("UNESCOThesaurus");
  });
});

// ─── semaphore_cls_languages ─────────────────────────────────────────────────

describe("semaphore_cls_languages handler", () => {
  it("returns error when not configured", async () => {
    const { tools } = setup({ configured: false });
    const result = await tools.get("semaphore_cls_languages")!({});
    expect(result.isError).toBe(true);
  });

  it("returns friendly message when no languages found", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.listClsLanguages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const result = await tools.get("semaphore_cls_languages")!({});
    expect(result.content[0].text).toContain("No languages found");
  });

  it("lists languages with default flag and rule status", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.listClsLanguages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "en1", name: "English", default: true, hasRules: true },
      { id: "fr1", name: "French", default: false, hasRules: false },
    ]);
    const result = await tools.get("semaphore_cls_languages")!({});
    expect(result.content[0].text).toContain("en1");
    expect(result.content[0].text).toContain("DEFAULT");
    expect(result.content[0].text).toContain("fr1");
    expect(result.content[0].text).toContain("[no rules]");
  });
});

// ─── semaphore_classify ──────────────────────────────────────────────────────

describe("semaphore_classify handler", () => {
  it("returns error when not configured", async () => {
    const { tools } = setup({ configured: false });
    const result = await tools.get("semaphore_classify")!({ content: "test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not configured");
  });

  it("returns no-categories message when result is empty", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.classify as ReturnType<typeof vi.fn>).mockResolvedValue({ categories: [] });
    const result = await tools.get("semaphore_classify")!({ content: "hello world", threshold: 50 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No categories returned");
  });

  it("returns formatted categories grouped by class", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.classify as ReturnType<typeof vi.fn>).mockResolvedValue({
      categories: [
        { className: "IPTCMediaTopics", label: "Sports", id: "uuid-1", score: 0.92 },
        { className: "IPTCMediaTopics", label: "Football", id: "uuid-2", score: 0.75 },
        { className: "UNESCOThesaurus", label: "Physical education", id: "uuid-3", score: 0.60 },
      ],
    });
    const result = await tools.get("semaphore_classify")!({ content: "The football match was exciting." });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("IPTCMediaTopics");
    expect(text).toContain("Sports");
    expect(text).toContain("0.9");
    expect(text).toContain("UNESCOThesaurus");
  });

  it("passes content and threshold to the client", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.classify as ReturnType<typeof vi.fn>).mockResolvedValue({ categories: [] });
    await tools.get("semaphore_classify")!({ content: "text to classify", threshold: 70 });
    expect(clients.semaphore.classify).toHaveBeenCalledWith("text to classify", 70, undefined, undefined);
  });

  it("passes publish_set and publish_sets to the client", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.classify as ReturnType<typeof vi.fn>).mockResolvedValue({ categories: [] });
    await tools.get("semaphore_classify")!({
      content: "sample",
      threshold: 0,
      publish_set: "iptcmediatopics",
      publish_sets: ["iptcmediatopics", "unescothesaurus"],
    });
    expect(clients.semaphore.classify).toHaveBeenCalledWith(
      "sample",
      0,
      "iptcmediatopics",
      ["iptcmediatopics", "unescothesaurus"]
    );
  });

  it("sets isError on classify failure", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.classify as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("CLS unreachable"));
    const result = await tools.get("semaphore_classify")!({ content: "test" });
    expect(result.isError).toBe(true);
  });
});

// ─── semaphore_kmm_models_list ───────────────────────────────────────────────

describe("semaphore_kmm_models_list handler", () => {
  it("returns error when kmmBaseUrl not set", async () => {
    const { tools } = setup({ kmmBaseUrl: null });
    const result = await tools.get("semaphore_kmm_models_list")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not configured");
  });

  it("returns error when credentials not set", async () => {
    const { tools } = setup({ kmmConfigured: false });
    const result = await tools.get("semaphore_kmm_models_list")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("credentials not configured");
  });

  it("returns friendly message when no models exist", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.listKmmModels as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const result = await tools.get("semaphore_kmm_models_list")!({});
    expect(result.content[0].text).toContain("No models found");
  });

  it("lists model IDs", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.listKmmModels as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "urn:x-evn-master:IPTCMediaTopics" },
      { id: "urn:x-evn-master:UNESCOThesaurus" },
    ]);
    const result = await tools.get("semaphore_kmm_models_list")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("IPTCMediaTopics");
    expect(result.content[0].text).toContain("UNESCOThesaurus");
    expect(result.content[0].text).toContain("2 model(s)");
  });
});

// ─── semaphore_kmm_model_create ──────────────────────────────────────────────

describe("semaphore_kmm_model_create handler", () => {
  it("returns error when kmmBaseUrl not set", async () => {
    const { tools } = setup({ kmmBaseUrl: null });
    const result = await tools.get("semaphore_kmm_model_create")!({
      name: "MyModel",
      default_namespace: "http://example.org/",
    });
    expect(result.isError).toBe(true);
  });

  it("returns error when credentials not set", async () => {
    const { tools } = setup({ kmmConfigured: false });
    const result = await tools.get("semaphore_kmm_model_create")!({
      name: "MyModel",
      default_namespace: "http://example.org/",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("credentials not configured");
  });

  it("returns model creation result with ConceptScheme URI guidance", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.createKmmModel as ReturnType<typeof vi.fn>).mockResolvedValue("model:MyModel");

    const result = await tools.get("semaphore_kmm_model_create")!({
      name: "MyModel",
      default_namespace: "http://example.org/ontology/",
      description: "A test model",
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("MyModel");
    expect(text).toContain("model:MyModel");
    expect(text).toContain("MyModelTaxonomy");
    expect(text).toContain("NEXT STEPS");
  });

  it("calls createKmmModel with name, namespace, and description", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.createKmmModel as ReturnType<typeof vi.fn>).mockResolvedValue("model:X");

    await tools.get("semaphore_kmm_model_create")!({
      name: "TestTaxonomy",
      default_namespace: "http://test.org/ns/",
      description: "My description",
    });

    expect(clients.semaphore.createKmmModel).toHaveBeenCalledWith(
      "TestTaxonomy",
      "http://test.org/ns/",
      "My description"
    );
  });
});

// ─── semaphore_kmm_sparql ─────────────────────────────────────────────────────

describe("semaphore_kmm_sparql handler", () => {
  it("returns error when KMM not configured", async () => {
    const { tools } = setup({ kmmBaseUrl: null });
    const result = await tools.get("semaphore_kmm_sparql")!({
      model_uri: "model:Test",
      query: "SELECT * WHERE { ?s ?p ?o }",
    });
    expect(result.isError).toBe(true);
  });

  it("returns 0-results message when rows are empty", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmSparqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await tools.get("semaphore_kmm_sparql")!({
      model_uri: "model:Test",
      query: "SELECT ?s WHERE { ?s a skos:Concept }",
    });
    expect(result.content[0].text).toContain("0 results");
  });

  it("returns formatted table for query results", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmSparqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({
      rows: [
        { s: "http://example.org/Concept1", label: "Concept One" },
        { s: "http://example.org/Concept2", label: "Concept Two" },
      ],
    });

    const result = await tools.get("semaphore_kmm_sparql")!({
      model_uri: "model:Test",
      query: "SELECT ?s ?label WHERE { ?s skos:prefLabel ?label }",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Concept One");
    expect(result.content[0].text).toContain("Rows: 2");
  });

  it("sets isError on failure", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmSparqlQuery as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("SPARQL error"));
    const result = await tools.get("semaphore_kmm_sparql")!({
      model_uri: "model:Test",
      query: "BAD QUERY",
    });
    expect(result.isError).toBe(true);
  });
});

// ─── semaphore_kmm_skos_load ─────────────────────────────────────────────────

describe("semaphore_kmm_skos_load handler", () => {
  it("returns error when neither skos_url nor skos_content is provided", async () => {
    const { tools } = setup();
    const result = await tools.get("semaphore_kmm_skos_load")!({ model_uri: "model:Test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("skos_url or skos_content must be provided");
  });

  it("returns error when both skos_url and skos_content are provided", async () => {
    const { tools } = setup();
    const result = await tools.get("semaphore_kmm_skos_load")!({
      model_uri: "model:Test",
      skos_url: "https://example.org/vocab.ttl",
      skos_content: "@prefix skos: ...",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not both");
  });

  it("returns COMPLETE status on successful import", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmImportSkos as ReturnType<typeof vi.fn>).mockResolvedValue("job-123");
    (clients.semaphore.kmmWaitForAsyncJob as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "COMPLETE" });
    (clients.semaphore.kmmSparqlQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });

    const result = await tools.get("semaphore_kmm_skos_load")!({
      model_uri: "model:IPTCMediaTopics",
      skos_url: "https://cv.iptc.org/newscodes/mediatopic/?lang=x-all&format=rdfxml",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("COMPLETE");
    expect(result.content[0].text).toContain("NEXT STEPS");
  });

  it("returns isError on FAILED import", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmImportSkos as ReturnType<typeof vi.fn>).mockResolvedValue("job-456");
    (clients.semaphore.kmmWaitForAsyncJob as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "FAILED",
      error: "Import validation failed",
    });

    const result = await tools.get("semaphore_kmm_skos_load")!({
      model_uri: "model:Test",
      skos_content: "@prefix skos: <http://www.w3.org/2004/02/skos/core#> .",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("FAILED");
  });
});
