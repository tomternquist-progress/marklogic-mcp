import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config/index.js";
import { createClients } from "./client/index.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources/index.js";
import { registerAllPrompts } from "./prompts/index.js";

export function createMcpServer(config: AppConfig, oauthToken?: string): McpServer {
  const server = new McpServer({
    name: "marklogic-mcp",
    version: "0.1.0",
  });

  const clients = createClients(config, oauthToken);

  registerAllTools(server, clients, config);
  registerAllResources(server, clients, config);
  registerAllPrompts(server);

  return server;
}
