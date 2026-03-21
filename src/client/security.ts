import type { MarkLogicBaseClient } from "./base.js";

export interface UserSummary {
  name: string;
  id: string;
}

export interface RoleSummary {
  name: string;
  id: string;
}

export interface RoleProperties {
  "role-name": string;
  description?: string;
  roles: string[];
  privileges: string[];
  [key: string]: unknown;
}

export interface DocumentPermission {
  "role-name": string;
  capabilities: string[];
}

export class SecurityClient {
  constructor(private readonly base: MarkLogicBaseClient) {}

  /** List all users in the Security database. */
  async listUsers(limit?: number): Promise<UserSummary[]> {
    const data = await this.base.get<{
      "user-default-list": { "list-items": { "list-item": Array<{ nameref: string; idref: string }> } };
    }>(this.base.mgmt, "/manage/v2/users", { params: { format: "json" } });
    const items = data?.["user-default-list"]?.["list-items"]?.["list-item"] ?? [];
    const users = items.map((i) => ({ name: i.nameref, id: i.idref }));
    return limit ? users.slice(0, limit) : users;
  }

  /** List all roles defined in the Security database. */
  async listRoles(limit?: number): Promise<RoleSummary[]> {
    const data = await this.base.get<{
      "role-default-list": { "list-items": { "list-item": Array<{ nameref: string; idref: string }> } };
    }>(this.base.mgmt, "/manage/v2/roles", { params: { format: "json" } });
    const items = data?.["role-default-list"]?.["list-items"]?.["list-item"] ?? [];
    const roles = items.map((i) => ({ name: i.nameref, id: i.idref }));
    return limit ? roles.slice(0, limit) : roles;
  }

  /** Get full properties for a named role, including parent roles and privileges. */
  async getRoleProperties(roleName: string): Promise<RoleProperties> {
    const raw = await this.base.get<Record<string, unknown>>(
      this.base.mgmt,
      `/manage/v2/roles/${encodeURIComponent(roleName)}/properties`,
      { params: { format: "json" } }
    );
    // Normalise parent-role and privilege lists to simple string arrays.
    // The Management API returns "role" as string[] and "privilege" as
    // Array<{"privilege-name": string}> in ML 12.
    const roleRaw = raw?.["role"];
    const privRef = raw?.["privilege"] as Array<{ "privilege-name": string }> | undefined;
    const roles: string[] = Array.isArray(roleRaw)
      ? roleRaw.map((r) => (typeof r === "string" ? r : (r as Record<string, string>)["roleref"] ?? (r as Record<string, string>)["role-name"] ?? String(r)))
      : [];
    return {
      ...raw,
      "role-name": raw?.["role-name"] as string,
      description: raw?.["description"] as string | undefined,
      roles,
      privileges: (privRef ?? []).map((p) => p["privilege-name"]),
    } as RoleProperties;
  }

  /** Return the permissions assigned to a specific document URI. */
  async getDocumentPermissions(uri: string, database?: string): Promise<DocumentPermission[]> {
    const params: Record<string, string> = { uri, category: "permissions", format: "json" };
    if (database) params["database"] = database;
    const raw = await this.base.get<Record<string, unknown>>(
      this.base.http,
      "/v1/documents",
      { params }
    );
    const perms = (raw?.["permissions"] as Array<Record<string, unknown>>) ?? [];
    return perms.map((p) => ({
      "role-name": p["role-name"] as string,
      // The REST API returns capabilities as a plain string array (e.g. ["read", "update"]),
      // not as an array of {capability: string} objects.
      capabilities: (p["capabilities"] as string[]) ?? [],
    }));
  }
}
