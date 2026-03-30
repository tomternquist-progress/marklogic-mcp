import { describe, it, expect, beforeEach } from "vitest";

// ── Isolate logger module state between tests by re-importing fresh each time ──
// The logger module holds a module-level singleton (_logger). To test initialization
// and the "not initialized" guard independently, we use vi.resetModules() so each
// test gets a fresh module instance.

import { vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

// ─── initLogger + getLogger ───────────────────────────────────────────────────

describe("initLogger / getLogger", () => {
  it("getLogger throws before initLogger is called", async () => {
    const { getLogger } = await import("../../src/utils/logger.js");
    expect(() => getLogger()).toThrow("Logger not initialized");
  });

  it("getLogger returns a logger after initLogger is called (json format)", async () => {
    const { initLogger, getLogger } = await import("../../src/utils/logger.js");
    initLogger({ level: "info", format: "json" });
    const log = getLogger();
    expect(log).toBeDefined();
    expect(typeof log.info).toBe("function");
  });

  it("getLogger returns a logger after initLogger is called (pretty format)", async () => {
    const { initLogger, getLogger } = await import("../../src/utils/logger.js");
    initLogger({ level: "debug", format: "pretty" });
    const log = getLogger();
    expect(log).toBeDefined();
  });

  it("calling initLogger twice replaces the logger instance", async () => {
    const { initLogger, getLogger } = await import("../../src/utils/logger.js");
    initLogger({ level: "error", format: "json" });
    const first = getLogger();
    initLogger({ level: "warn", format: "json" });
    const second = getLogger();
    // After second init the returned logger changes (different instance)
    expect(second).not.toBe(first);
  });
});

// ─── logger proxy ─────────────────────────────────────────────────────────────

describe("logger proxy", () => {
  it("proxied logger delegates method calls to the real logger", async () => {
    const { initLogger, logger } = await import("../../src/utils/logger.js");
    initLogger({ level: "debug", format: "json" });
    // Calling logger.info() should not throw — it delegates to the underlying winston logger
    expect(() => logger.info("proxy test message")).not.toThrow();
  });

  it("proxied logger throws (via getLogger) when not initialized", async () => {
    const { logger } = await import("../../src/utils/logger.js");
    // The proxy forwards the call to getLogger() which throws
    expect(() => logger.info("uninitialised")).toThrow("Logger not initialized");
  });
});
