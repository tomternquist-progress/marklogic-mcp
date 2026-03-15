import { z } from "zod";

export const ConnectionConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(8000),
  managementPort: z.coerce.number().int().min(1).max(65535).default(8002),
  username: z.string().min(1),
  password: z.string().min(1),
  database: z.string().default("Documents"),
  ssl: z
    .string()
    .transform((v) => v === "true")
    .or(z.boolean())
    .default(false),
  rejectUnauthorized: z
    .string()
    .transform((v) => v === "true")
    .or(z.boolean())
    .default(true),
  authType: z.enum(["digest", "basic"]).default("digest"),
  timeoutMs: z.coerce.number().int().positive().default(30000),
});

export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

export const SafetyConfigSchema = z.object({
  readonly: z
    .string()
    .transform((v) => v !== "false")
    .or(z.boolean())
    .default(true),
  allowEval: z
    .string()
    .transform((v) => v === "true")
    .or(z.boolean())
    .default(false),
});

export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;

export const HttpConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
  apiKey: z.string().optional(),
});

export type HttpConfig = z.infer<typeof HttpConfigSchema>;

export const LogConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  format: z.enum(["json", "pretty"]).default("json"),
});

export type LogConfig = z.infer<typeof LogConfigSchema>;

export const AppConfigSchema = z.object({
  transport: z.enum(["stdio", "http"]).default("stdio"),
  connection: ConnectionConfigSchema,
  safety: SafetyConfigSchema,
  http: HttpConfigSchema,
  log: LogConfigSchema,
  aws: z.object({
    region: z.string().optional(),
    quicksightAccountId: z.string().optional(),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
