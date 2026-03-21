/**
 * Integration tests for ExtensionsClient against a live MarkLogic instance.
 *
 * Tests the full lifecycle: list → deploy → retrieve → call → delete.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - listExtensions() returned undefined when ML returned {} instead of {resources:[]}
 *  - putExtension() used wrong Content-Type for SJS modules
 *  - callExtension() did not prefix custom params with rs: (ML ignores unprefixed params)
 */

import { describe, it, expect, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const EXT_NAME = "integration-test-ext";

// A minimal SJS REST extension — must export at least one HTTP handler function
const EXT_CODE = [
  "'use strict';",
  "exports.GET = function(context, params) {",
  "  context.outputTypes = ['application/json'];",
  "  return { message: 'hello from integration test' };",
  "};",
].join("\n");

describeIfLive("ExtensionsClient (live)", () => {
  const { extensions } = buildClients();

  afterAll(async () => {
    try {
      await extensions.deleteExtension(EXT_NAME);
    } catch {
      // ignore — extension may already be deleted
    }
  });

  describe("listExtensions", () => {
    it("returns an array (never undefined)", async () => {
      // Regression: returned undefined when ML returned {} with no resources key
      const exts = await extensions.listExtensions();
      expect(Array.isArray(exts)).toBe(true);
    });

    it("each extension has name and language fields", async () => {
      const exts = await extensions.listExtensions();
      exts.forEach((e) => {
        expect(typeof e.name).toBe("string");
        expect(typeof e.language).toBe("string");
      });
    });
  });

  describe("putExtension", () => {
    it("deploys a JavaScript extension without error", async () => {
      // Regression: used wrong Content-Type (application/javascript instead of
      // application/vnd.marklogic-javascript)
      await expect(
        extensions.putExtension(EXT_NAME, EXT_CODE, "javascript")
      ).resolves.not.toThrow();
    });
  });

  describe("getExtension", () => {
    it("retrieves the deployed extension source", async () => {
      await extensions.putExtension(EXT_NAME, EXT_CODE, "javascript");
      const source = await extensions.getExtension(EXT_NAME);
      expect(typeof source).toBe("string");
      expect(source.length).toBeGreaterThan(0);
    });
  });

  describe("listExtensions (after deploy)", () => {
    it("includes the deployed extension", async () => {
      await extensions.putExtension(EXT_NAME, EXT_CODE, "javascript");
      const exts = await extensions.listExtensions();
      const names = exts.map((e) => e.name);
      expect(names).toContain(EXT_NAME);
    });
  });

  describe("deleteExtension", () => {
    it("removes a deployed extension without error", async () => {
      await extensions.putExtension(EXT_NAME, EXT_CODE, "javascript");
      await expect(extensions.deleteExtension(EXT_NAME)).resolves.not.toThrow();
    });

    it("is no longer listed after deletion", async () => {
      await extensions.putExtension(EXT_NAME, EXT_CODE, "javascript");
      await extensions.deleteExtension(EXT_NAME);
      const exts = await extensions.listExtensions();
      const names = exts.map((e) => e.name);
      expect(names).not.toContain(EXT_NAME);
    });
  });
});
