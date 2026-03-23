import { describe, it, expect } from "vitest";
import {
  ConnectionConfigSchema,
  SafetyConfigSchema,
  HttpConfigSchema,
  LogConfigSchema,
  FluxConfigSchema,
  AppConfigSchema,
} from "../../src/config/schema.js";

// ─── ConnectionConfigSchema ────────────────────────────────────────────────

describe("ConnectionConfigSchema", () => {
  const base = { host: "localhost", username: "admin", password: "admin" };

  it("accepts minimal valid config and applies defaults", () => {
    const result = ConnectionConfigSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.port).toBe(8000);
    expect(result.data.managementPort).toBe(8002);
    expect(result.data.database).toBe("Documents");
    expect(result.data.ssl).toBe(false);
    expect(result.data.rejectUnauthorized).toBe(true);
    expect(result.data.authType).toBe("digest");
    expect(result.data.timeoutMs).toBe(30000);
  });

  it("coerces port from string", () => {
    const result = ConnectionConfigSchema.safeParse({ ...base, port: "9000" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.port).toBe(9000);
  });

  it("coerces managementPort from string", () => {
    const result = ConnectionConfigSchema.safeParse({ ...base, managementPort: "8003" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.managementPort).toBe(8003);
  });

  it('transforms ssl "true" string to boolean true', () => {
    const result = ConnectionConfigSchema.safeParse({ ...base, ssl: "true" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ssl).toBe(true);
  });

  it('transforms ssl "false" string to boolean false', () => {
    const result = ConnectionConfigSchema.safeParse({ ...base, ssl: "false" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ssl).toBe(false);
  });

  it("accepts ssl as a boolean directly", () => {
    const result = ConnectionConfigSchema.safeParse({ ...base, ssl: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ssl).toBe(true);
  });

  it('transforms rejectUnauthorized "true" to boolean true', () => {
    const result = ConnectionConfigSchema.safeParse({ ...base, rejectUnauthorized: "true" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rejectUnauthorized).toBe(true);
  });

  it('transforms rejectUnauthorized "false" to boolean false', () => {
    const result = ConnectionConfigSchema.safeParse({ ...base, rejectUnauthorized: "false" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rejectUnauthorized).toBe(false);
  });

  it("accepts authType basic", () => {
    const result = ConnectionConfigSchema.safeParse({ ...base, authType: "basic" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.authType).toBe("basic");
  });

  it("accepts authType oauth", () => {
    const result = ConnectionConfigSchema.safeParse({ ...base, authType: "oauth" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.authType).toBe("oauth");
  });

  it("accepts oauth authType without username/password", () => {
    const result = ConnectionConfigSchema.safeParse({ host: "localhost", authType: "oauth" });
    expect(result.success).toBe(true);
  });

  it("rejects unknown authType", () => {
    expect(ConnectionConfigSchema.safeParse({ ...base, authType: "kerberos" }).success).toBe(false);
  });

  it("rejects empty host", () => {
    expect(ConnectionConfigSchema.safeParse({ ...base, host: "" }).success).toBe(false);
  });

  it("rejects empty username", () => {
    expect(ConnectionConfigSchema.safeParse({ ...base, username: "" }).success).toBe(false);
  });

  it("rejects empty password", () => {
    expect(ConnectionConfigSchema.safeParse({ ...base, password: "" }).success).toBe(false);
  });

  it("rejects port 0 (out of range)", () => {
    expect(ConnectionConfigSchema.safeParse({ ...base, port: 0 }).success).toBe(false);
  });

  it("rejects port 65536 (out of range)", () => {
    expect(ConnectionConfigSchema.safeParse({ ...base, port: 65536 }).success).toBe(false);
  });

  it("accepts port 1 (minimum valid)", () => {
    expect(ConnectionConfigSchema.safeParse({ ...base, port: 1 }).success).toBe(true);
  });

  it("accepts port 65535 (maximum valid)", () => {
    expect(ConnectionConfigSchema.safeParse({ ...base, port: 65535 }).success).toBe(true);
  });
});

// ─── SafetyConfigSchema ────────────────────────────────────────────────────

describe("SafetyConfigSchema", () => {
  it("defaults readonly to true (safe by default)", () => {
    const result = SafetyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.readonly).toBe(true);
  });

  it("defaults allowEval to false (disabled by default)", () => {
    const result = SafetyConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.allowEval).toBe(false);
  });

  it('readonly "false" string disables readonly', () => {
    const result = SafetyConfigSchema.safeParse({ readonly: "false" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.readonly).toBe(false);
  });

  it("readonly with any value other than \"false\" keeps readonly=true", () => {
    for (const val of ["true", "1", "yes", "FALSE", "0"]) {
      const result = SafetyConfigSchema.safeParse({ readonly: val });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.readonly).toBe(true);
    }
  });

  it('allowEval "true" string enables eval', () => {
    const result = SafetyConfigSchema.safeParse({ allowEval: "true" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.allowEval).toBe(true);
  });

  it("allowEval with any value other than \"true\" keeps allowEval=false", () => {
    for (const val of ["false", "1", "yes", "TRUE", "0"]) {
      const result = SafetyConfigSchema.safeParse({ allowEval: val });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.allowEval).toBe(false);
    }
  });

  it("accepts boolean values directly", () => {
    const r1 = SafetyConfigSchema.safeParse({ readonly: false, allowEval: true });
    expect(r1.success).toBe(true);
    if (r1.success) {
      expect(r1.data.readonly).toBe(false);
      expect(r1.data.allowEval).toBe(true);
    }
  });
});

// ─── HttpConfigSchema ──────────────────────────────────────────────────────

describe("HttpConfigSchema", () => {
  it("defaults to port 3000 and host 0.0.0.0", () => {
    const result = HttpConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.port).toBe(3000);
    expect(result.data.host).toBe("0.0.0.0");
    expect(result.data.apiKey).toBeUndefined();
  });

  it("accepts an optional apiKey", () => {
    const result = HttpConfigSchema.safeParse({ apiKey: "secret-token-xyz" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.apiKey).toBe("secret-token-xyz");
  });

  it("corsOrigin is undefined by default", () => {
    const result = HttpConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.corsOrigin).toBeUndefined();
  });

  it("accepts a corsOrigin value", () => {
    const result = HttpConfigSchema.safeParse({ corsOrigin: "https://app.example.com" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.corsOrigin).toBe("https://app.example.com");
  });

  it("treats empty string corsOrigin as undefined", () => {
    const result = HttpConfigSchema.safeParse({ corsOrigin: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.corsOrigin).toBeUndefined();
  });

  it("coerces port from string", () => {
    const result = HttpConfigSchema.safeParse({ port: "4000" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.port).toBe(4000);
  });
});

// ─── LogConfigSchema ───────────────────────────────────────────────────────

describe("LogConfigSchema", () => {
  it("defaults to info level and json format", () => {
    const result = LogConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.level).toBe("info");
    expect(result.data.format).toBe("json");
  });

  it("accepts valid log levels", () => {
    for (const level of ["debug", "info", "warn", "error"]) {
      expect(LogConfigSchema.safeParse({ level }).success).toBe(true);
    }
  });

  it("rejects invalid log level", () => {
    expect(LogConfigSchema.safeParse({ level: "verbose" }).success).toBe(false);
  });

  it("accepts pretty format", () => {
    const result = LogConfigSchema.safeParse({ format: "pretty" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.format).toBe("pretty");
  });

  it("rejects invalid format", () => {
    expect(LogConfigSchema.safeParse({ format: "xml" }).success).toBe(false);
  });
});

// ─── FluxConfigSchema ──────────────────────────────────────────────────────

describe("FluxConfigSchema", () => {
  it("treats empty string as undefined (not configured)", () => {
    const result = FluxConfigSchema.safeParse({ runnerUrl: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.runnerUrl).toBeUndefined();
  });

  it("accepts undefined runnerUrl", () => {
    const result = FluxConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.runnerUrl).toBeUndefined();
  });

  it("accepts a valid HTTP URL", () => {
    const result = FluxConfigSchema.safeParse({ runnerUrl: "http://localhost:8080" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.runnerUrl).toBe("http://localhost:8080");
  });

  it("accepts a valid HTTPS URL", () => {
    const result = FluxConfigSchema.safeParse({ runnerUrl: "https://flux.example.com/api" });
    expect(result.success).toBe(true);
  });

  it("rejects a non-empty invalid URL", () => {
    // Zod's z.string().url() uses the WHATWG URL parser; plain strings without a
    // recognised scheme (e.g. no "://") are rejected.
    expect(FluxConfigSchema.safeParse({ runnerUrl: "not-a-url" }).success).toBe(false);
    expect(FluxConfigSchema.safeParse({ runnerUrl: "just-a-hostname" }).success).toBe(false);
  });
});

// ─── AppConfigSchema (integration) ────────────────────────────────────────

describe("AppConfigSchema", () => {
  const validApp = {
    transport: "stdio",
    connection: { host: "localhost", username: "admin", password: "admin" },
    safety: {},
    http: {},
    log: {},
    aws: {},
    flux: {},
    semaphore: {},
    dhf: {},
  };

  it("accepts a complete valid config", () => {
    expect(AppConfigSchema.safeParse(validApp).success).toBe(true);
  });

  it("defaults transport to stdio", () => {
    const input = { ...validApp };
    delete (input as Record<string, unknown>).transport;
    const result = AppConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.transport).toBe("stdio");
  });

  it("accepts http transport", () => {
    const result = AppConfigSchema.safeParse({ ...validApp, transport: "http" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.transport).toBe("http");
  });

  it("rejects unknown transport", () => {
    expect(AppConfigSchema.safeParse({ ...validApp, transport: "grpc" }).success).toBe(false);
  });
});
