/**
 * Integration tests for DocumentsClient against a live MarkLogic instance.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - get(uri, db, includeMetadata=true) triggered HTTP 415 multipart error (fixed)
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

// A document that reliably exists in the test ML instance
const TEST_URI = "/wikipedia/climate-change.json";

describeIfLive("DocumentsClient (live)", () => {
  const { documents } = buildClients();

  describe("get", () => {
    it("fetches a document without metadata", async () => {
      const result = await documents.get(TEST_URI);
      expect(result.uri).toBe(TEST_URI);
      expect(result.content).not.toBeNull();
    });

    it("fetches a document with metadata without HTTP 415", async () => {
      // Regression: requesting content+metadata in one call triggers multipart/mixed
      // which caused HTTP 415. Now makes two separate requests.
      const result = await documents.get(TEST_URI, undefined, true);
      expect(result.uri).toBe(TEST_URI);
      expect(result.content).not.toBeNull();
      expect(result.metadata).toBeDefined();
    });

    it("metadata includes collections array", async () => {
      const result = await documents.get(TEST_URI, undefined, true);
      expect(result.metadata).toBeDefined();
      expect(Array.isArray(result.metadata!.collections)).toBe(true);
    });

    it("metadata includes permissions array", async () => {
      const result = await documents.get(TEST_URI, undefined, true);
      expect(Array.isArray(result.metadata!.permissions)).toBe(true);
    });
  });
});
