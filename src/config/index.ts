import "dotenv/config";
import { AppConfigSchema, type AppConfig } from "./schema.js";

export function loadConfig(): AppConfig {
  const raw = {
    transport: process.env.MCP_TRANSPORT ?? "stdio",
    connection: {
      host: process.env.ML_HOST ?? "localhost",
      port: process.env.ML_PORT,
      managementPort: process.env.ML_MANAGEMENT_PORT,
      username: process.env.ML_USERNAME ?? "admin",
      password: process.env.ML_PASSWORD ?? "admin",
      database: process.env.ML_DATABASE ?? "Documents",
      ssl: process.env.ML_SSL,
      rejectUnauthorized: process.env.ML_SSL_REJECT_UNAUTHORIZED,
      authType: process.env.ML_AUTH_TYPE ?? "digest",
      timeoutMs: process.env.ML_TIMEOUT_MS,
    },
    safety: {
      readonly: process.env.ML_READONLY,
      allowEval: process.env.ML_ALLOW_EVAL,
    },
    http: {
      port: process.env.MCP_HTTP_PORT,
      host: process.env.MCP_HTTP_HOST,
      apiKey: process.env.MCP_API_KEY,
    },
    log: {
      level: process.env.LOG_LEVEL ?? "info",
      format: process.env.LOG_FORMAT ?? "json",
    },
    aws: {
      region: process.env.AWS_REGION,
      quicksightAccountId: process.env.AWS_QUICKSIGHT_ACCOUNT_ID,
    },
  };

  const result = AppConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}

export type { AppConfig };
