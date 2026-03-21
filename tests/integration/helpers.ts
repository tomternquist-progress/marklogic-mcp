/**
 * Shared helpers for integration tests.
 *
 * Tests use the following env vars (all required when running integration tests):
 *   ML_HOST       — MarkLogic hostname (e.g. 192.168.175.200 or localhost)
 *   ML_PORT       — REST API port (default: 8000)
 *   ML_USER       — username (default: admin)
 *   ML_PASSWORD   — password (default: admin)
 *   ML_AUTH_TYPE  — auth type (default: digest)
 *
 * All integration tests are guarded with:
 *   const itLive = ML_HOST ? it : it.skip;
 * so they are silently skipped in CI unless ML_HOST is set.
 */

import { initLogger } from "../../src/utils/logger.js";
import { MarkLogicBaseClient } from "../../src/client/base.js";

// Initialise the Winston logger that MarkLogicBaseClient.mapError() uses
initLogger({ level: "warn", format: "json" });
import { AdminClient } from "../../src/client/admin.js";
import { DocumentsClient } from "../../src/client/documents.js";
import { SearchClient } from "../../src/client/search.js";
import { EvalClient } from "../../src/client/eval.js";
import { SchemaClient } from "../../src/client/schema.js";
import { SecurityClient } from "../../src/client/security.js";
import { PerformanceClient } from "../../src/client/performance.js";
import { GraphsClient } from "../../src/client/graphs.js";
import { OpticClient } from "../../src/client/optic.js";
import { ExtensionsClient } from "../../src/client/extensions.js";
import { FastTrackClient } from "../../src/client/fasttrack.js";

export const ML_HOST = process.env.ML_HOST ?? "";
export const ML_PORT = parseInt(process.env.ML_PORT ?? "8000", 10);
export const ML_MGMT_PORT = parseInt(process.env.ML_MGMT_PORT ?? "8002", 10);
export const ML_USER = process.env.ML_USER ?? "admin";
export const ML_PASSWORD = process.env.ML_PASSWORD ?? "admin";
export const ML_AUTH_TYPE = (process.env.ML_AUTH_TYPE ?? "digest") as "digest" | "basic" | "oauth";

/** Build a real base client from env vars. Throws if ML_HOST is unset. */
export function buildBase(): MarkLogicBaseClient {
  if (!ML_HOST) throw new Error("ML_HOST not set — integration tests require a live MarkLogic instance");
  return new MarkLogicBaseClient({
    host: ML_HOST,
    port: ML_PORT,
    managementPort: ML_MGMT_PORT,
    username: ML_USER,
    password: ML_PASSWORD,
    authType: ML_AUTH_TYPE,
    database: "Documents",
    ssl: false,
    rejectUnauthorized: true,
    timeoutMs: 30_000,
  });
}

export function buildClients() {
  const base = buildBase();
  const search = new SearchClient(base);
  const admin = new AdminClient(base);
  return {
    base,
    admin,
    documents: new DocumentsClient(base, false),
    search,
    eval: new EvalClient(base, true),
    schema: new SchemaClient(base, search, admin),
    security: new SecurityClient(base),
    performance: new PerformanceClient(base),
    graphs: new GraphsClient(base),
    optic: new OpticClient(base),
    extensions: new ExtensionsClient(base),
    fasttrack: new FastTrackClient(base, false),
  };
}
