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
    kmmGetKidTemplate: vi.fn(),
    kmmSetKidTemplate: vi.fn(),
    getTdeInstalledForModel: vi.fn(),
    ...overrides,
  };
}

function createMockDocuments() {
  return {
    get: vi.fn(),
    list: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
    patchDocument: vi.fn(),
  };
}

function createMockClients(semaphoreOverrides?: Record<string, unknown>) {
  return {
    semaphore: createMockSemaphore(semaphoreOverrides),
    documents: createMockDocuments(),
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
      "semaphore_classify_batch",
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

// ─── semaphore_classify_batch ────────────────────────────────────────────────

describe("semaphore_classify_batch handler", () => {
  it("returns error when Semaphore is not configured", async () => {
    const { tools } = setup({ configured: false });
    const result = await tools.get("semaphore_classify_batch")!({ uris: ["/doc/a.json"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not configured");
  });

  it("returns error when neither uris nor collection is provided", async () => {
    const { tools } = setup();
    const result = await tools.get("semaphore_classify_batch")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("at least one of");
  });

  it("classifies each URI and returns per-document results", async () => {
    const { tools, clients } = setup();
    (clients.documents.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ content: "Document about football." })
      .mockResolvedValueOnce({ content: "Document about climate change." });
    (clients.semaphore.classify as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ categories: [{ className: "IPTC", label: "Sports", id: "u1", score: 0.9 }] })
      .mockResolvedValueOnce({ categories: [{ className: "IPTC", label: "Environment", id: "u2", score: 0.85 }] });

    const result = await tools.get("semaphore_classify_batch")!({
      uris: ["/doc/a.json", "/doc/b.json"],
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Documents classified: 2/2");
    expect(text).toContain("Total categories:     2");
    expect(text).toContain("/doc/a.json");
    expect(text).toContain("/doc/b.json");
  });

  it("lists collection documents then classifies each one", async () => {
    const { tools, clients } = setup();
    (clients.documents.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      uris: ["/col/x.json", "/col/y.json"],
    });
    (clients.documents.get as ReturnType<typeof vi.fn>).mockResolvedValue({ content: "some text" });
    (clients.semaphore.classify as ReturnType<typeof vi.fn>).mockResolvedValue({ categories: [] });

    await tools.get("semaphore_classify_batch")!({ collection: "my-col" });

    expect(clients.documents.list).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "my-col" })
    );
    expect(clients.semaphore.classify).toHaveBeenCalledTimes(2);
  });

  it("passes threshold and publish_sets through to the classifier", async () => {
    const { tools, clients } = setup();
    (clients.documents.get as ReturnType<typeof vi.fn>).mockResolvedValue({ content: "text" });
    (clients.semaphore.classify as ReturnType<typeof vi.fn>).mockResolvedValue({ categories: [] });

    await tools.get("semaphore_classify_batch")!({
      uris: ["/doc/a.json"],
      threshold: 60,
      publish_sets: ["iptcmediatopics", "unescothesaurus"],
    });

    expect(clients.semaphore.classify).toHaveBeenCalledWith(
      "text",
      60,
      undefined,
      ["iptcmediatopics", "unescothesaurus"]
    );
  });

  it("records document fetch errors without aborting the whole batch", async () => {
    const { tools, clients } = setup();
    (clients.documents.get as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("404 not found"))
      .mockResolvedValueOnce({ content: "good doc" });
    (clients.semaphore.classify as ReturnType<typeof vi.fn>).mockResolvedValue({
      categories: [{ className: "C", label: "L", id: "x", score: 0.5 }],
    });

    const result = await tools.get("semaphore_classify_batch")!({
      uris: ["/missing.json", "/good.json"],
    });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Documents classified: 1/2");
    expect(text).toContain("ERRORS:");
    expect(text).toContain("/missing.json");
  });

  it("returns 'no documents' when collection is empty", async () => {
    const { tools, clients } = setup();
    (clients.documents.list as ReturnType<typeof vi.fn>).mockResolvedValue({ uris: [] });

    const result = await tools.get("semaphore_classify_batch")!({ collection: "empty-col" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No documents found");
  });

  it("serialises object document content to string before classifying", async () => {
    const { tools, clients } = setup();
    const docContent = { title: "AI in healthcare", body: "Machine learning ..." };
    (clients.documents.get as ReturnType<typeof vi.fn>).mockResolvedValue({ content: docContent });
    (clients.semaphore.classify as ReturnType<typeof vi.fn>).mockResolvedValue({ categories: [] });

    await tools.get("semaphore_classify_batch")!({ uris: ["/doc/a.json"] });

    const calledWith = (clients.semaphore.classify as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof calledWith).toBe("string");
    expect(calledWith).toContain("AI in healthcare");
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

// ─── semaphore_kid_template_get ───────────────────────────────────────────────

describe("semaphore_kid_template_get handler", () => {
  it("returns error when kmmBaseUrl not set", async () => {
    const { tools } = setup({ kmmBaseUrl: null });
    const result = await tools.get("semaphore_kid_template_get")!({ model_uri: "model:Test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("KMM is not configured");
  });

  it("returns error when credentials not configured", async () => {
    const { tools } = setup({ kmmConfigured: false });
    const result = await tools.get("semaphore_kid_template_get")!({ model_uri: "model:Test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("KMM credentials");
  });

  it("returns a message when workspace has no template yet", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmGetKidTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await tools.get("semaphore_kid_template_get")!({
      model_uri: "model:Test",
      template_name: "ContextualCitation.kid",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("TEMPLATE NOT FOUND");
  });

  it("returns formatted template content on success", async () => {
    const { tools, clients } = setup();
    const fakeTemplate = "<rulebase language=\"en\"><content/></rulebase>";
    (clients.semaphore.kmmGetKidTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(fakeTemplate);
    const result = await tools.get("semaphore_kid_template_get")!({ model_uri: "model:Test" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain(fakeTemplate);
    expect(result.content[0].text).toContain("ContextualCitation.kid");
  });

  it("passes templateName to the client", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmGetKidTemplate as ReturnType<typeof vi.fn>).mockResolvedValue("<rulebase/>");
    await tools.get("semaphore_kid_template_get")!({ model_uri: "model:Test", template_name: "Custom.kid" });
    expect(clients.semaphore.kmmGetKidTemplate).toHaveBeenCalledWith("model:Test", "Custom.kid");
  });
});

// ─── semaphore_kid_template_set ───────────────────────────────────────────────

describe("semaphore_kid_template_set handler", () => {
  it("returns error when kmmBaseUrl not set", async () => {
    const { tools } = setup({ kmmBaseUrl: null });
    const result = await tools.get("semaphore_kid_template_set")!({ model_uri: "model:Test" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("KMM is not configured");
  });

  it("returns error when credentials not configured", async () => {
    const { tools } = setup({ kmmConfigured: false });
    const result = await tools.get("semaphore_kid_template_set")!({ model_uri: "model:Test" });
    expect(result.isError).toBe(true);
  });

  it("uploads raw content as-is when content param is provided", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmSetKidTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const raw = "<rulebase language=\"en\"><content/></rulebase>";
    const result = await tools.get("semaphore_kid_template_set")!({ model_uri: "model:Test", content: raw });
    expect(result.isError).toBeUndefined();
    expect(clients.semaphore.kmmSetKidTemplate).toHaveBeenCalledWith("model:Test", raw, expect.any(Object));
    expect(result.content[0].text).toContain("raw XML content");
  });

  it("generates a template from default weights when no preset or weights given", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmSetKidTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const result = await tools.get("semaphore_kid_template_set")!({ model_uri: "model:Test" });
    expect(result.isError).toBeUndefined();
    const uploadedContent: string = (clients.semaphore.kmmSetKidTemplate as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(uploadedContent).toContain("weight=\"20\""); // default phraselist
    expect(uploadedContent).toContain("weight=\"50\""); // default nearlist
  });

  it("applies named preset weights correctly", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmSetKidTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const result = await tools.get("semaphore_kid_template_set")!({ model_uri: "model:Test", preset: "exact_only" });
    expect(result.isError).toBeUndefined();
    const uploadedContent: string = (clients.semaphore.kmmSetKidTemplate as ReturnType<typeof vi.fn>).mock.calls[0][1];
    // exact_only: phrase=100, near=0, hierarchy=0, assoc=0
    expect(uploadedContent).toContain("weight=\"100\""); // phraselist
    expect(uploadedContent).not.toContain("<nearlist"); // nearlist omitted when weight=0
    expect(result.content[0].text).toContain("exact_only");
  });

  it("overrides preset weight with explicit param", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmSetKidTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await tools.get("semaphore_kid_template_set")!({
      model_uri: "model:Test",
      preset: "balanced",
      phraselist_weight: 40,
    });
    const uploadedContent: string = (clients.semaphore.kmmSetKidTemplate as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(uploadedContent).toContain("weight=\"40\""); // overridden phraselist
    expect(uploadedContent).toContain("weight=\"50\""); // balanced nearlist unchanged
  });

  it("generates zone-biased template when title_weight and body_weight provided", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmSetKidTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const result = await tools.get("semaphore_kid_template_set")!({
      model_uri: "model:Test",
      title_weight: 80,
      body_weight: 20,
    });
    expect(result.isError).toBeUndefined();
    const uploadedContent: string = (clients.semaphore.kmmSetKidTemplate as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(uploadedContent).toContain("pos=\"1\""); // title zone
    expect(uploadedContent).toContain("pos=\"0\""); // body zone
    expect(uploadedContent).toContain("zone-biased");
    expect(result.content[0].text).toContain("title=80");
  });

  it("sets isError on upload failure", async () => {
    const { tools, clients } = setup();
    (clients.semaphore.kmmSetKidTemplate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("zip error"));
    const result = await tools.get("semaphore_kid_template_set")!({ model_uri: "model:Test" });
    expect(result.isError).toBe(true);
  });
});
