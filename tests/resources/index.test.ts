import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerAllResources } from "../../src/resources/index.js";

type ResourceHandler = () => Promise<{
  contents: Array<{ uri: string; text: string; mimeType?: string }>;
}>;

function createMockServer() {
  const resources = new Map<string, ResourceHandler>();
  const server = {
    resource: vi.fn((_name: string, _uri: string, _meta: unknown, handler: ResourceHandler) => {
      resources.set(_name, handler);
    }),
  };
  return { server, resources };
}

function createMockClients() {
  return {
    admin: {
      listDatabases: vi.fn(),
      getClusterStatus: vi.fn(),
      listForests: vi.fn(),
    },
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("registerAllResources – registration", () => {
  it("registers all expected resources", () => {
    const { server, resources } = createMockServer();
    registerAllResources(server as never, createMockClients() as never);

    expect(resources.has("marklogic_databases")).toBe(true);
    expect(resources.has("marklogic_cluster_status")).toBe(true);
    expect(resources.has("marklogic_document_info")).toBe(true);
    expect(resources.has("marklogic_instructions")).toBe(true);
    expect(resources.has("marklogic_forests")).toBe(true);
    expect(resources.size).toBe(5);
  });
});

// ── marklogic_instructions ────────────────────────────────────────────────────

describe("marklogic_instructions resource", () => {
  let resources: Map<string, ResourceHandler>;

  beforeEach(() => {
    const mock = createMockServer();
    registerAllResources(mock.server as never, createMockClients() as never);
    resources = mock.resources;
  });

  it("returns non-empty text content", async () => {
    const result = await resources.get("marklogic_instructions")!();
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].text.length).toBeGreaterThan(100);
  });

  it("has correct URI marklogic://instructions", async () => {
    const result = await resources.get("marklogic_instructions")!();
    expect(result.contents[0].uri).toBe("marklogic://instructions");
  });

  it("content mentions DECISION PRINCIPLES", async () => {
    const result = await resources.get("marklogic_instructions")!();
    expect(result.contents[0].text).toContain("DECISION PRINCIPLES");
  });

  it("content includes TOOL GROUPS AT A GLANCE section", async () => {
    const result = await resources.get("marklogic_instructions")!();
    expect(result.contents[0].text).toContain("TOOL GROUPS AT A GLANCE");
  });

  it("content includes PROBLEM → MARKLOGIC-NATIVE SOLUTION TABLE", async () => {
    const result = await resources.get("marklogic_instructions")!();
    expect(result.contents[0].text).toContain("PROBLEM → MARKLOGIC-NATIVE SOLUTION TABLE");
  });

  it("content mentions flux_import in tool groups", async () => {
    const result = await resources.get("marklogic_instructions")!();
    expect(result.contents[0].text).toContain("flux_import");
  });

  it("content mentions semaphore_classify in tool groups", async () => {
    const result = await resources.get("marklogic_instructions")!();
    expect(result.contents[0].text).toContain("semaphore_classify");
  });

  it("content mentions ml_optic_query in tool groups", async () => {
    const result = await resources.get("marklogic_instructions")!();
    expect(result.contents[0].text).toContain("ml_optic_query");
  });

  it("content mentions ml_sparql_query in tool groups", async () => {
    const result = await resources.get("marklogic_instructions")!();
    expect(result.contents[0].text).toContain("ml_sparql_query");
  });

  it("content mentions problem_advisor prompt", async () => {
    const result = await resources.get("marklogic_instructions")!();
    expect(result.contents[0].text).toContain("problem_advisor");
  });
});

// ── marklogic_document_info ───────────────────────────────────────────────────

describe("marklogic_document_info resource", () => {
  it("returns static guidance text without making API calls", async () => {
    const { server, resources } = createMockServer();
    const clients = createMockClients();
    registerAllResources(server as never, clients as never);

    const result = await resources.get("marklogic_document_info")!();

    expect(result.contents[0].text).toContain("ml_document_get");
    expect(clients.admin.listDatabases).not.toHaveBeenCalled();
  });
});

// ── marklogic_databases ───────────────────────────────────────────────────────

describe("marklogic_databases resource", () => {
  it("returns JSON list of databases", async () => {
    const { server, resources } = createMockServer();
    const clients = createMockClients();
    clients.admin.listDatabases.mockResolvedValue([
      { name: "Documents", id: "1" },
      { name: "Schemas", id: "2" },
    ]);
    registerAllResources(server as never, clients as never);

    const result = await resources.get("marklogic_databases")!();

    expect(result.contents[0].mimeType).toBe("application/json");
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("Documents");
  });

  it("returns error text when listDatabases fails", async () => {
    const { server, resources } = createMockServer();
    const clients = createMockClients();
    clients.admin.listDatabases.mockRejectedValue(new Error("Connection refused"));
    registerAllResources(server as never, clients as never);

    const result = await resources.get("marklogic_databases")!();

    // Should not throw; returns error text instead
    expect(result.contents[0].text).toBeTruthy();
  });
});

// ── marklogic_cluster_status ──────────────────────────────────────────────────

describe("marklogic_cluster_status resource", () => {
  it("returns cluster status JSON", async () => {
    const { server, resources } = createMockServer();
    const clients = createMockClients();
    clients.admin.getClusterStatus.mockResolvedValue({
      "local-host": "ml-host",
      version: "12.0",
      "cluster-id": "cl1",
    });
    registerAllResources(server as never, clients as never);

    const result = await resources.get("marklogic_cluster_status")!();

    expect(result.contents[0].mimeType).toBe("application/json");
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.version).toBe("12.0");
  });

  it("returns error text when getClusterStatus fails", async () => {
    const { server, resources } = createMockServer();
    const clients = createMockClients();
    clients.admin.getClusterStatus.mockRejectedValue(new Error("Network error"));
    registerAllResources(server as never, clients as never);

    const result = await resources.get("marklogic_cluster_status")!();

    expect(result.contents[0].text).toBeTruthy();
  });
});
