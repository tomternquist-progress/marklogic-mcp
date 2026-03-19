#!/usr/bin/env node
import { loadConfig } from "./config/index.js";
import { initLogger, logger } from "./utils/logger.js";
import { createMcpServer } from "./server.js";
import { startStdioTransport } from "./transport/stdio.js";
import { startHttpTransport } from "./transport/http.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config.log);

  const ml = config.connection;
  logger.info("Starting MarkLogic MCP server", {
    transport: config.transport,
    host: `${ml.host}:${ml.port}`,
    database: ml.database,
    readonly: config.safety.readonly,
    allowEval: config.safety.allowEval,
  });

  if (config.transport === "http") {
    await startHttpTransport(
      (oauthToken?: string) => createMcpServer(config, oauthToken),
      config.http,
      config.connection.authType
    );
  } else {
    const server = createMcpServer(config);
    await startStdioTransport(server);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
