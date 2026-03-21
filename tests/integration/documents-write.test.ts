/**
 * Integration tests for DocumentsClient write operations against a live MarkLogic instance.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - put() serialized multiple collections as collection[]=A&collection[]=B which ML
 *    rejects with REST-UNSUPPORTEDPARAM; fixed to repeat collection=A&collection=B
 *  - del() used wrong param name causing documents to not be deleted
 *  - patchDocument() patch envelope format rejected by ML
 *  - list() used /v1/documents (single-doc endpoint) instead of /v1/search
 */

import { describe, it, expect, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const TEST_URI = "/integration-test/documents-write-test.json";
const TEST_CONTENT = JSON.stringify({ title: "Write test", value: 42, tags: ["a", "b"] });
const TEST_COLLECTION = "integration-test-docs";

describeIfLive("DocumentsClient write (live)", () => {
  const { documents } = buildClients();

  afterAll(async () => {
    try { await documents.del(TEST_URI); } catch { /* ignore */ }
  });

  describe("put", () => {
    it("writes a JSON document without error", async () => {
      await expect(
        documents.put(TEST_URI, TEST_CONTENT, "application/json")
      ).resolves.not.toThrow();
    });

    it("written document is retrievable", async () => {
      await documents.put(TEST_URI, TEST_CONTENT, "application/json");
      const result = await documents.get(TEST_URI);
      expect(result.uri).toBe(TEST_URI);
      expect((result.content as Record<string, unknown>).title).toBe("Write test");
    });

    it("assigns multiple collections without REST-UNSUPPORTEDPARAM", async () => {
      // Regression: collection[]=A&collection[]=B rejected by ML — fixed to collection=A&collection=B
      await documents.put(TEST_URI, TEST_CONTENT, "application/json", {
        collections: [TEST_COLLECTION, "integration-test-extra"],
      });
      const result = await documents.get(TEST_URI, undefined, true);
      expect(result.metadata?.collections).toContain(TEST_COLLECTION);
      expect(result.metadata?.collections).toContain("integration-test-extra");
    });
  });

  describe("list", () => {
    it("lists documents in a collection", async () => {
      await documents.put(TEST_URI, TEST_CONTENT, "application/json", {
        collections: [TEST_COLLECTION],
      });
      const result = await documents.list({ collection: TEST_COLLECTION });
      expect(Array.isArray(result.uris)).toBe(true);
      expect(result.uris).toContain(TEST_URI);
      expect(typeof result.total).toBe("number");
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it("lists documents in a directory", async () => {
      await documents.put(TEST_URI, TEST_CONTENT, "application/json");
      const result = await documents.list({ directory: "/integration-test/" });
      expect(result.uris).toContain(TEST_URI);
    });

    it("respects pageLength", async () => {
      const result = await documents.list({ collection: TEST_COLLECTION, pageLength: 1 });
      expect(result.uris.length).toBeLessThanOrEqual(1);
      expect(result.pageLength).toBe(1);
    });
  });

  describe("patchDocument", () => {
    it("updates a field in an existing document", async () => {
      await documents.put(TEST_URI, TEST_CONTENT, "application/json");

      // ML REST patch format: {"patch":[{"replace":{"select":"field","content":value}}]}
      await documents.patchDocument(TEST_URI, {
        patch: [{ replace: { select: "value", content: 99 } }],
      });

      const result = await documents.get(TEST_URI);
      expect((result.content as Record<string, unknown>).value).toBe(99);
    });

    it("adds a new field via patch", async () => {
      await documents.put(TEST_URI, TEST_CONTENT, "application/json");

      await documents.patchDocument(TEST_URI, {
        patch: [{ insert: { context: "title", position: "after", content: { patched: true } } }],
      });

      const result = await documents.get(TEST_URI);
      expect((result.content as Record<string, unknown>).patched).toBe(true);
    });
  });

  describe("del", () => {
    it("deletes a document without error", async () => {
      await documents.put(TEST_URI, TEST_CONTENT, "application/json");
      await expect(documents.del(TEST_URI)).resolves.not.toThrow();
    });

    it("document is gone after deletion", async () => {
      await documents.put(TEST_URI, TEST_CONTENT, "application/json");
      await documents.del(TEST_URI);
      await expect(documents.get(TEST_URI)).rejects.toThrow();
    });
  });
});
