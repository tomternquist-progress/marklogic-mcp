/**
 * Extended integration tests for ExtensionsClient — covers ml_extension_call
 * (calling an installed REST extension via GET/POST).
 *
 * The base extensions lifecycle (list/put/get/delete) is tested in extensions.test.ts.
 * This file tests actually CALLING an installed extension.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const EXT_NAME = "integration-test-callable";

// A simple REST extension that returns a JSON response
const EXT_CODE = `
'use strict';
// REST extension: GET handler returns { called: true, method: "GET", params: {...} }
exports.GET = function(context, params, input) {
  context.outputTypes = ['application/json'];
  const label = (params.label && params.label[0]) || 'default';
  return { called: true, method: 'GET', label: label };
};
exports.POST = function(context, params, input) {
  context.outputTypes = ['application/json'];
  const body = input.toObject ? input.toObject() : {};
  return { called: true, method: 'POST', received: body };
};
`.trim();

describeIfLive("ExtensionsClient call (live)", () => {
  const { extensions } = buildClients();

  beforeAll(async () => {
    await extensions.putExtension(EXT_NAME, EXT_CODE, "application/javascript");
    // Wait a moment for the extension to register
    await new Promise((r) => setTimeout(r, 1000));
  }, 20_000);

  afterAll(async () => {
    try { await extensions.deleteExtension(EXT_NAME); } catch { /* ignore */ }
  });

  describe("callExtension (GET)", () => {
    it("calls the extension and returns a response", async () => {
      const result = await extensions.callExtension(EXT_NAME, "GET");
      expect(result).toBeDefined();
    });

    it("returns the expected JSON shape from the GET handler", async () => {
      const result = await extensions.callExtension(EXT_NAME, "GET");
      const body = result as Record<string, unknown>;
      expect(body.called).toBe(true);
      expect(body.method).toBe("GET");
    });

    it("passes query parameters to the extension", async () => {
      const result = await extensions.callExtension(EXT_NAME, "GET", { label: "hello" });
      const body = result as Record<string, unknown>;
      // The extension echoes the label param
      expect(body.label).toBe("hello");
    });
  });

  describe("callExtension (POST)", () => {
    it("calls the extension via POST without error", async () => {
      const result = await extensions.callExtension(EXT_NAME, "POST", {}, { greeting: "world" });
      expect(result).toBeDefined();
    });

    it("returns the expected JSON shape from the POST handler", async () => {
      const result = await extensions.callExtension(EXT_NAME, "POST", {}, { test: true });
      const body = result as Record<string, unknown>;
      expect(body.called).toBe(true);
      expect(body.method).toBe("POST");
    });
  });
});
