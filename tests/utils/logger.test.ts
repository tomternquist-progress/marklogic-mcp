import { describe, it, expect, beforeEach } from "vitest";
import { initLogger, getLogger, logger } from "../../src/utils/logger.js";
import type { LogConfig } from "../../src/config/schema.js";

// Reset module-level logger state between tests by re-importing with a fresh state.
// We test the exported API surface rather than internal Winston details.

describe("getLogger – before initialization", () => {
  it("throws when logger has not been initialized", () => {
    // We cannot guarantee module-level state is clean between test files, so
    // we test this indirectly: after initLogger runs, getLogger must succeed.
    // The only way to reliably test the uninitialized path is to import in
    // isolation — but since our tests share a module cache we just document it.
    // The behaviour IS tested implicitly by the throw check in the source.
    expect(() => {
      // This may or may not throw depending on test ordering; just verify no
      // exception type confusion
      try {
        getLogger();
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe("Logger not initialized");
        throw err;
      }
    }).toThrow();
  });
});

describe("initLogger + getLogger", () => {
  beforeEach(() => {
    // Re-initialize before each test so we always have a clean logger.
    const cfg: LogConfig = { level: "error", format: "json" };
    initLogger(cfg);
  });

  it("returns a logger instance after initialization", () => {
    const l = getLogger();
    expect(l).toBeDefined();
    expect(typeof l.info).toBe("function");
    expect(typeof l.error).toBe("function");
    expect(typeof l.warn).toBe("function");
    expect(typeof l.debug).toBe("function");
  });

  it("returns the same instance on repeated calls", () => {
    const a = getLogger();
    const b = getLogger();
    expect(a).toBe(b);
  });

  it("sets log level to the configured value", () => {
    initLogger({ level: "debug", format: "json" });
    const l = getLogger();
    expect(l.level).toBe("debug");
  });

  it("sets log level to warn", () => {
    initLogger({ level: "warn", format: "json" });
    const l = getLogger();
    expect(l.level).toBe("warn");
  });
});

describe("initLogger – format variants", () => {
  it("accepts json format without throwing", () => {
    expect(() => initLogger({ level: "info", format: "json" })).not.toThrow();
  });

  it("accepts pretty format without throwing", () => {
    expect(() => initLogger({ level: "info", format: "pretty" })).not.toThrow();
  });

  it("reinitializes when called a second time", () => {
    initLogger({ level: "info", format: "json" });
    expect(() => initLogger({ level: "warn", format: "pretty" })).not.toThrow();
    expect(getLogger().level).toBe("warn");
  });
});

describe("logger proxy", () => {
  beforeEach(() => {
    initLogger({ level: "error", format: "json" });
  });

  it("exposes info/error/warn/debug via proxy without throwing", () => {
    // The proxy forwards calls to getLogger(); calling methods should not throw.
    expect(() => logger.error("test error")).not.toThrow();
    expect(() => logger.warn("test warn")).not.toThrow();
    expect(() => logger.info("test info")).not.toThrow();
    expect(() => logger.debug("test debug")).not.toThrow();
  });

  it("is a Proxy object (not the real logger)", () => {
    // The exported `logger` constant is constructed as a Proxy — it should NOT
    // be the same reference as what getLogger() returns.
    expect(logger).not.toBe(getLogger());
  });
});
