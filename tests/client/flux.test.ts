import { describe, it, expect, vi, beforeEach } from "vitest";
import { FluxClient } from "../../src/client/flux.js";
import type { ConnectionConfig } from "../../src/config/schema.js";

const mockConnection: ConnectionConfig = {
  host: "localhost",
  port: 8000,
  database: "Documents",
  username: "admin",
  password: "secret",
  authType: "digest",
  ssl: false,
  staticOauthToken: undefined,
};

// ── configured flag ───────────────────────────────────────────────────────────

describe("FluxClient – configured flag", () => {
  it("is false when no runnerUrl provided", () => {
    const client = new FluxClient(undefined, mockConnection);
    expect(client.configured).toBe(false);
  });

  it("is true when runnerUrl is provided", () => {
    const client = new FluxClient("http://flux-runner:8080", mockConnection);
    expect(client.configured).toBe(true);
  });
});

// ── connectionString ──────────────────────────────────────────────────────────

describe("FluxClient.connectionString", () => {
  it("builds connection string from config", () => {
    const client = new FluxClient("http://flux-runner:8080", mockConnection);
    expect(client.connectionString()).toBe("admin:secret@localhost:8000/Documents");
  });

  it("overrides database when provided", () => {
    const client = new FluxClient("http://flux-runner:8080", mockConnection);
    expect(client.connectionString("Schemas")).toBe("admin:secret@localhost:8000/Schemas");
  });
});

// ── authType ──────────────────────────────────────────────────────────────────

describe("FluxClient.authType", () => {
  it("returns the configured auth type", () => {
    const client = new FluxClient("http://flux-runner:8080", mockConnection);
    expect(client.authType).toBe("digest");
  });

  it("returns basic when configured", () => {
    const client = new FluxClient("http://flux-runner:8080", {
      ...mockConnection,
      authType: "basic",
    });
    expect(client.authType).toBe("basic");
  });
});

// ── run – not configured ──────────────────────────────────────────────────────

describe("FluxClient.run – not configured", () => {
  it("returns failure result with instructions when not configured", async () => {
    const client = new FluxClient(undefined, mockConnection);
    const result = await client.run(["import-delimited-files"]);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.output).toContain("FLUX_RUNNER_URL");
  });
});
