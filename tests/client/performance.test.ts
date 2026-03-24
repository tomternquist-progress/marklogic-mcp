import { describe, it, expect, vi } from "vitest";
import { PerformanceClient } from "../../src/client/performance.js";

function createMockBase() {
  const http = {
    post: vi.fn(),
  };
  return {
    http,
    get: vi.fn(),
    post: vi.fn(),
  };
}

// ── explainOptic ──────────────────────────────────────────────────────────────

describe("PerformanceClient.explainOptic", () => {
  it("posts plan with output=explain param", async () => {
    const base = createMockBase();
    const client = new PerformanceClient(base as never);
    const explanation = { plan: { nodes: [] } };
    base.post.mockResolvedValue(explanation);

    const plan = { $optic: {} };
    const result = await client.explainOptic(plan);

    expect(result).toEqual(explanation);
    const [, , , opts] = base.post.mock.calls[0];
    expect(opts.params.output).toBe("explain");
  });

  it("passes database param when provided", async () => {
    const base = createMockBase();
    const client = new PerformanceClient(base as never);
    base.post.mockResolvedValue({});

    await client.explainOptic({}, "my-db");

    const [, , , opts] = base.post.mock.calls[0];
    expect(opts.params.database).toBe("my-db");
  });
});

// ── searchDebug ───────────────────────────────────────────────────────────────

describe("PerformanceClient.searchDebug", () => {
  it("calls GET search with debug=true", async () => {
    const base = createMockBase();
    const client = new PerformanceClient(base as never);
    base.get.mockResolvedValue({ total: 0, "qtext": "foo" });

    const result = await client.searchDebug({ q: "foo" });

    const [, , opts] = base.get.mock.calls[0];
    expect(opts.params.debug).toBe("true");
    expect(opts.params.q).toBe("foo");
    expect(result).toEqual({ total: 0, "qtext": "foo" });
  });

  it("falls back to plain search when debug param unsupported (UNSUPPORTEDPARAM error)", async () => {
    const base = createMockBase();
    const client = new PerformanceClient(base as never);

    base.get
      .mockRejectedValueOnce(new Error("UNSUPPORTEDPARAM: debug"))
      .mockResolvedValueOnce({ total: 5 });

    const result = await client.searchDebug({ q: "test" });

    // Should have made 2 calls
    expect(base.get).toHaveBeenCalledTimes(2);
    // Second call should NOT have debug=true
    const secondCall = base.get.mock.calls[1];
    expect((secondCall[2] as Record<string, Record<string, string>>).params.debug).toBeUndefined();
    expect(result).toEqual({ total: 5 });
  });

  it("re-throws non-debug errors", async () => {
    const base = createMockBase();
    const client = new PerformanceClient(base as never);
    base.get.mockRejectedValue(new Error("XDMP-NOSUCHDB: Database not found"));

    await expect(client.searchDebug({ q: "test" })).rejects.toThrow("XDMP-NOSUCHDB");
  });

  it("calls POST for structured queries", async () => {
    const base = createMockBase();
    const client = new PerformanceClient(base as never);
    base.post.mockResolvedValue({ total: 0 });

    const sq = { term: { text: "foo" } };
    await client.searchDebug({ structuredQuery: sq });

    expect(base.post).toHaveBeenCalled();
    const [, , body] = base.post.mock.calls[0];
    expect(body).toEqual({ search: { query: sq } });
  });
});

// ── getForestStatus ───────────────────────────────────────────────────────────

describe("PerformanceClient.getForestStatus", () => {
  it("fetches forest status with view=status param", async () => {
    const base = createMockBase();
    const client = new PerformanceClient(base as never);
    const status = { "forest-status": { "forest-name": "Documents-1" } };
    base.get.mockResolvedValue(status);

    const result = await client.getForestStatus("Documents-1");

    expect(result).toEqual(status);
    const [, url, opts] = base.get.mock.calls[0];
    expect(url).toContain("Documents-1");
    expect(opts.params.view).toBe("status");
  });

  it("URL-encodes forest name with special chars", async () => {
    const base = createMockBase();
    const client = new PerformanceClient(base as never);
    base.get.mockResolvedValue({});

    await client.getForestStatus("My Forest");

    const [, url] = base.get.mock.calls[0];
    expect(url).toContain("My%20Forest");
  });
});
