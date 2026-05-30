#!/usr/bin/env node
import { loadConfig } from "./config/index.js";
import { initLogger, logger } from "./utils/logger.js";
import { createMcpServer } from "./server.js";
import { startStdioTransport } from "./transport/stdio.js";
import { startHttpTransport } from "./transport/http.js";
import { analyzeSecurityPosture } from "./utils/security-posture.js";

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

  // Surface security-posture warnings at startup so operators don't discover
  // a misconfiguration (readonly+eval, readonly with privileged user, etc.)
  // only after a bypass has already happened.
  const posture = analyzeSecurityPosture(config);
  for (const w of posture.warnings) {
    const log = w.severity === "critical"
      ? logger.error.bind(logger)
      : w.severity === "warning"
      ? logger.warn.bind(logger)
      : logger.info.bind(logger);
    log(`[security:${w.code}] ${w.message} Remedy: ${w.remedy}`);
  }

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
