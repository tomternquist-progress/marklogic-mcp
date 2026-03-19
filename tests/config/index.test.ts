import { describe, it, expect, beforeEach, vi } from "vitest";

// We import loadConfig lazily inside each test via dynamic import so that
// the module is re-evaluated after we've set env vars.  Vitest caches modules,
// so we rely on vi.resetModules() between tests.

describe("loadConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  async function load() {
    const mod = await import("../../src/config/index.js");
    return mod.loadConfig();
  }

  it("loads valid config from environment variables", async () => {
    vi.stubEnv("ML_HOST", "myhost.example.com");
    vi.stubEnv("ML_USERNAME", "testuser");
    vi.stubEnv("ML_PASSWORD", "testpass");
    vi.stubEnv("ML_PORT", "9000");
    vi.stubEnv("ML_DATABASE", "MyDB");
    vi.stubEnv("ML_READONLY", "false");
    vi.stubEnv("ML_ALLOW_EVAL", "true");
    vi.stubEnv("MCP_TRANSPORT", "http");
    vi.stubEnv("LOG_LEVEL", "debug");
    vi.stubEnv("LOG_FORMAT", "pretty");

    const config = await load();

    expect(config.connection.host).toBe("myhost.example.com");
    expect(config.connection.username).toBe("testuser");
    expect(config.connection.password).toBe("testpass");
    expect(config.connection.port).toBe(9000);
    expect(config.connection.database).toBe("MyDB");
    expect(config.safety.readonly).toBe(false);
    expect(config.safety.allowEval).toBe(true);
    expect(config.transport).toBe("http");
    expect(config.log.level).toBe("debug");
    expect(config.log.format).toBe("pretty");
  });

  it("applies defaults when optional env vars are absent", async () => {
    vi.stubEnv("ML_HOST", "localhost");
    vi.stubEnv("ML_USERNAME", "admin");
    vi.stubEnv("ML_PASSWORD", "admin");
    // Explicitly clear optional vars that may be set in the real environment
    vi.stubEnv("ML_AUTH_TYPE", undefined as never);
    vi.stubEnv("MCP_TRANSPORT", undefined as never);
    vi.stubEnv("ML_PORT", undefined as never);
    vi.stubEnv("ML_DATABASE", undefined as never);
    vi.stubEnv("ML_READONLY", undefined as never);
    vi.stubEnv("ML_ALLOW_EVAL", undefined as never);
    vi.stubEnv("LOG_LEVEL", undefined as never);
    vi.stubEnv("LOG_FORMAT", undefined as never);

    const config = await load();

    expect(config.connection.port).toBe(8000);
    expect(config.connection.managementPort).toBe(8002);
    expect(config.connection.database).toBe("Documents");
    expect(config.connection.ssl).toBe(false);
    expect(config.connection.authType).toBe("digest");
    expect(config.safety.readonly).toBe(true);
    expect(config.safety.allowEval).toBe(false);
    expect(config.transport).toBe("stdio");
    expect(config.log.level).toBe("info");
    expect(config.log.format).toBe("json");
  });

  it("throws with a descriptive error message when host is empty", async () => {
    vi.stubEnv("ML_HOST", "");
    vi.stubEnv("ML_USERNAME", "admin");
    vi.stubEnv("ML_PASSWORD", "admin");

    await expect(load()).rejects.toThrow("Invalid configuration");
  });

  it("throws when username is empty", async () => {
    vi.stubEnv("ML_HOST", "localhost");
    vi.stubEnv("ML_USERNAME", "");
    vi.stubEnv("ML_PASSWORD", "admin");

    await expect(load()).rejects.toThrow("Invalid configuration");
  });

  it("throws when password is empty", async () => {
    vi.stubEnv("ML_HOST", "localhost");
    vi.stubEnv("ML_USERNAME", "admin");
    vi.stubEnv("ML_PASSWORD", "");

    await expect(load()).rejects.toThrow("Invalid configuration");
  });

  it("includes the failing field path in the error message", async () => {
    vi.stubEnv("ML_HOST", "");
    vi.stubEnv("ML_USERNAME", "admin");
    vi.stubEnv("ML_PASSWORD", "admin");

    await expect(load()).rejects.toThrow(/connection\.(host|username|password)/);
  });

  it("sets Flux runnerUrl from FLUX_RUNNER_URL env var", async () => {
    vi.stubEnv("ML_HOST", "localhost");
    vi.stubEnv("ML_USERNAME", "admin");
    vi.stubEnv("ML_PASSWORD", "admin");
    vi.stubEnv("FLUX_RUNNER_URL", "http://flux:8080");

    const config = await load();
    expect(config.flux.runnerUrl).toBe("http://flux:8080");
  });

  it("treats empty FLUX_RUNNER_URL as unconfigured (undefined)", async () => {
    vi.stubEnv("ML_HOST", "localhost");
    vi.stubEnv("ML_USERNAME", "admin");
    vi.stubEnv("ML_PASSWORD", "admin");
    vi.stubEnv("FLUX_RUNNER_URL", "");

    const config = await load();
    expect(config.flux.runnerUrl).toBeUndefined();
  });

  it("sets AWS config from environment", async () => {
    vi.stubEnv("ML_HOST", "localhost");
    vi.stubEnv("ML_USERNAME", "admin");
    vi.stubEnv("ML_PASSWORD", "admin");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_QUICKSIGHT_ACCOUNT_ID", "123456789012");

    const config = await load();
    expect(config.aws.region).toBe("us-east-1");
    expect(config.aws.quicksightAccountId).toBe("123456789012");
  });
});
