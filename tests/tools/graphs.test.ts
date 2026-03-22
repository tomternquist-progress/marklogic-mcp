import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerGraphTools } from "../../src/tools/graphs.js";
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
    graphs: {
      sparqlQuery: vi.fn(),
      listGraphs: vi.fn(),
      putGraph: vi.fn(),
      deleteGraph: vi.fn(),
    },
  };
}

// ─── Tool registration ─────────────────────────────────────────────────────

describe("registerGraphTools – tool registration", () => {
  it("registers 3 tools in readonly mode (no ml_graph_delete)", () => {
    const { server, tools } = createMockServer();
    registerGraphTools(server as never, createMockClients() as never, true);

    expect(tools.has("ml_sparql_query")).toBe(true);
    expect(tools.has("ml_graphs_list")).toBe(true);
    expect(tools.has("ml_graph_put")).toBe(true);
    expect(tools.has("ml_graph_delete")).toBe(false);
    expect(tools.size).toBe(3);
  });

  it("registers all 4 tools in read-write mode", () => {
    const { server, tools } = createMockServer();
    registerGraphTools(server as never, createMockClients() as never, false);

    expect(tools.has("ml_sparql_query")).toBe(true);
    expect(tools.has("ml_graphs_list")).toBe(true);
    expect(tools.has("ml_graph_put")).toBe(true);
    expect(tools.has("ml_graph_delete")).toBe(true);
    expect(tools.size).toBe(4);
  });
});

// ─── ml_sparql_query ────────────────────────────────────────────────────────

describe("ml_sparql_query handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerGraphTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns JSON for SELECT/ASK results", async () => {
    const sparqlResult = { head: { vars: ["s"] }, results: { bindings: [] } };
    clients.graphs.sparqlQuery.mockResolvedValue(sparqlResult);

    const result = await tools.get("ml_sparql_query")!({
      sparql: "SELECT ?s WHERE { ?s ?p ?o } LIMIT 10",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(sparqlResult);
  });

  it("returns raw text for CONSTRUCT/DESCRIBE results (Turtle)", async () => {
    const turtle = "<http://ex.org/s> <http://ex.org/p> <http://ex.org/o> .";
    clients.graphs.sparqlQuery.mockResolvedValue(turtle);

    const result = await tools.get("ml_sparql_query")!({
      sparql: "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 1",
    });

    expect(result.content[0].text).toBe(turtle);
  });

  it("passes all parameters to client", async () => {
    clients.graphs.sparqlQuery.mockResolvedValue({});
    await tools.get("ml_sparql_query")!({
      sparql: "ASK { ?s ?p ?o }",
      default_graph: "http://example.org/graph",
      base: "http://example.org/",
      database: "TestDB",
    });

    expect(clients.graphs.sparqlQuery).toHaveBeenCalledWith("ASK { ?s ?p ?o }", {
      defaultGraph: "http://example.org/graph",
      database: "TestDB",
      base: "http://example.org/",
    });
  });

  it("sets isError on failure", async () => {
    clients.graphs.sparqlQuery.mockRejectedValue(new MarkLogicError("parse error", 400));
    const result = await tools.get("ml_sparql_query")!({ sparql: "INVALID" });

    expect(result.isError).toBe(true);
  });
});

// ─── ml_graphs_list ─────────────────────────────────────────────────────────

describe("ml_graphs_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerGraphTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns graph list", async () => {
    const graphs = ["http://example.org/graph1", "http://example.org/graph2"];
    clients.graphs.listGraphs.mockResolvedValue(graphs);

    const result = await tools.get("ml_graphs_list")!({});

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(graphs);
  });

  it("passes pagination parameters", async () => {
    clients.graphs.listGraphs.mockResolvedValue([]);
    await tools.get("ml_graphs_list")!({
      start: 5,
      page_length: 50,
      database: "MyDB",
    });

    expect(clients.graphs.listGraphs).toHaveBeenCalledWith({
      start: 5,
      pageLength: 50,
      database: "MyDB",
    });
  });
});

// ─── ml_graph_put ───────────────────────────────────────────────────────────

describe("ml_graph_put handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockClients();
    registerGraphTools(mock.server as never, clients as never);
    tools = mock.tools;
  });

  it("returns created message on new graph", async () => {
    clients.graphs.putGraph.mockResolvedValue({
      graph: "http://example.org/mygraph",
      created: true,
    });

    const result = await tools.get("ml_graph_put")!({
      graph_uri: "http://example.org/mygraph",
      content: "@prefix : <http://ex.org/> . :a :b :c .",
      content_type: "text/turtle",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("created");
    expect(result.content[0].text).toContain("http://example.org/mygraph");
  });

  it("returns replaced message on existing graph", async () => {
    clients.graphs.putGraph.mockResolvedValue({
      graph: "http://example.org/mygraph",
      created: false,
    });

    const result = await tools.get("ml_graph_put")!({
      graph_uri: "http://example.org/mygraph",
      content: "data",
      content_type: "application/n-triples",
    });

    expect(result.content[0].text).toContain("replaced");
  });

  it("returns merged message when merge=true", async () => {
    clients.graphs.putGraph.mockResolvedValue({
      graph: "http://example.org/mygraph",
      created: false,
    });

    const result = await tools.get("ml_graph_put")!({
      graph_uri: "http://example.org/mygraph",
      content: "data",
      content_type: "text/turtle",
      merge: true,
    });

    expect(result.content[0].text).toContain("merged into");
  });

  it("sets isError on failure", async () => {
    clients.graphs.putGraph.mockRejectedValue(new MarkLogicError("invalid turtle", 400));

    const result = await tools.get("ml_graph_put")!({
      graph_uri: "http://example.org/mygraph",
      content: "bad turtle",
      content_type: "text/turtle",
    });

    expect(result.isError).toBe(true);
  });
});
