import { z } from "zod";

export const ConnectionConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(8000),
  managementPort: z.coerce.number().int().min(1).max(65535).default(8002),
  username: z.string().default(""),
  password: z.string().default(""),
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
  authType: z.enum(["digest", "basic", "oauth"]).default("digest"),
  timeoutMs: z.coerce.number().int().positive().default(30000),
  /** Static OAuth token — used in stdio mode when ML_AUTH_TYPE=oauth (set via ML_OAUTH_TOKEN). */
  staticOauthToken: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.authType !== "oauth") {
    if (!data.username) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["username"], message: "Required when ML_AUTH_TYPE is not oauth" });
    }
    if (!data.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["password"], message: "Required when ML_AUTH_TYPE is not oauth" });
    }
  }
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
  /**
   * Express `trust proxy` setting — required when running behind a reverse proxy
   * (nginx, ALB, ingress) so that req.ip and X-Forwarded-For are interpreted correctly
   * by middleware like express-rate-limit. Accepts:
   *   - "true" / "false" → boolean
   *   - a number (e.g. "1") → trust that many hops
   *   - any other string → passed through to Express (IP list, "loopback", subnet, etc.)
   * Recommended: set to the exact number of proxies in front of the server (usually "1").
   * Setting "true" is discouraged because X-Forwarded-For becomes spoofable.
   */
  trustProxy: z
    .preprocess((val) => {
      if (val === "" || val === undefined || val === null) return undefined;
      if (typeof val !== "string") return val;
      if (val === "true") return true;
      if (val === "false") return false;
      if (/^\d+$/.test(val)) return Number(val);
      return val;
    }, z.union([z.boolean(), z.number().int().nonnegative(), z.string()]).optional()),
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

export const DhfConfigSchema = z.object({
  /**
   * Absolute path to the DHF client JAR (ML_DHF_CLIENT_JAR).
   * When set, enables the dhf_flow_run_jar tool for large-scale flow execution
   * without using MarkLogic eval. The Docker image pre-bundles the JAR at
   * /app/marklogic-data-hub-client.jar and sets this env var automatically.
   */
  clientJarPath: z.preprocess(val => (val === "" ? undefined : val), z.string().optional()),
  /**
   * DHF staging app server port (ML_DHF_PORT).
   * Defaults to ML_PORT. Set this explicitly when your DHF staging server runs
   * on a different port from the main MarkLogic REST endpoint (e.g. 8010).
   */
  port: z.coerce.number().int().min(1).max(65535).optional(),
  /**
   * DHF jobs app server port (ML_DHF_JOBS_PORT).
   * Used by dhf_flow_run_jar to pass -PmlJobPort to the client JAR.
   * When omitted, defaults to the staging port + 2 (the standard DHF on-premise
   * offset, e.g. staging=8020 → jobs=8022). Set explicitly for DHS or
   * non-standard port layouts.
   */
  jobsPort: z.coerce.number().int().min(1).max(65535).optional(),
});

export type DhfConfig = z.infer<typeof DhfConfigSchema>;

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
  dhf: DhfConfigSchema,
}).superRefine((data, ctx) => {
  if (data.connection.authType === "oauth" && data.transport === "stdio" && !data.connection.staticOauthToken) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["connection", "staticOauthToken"],
      message: "ML_OAUTH_TOKEN is required when ML_AUTH_TYPE=oauth in stdio mode (no HTTP request to extract a Bearer token from). Set ML_OAUTH_TOKEN=<your-jwt>.",
    });
  }
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
