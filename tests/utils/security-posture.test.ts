import { describe, it, expect } from "vitest";
import { analyzeSecurityPosture, renderSecurityPosture } from "../../src/utils/security-posture.js";

function makeConfig(overrides: Partial<{
  readonly: boolean;
  allowEval: boolean;
  username: string;
  authType: "digest" | "basic" | "oauth";
  ssl: boolean;
  rejectUnauthorized: boolean;
}> = {}) {
  return {
    safety: {
      readonly: overrides.readonly ?? true,
      allowEval: overrides.allowEval ?? false,
    },
    connection: {
      host: "h",
      port: 8000,
      managementPort: 8002,
      username: overrides.username ?? "appuser",
      password: "x",
      database: "Documents",
      ssl: overrides.ssl ?? false,
      rejectUnauthorized: overrides.rejectUnauthorized ?? true,
      authType: overrides.authType ?? "digest",
      timeoutMs: 30000,
    },
  } as never;
}

describe("analyzeSecurityPosture", () => {
  it("flags readonly+allowEval as critical (eval defeats readonly)", () => {
    const posture = analyzeSecurityPosture(makeConfig({ readonly: true, allowEval: true }));
    const critical = posture.warnings.find((w) => w.code === "READONLY_DEFEATED_BY_EVAL");
    expect(critical?.severity).toBe("critical");
    expect(critical?.message).toMatch(/inconsistent|defeats|bypass/i);
  });

  it("warns when readonly is set with an admin-looking username", () => {
    const posture = analyzeSecurityPosture(makeConfig({ readonly: true, username: "admin" }));
    const warn = posture.warnings.find((w) => w.code === "READONLY_WITH_PRIVILEGED_USER");
    expect(warn?.severity).toBe("warning");
    expect(warn?.remedy).toMatch(/role/i);
    expect(posture.usernameHint).toBe("admin");
  });

  it("reports a clean readonly posture with no warnings of severity>info", () => {
    const posture = analyzeSecurityPosture(makeConfig({ readonly: true, allowEval: false, username: "rest-reader" }));
    const elevated = posture.warnings.filter((w) => w.severity !== "info");
    expect(elevated).toHaveLength(0);
    expect(posture.warnings.some((w) => w.code === "READONLY_POSTURE_OK")).toBe(true);
  });

  it("returns no warnings at all when readonly is off", () => {
    const posture = analyzeSecurityPosture(makeConfig({ readonly: false, allowEval: true, username: "admin" }));
    expect(posture.warnings).toEqual([]);
  });

  it("warns when TLS is enabled but certificate verification is disabled", () => {
    const posture = analyzeSecurityPosture(makeConfig({ ssl: true, rejectUnauthorized: false }));
    const warn = posture.warnings.find((w) => w.code === "TLS_VERIFICATION_DISABLED");
    expect(warn?.severity).toBe("warning");
    expect(warn?.message).toMatch(/man-in-the-middle/i);
  });

  it("does not warn about TLS when verification is enabled", () => {
    const posture = analyzeSecurityPosture(makeConfig({ ssl: true, rejectUnauthorized: true }));
    expect(posture.warnings.some((w) => w.code === "TLS_VERIFICATION_DISABLED")).toBe(false);
  });

  it("reports the TLS warning independent of the readonly posture", () => {
    const posture = analyzeSecurityPosture(makeConfig({ readonly: false, ssl: true, rejectUnauthorized: false }));
    expect(posture.warnings.some((w) => w.code === "TLS_VERIFICATION_DISABLED")).toBe(true);
  });
});

describe("renderSecurityPosture", () => {
  it("includes the structural-limits reminder when warnings exist", () => {
    const posture = analyzeSecurityPosture(makeConfig({ readonly: true, allowEval: true }));
    const out = renderSecurityPosture(posture);
    expect(out).toMatch(/TOOL-LAYER safety belt/);
    expect(out).toMatch(/MarkLogic role/);
  });

  it("renders a 'no warnings' line when posture is clean and there are no info warnings", () => {
    const posture = { ...analyzeSecurityPosture(makeConfig({ readonly: false })), warnings: [] };
    const out = renderSecurityPosture(posture);
    expect(out).toMatch(/No warnings/);
  });
});
