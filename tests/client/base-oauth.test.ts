/**
 * Tests for MarkLogicBaseClient OAuth authentication behavior.
 *
 * These tests validate the OAuth token passthrough mode that was previously
 * untested: when authType="oauth", the client must attach the Bearer token
 * to requests and skip digest auth.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MarkLogicBaseClient } from "../../src/client/base.js";
import { initLogger } from "../../src/utils/logger.js";
import type { ConnectionConfig } from "../../src/config/schema.js";

beforeEach(() => {
  initLogger({ level: "error", format: "json" });
});

function makeConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    host: "localhost",
    port: 8000,
    managementPort: 8002,
    database: "Documents",
    username: "admin",
    password: "secret",
    authType: "digest",
    ssl: false,
    rejectUnauthorized: true,
    timeoutMs: 30000,
    staticOauthToken: undefined,
    ...overrides,
  };
}

// ── OAuth mode ────────────────────────────────────────────────────────────────

describe("MarkLogicBaseClient – oauth mode", () => {
  it("sets Bearer token on default headers when staticOauthToken is provided", () => {
    const client = new MarkLogicBaseClient(makeConfig({
      authType: "oauth",
      staticOauthToken: "my-jwt-token",
    }));

    const authHeader = client.http.defaults.headers.common["Authorization"] as string | undefined;
    expect(authHeader).toBe("Bearer my-jwt-token");
  });

  it("does not set Authorization header when oauth but no token", () => {
    const client = new MarkLogicBaseClient(makeConfig({
      authType: "oauth",
      staticOauthToken: undefined,
    }));

    const authHeader = client.http.defaults.headers.common["Authorization"] as string | undefined;
    expect(authHeader).toBeUndefined();
  });
});

// ── Basic mode ────────────────────────────────────────────────────────────────

describe("MarkLogicBaseClient – basic mode", () => {
  it("sets basic auth credentials on axios defaults", () => {
    const client = new MarkLogicBaseClient(makeConfig({
      authType: "basic",
      username: "admin",
      password: "pass",
    }));

    // Axios stores basic auth on instance.defaults.auth
    const auth = client.http.defaults.auth;
    expect(auth?.username).toBe("admin");
    expect(auth?.password).toBe("pass");
  });
});

// ── Digest mode ───────────────────────────────────────────────────────────────

describe("MarkLogicBaseClient – digest mode", () => {
  it("does NOT set auth on defaults (digest is interceptor-based)", () => {
    const client = new MarkLogicBaseClient(makeConfig({ authType: "digest" }));

    // Digest auth is handled by a response interceptor, not defaults.auth
    expect(client.http.defaults.auth).toBeUndefined();
    // And no static Authorization header either
    const authHeader = client.http.defaults.headers.common["Authorization"] as string | undefined;
    expect(authHeader).toBeUndefined();
  });
});

// ── SSL configuration ─────────────────────────────────────────────────────────

describe("MarkLogicBaseClient – SSL configuration", () => {
  it("builds https baseURL when ssl=true", () => {
    const client = new MarkLogicBaseClient(makeConfig({ ssl: true }));
    // The baseURL on the Axios instance reflects the scheme
    const baseURL = (client.http.defaults.baseURL as string) ?? "";
    expect(baseURL).toMatch(/^https:/);
  });

  it("builds http baseURL when ssl=false", () => {
    const client = new MarkLogicBaseClient(makeConfig({ ssl: false }));
    const baseURL = (client.http.defaults.baseURL as string) ?? "";
    expect(baseURL).toMatch(/^http:/);
  });
});

// ── Management port ───────────────────────────────────────────────────────────

describe("MarkLogicBaseClient – management port", () => {
  it("exposes http and mgmt as separate Axios instances", () => {
    const client = new MarkLogicBaseClient(makeConfig({
      port: 8000,
      managementPort: 8002,
    }));

    expect(client.http).not.toBe(client.mgmt);
    const httpBase = (client.http.defaults.baseURL as string) ?? "";
    const mgmtBase = (client.mgmt.defaults.baseURL as string) ?? "";
    expect(httpBase).toContain(":8000");
    expect(mgmtBase).toContain(":8002");
  });
});
