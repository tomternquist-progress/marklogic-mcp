import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerSecurityTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_users_list",
    "List all MarkLogic users in the Security database. Requires the 'manage-user' or 'security' " +
    "role on the connecting account. Use this to audit what accounts exist in the cluster before " +
    "diagnosing a permission problem. Follow up with ml_roles_list to see what roles each user holds, " +
    "and ml_document_permissions to check what roles a specific document requires.",
    { limit: z.number().int().positive().optional().describe("Maximum number of users to return (default: all)") },
    async ({ limit }) => {
      try {
        const users = await clients.security.listUsers(limit);
        if (users.length === 0) {
          return { content: [{ type: "text", text: "No users found in the Security database." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(users, null, 2) }] };
      } catch (err) {
        const msg = toToolError(err);
        const note = msg.includes("401") || msg.includes("403")
          ? "\nHint: The connecting account lacks the 'manage-user' privilege. Ask a MarkLogic admin to grant this role."
          : "";
        return { content: [{ type: "text", text: msg + note }], isError: true };
      }
    }
  );

  server.tool(
    "ml_roles_list",
    "List MarkLogic roles or inspect the full properties of a specific role. Requires the 'manage-user' " +
    "role on the connecting account.\n\n" +
    "• Omit role_name → returns all role names (for browsing the role hierarchy)\n" +
    "• Provide role_name → returns that role's description, parent roles, and privilege grants\n\n" +
    "Use this before ml_document_permissions to understand the role hierarchy. " +
    "Compare the roles a document requires against the roles a user holds to diagnose access denials.",
    {
      role_name: z.string().optional().describe(
        "Role name to inspect in detail. Omit to list all roles."
      ),
    },
    async ({ role_name }) => {
      try {
        if (role_name) {
          const props = await clients.security.getRoleProperties(role_name);
          return { content: [{ type: "text", text: JSON.stringify(props, null, 2) }] };
        }
        const roles = await clients.security.listRoles();
        if (roles.length === 0) {
          return { content: [{ type: "text", text: "No roles found in the Security database." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(roles, null, 2) }] };
      } catch (err) {
        const msg = toToolError(err);
        const note = msg.includes("401") || msg.includes("403")
          ? "\nHint: The connecting account lacks the 'manage-user' privilege. Ask a MarkLogic admin to grant this role."
          : "";
        return { content: [{ type: "text", text: msg + note }], isError: true };
      }
    }
  );

  server.tool(
    "ml_document_permissions",
    "Return the read/update/insert/execute permissions assigned to a specific document. " +
    "Requires the 'manage-user' role or that the connecting account can read the document.\n\n" +
    "DEFAULT DATABASE: When the 'database' parameter is omitted, the request goes to the " +
    "app server's configured default database — the same default used by ml_document_put. " +
    "Always pass the same 'database' value you used when writing the document; omitting it " +
    "on both calls keeps them consistent.\n\n" +
    "EMPTY RESULT: 'No explicit permissions found' means the document EXISTS but has no ACL " +
    "entries stored on it (written without a permissions parameter). The document may still be " +
    "accessible if the connecting user holds a role that grants broad access (e.g. admin). " +
    "This is different from a 404 error, which means the document was not found.\n\n" +
    "DIAGNOSIS WORKFLOW:\n" +
    "  1. ml_document_permissions — see which roles can access the document\n" +
    "  2. ml_roles_list role_name=<role> — inspect that role's privilege grants\n" +
    "  3. ml_users_list — confirm the user account exists\n" +
    "  Answer: user needs one of the document's roles assigned to their account.\n\n" +
    "capabilities returned:\n" +
    "  read   — user can retrieve the document\n" +
    "  update — user can replace/patch the document\n" +
    "  insert — user can insert a document at this URI\n" +
    "  execute — user can invoke this document as a module",
    {
      uri: z.string().describe("Document URI (e.g. /entities/person/12345.json)"),
      database: z.string().optional().describe("Database name. Defaults to the app server's configured database — the same default as ml_document_put. Pass explicitly to avoid ambiguity."),
    },
    async ({ uri, database }) => {
      try {
        const perms = await clients.security.getDocumentPermissions(uri, database);
        if (perms.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No explicit permissions found for ${uri}.\n` +
                "The document exists but has no ACL entries — it was likely written without a " +
                "permissions parameter. It may still be accessible via role-level grants on " +
                "the connecting account (e.g. admin or rest-admin roles).\n" +
                "To set permissions, re-write the document with ml_document_put and include " +
                "a permissions array, or verify the document exists first with ml_document_get.",
            }],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(perms, null, 2) }] };
      } catch (err) {
        const msg = toToolError(err);
        let note = "";
        if (msg.includes("401") || msg.includes("403")) {
          note =
            "\nHint: The connecting account lacks 'manage-user' or read access to this document. " +
            "Ask a MarkLogic admin to grant the 'manage-user' role or the appropriate document role.";
        } else if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
          // ML-1 / ML-2: paired ml_document_put + ml_document_permissions calls often
          // route to different default databases when neither passes `database` explicitly.
          // The put goes to the REST app server's content DB; the permissions GET goes to
          // the same default — but if the user passed `database` to one and not the other,
          // the URIs land in different databases and the 404 is opaque.
          note =
            `\nHint: 404 on permissions usually means the URI is not in the database this call routed to. ` +
            `Two common causes:\n` +
            `  1. You passed 'database' to ml_document_put but not here (or vice versa). Pass the SAME ` +
            `'database' value to both calls so they target the same content DB.\n` +
            `  2. The document URI was misspelled. Confirm with ml_document_get (using the same database param).\n` +
            `Note: a document that EXISTS but was written with no permissions returns "No explicit permissions found", ` +
            `not 404 — so this error means the URI is genuinely not in the targeted database.`;
        }
        return { content: [{ type: "text", text: msg + note }], isError: true };
      }
    }
  );
}
