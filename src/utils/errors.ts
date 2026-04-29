export class MarkLogicError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly mlCode?: string
  ) {
    super(message);
    this.name = "MarkLogicError";
  }
}

export class AuthenticationError extends MarkLogicError {
  constructor(host: string) {
    super(`Authentication failed for MarkLogic at ${host}`, 401);
    this.name = "AuthenticationError";
  }
}

export class NotFoundError extends MarkLogicError {
  constructor(uri: string) {
    super(`Document not found: ${uri}`, 404);
    this.name = "NotFoundError";
  }
}

export class WriteProtectedError extends Error {
  constructor() {
    super(
      "Write operation blocked: ML_READONLY=true. Set ML_READONLY=false to enable writes."
    );
    this.name = "WriteProtectedError";
  }
}

export class EvalDisabledError extends Error {
  constructor() {
    super(
      "Eval is disabled: ML_ALLOW_EVAL=false. Set ML_ALLOW_EVAL=true to enable server-side code execution."
    );
    this.name = "EvalDisabledError";
  }
}

export class ForbiddenError extends MarkLogicError {
  constructor(message: string) {
    super(message, 403);
    this.name = "ForbiddenError";
  }
}

/**
 * Append TDE-specific recovery hints when a MarkLogic error relates to a
 * missing or still-indexing TDE view. Used by optic.ts and schema.ts so the
 * same guidance surfaces regardless of which tool triggered the error.
 */
export function appendTdeHint(msg: string): string {
  if (msg.includes("SQL-TABLENOTFOUND") || (msg.includes("Table") && msg.includes("not found"))) {
    return msg + "\nHint: TDE templates must be stored in the Schemas database with collection 'http://marklogic.com/xdmp/tde'. Use ml_document_put (database='Schemas') to register your template, use ml_views_list to confirm the view exists, then use ml_schema_get_tde to verify it was applied.";
  }
  if (msg.includes("TABLEREINDEXING") || msg.includes("reindexing")) {
    return msg + "\nHint: The TDE view is still being built. Use ml_reindex_status (database='Documents') to check when reindex-count reaches 0, then retry.";
  }
  return msg;
}

/**
 * Append generic recovery hints for common HTTP statuses returned by MarkLogic.
 * Tools may append their own more-specific hints on top (e.g. appendTdeHint,
 * Optic column hints) — this provides a baseline so bare auth/permission/not-found
 * errors are always actionable.
 */
function appendHttpHint(msg: string, statusCode: number | undefined): string {
  if (statusCode === 401) {
    return msg + "\nHint: Authentication failed. Check ML_USERNAME / ML_PASSWORD and that ML_AUTH_TYPE (digest|basic|oauth) matches how the MarkLogic app server is configured.";
  }
  if (statusCode === 403) {
    return msg + "\nHint: Permission denied. The current user lacks the required privilege or role. Use ml_users_list / ml_roles_list to inspect roles, and ml_document_permissions to see per-document ACLs.";
  }
  if (statusCode === 404) {
    return msg + "\nHint: Not found. Verify the URI, collection, or database name. Use ml_document_list to browse available URIs or ml_collections_list to see collection names.";
  }
  return msg;
}

/** Convert any caught error into a human-readable string for MCP tool responses. */
export function toToolError(err: unknown): string {
  if (err instanceof WriteProtectedError || err instanceof EvalDisabledError) {
    return err.message;
  }
  if (err instanceof MarkLogicError) {
    const base = `MarkLogic error${err.statusCode ? ` (HTTP ${err.statusCode})` : ""}${err.mlCode ? ` [${err.mlCode}]` : ""}: ${err.message}`;
    return appendHttpHint(base, err.statusCode);
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
