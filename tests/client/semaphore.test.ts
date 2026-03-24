import { describe, it, expect, beforeEach } from "vitest";
import { SemaphoreClient } from "../../src/client/semaphore.js";
import type { SemaphoreConfig } from "../../src/config/schema.js";
import { initLogger } from "../../src/utils/logger.js";

// Initialize logger so SemaphoreClient can import it without throwing
beforeEach(() => {
  initLogger({ level: "error", format: "json" });
});

function makeConfig(overrides: Partial<SemaphoreConfig> = {}): SemaphoreConfig {
  return {
    host: undefined,
    url: undefined,
    scsPort: 5058,
    kmmPort: 5080,
    username: undefined,
    password: undefined,
    ssl: false,
    timeoutMs: 30000,
    ...overrides,
  };
}

// ── configured flag ───────────────────────────────────────────────────────────

describe("SemaphoreClient – configured flag", () => {
  it("is false when neither host nor url is set", () => {
    const client = new SemaphoreClient(makeConfig());
    expect(client.configured).toBe(false);
  });

  it("is true when host is set", () => {
    const client = new SemaphoreClient(makeConfig({ host: "semaphore.example.com" }));
    expect(client.configured).toBe(true);
  });

  it("is true when url override is set", () => {
    const client = new SemaphoreClient(makeConfig({ url: "http://semaphore:5058" }));
    expect(client.configured).toBe(true);
  });
});

// ── baseUrl construction ──────────────────────────────────────────────────────

describe("SemaphoreClient – baseUrl construction", () => {
  it("builds http baseUrl from host and scsPort", () => {
    const client = new SemaphoreClient(makeConfig({ host: "semaphore.example.com", scsPort: 5058 }));
    expect(client.baseUrl).toBe("http://semaphore.example.com:5058");
  });

  it("builds https baseUrl when ssl=true", () => {
    const client = new SemaphoreClient(makeConfig({ host: "semaphore.example.com", ssl: true }));
    expect(client.baseUrl).toBe("https://semaphore.example.com:5058");
  });

  it("uses explicit url override over host:port", () => {
    const client = new SemaphoreClient(makeConfig({
      host: "semaphore.example.com",
      url: "http://custom-semaphore:9999",
    }));
    expect(client.baseUrl).toBe("http://custom-semaphore:9999");
  });

  it("returns empty string when no host or url", () => {
    const client = new SemaphoreClient(makeConfig());
    expect(client.baseUrl).toBe("");
  });
});

// ── kmmBaseUrl construction ────────────────────────────────────────────────────

describe("SemaphoreClient – kmmBaseUrl construction", () => {
  it("builds KMM URL from host and kmmPort", () => {
    const client = new SemaphoreClient(makeConfig({ host: "semaphore.example.com", kmmPort: 5080 }));
    expect(client.kmmBaseUrl).toBe("http://semaphore.example.com:5080");
  });

  it("uses custom kmmPort", () => {
    const client = new SemaphoreClient(makeConfig({ host: "semaphore.example.com", kmmPort: 9080 }));
    expect(client.kmmBaseUrl).toBe("http://semaphore.example.com:9080");
  });

  it("returns empty string when no host", () => {
    const client = new SemaphoreClient(makeConfig({ url: "http://semaphore:5058" }));
    // url only sets CLS base, not KMM — kmmBaseUrl needs host
    expect(client.kmmBaseUrl).toBe("");
  });
});

// ── kmmConfigured flag ────────────────────────────────────────────────────────

describe("SemaphoreClient – kmmConfigured flag", () => {
  it("is false when no host", () => {
    const client = new SemaphoreClient(makeConfig({ username: "admin", password: "pass" }));
    expect(client.kmmConfigured).toBe(false);
  });

  it("is false when no credentials", () => {
    const client = new SemaphoreClient(makeConfig({ host: "semaphore.example.com" }));
    expect(client.kmmConfigured).toBe(false);
  });

  it("is true when host + credentials are all set", () => {
    const client = new SemaphoreClient(makeConfig({
      host: "semaphore.example.com",
      username: "admin",
      password: "secret",
    }));
    expect(client.kmmConfigured).toBe(true);
  });
});

// ── scsHost / scsPort (deprecated aliases) ────────────────────────────────────

describe("SemaphoreClient – scsHost/scsPort aliases", () => {
  it("scsHost returns the host", () => {
    const client = new SemaphoreClient(makeConfig({ host: "cls.example.com" }));
    expect(client.scsHost).toBe("cls.example.com");
  });

  it("scsPort returns the port", () => {
    const client = new SemaphoreClient(makeConfig({ scsPort: 5099 }));
    expect(client.scsPort).toBe(5099);
  });

  it("scsHost is undefined when no host set", () => {
    const client = new SemaphoreClient(makeConfig());
    expect(client.scsHost).toBeUndefined();
  });
});
