/**
 * Integration tests for ml_document_sample tool behavior.
 *
 * ml_document_sample = list() + get() for N documents from a collection.
 * Tests verify both the full-content and show_keys_only patterns.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - list() returning empty when collection has documents
 *  - get() returning wrong content type
 *  - show_keys_only shape derivation when content is JSON object
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const TEST_COLLECTION = "wikipedia-articles";

describeIfLive("ml_document_sample (live)", () => {
  const { documents } = buildClients();

  describe("list + get (document_sample pattern)", () => {
    it("lists up to 3 URIs from the wikipedia-articles collection", async () => {
      const listing = await documents.list({ collection: TEST_COLLECTION, pageLength: 3 });
      expect(Array.isArray(listing.uris)).toBe(true);
      expect(listing.uris.length).toBeGreaterThan(0);
      expect(listing.uris.length).toBeLessThanOrEqual(3);
    });

    it("gets content for each sampled URI", async () => {
      const listing = await documents.list({ collection: TEST_COLLECTION, pageLength: 3 });
      for (const uri of listing.uris) {
        const doc = await documents.get(uri, undefined, false);
        expect(doc.uri).toBe(uri);
        expect(doc.content).not.toBeNull();
      }
    });

    it("content is a JSON object with at least a title field (wikipedia docs)", async () => {
      const listing = await documents.list({ collection: TEST_COLLECTION, pageLength: 1 });
      const uri = listing.uris[0];
      const doc = await documents.get(uri);
      const content = doc.content as Record<string, unknown>;
      expect(typeof content).toBe("object");
      expect(content).not.toBeNull();
      // Wikipedia documents have at minimum a title field
      expect(typeof content.title).toBe("string");
    });

    it("show_keys_only shape: top-level field names and value types", async () => {
      // Simulate show_keys_only=true logic from the ml_document_sample tool
      const listing = await documents.list({ collection: TEST_COLLECTION, pageLength: 1 });
      const uri = listing.uris[0];
      const doc = await documents.get(uri);
      const content = doc.content;
      // Build shape map as the tool does
      if (content !== null && typeof content === "object" && !Array.isArray(content)) {
        const shape: Record<string, string> = {};
        for (const [k, v] of Object.entries(content as Record<string, unknown>)) {
          const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
          shape[k] = t;
        }
        // Shape should have string values ("string", "number", "object", "array", "null", "boolean")
        const validTypes = new Set(["string", "number", "object", "array", "null", "boolean", "undefined"]);
        for (const [, t] of Object.entries(shape)) {
          expect(validTypes.has(t)).toBe(true);
        }
        expect(Object.keys(shape).length).toBeGreaterThan(0);
      }
    });

    it("returns total count in listing response", async () => {
      const listing = await documents.list({ collection: TEST_COLLECTION });
      expect(typeof listing.total).toBe("number");
      expect(listing.total).toBeGreaterThanOrEqual(2);
    });
  });
});
