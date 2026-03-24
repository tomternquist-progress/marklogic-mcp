import { describe, it, expect, vi } from "vitest";
import { FastTrackClient } from "../../src/client/fasttrack.js";

function createMockBase() {
  return {
    http: {},
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
}

// ── listSearchOptions ─────────────────────────────────────────────────────────

describe("FastTrackClient.listSearchOptions", () => {
  it("handles ML 12 flat JSON array response", async () => {
    const base = createMockBase();
    const client = new FastTrackClient(base as never, false);
    base.get.mockResolvedValue([
      { name: "default", uri: "/v1/config/query/default" },
      { name: "facets", uri: "/v1/config/query/facets" },
    ]);

    const result = await client.listSearchOptions();
    expect(result).toEqual([
      { name: "default", uri: "/v1/config/query/default" },
      { name: "facets", uri: "/v1/config/query/facets" },
    ]);
  });

  it("handles older ML wrapped format: query-options-list.options", async () => {
    const base = createMockBase();
    const client = new FastTrackClient(base as never, false);
    base.get.mockResolvedValue({
      "query-options-list": {
        options: [
          { name: "default", uri: "/v1/config/query/default" },
        ],
      },
    });

    const result = await client.listSearchOptions();
    expect(result).toEqual([{ name: "default", uri: "/v1/config/query/default" }]);
  });

  it("handles flat options-name array fallback", async () => {
    const base = createMockBase();
    const client = new FastTrackClient(base as never, false);
    base.get.mockResolvedValue({ "options-name": ["default", "facets"] });

    const result = await client.listSearchOptions();
    expect(result).toEqual([
      { name: "default", uri: "/v1/config/query/default" },
      { name: "facets", uri: "/v1/config/query/facets" },
    ]);
  });

  it("returns empty array when response is empty object", async () => {
    const base = createMockBase();
    const client = new FastTrackClient(base as never, false);
    base.get.mockResolvedValue({});

    const result = await client.listSearchOptions();
    expect(result).toEqual([]);
  });

  it("handles single string in options-name (not array)", async () => {
    const base = createMockBase();
    const client = new FastTrackClient(base as never, false);
    base.get.mockResolvedValue({ "options-name": "default" });

    const result = await client.listSearchOptions();
    expect(result).toEqual([{ name: "default", uri: "/v1/config/query/default" }]);
  });
});

// ── getSearchOptions ──────────────────────────────────────────────────────────

describe("FastTrackClient.getSearchOptions", () => {
  it("fetches search options by name", async () => {
    const base = createMockBase();
    const client = new FastTrackClient(base as never, false);
    const opts = { "search-options": { constraint: [] } };
    base.get.mockResolvedValue(opts);

    const result = await client.getSearchOptions("default");
    expect(result).toEqual(opts);

    const [, url] = base.get.mock.calls[0];
    expect(url).toContain("default");
  });
});

// ── putSearchOptions ──────────────────────────────────────────────────────────

describe("FastTrackClient.putSearchOptions", () => {
  it("throws in readonly mode", async () => {
    const base = createMockBase();
    const client = new FastTrackClient(base as never, true);

    await expect(client.putSearchOptions("default", {})).rejects.toThrow(/readonly/i);
  });

  it("calls put in writable mode", async () => {
    const base = createMockBase();
    const client = new FastTrackClient(base as never, false);
    base.put.mockResolvedValue(undefined);

    await client.putSearchOptions("default", { constraint: [] });
    expect(base.put).toHaveBeenCalled();
  });
});
