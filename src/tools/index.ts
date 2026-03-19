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
import { registerSuggestApproachTool } from "./suggest-approach.js";
import { registerFastTrackTools } from "./fasttrack.js";
import { registerSemaphoreTools } from "./semaphore.js";
import { registerExtensionTools } from "./extensions.js";
import { registerSecurityTools } from "./security.js";

export function registerAllTools(server: McpServer, clients: MarkLogicClients, config: AppConfig): void {
  registerSuggestApproachTool(server);
  registerAdminTools(server, clients);
  registerDocumentTools(server, clients, config.safety.readonly);
  registerSearchTools(server, clients);
  registerSchemaTools(server, clients);
  registerEvalTools(server, clients, config.safety.allowEval);
  registerGraphTools(server, clients);
  registerQuickSightTools(server, clients);
  registerOpticTools(server, clients);
  registerFluxTools(server, clients, config.connection.authType);
  registerFastTrackTools(server, clients, config.safety.readonly);
  registerSemaphoreTools(server, clients);
  registerExtensionTools(server, clients, config.safety.readonly);
  registerSecurityTools(server, clients);
}
