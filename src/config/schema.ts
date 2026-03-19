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
  corsOrigin: z.preprocess(val => (val === "" ? undefined : val), z.string().optional()),
});

export type HttpConfig = z.infer<typeof HttpConfigSchema>;

export const LogConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  format: z.enum(["json", "pretty"]).default("json"),
});

export type LogConfig = z.infer<typeof LogConfigSchema>;

export const FluxConfigSchema = z.object({
  // Empty string (unset env var) is treated as "not configured" rather than a validation error
  runnerUrl: z.preprocess(val => (val === "" ? undefined : val), z.string().url().optional()),
});

export type FluxConfig = z.infer<typeof FluxConfigSchema>;

const optionalUrl = z.preprocess(val => (val === "" ? undefined : val), z.string().url().optional());
const optionalString = z.preprocess(val => (val === "" ? undefined : val), z.string().optional());

export const SemaphoreConfigSchema = z.object({
  /**
   * Semaphore host (mirrors ML_HOST pattern).
   * Used to construct SCS and KMM URLs automatically.
   */
  host: optionalString,
  /** Classification Server (SCS) port — default 5058 */
  scsPort: z.coerce.number().int().min(1).max(65535).default(5058),
  /** Semaphore Studio / KMM port — default 5080 */
  kmmPort: z.coerce.number().int().min(1).max(65535).default(5080),
  /** KMM username (for Semaphore Studio REST API authentication) */
  username: optionalString,
  /** KMM password */
  password: optionalString,
  ssl: z
    .string()
    .transform((v) => v === "true")
    .or(z.boolean())
    .default(false),
  timeoutMs: z.coerce.number().int().positive().default(30000),
  /**
   * Explicit SCS base URL override (backward compatibility with SEMAPHORE_URL).
   * When set, takes precedence over host:scsPort for the Classification Server.
   * Typically http://<host>:5058
   */
  url: optionalUrl,
});

export type SemaphoreConfig = z.infer<typeof SemaphoreConfigSchema>;

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
  flux: FluxConfigSchema,
  semaphore: SemaphoreConfigSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
