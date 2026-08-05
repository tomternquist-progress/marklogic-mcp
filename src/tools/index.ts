import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MarkLogicClients } from "../client/index.js";
import type { AppConfig } from "../config/index.js";
import { registerAdminTools } from "./admin.js";
import { registerDocumentTools } from "./documents.js";
import { registerSearchTools } from "./search.js";
import { registerSchemaTools } from "./schema.js";
import { registerEvalTools } from "./eval.js";
import { registerGraphTools } from "./graphs.js";
import { registerQuickSightTools } from "./quicksight.js";
import { registerOpticTools } from "./optic.js";
import { registerFluxTools } from "./flux.js";
import { registerFastTrackTools } from "./fasttrack.js";
import { registerSemaphoreTools } from "./semaphore.js";
import { registerExtensionTools } from "./extensions.js";
import { registerSecurityTools } from "./security.js";
import { registerPerformanceTools } from "./performance.js";
import { registerDhfTools } from "./dhf.js";
import { registerAnswerTools } from "./answer.js";

export function registerAllTools(server: McpServer, clients: MarkLogicClients, config: AppConfig): void {
  const { readonly, allowEval } = config.safety;
  // Eval can call any server-side write API (xdmp.documentInsert,
  // admin:database-create, sec:create-user, etc.) — so registering eval
  // tools alongside readonly defeats the safety belt entirely. Only register
  // them when readonly is OFF. Operators who need read-only complex queries
  // can set ML_READONLY=false and rely on MarkLogic role-based ACL instead.
  const effectiveAllowEval = allowEval && !readonly;

  registerAdminTools(server, clients, readonly);
  registerDocumentTools(server, clients, readonly);
  registerSearchTools(server, clients);
  registerSchemaTools(server, clients);
  registerEvalTools(server, clients, effectiveAllowEval);
  registerGraphTools(server, clients, readonly);
  registerQuickSightTools(server, clients);
  registerOpticTools(server, clients);
  registerFluxTools(server, clients, config.connection.authType, readonly);
  registerFastTrackTools(server, clients, readonly);
  registerSemaphoreTools(server, clients);
  registerExtensionTools(server, clients, readonly);
  registerSecurityTools(server, clients);
  registerPerformanceTools(server, clients, effectiveAllowEval);
  registerDhfTools(server, clients, effectiveAllowEval, readonly, config.dhf, config.connection);
  registerAnswerTools(server, clients);
}
