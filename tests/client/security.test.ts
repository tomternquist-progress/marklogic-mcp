import { describe, it, expect, vi } from "vitest";
import { SecurityClient } from "../../src/client/security.js";

function createMockBase() {
  return {
    http: {},
    mgmt: {},
    get: vi.fn(),
  };
}

// ── listUsers ─────────────────────────────────────────────────────────────────

describe("SecurityClient.listUsers", () => {
  it("returns mapped user summaries", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({
      "user-default-list": {
        "list-items": {
          "list-item": [
            { nameref: "admin", idref: "u1" },
            { nameref: "reader", idref: "u2" },
          ],
        },
      },
    });

    const result = await client.listUsers();
    expect(result).toEqual([
      { name: "admin", id: "u1" },
      { name: "reader", id: "u2" },
    ]);
  });

  it("applies limit when provided", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({
      "user-default-list": {
        "list-items": {
          "list-item": [
            { nameref: "a", idref: "1" },
            { nameref: "b", idref: "2" },
            { nameref: "c", idref: "3" },
          ],
        },
      },
    });

    const result = await client.listUsers(2);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no users", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({ "user-default-list": { "list-items": { "list-item": [] } } });

    const result = await client.listUsers();
    expect(result).toEqual([]);
  });
});

// ── listRoles ─────────────────────────────────────────────────────────────────

describe("SecurityClient.listRoles", () => {
  it("returns mapped role summaries", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({
      "role-default-list": {
        "list-items": {
          "list-item": [
            { nameref: "admin", idref: "r1" },
            { nameref: "rest-reader", idref: "r2" },
          ],
        },
      },
    });

    const result = await client.listRoles();
    expect(result).toEqual([
      { name: "admin", id: "r1" },
      { name: "rest-reader", id: "r2" },
    ]);
  });

  it("applies limit when provided", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({
      "role-default-list": {
        "list-items": {
          "list-item": [
            { nameref: "a", idref: "1" },
            { nameref: "b", idref: "2" },
            { nameref: "c", idref: "3" },
          ],
        },
      },
    });

    const result = await client.listRoles(1);
    expect(result).toHaveLength(1);
  });
});

// ── getRoleProperties ──────────────────────────────────────────────────────────

describe("SecurityClient.getRoleProperties", () => {
  it("normalizes parent roles from string array", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({
      "role-name": "my-role",
      description: "My role",
      role: ["admin", "rest-writer"],
      privilege: [{ "privilege-name": "xdmp:eval" }],
    });

    const result = await client.getRoleProperties("my-role");

    expect(result["role-name"]).toBe("my-role");
    expect(result.roles).toEqual(["admin", "rest-writer"]);
    expect(result.privileges).toEqual(["xdmp:eval"]);
  });

  it("returns empty roles when role field absent", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({
      "role-name": "empty-role",
    });

    const result = await client.getRoleProperties("empty-role");
    expect(result.roles).toEqual([]);
    expect(result.privileges).toEqual([]);
  });

  it("normalizes role objects with roleref field", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({
      "role-name": "complex-role",
      role: [{ roleref: "admin" }, { roleref: "writer" }],
      privilege: [],
    });

    const result = await client.getRoleProperties("complex-role");
    expect(result.roles).toEqual(["admin", "writer"]);
  });

  it("URL-encodes role name with spaces", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({ "role-name": "my role" });

    await client.getRoleProperties("my role");

    const [, url] = base.get.mock.calls[0];
    expect(url).toContain("my%20role");
  });
});

// ── getDocumentPermissions ────────────────────────────────────────────────────

describe("SecurityClient.getDocumentPermissions", () => {
  it("returns document permissions array", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({
      permissions: [
        { "role-name": "rest-reader", capabilities: ["read"] },
        { "role-name": "rest-writer", capabilities: ["read", "update"] },
      ],
    });

    const result = await client.getDocumentPermissions("/doc.json");
    expect(result).toHaveLength(2);
    expect(result[0]["role-name"]).toBe("rest-reader");
    expect(result[0].capabilities).toEqual(["read"]);
  });

  it("returns empty array when no permissions field", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({});

    const result = await client.getDocumentPermissions("/doc.json");
    expect(result).toEqual([]);
  });

  it("passes database param when provided", async () => {
    const base = createMockBase();
    const client = new SecurityClient(base as never);
    base.get.mockResolvedValue({ permissions: [] });

    await client.getDocumentPermissions("/doc.json", "my-db");

    const [, , opts] = base.get.mock.calls[0];
    expect(opts.params.database).toBe("my-db");
  });
});
