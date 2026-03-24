import { describe, it, expect, vi } from "vitest";
import { ExtensionsClient } from "../../src/client/extensions.js";

function createMockBase() {
  return {
    http: {},
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    post: vi.fn(),
  };
}

// ── listExtensions ────────────────────────────────────────────────────────────

describe("ExtensionsClient.listExtensions", () => {
  it("returns mapped extension infos from nested resource array", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.get.mockResolvedValue({
      resources: {
        resource: [
          { name: "my-ext", "source-format": "javascript", version: "1.0", provider: "acme" },
        ],
      },
    });

    const result = await client.listExtensions();
    expect(result).toEqual([{ name: "my-ext", language: "javascript", version: "1.0", provider: "acme" }]);
  });

  it("returns empty array when resources is empty string (no extensions deployed)", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.get.mockResolvedValue({ resources: "" });

    const result = await client.listExtensions();
    expect(result).toEqual([]);
  });

  it("returns empty array when response is empty", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.get.mockResolvedValue({});

    const result = await client.listExtensions();
    expect(result).toEqual([]);
  });

  it("handles direct array in resources field", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.get.mockResolvedValue({
      resources: [{ name: "ext-a", language: "javascript" }],
    });

    const result = await client.listExtensions();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("ext-a");
  });
});

// ── getExtension ──────────────────────────────────────────────────────────────

describe("ExtensionsClient.getExtension", () => {
  it("returns source code string", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.get.mockResolvedValue("'use strict'; exports.GET = function() {};");

    const code = await client.getExtension("my-ext");
    expect(code).toBe("'use strict'; exports.GET = function() {};");

    const [, url] = base.get.mock.calls[0];
    expect(url).toContain("my-ext");
  });

  it("URL-encodes extension name with special chars", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.get.mockResolvedValue("");

    await client.getExtension("my ext");

    const [, url] = base.get.mock.calls[0];
    expect(url).toContain("my%20ext");
  });
});

// ── putExtension ──────────────────────────────────────────────────────────────

describe("ExtensionsClient.putExtension", () => {
  it("uses javascript content-type by default", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.put.mockResolvedValue(undefined);

    await client.putExtension("ext", "code");

    const [, , , opts] = base.put.mock.calls[0];
    expect(opts.headers["Content-Type"]).toBe("application/vnd.marklogic-javascript");
  });

  it("uses xquery content-type for xquery language", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.put.mockResolvedValue(undefined);

    await client.putExtension("ext", "xquery version '1.0-ml';", "xquery");

    const [, , , opts] = base.put.mock.calls[0];
    expect(opts.headers["Content-Type"]).toBe("application/xquery");
  });
});

// ── deleteExtension ───────────────────────────────────────────────────────────

describe("ExtensionsClient.deleteExtension", () => {
  it("calls delete with encoded extension name", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.delete.mockResolvedValue(undefined);

    await client.deleteExtension("my-ext");

    const [, url] = base.delete.mock.calls[0];
    expect(url).toContain("my-ext");
  });
});

// ── callExtension ─────────────────────────────────────────────────────────────

describe("ExtensionsClient.callExtension", () => {
  it("calls GET extension and prefixes params with rs:", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.get.mockResolvedValue({ results: [] });

    await client.callExtension("emp-search", "GET", { department: "Engineering" });

    const [, url, opts] = base.get.mock.calls[0];
    expect(url).toContain("emp-search");
    expect(opts.params["rs:department"]).toBe("Engineering");
  });

  it("calls POST extension with body", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.post.mockResolvedValue({ ok: true });

    await client.callExtension("writer", "POST", {}, { data: "value" });

    const [, url, body] = base.post.mock.calls[0];
    expect(url).toContain("writer");
    expect(body).toEqual({ data: "value" });
  });

  it("uses empty body {} when POST has no body", async () => {
    const base = createMockBase();
    const client = new ExtensionsClient(base as never);
    base.post.mockResolvedValue({});

    await client.callExtension("ext", "POST");

    const [, , body] = base.post.mock.calls[0];
    expect(body).toEqual({});
  });
});
