import winston from "winston";
import type { LogConfig } from "../config/schema.js";

let _logger: winston.Logger | null = null;

export function initLogger(config: LogConfig): void {
  const fmt =
    config.format === "pretty"
      ? winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp(),
          winston.format.printf(
            ({ timestamp, level, message, ...meta }) =>
              `${timestamp} ${level}: ${message}${Object.keys(meta).length ? " " + JSON.stringify(meta) : ""}`
          )
        )
      : winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        );

  _logger = winston.createLogger({
    level: config.level,
    format: fmt,
    // Always write to stderr to avoid corrupting stdio MCP stream
    transports: [new winston.transports.Console({ stderrLevels: ["debug", "info", "warn", "error"] })],
  });
}

export function getLogger(): winston.Logger {
  if (!_logger) throw new Error("Logger not initialized");
  return _logger;
}

export const logger = new Proxy({} as winston.Logger, {
  get(_, prop) {
    return (...args: unknown[]) => (getLogger() as unknown as Record<string, (...a: unknown[]) => void>)[prop as string]?.(...args);
  },
});
