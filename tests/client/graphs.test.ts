import { describe, it, expect, vi, beforeEach } from "vitest";
import { GraphsClient } from "../../src/client/graphs.js";

function createMockBase() {
  const http = {
    post: vi.fn(),
    request: vi.fn(),
    delete: vi.fn(),
  };
  return { http };
}

// ── sparqlQuery ───────────────────────────────────────────────────────────────

describe("GraphsClient.sparqlQuery", () => {
  let base: ReturnType<typeof createMockBase>;
  let client: GraphsClient;

  beforeEach(() => {
    base = createMockBase();
    client = new GraphsClient(base as never);
  });

  it("posts a SELECT query with JSON accept header", async () => {
    const mockResult = {
      head: { vars: ["s", "p", "o"] },
      results: { bindings: [] },
    };
    base.http.post.mockResolvedValue({ data: mockResult });

    const result = await client.sparqlQuery("SELECT * WHERE { ?s ?p ?o }");

    const [, , opts] = base.http.post.mock.calls[0];
    expect(opts.headers["Accept"]).toBe("application/sparql-results+json");
    expect(opts.headers["Content-Type"]).toBe("application/sparql-query");
    expect(result).toEqual(mockResult);
  });

  it("uses text/turtle accept header for CONSTRUCT queries", async () => {
    base.http.post.mockResolvedValue({ data: "@prefix ex: <http://example.org/> ." });

    await client.sparqlQuery("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }");

    const [, , opts] = base.http.post.mock.calls[0];
    expect(opts.headers["Accept"]).toBe("text/turtle");
    expect(opts.responseType).toBe("text");
  });

  it("uses text/turtle accept header for DESCRIBE queries", async () => {
    base.http.post.mockResolvedValue({ data: "" });

    await client.sparqlQuery("DESCRIBE <http://example.org/resource>");

    const [, , opts] = base.http.post.mock.calls[0];
    expect(opts.headers["Accept"]).toBe("text/turtle");
  });

  it("uses JSON accept for ASK queries", async () => {
    base.http.post.mockResolvedValue({ data: { head: {}, boolean: true } });

    await client.sparqlQuery("ASK { <s> <p> <o> }");

    const [, , opts] = base.http.post.mock.calls[0];
    expect(opts.headers["Accept"]).toBe("application/sparql-results+json");
  });

  it("strips PREFIX declarations when detecting query type", async () => {
    base.http.post.mockResolvedValue({ data: "" });

    await client.sparqlQuery(
      "PREFIX ex: <http://example.org/>\nCONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }"
    );

    const [, , opts] = base.http.post.mock.calls[0];
    expect(opts.headers["Accept"]).toBe("text/turtle");
  });

  it("strips line comments when detecting query type", async () => {
    base.http.post.mockResolvedValue({ data: { head: { vars: [] }, results: { bindings: [] } } });

    await client.sparqlQuery("# This is a SELECT query\nSELECT * WHERE { }");

    const [, , opts] = base.http.post.mock.calls[0];
    expect(opts.headers["Accept"]).toBe("application/sparql-results+json");
  });

  it("passes default-graph-uri param when provided", async () => {
    base.http.post.mockResolvedValue({ data: { head: { vars: [] }, results: { bindings: [] } } });

    await client.sparqlQuery("SELECT * WHERE { }", { defaultGraph: "http://example.org/graph" });

    const [, , opts] = base.http.post.mock.calls[0];
    expect(opts.params["default-graph-uri"]).toBe("http://example.org/graph");
  });
});

// ── putGraph ──────────────────────────────────────────────────────────────────

describe("GraphsClient.putGraph", () => {
  it("uses PUT method by default", async () => {
    const base = createMockBase();
    const client = new GraphsClient(base as never);
    base.http.request.mockResolvedValue({ status: 201 });

    const result = await client.putGraph(
      "http://example.org/g",
      "@prefix ex: <http://example.org/> .",
      "text/turtle"
    );

    const [opts] = base.http.request.mock.calls[0];
    expect(opts.method).toBe("put");
    expect(result.created).toBe(true);
    expect(result.graph).toBe("http://example.org/g");
  });

  it("uses PATCH method when merge=true", async () => {
    const base = createMockBase();
    const client = new GraphsClient(base as never);
    base.http.request.mockResolvedValue({ status: 200 });

    const result = await client.putGraph("http://example.org/g", "", "text/turtle", { merge: true });

    const [opts] = base.http.request.mock.calls[0];
    expect(opts.method).toBe("patch");
    expect(result.created).toBe(false);
  });

  it("returns created=false for 200 response", async () => {
    const base = createMockBase();
    const client = new GraphsClient(base as never);
    base.http.request.mockResolvedValue({ status: 200 });

    const result = await client.putGraph("http://g", "", "text/turtle");
    expect(result.created).toBe(false);
  });
});

// ── listGraphs ────────────────────────────────────────────────────────────────

describe("GraphsClient.listGraphs", () => {
  it("paginates graphs in memory", async () => {
    const base = createMockBase();
    const client = new GraphsClient(base as never);
    // sparqlQuery returns SELECT bindings for 5 graphs
    base.http.post.mockResolvedValue({
      data: {
        head: { vars: ["g"] },
        results: {
          bindings: [
            { g: { type: "uri", value: "http://g1" } },
            { g: { type: "uri", value: "http://g2" } },
            { g: { type: "uri", value: "http://g3" } },
            { g: { type: "uri", value: "http://g4" } },
            { g: { type: "uri", value: "http://g5" } },
          ],
        },
      },
    });

    const page1 = await client.listGraphs({ start: 1, pageLength: 2 });
    expect(page1.graphs).toEqual(["http://g1", "http://g2"]);
    expect(page1.total).toBe(5);
  });

  it("returns all graphs when no pagination params", async () => {
    const base = createMockBase();
    const client = new GraphsClient(base as never);
    base.http.post.mockResolvedValue({
      data: {
        head: { vars: ["g"] },
        results: {
          bindings: [
            { g: { type: "uri", value: "http://g1" } },
            { g: { type: "uri", value: "http://g2" } },
          ],
        },
      },
    });

    const result = await client.listGraphs();
    expect(result.graphs).toHaveLength(2);
    expect(result.total).toBe(2);
  });
});
