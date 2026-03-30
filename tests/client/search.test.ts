import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  initLogger: vi.fn(),
  getLogger: vi.fn(),
}));

import nock from "nock";
import { MarkLogicBaseClient } from "../../src/client/base.js";
import { SearchClient } from "../../src/client/search.js";
import type { ConnectionConfig } from "../../src/config/schema.js";

const HOST = "ml-search-test.local";
const BASE_URL = `http://${HOST}:8000`;

const config: ConnectionConfig = {
  host: HOST,
  port: 8000,
  managementPort: 8002,
  username: "admin",
  password: "admin",
  database: "Documents",
  ssl: false,
  rejectUnauthorized: true,
  authType: "basic",
  timeoutMs: 5000,
};

function makeClient() {
  return new SearchClient(new MarkLogicBaseClient(config));
}

beforeAll(() => { nock.disableNetConnect(); });
afterAll(() => { nock.enableNetConnect(); });
afterEach(() => { nock.cleanAll(); });

// ─── search ───────────────────────────────────────────────────────────────────

describe("SearchClient.search – GET", () => {
  it("returns normalised search response on success", async () => {
    nock(BASE_URL)
      .get("/v1/search")
      .query(true)
      .reply(200, {
        total: 1,
        start: 1,
        "page-length": 10,
        results: [{ uri: "/doc.json", score: 0.8 }],
      });

    const res = await makeClient().search({ q: "hello" });
    expect(res.total).toBe(1);
    expect(res.results[0].uri).toBe("/doc.json");
    expect(res.results[0].score).toBe(0.8);
  });

  it("defaults start=1 and pageLength=10", async () => {
    let capturedQs: Record<string, string> = {};
    nock(BASE_URL)
      .get("/v1/search")
      .query((qs) => { capturedQs = qs as Record<string, string>; return true; })
      .reply(200, { total: 0, start: 1, "page-length": 10, results: [] });

    await makeClient().search({});
    expect(capturedQs.start).toBe("1");
    expect(capturedQs.pageLength).toBe("10");
  });

  it("passes collection, directory, options, and database in query params", async () => {
    let capturedQs: Record<string, string> = {};
    nock(BASE_URL)
      .get("/v1/search")
      .query((qs) => { capturedQs = qs as Record<string, string>; return true; })
      .reply(200, { total: 0, start: 1, "page-length": 10, results: [] });

    await makeClient().search({
      q: "test",
      collection: "col1",
      directory: "/data/",
      options: "my-opts",
      database: "DB1",
      start: 5,
      pageLength: 25,
    });

    expect(capturedQs.q).toBe("test");
    expect(capturedQs.collection).toBe("col1");
    expect(capturedQs.directory).toBe("/data/");
    expect(capturedQs.options).toBe("my-opts");
    expect(capturedQs.database).toBe("DB1");
    expect(capturedQs.start).toBe("5");
    expect(capturedQs.pageLength).toBe("25");
  });
});

describe("SearchClient.search – POST (structured query)", () => {
  it("POSTs when structuredQuery is provided", async () => {
    const sq = { "word-query": { text: ["hello"] } };
    nock(BASE_URL)
      .post("/v1/search", { search: { query: sq } })
      .query(true)
      .reply(200, { total: 1, start: 1, "page-length": 10, results: [{ uri: "/a.json" }] });

    const res = await makeClient().search({ structuredQuery: sq });
    expect(res.results[0].uri).toBe("/a.json");
  });
});

describe("SearchClient.search – facet normalisation", () => {
  it("normalises facet values from facet-value array", async () => {
    nock(BASE_URL)
      .get("/v1/search")
      .query(true)
      .reply(200, {
        total: 0,
        start: 1,
        "page-length": 10,
        results: [],
        facets: {
          status: {
            type: "xs:string",
            "facet-value": [{ name: "active", count: 5, _value: "active" }],
          },
        },
      });

    const res = await makeClient().search({ q: "" });
    expect(res.facets?.status.facetValues[0]).toMatchObject({ name: "active", count: 5 });
  });
});

// ─── qbe ─────────────────────────────────────────────────────────────────────

describe("SearchClient.qbe", () => {
  it("POSTs example to /v1/qbe and returns results", async () => {
    nock(BASE_URL)
      .post("/v1/qbe", { "$query": { name: "Alice" } })
      .query(true)
      .reply(200, { total: 1, start: 1, "page-length": 10, results: [{ uri: "/alice.json" }] });

    const res = await makeClient().qbe({ name: "Alice" });
    expect(res.total).toBe(1);
    expect(res.results[0].uri).toBe("/alice.json");
  });

  it("passes start, pageLength, and database params", async () => {
    let capturedQs: Record<string, string> = {};
    nock(BASE_URL)
      .post("/v1/qbe")
      .query((qs) => { capturedQs = qs as Record<string, string>; return true; })
      .reply(200, { total: 0, start: 1, "page-length": 10, results: [] });

    await makeClient().qbe({}, { start: 3, pageLength: 50, database: "TestDB" });

    expect(capturedQs.start).toBe("3");
    expect(capturedQs.pageLength).toBe("50");
    expect(capturedQs.database).toBe("TestDB");
  });
});

// ─── suggest ─────────────────────────────────────────────────────────────────

describe("SearchClient.suggest", () => {
  it("returns suggestions array", async () => {
    nock(BASE_URL)
      .get("/v1/suggest")
      .query(true)
      .reply(200, { suggestions: ["apple", "application"] });

    const suggestions = await makeClient().suggest("app");
    expect(suggestions).toEqual(["apple", "application"]);
  });

  it("returns empty array when suggestions key is absent", async () => {
    nock(BASE_URL)
      .get("/v1/suggest")
      .query(true)
      .reply(200, {});

    const suggestions = await makeClient().suggest("xyz");
    expect(suggestions).toEqual([]);
  });

  it("passes partial-q, options, database, and limit to the API", async () => {
    let capturedQs: Record<string, string> = {};
    nock(BASE_URL)
      .get("/v1/suggest")
      .query((qs) => { capturedQs = qs as Record<string, string>; return true; })
      .reply(200, { suggestions: [] });

    await makeClient().suggest("hel", "my-opts", "MyDB", 5);

    expect(capturedQs["partial-q"]).toBe("hel");
    expect(capturedQs.options).toBe("my-opts");
    expect(capturedQs.database).toBe("MyDB");
    expect(capturedQs.limit).toBe("5");
  });
});

// ─── values ──────────────────────────────────────────────────────────────────

describe("SearchClient.values", () => {
  it("returns normalised values response", async () => {
    nock(BASE_URL)
      .get("/v1/values/status")
      .query(true)
      .reply(200, {
        "values-response": {
          total: 2,
          "distinct-value": [
            { _value: "active", frequency: 10 },
            { _value: "inactive", frequency: 3 },
          ],
        },
      });

    const res = await makeClient().values("status");
    expect(res.name).toBe("status");
    expect(res.total).toBe(2);
    expect(res.values).toHaveLength(2);
    expect(res.values[0]).toEqual({ value: "active", frequency: 10 });
  });

  it("encodes the values name in the URL", async () => {
    nock(BASE_URL)
      .get("/v1/values/my%20index")
      .query(true)
      .reply(200, { "values-response": { total: 0, "distinct-value": [] } });

    const res = await makeClient().values("my index");
    expect(res.values).toEqual([]);
  });

  it("passes query, limit, direction, aggregate, and database params", async () => {
    let capturedQs: Record<string, string> = {};
    nock(BASE_URL)
      .get("/v1/values/cat")
      .query((qs) => { capturedQs = qs as Record<string, string>; return true; })
      .reply(200, { "values-response": { total: 0, "distinct-value": [] } });

    await makeClient().values("cat", {
      query: "type:A",
      limit: 50,
      direction: "ascending",
      aggregate: "count",
      database: "DB1",
    });

    expect(capturedQs.q).toBe("type:A");
    expect(capturedQs.limit).toBe("50");
    expect(capturedQs.direction).toBe("ascending");
    expect(capturedQs.aggregate).toBe("count");
    expect(capturedQs.database).toBe("DB1");
  });
});
