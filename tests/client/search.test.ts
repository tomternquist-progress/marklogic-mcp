import { describe, it, expect, vi, beforeEach } from "vitest";
import { SearchClient } from "../../src/client/search.js";

function createMockBase() {
  return {
    http: {},
    get: vi.fn(),
    post: vi.fn(),
  };
}

// ── search ────────────────────────────────────────────────────────────────────

describe("SearchClient.search", () => {
  let base: ReturnType<typeof createMockBase>;
  let client: SearchClient;

  beforeEach(() => {
    base = createMockBase();
    client = new SearchClient(base as never);
  });

  it("calls GET /v1/search with query params for keyword search", async () => {
    base.get.mockResolvedValue({
      total: 1,
      start: 1,
      "page-length": 10,
      results: [{ uri: "/doc.json", score: 0.9 }],
    });

    const result = await client.search({ q: "hello" });

    expect(base.get).toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.results[0].uri).toBe("/doc.json");
    const [, , opts] = base.get.mock.calls[0];
    expect(opts.params.q).toBe("hello");
  });

  it("calls POST /v1/search with structured query body", async () => {
    base.post.mockResolvedValue({
      total: 2,
      start: 1,
      "page-length": 10,
      results: [{ uri: "/a.json" }, { uri: "/b.json" }],
    });

    const sq = { term: { text: "foo" } };
    const result = await client.search({ structuredQuery: sq });

    expect(base.post).toHaveBeenCalled();
    expect(result.results).toHaveLength(2);
    const [, , body] = base.post.mock.calls[0];
    expect(body).toEqual({ search: { query: sq } });
  });

  it("defaults start to 1 and pageLength to 10", async () => {
    base.get.mockResolvedValue({ total: 0, start: 1, "page-length": 10, results: [] });

    await client.search({});

    const [, , opts] = base.get.mock.calls[0];
    expect(opts.params.start).toBe(1);
    expect(opts.params.pageLength).toBe(10);
  });

  it("passes collection and database params", async () => {
    base.get.mockResolvedValue({ total: 0, start: 1, "page-length": 10, results: [] });

    await client.search({ collection: "my-coll", database: "my-db" });

    const [, , opts] = base.get.mock.calls[0];
    expect(opts.params.collection).toBe("my-coll");
    expect(opts.params.database).toBe("my-db");
  });

  it("normalizes facets from facet-value response shape", async () => {
    base.get.mockResolvedValue({
      total: 5,
      start: 1,
      "page-length": 10,
      results: [],
      facets: {
        category: {
          type: "string",
          "facet-value": [
            { name: "Sports", count: 3, _value: "Sports" },
            { name: "Tech", count: 2, _value: "Tech" },
          ],
        },
      },
    });

    const result = await client.search({ q: "test" });

    expect(result.facets).toBeDefined();
    expect(result.facets!["category"].facetValues).toHaveLength(2);
    expect(result.facets!["category"].facetValues[0].name).toBe("Sports");
  });

  it("normalizes facets from facetValues response shape", async () => {
    base.get.mockResolvedValue({
      total: 1,
      start: 1,
      "page-length": 10,
      results: [],
      facets: {
        status: {
          facetValues: [{ name: "active", count: 1, _value: "active" }],
        },
      },
    });

    const result = await client.search({});

    expect(result.facets!["status"].facetValues[0].name).toBe("active");
  });

  it("handles empty results gracefully", async () => {
    base.get.mockResolvedValue({ total: 0, start: 1, "page-length": 10, results: [] });

    const result = await client.search({ q: "noresults" });
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });
});

// ── qbe ───────────────────────────────────────────────────────────────────────

describe("SearchClient.qbe", () => {
  it("posts QBE query with $query wrapper", async () => {
    const base = createMockBase();
    const client = new SearchClient(base as never);
    base.post.mockResolvedValue({ total: 1, start: 1, "page-length": 10, results: [{ uri: "/doc.json" }] });

    const result = await client.qbe({ status: "active" });

    expect(base.post).toHaveBeenCalled();
    const [, , body] = base.post.mock.calls[0];
    expect(body).toEqual({ "$query": { status: "active" } });
    expect(result.total).toBe(1);
  });
});

// ── suggest ───────────────────────────────────────────────────────────────────

describe("SearchClient.suggest", () => {
  it("returns array of suggestions", async () => {
    const base = createMockBase();
    const client = new SearchClient(base as never);
    base.get.mockResolvedValue({ suggestions: ["hello world", "hello there"] });

    const result = await client.suggest("hello");

    expect(result).toEqual(["hello world", "hello there"]);
    const [, , opts] = base.get.mock.calls[0];
    expect(opts.params["partial-q"]).toBe("hello");
  });

  it("returns empty array when no suggestions field in response", async () => {
    const base = createMockBase();
    const client = new SearchClient(base as never);
    base.get.mockResolvedValue({});

    const result = await client.suggest("xyz");
    expect(result).toEqual([]);
  });
});

// ── values ────────────────────────────────────────────────────────────────────

describe("SearchClient.values", () => {
  it("returns normalized values response", async () => {
    const base = createMockBase();
    const client = new SearchClient(base as never);
    base.get.mockResolvedValue({
      "values-response": {
        total: 3,
        "distinct-value": [
          { _value: "Sports", frequency: 10 },
          { _value: "Tech", frequency: 5 },
        ],
      },
    });

    const result = await client.values("category");

    expect(result.name).toBe("category");
    expect(result.total).toBe(3);
    expect(result.values).toHaveLength(2);
    expect(result.values[0]).toEqual({ value: "Sports", frequency: 10 });
  });

  it("passes name in the URI path", async () => {
    const base = createMockBase();
    const client = new SearchClient(base as never);
    base.get.mockResolvedValue({ "values-response": { total: 0, "distinct-value": [] } });

    await client.values("my-index");

    const [, path] = base.get.mock.calls[0];
    expect(path).toContain("my-index");
  });

  it("defaults limit to 20", async () => {
    const base = createMockBase();
    const client = new SearchClient(base as never);
    base.get.mockResolvedValue({ "values-response": { total: 0, "distinct-value": [] } });

    await client.values("field");

    const [, , opts] = base.get.mock.calls[0];
    expect(opts.params.limit).toBe(20);
  });
});

// ── snippet extraction ────────────────────────────────────────────────────────

describe("SearchClient search snippet extraction", () => {
  it("extracts snippet match-text from nested structure", async () => {
    const base = createMockBase();
    const client = new SearchClient(base as never);
    base.get.mockResolvedValue({
      total: 1,
      start: 1,
      "page-length": 10,
      results: [{
        uri: "/doc.json",
        snippet: {
          match: [
            { "match-text": "foo bar" },
            { "match-text": "baz" },
          ],
        },
      }],
    });

    const result = await client.search({ q: "foo" });
    expect(result.results[0].snippet).toBe("foo bar ... baz");
  });

  it("returns undefined snippet when no match array", async () => {
    const base = createMockBase();
    const client = new SearchClient(base as never);
    base.get.mockResolvedValue({
      total: 1,
      start: 1,
      "page-length": 10,
      results: [{ uri: "/doc.json" }],
    });

    const result = await client.search({});
    expect(result.results[0].snippet).toBeUndefined();
  });
});
