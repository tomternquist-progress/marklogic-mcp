/**
 * Unit tests for security tool handlers:
 *   ml_users_list         — lists all MarkLogic users
 *   ml_roles_list         — lists roles or inspects a specific role's properties
 *   ml_document_permissions — returns read/update/insert/execute permissions for a URI
 *
 * All client calls are mocked — no live MarkLogic required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerSecurityTools } from "../../src/tools/security.js";
import { MarkLogicError } from "../../src/utils/errors.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(_name, handler);
    },
  };
  return { server, tools };
}

function createMockClients() {
  return {
    security: {
      listUsers: vi.fn(),
      listRoles: vi.fn(),
      getRoleProperties: vi.fn(),
      getDocumentPermissions: vi.fn(),
    },
  };
}

// ─── Registration ──────────────────────────────────────────────────────────────

describe("registerSecurityTools – registration", () => {
  it("registers exactly 3 tools", () => {
    const { server, tools } = createMockServer();
    registerSecurityTools(server as never, createMockClients() as never);
    expect(tools.has("ml_users_list")).toBe(true);
    expect(tools.has("ml_roles_list")).toBe(true);
    expect(tools.has("ml_document_permissions")).toBe(true);
    expect(tools.size).toBe(3);
  });
});

// ─── ml_users_list ────────────────────────────────────────────────────────────

describe("ml_users_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerSecurityTools(server as never, clients as never);
    tools = t;
  });

  it("returns JSON-formatted user list on success", async () => {
    const mockUsers = [{ name: "admin" }, { name: "app-user" }];
    clients.security.listUsers.mockResolvedValue(mockUsers);

    const result = await tools.get("ml_users_list")!({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockUsers);
  });

  it("passes limit parameter to the client", async () => {
    clients.security.listUsers.mockResolvedValue([{ name: "admin" }]);
    await tools.get("ml_users_list")!({ limit: 5 });
    expect(clients.security.listUsers).toHaveBeenCalledWith(5);
  });

  it("passes undefined when limit is omitted", async () => {
    clients.security.listUsers.mockResolvedValue([]);
    await tools.get("ml_users_list")!({});
    expect(clients.security.listUsers).toHaveBeenCalledWith(undefined);
  });

  it("returns 'No users found' message on empty list", async () => {
    clients.security.listUsers.mockResolvedValue([]);
    const result = await tools.get("ml_users_list")!({});
    expect(result.content[0].text).toContain("No users found");
  });

  it("returns isError on failure", async () => {
    clients.security.listUsers.mockRejectedValue(new MarkLogicError("access denied", 403));
    const result = await tools.get("ml_users_list")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("403");
  });

  it("appends manage-user privilege hint on 401/403 errors", async () => {
    clients.security.listUsers.mockRejectedValue(new MarkLogicError("401 Unauthorized", 401));
    const result = await tools.get("ml_users_list")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("manage-user");
  });
});

// ─── ml_roles_list ────────────────────────────────────────────────────────────

describe("ml_roles_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerSecurityTools(server as never, clients as never);
    tools = t;
  });

  it("lists all roles when role_name is omitted", async () => {
    const mockRoles = ["admin", "app-user", "rest-reader"];
    clients.security.listRoles.mockResolvedValue(mockRoles);

    const result = await tools.get("ml_roles_list")!({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockRoles);
    expect(clients.security.listRoles).toHaveBeenCalled();
    expect(clients.security.getRoleProperties).not.toHaveBeenCalled();
  });

  it("calls getRoleProperties when role_name is provided", async () => {
    const mockProps = { "role-name": "admin", description: "Admin role", privileges: [] };
    clients.security.getRoleProperties.mockResolvedValue(mockProps);

    const result = await tools.get("ml_roles_list")!({ role_name: "admin" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockProps);
    expect(clients.security.getRoleProperties).toHaveBeenCalledWith("admin");
    expect(clients.security.listRoles).not.toHaveBeenCalled();
  });

  it("returns 'No roles found' message on empty list", async () => {
    clients.security.listRoles.mockResolvedValue([]);
    const result = await tools.get("ml_roles_list")!({});
    expect(result.content[0].text).toContain("No roles found");
  });

  it("returns isError on list failure", async () => {
    clients.security.listRoles.mockRejectedValue(new MarkLogicError("forbidden", 403));
    const result = await tools.get("ml_roles_list")!({});
    expect(result.isError).toBe(true);
  });

  it("returns isError on getRoleProperties failure", async () => {
    clients.security.getRoleProperties.mockRejectedValue(new MarkLogicError("not found", 404));
    const result = await tools.get("ml_roles_list")!({ role_name: "nonexistent" });
    expect(result.isError).toBe(true);
  });

  it("appends manage-user hint on 403 error for role detail", async () => {
    clients.security.getRoleProperties.mockRejectedValue(new MarkLogicError("403 Forbidden", 403));
    const result = await tools.get("ml_roles_list")!({ role_name: "admin" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("manage-user");
  });
});

// ─── ml_document_permissions ──────────────────────────────────────────────────

describe("ml_document_permissions handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockClients>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    clients = createMockClients();
    registerSecurityTools(server as never, clients as never);
    tools = t;
  });

  it("returns JSON-formatted permissions on success", async () => {
    const mockPerms = [
      { "role-name": "rest-reader", capability: "read" },
      { "role-name": "rest-writer", capability: "update" },
    ];
    clients.security.getDocumentPermissions.mockResolvedValue(mockPerms);

    const result = await tools.get("ml_document_permissions")!({ uri: "/doc.json" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(mockPerms);
  });

  it("passes uri and database to the client", async () => {
    clients.security.getDocumentPermissions.mockResolvedValue([{ "role-name": "r", capability: "read" }]);
    await tools.get("ml_document_permissions")!({ uri: "/my/doc.json", database: "MyDB" });
    expect(clients.security.getDocumentPermissions).toHaveBeenCalledWith("/my/doc.json", "MyDB");
  });

  it("shows 'No permissions found' hint when list is empty", async () => {
    clients.security.getDocumentPermissions.mockResolvedValue([]);
    const result = await tools.get("ml_document_permissions")!({ uri: "/missing.json" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No permissions found");
    expect(result.content[0].text).toContain("ml_document_list");
  });

  it("returns isError and hint on 401/403 failure", async () => {
    clients.security.getDocumentPermissions.mockRejectedValue(
      new MarkLogicError("401 Unauthorized", 401)
    );
    const result = await tools.get("ml_document_permissions")!({ uri: "/secret.json" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("manage-user");
  });

  it("returns isError on generic failure", async () => {
    clients.security.getDocumentPermissions.mockRejectedValue(new Error("network error"));
    const result = await tools.get("ml_document_permissions")!({ uri: "/doc.json" });
    expect(result.isError).toBe(true);
  });
});
