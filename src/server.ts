import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config/index.js";
import { createClients } from "./client/index.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources/index.js";
import { registerAllPrompts } from "./prompts/index.js";

export function createMcpServer(config: AppConfig): McpServer {
  const server = new McpServer({
    name: "marklogic-mcp",
    version: "0.1.0",
  });

  const clients = createClients(
    config.connection,
    config.safety.readonly,
    config.safety.allowEval
  );

  registerAllTools(server, clients, config);
  registerAllResources(server, clients);
  registerAllPrompts(server);

  return server;
}
