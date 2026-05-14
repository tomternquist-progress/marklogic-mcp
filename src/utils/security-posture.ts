// Inspects the loaded config and reports security misconfigurations.
// Output is consumed at startup (logged loudly) and exposed via the
// marklogic://security resource so operators can introspect at runtime.
//
// Important context: the MCP server's ML_READONLY flag is a tool-layer
// safety belt — it controls which tools the server registers. It does NOT
// restrict the underlying MarkLogic user's privileges. A user with shell
// access to the same machine can read the MCP server's credentials and
// call MarkLogic directly. For true read-only protection, the operator
// must provision a MarkLogic user with a read-only role.

import type { AppConfig } from "../config/index.js";

export type WarningSeverity = "info" | "warning" | "critical";

export interface SecurityWarning {
  severity: WarningSeverity;
  code: string;
  message: string;
  remedy: string;
}

export interface SecurityPosture {
  readonly: boolean;
  allowEval: boolean;
  authType: string;
  usernameHint: string | undefined;
  warnings: SecurityWarning[];
}

/** Best-effort heuristic that the configured user looks like an admin user.
 *  Used only for warning purposes; we never call MarkLogic to verify. */
function looksLikeAdminUser(username: string | undefined): boolean {
  if (!username) return false;
  return /^(admin|root|superuser|sysadmin)$/i.test(username);
}

export function analyzeSecurityPosture(config: AppConfig): SecurityPosture {
  const warnings: SecurityWarning[] = [];
  const { safety, connection } = config;
  const usernameHint = looksLikeAdminUser(connection.username) ? connection.username : undefined;

  // Critical: readonly is meaningful only if writes are blocked from BOTH the
  // tool layer AND the credential layer. If the configured user has admin
  // privileges, the safety belt only protects the MCP tool surface — any
  // process on the same host with access to the credentials can bypass it.
  if (safety.readonly && usernameHint) {
    warnings.push({
      severity: "warning",
      code: "READONLY_WITH_PRIVILEGED_USER",
      message:
        `ML_READONLY=true is configured but ML_USERNAME="${connection.username}" looks like a privileged ` +
        `account. The readonly flag only blocks the MCP server's own write tools; it does NOT restrict ` +
        `what the underlying MarkLogic user can do.`,
      remedy:
        `For true read-only protection, create a MarkLogic role with only read privileges and a user ` +
        `bound to that role, then set ML_USERNAME/ML_PASSWORD to those credentials.`,
    });
  }

  // Critical: ML_ALLOW_EVAL grants xdmp.eval, which can execute any server-side
  // write (xdmp.documentInsert, admin:database-create, sec:create-user). It
  // completely defeats ML_READONLY. We now disable eval tools when readonly
  // is on; flag it loudly so operators understand why their eval tools are
  // missing.
  if (safety.readonly && safety.allowEval) {
    warnings.push({
      severity: "critical",
      code: "READONLY_DEFEATED_BY_EVAL",
      message:
        `ML_READONLY=true and ML_ALLOW_EVAL=true together are inconsistent — server-side eval can ` +
        `execute any write (xdmp.documentInsert, admin:database-create, sec:create-user, etc.), ` +
        `completely bypassing the readonly safety belt.`,
      remedy:
        `Eval tools are not registered when ML_READONLY=true. Either set ML_READONLY=false (and rely on ` +
        `MarkLogic role-based ACL for write protection), or set ML_ALLOW_EVAL=false to keep readonly meaningful.`,
    });
  }

  // Info: a meaningful readonly posture exists.
  if (safety.readonly && !usernameHint && !safety.allowEval) {
    warnings.push({
      severity: "info",
      code: "READONLY_POSTURE_OK",
      message:
        `ML_READONLY=true is active and the configured user does not look privileged. ` +
        `Tool-layer writes are blocked; verify your MarkLogic role is also read-only for defence in depth.`,
      remedy:
        `Confirm the MarkLogic user has been granted only the privileges needed for read operations. ` +
        `Tool-layer readonly is a safety belt, not a credential boundary.`,
    });
  }

  return {
    readonly: safety.readonly,
    allowEval: safety.allowEval,
    authType: connection.authType,
    usernameHint,
    warnings,
  };
}

/** Render a posture summary as a multi-line string for logging or the
 *  marklogic://security resource. */
export function renderSecurityPosture(posture: SecurityPosture): string {
  const lines: string[] = [
    "MARKLOGIC MCP — SECURITY POSTURE",
    "═════════════════════════════════",
    `  readonly         : ${posture.readonly}`,
    `  allowEval        : ${posture.allowEval}`,
    `  authType         : ${posture.authType}`,
    posture.usernameHint ? `  username (hint)  : ${posture.usernameHint} (looks privileged)` : `  username         : (not flagged)`,
    "",
  ];
  if (!posture.warnings.length) {
    lines.push("No warnings.");
    return lines.join("\n");
  }
  lines.push("Warnings:");
  for (const w of posture.warnings) {
    lines.push(`  [${w.severity.toUpperCase()}] ${w.code}`);
    lines.push(`    ${w.message}`);
    lines.push(`    Remedy: ${w.remedy}`);
    lines.push("");
  }
  lines.push(
    "REMINDER: ML_READONLY is a TOOL-LAYER safety belt. It controls which MCP tools",
    "this server registers — it does NOT restrict the underlying MarkLogic user.",
    "For true read-only protection, use a MarkLogic role with only read privileges."
  );
  return lines.join("\n");
}
