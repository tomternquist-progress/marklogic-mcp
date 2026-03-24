import { describe, it, expect, vi, beforeEach } from "vitest";
import { AdminClient } from "../../src/client/admin.js";

function createMockBase() {
  return {
    http: {},
    mgmt: {},
    get: vi.fn(),
    post: vi.fn(),
  };
}

// ── listDatabases ─────────────────────────────────────────────────────────────

describe("AdminClient.listDatabases", () => {
  it("returns mapped database summaries", async () => {
    const base = createMockBase();
    const client = new AdminClient(base as never);
    base.get.mockResolvedValue({
      "database-default-list": {
        "list-items": {
          "list-item": [
            { nameref: "Documents", idref: "1234" },
            { nameref: "Schemas", idref: "5678" },
          ],
        },
      },
    });

    const result = await client.listDatabases();

    expect(result).toEqual([
      { name: "Documents", id: "1234" },
      { name: "Schemas", id: "5678" },
    ]);
  });

  it("returns empty array when list is empty", async () => {
    const base = createMockBase();
    const client = new AdminClient(base as never);
    base.get.mockResolvedValue({
      "database-default-list": {
        "list-items": { "list-item": [] },
      },
    });

    const result = await client.listDatabases();
    expect(result).toEqual([]);
  });

  it("returns empty array when response is malformed", async () => {
    const base = createMockBase();
    const client = new AdminClient(base as never);
    base.get.mockResolvedValue({});

    const result = await client.listDatabases();
    expect(result).toEqual([]);
  });
});

// ── getDatabaseProperties ─────────────────────────────────────────────────────

describe("AdminClient.getDatabaseProperties", () => {
  it("passes database name in URL and returns properties", async () => {
    const base = createMockBase();
    const client = new AdminClient(base as never);
    const props = { "database-name": "Documents", enabled: true, forest: ["Forest1"], uri: "" };
    base.get.mockResolvedValue(props);

    const result = await client.getDatabaseProperties("Documents");

    expect(result).toEqual(props);
    const [, url] = base.get.mock.calls[0];
    expect(url).toContain("Documents");
  });

  it("URL-encodes database name with special chars", async () => {
    const base = createMockBase();
    const client = new AdminClient(base as never);
    base.get.mockResolvedValue({});

    await client.getDatabaseProperties("My DB");

    const [, url] = base.get.mock.calls[0];
    expect(url).toContain("My%20DB");
  });
});

// ── listForests ───────────────────────────────────────────────────────────────

describe("AdminClient.listForests", () => {
  it("returns mapped forest summaries", async () => {
    const base = createMockBase();
    const client = new AdminClient(base as never);
    base.get.mockResolvedValue({
      "forest-default-list": {
        "list-items": {
          "list-item": [
            { nameref: "Documents-1", idref: "abc" },
          ],
        },
      },
    });

    const result = await client.listForests();
    expect(result).toEqual([{ name: "Documents-1", id: "abc", state: "unknown" }]);
  });
});

// ── listServers ───────────────────────────────────────────────────────────────

describe("AdminClient.listServers", () => {
  it("returns mapped server summaries", async () => {
    const base = createMockBase();
    const client = new AdminClient(base as never);
    base.get.mockResolvedValue({
      "server-default-list": {
        "list-items": {
          "list-item": [
            { nameref: "App-Services", idref: "s1", kindref: "http", groupnameref: "Default" },
          ],
        },
      },
    });

    const result = await client.listServers();
    expect(result[0].name).toBe("App-Services");
  });

  it("returns empty array when no servers found", async () => {
    const base = createMockBase();
    const client = new AdminClient(base as never);
    base.get.mockResolvedValue({});

    const result = await client.listServers();
    expect(result).toEqual([]);
  });
});

// ── getClusterStatus ──────────────────────────────────────────────────────────

describe("AdminClient.getClusterStatus", () => {
  it("returns cluster status object", async () => {
    const base = createMockBase();
    const client = new AdminClient(base as never);
    const status = { "local-host": "ml-host", version: "12.0", "cluster-id": "cl1" };
    base.get.mockResolvedValue(status);

    const result = await client.getClusterStatus();
    expect(result).toEqual(status);
  });
});
