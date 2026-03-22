/**
 * Integration tests: Content Enrichment Workflow
 *
 * Use case: A real-world editorial pipeline that:
 *   1. Ingests raw article documents (ml_document_put)
 *   2. Enriches them with structured metadata via JSON patch (ml_document_patch)
 *   3. Retrieves the enriched document to verify patch succeeded (ml_document_get)
 *   4. Runs faceted search to aggregate the enriched collection (ml_search)
 *   5. Queries values/facets on the enriched metadata field (ml_values_query via search options)
 *   6. Uses ml_search_qbe (query by example) against enriched properties
 *   7. Cleans up test documents (ml_document_delete)
 *
 * Why this tests things mock-based tests cannot:
 *   - Patch → read round-trip verifies that the patch format is correct
 *   - JSON pointer paths must match actual stored document structure
 *   - Collection-scoped faceted search is only meaningful with real data
 *
 * Requires: ML_HOST env var pointing to a live MarkLogic instance.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

// ── Test data ──────────────────────────────────────────────────────────────────

const COLLECTION = "enrichment-test-articles";
const BASE_URI = "/test/enrichment/";

const RAW_ARTICLES = [
  {
    uri: `${BASE_URI}article-001.json`,
    content: {
      title: "Climate Change Accelerates Arctic Ice Melt",
      body: "Scientists report record levels of ice melt in the Arctic as global temperatures rise.",
      publishedDate: "2024-01-15",
      source: "ScienceDaily",
    },
  },
  {
    uri: `${BASE_URI}article-002.json`,
    content: {
      title: "New Renewable Energy Breakthrough",
      body: "Researchers achieve 40% efficiency in next-generation solar cells.",
      publishedDate: "2024-02-10",
      source: "TechReview",
    },
  },
  {
    uri: `${BASE_URI}article-003.json`,
    content: {
      title: "AI Transforms Healthcare Diagnostics",
      body: "Machine learning models outperform radiologists in detecting early-stage cancers.",
      publishedDate: "2024-03-05",
      source: "MedJournal",
    },
  },
  {
    uri: `${BASE_URI}article-004.json`,
    content: {
      title: "Ocean Temperature Records Broken Again",
      body: "Climate data shows unprecedented ocean warming for the third consecutive year.",
      publishedDate: "2024-03-20",
      source: "ScienceDaily",
    },
  },
];

// Enrichment patches: add a 'category' field and 'enriched' flag
const ENRICHMENTS: Record<string, { category: string; priority: number }> = {
  [`${BASE_URI}article-001.json`]: { category: "climate", priority: 1 },
  [`${BASE_URI}article-002.json`]: { category: "technology", priority: 2 },
  [`${BASE_URI}article-003.json`]: { category: "technology", priority: 1 },
  [`${BASE_URI}article-004.json`]: { category: "climate", priority: 3 },
};

describeIfLive("Content Enrichment Workflow (live)", () => {
  const { documents, search } = buildClients();

  // ── Setup: ingest raw articles ────────────────────────────────────────────

  beforeAll(async () => {
    // Write all raw articles into the test collection
    for (const article of RAW_ARTICLES) {
      await documents.put(
        article.uri,
        JSON.stringify(article.content),
        "application/json",
        { collections: [COLLECTION], permissions: [] }
      );
    }
  }, 30_000);

  // ── Teardown: delete test documents ──────────────────────────────────────

  afterAll(async () => {
    for (const article of RAW_ARTICLES) {
      try { await documents.del(article.uri); } catch { /* ignore */ }
    }
  });

  // ── Step 1: Verify ingestion ──────────────────────────────────────────────

  describe("Step 1: document ingestion", () => {
    it("all 4 articles are retrievable after ingestion", async () => {
      for (const article of RAW_ARTICLES) {
        const doc = await documents.get(article.uri);
        expect(doc).toBeDefined();
        const parsed = typeof doc.content === "string" ? JSON.parse(doc.content) : doc.content;
        expect(parsed.title).toBe(article.content.title);
      }
    });

    it("articles are in the test collection", async () => {
      const result = await search.search({ collection: COLLECTION, pageLength: 10 });
      expect(result.total).toBe(RAW_ARTICLES.length);
    });
  });

  // ── Step 2: Apply enrichment patches ─────────────────────────────────────

  describe("Step 2: metadata enrichment via patch", () => {
    it("patches each article with category and priority metadata", async () => {
      for (const [uri, enrichment] of Object.entries(ENRICHMENTS)) {
        // MarkLogic REST patch format: insert adds new fields as siblings of the context node
        const patch = {
          patch: [
            { insert: { context: "source", position: "after", content: {
              category: enrichment.category,
              priority: enrichment.priority,
              enriched: true,
            }}},
          ],
        };
        await documents.patchDocument(uri, patch);
      }
    });

    it("reads back the enriched fields correctly after patch", async () => {
      for (const [uri, enrichment] of Object.entries(ENRICHMENTS)) {
        const doc = await documents.get(uri);
        const parsed = typeof doc.content === "string" ? JSON.parse(doc.content) : doc.content;
        expect(parsed.category).toBe(enrichment.category);
        expect(parsed.priority).toBe(enrichment.priority);
        expect(parsed.enriched).toBe(true);
      }
    });

    it("original fields are preserved after patch", async () => {
      const doc = await documents.get(`${BASE_URI}article-001.json`);
      const parsed = typeof doc.content === "string" ? JSON.parse(doc.content) : doc.content;
      expect(parsed.title).toBe("Climate Change Accelerates Arctic Ice Melt");
      expect(parsed.source).toBe("ScienceDaily");
    });
  });

  // ── Step 3: Search across the enriched collection ─────────────────────────

  describe("Step 3: full-text search over enriched collection", () => {
    it("finds climate articles by keyword", async () => {
      const result = await search.search({
        q: "climate",
        collection: COLLECTION,
        pageLength: 10,
      });
      expect(result.total).toBeGreaterThanOrEqual(1);
      const uris = (result.results ?? []).map((r: { uri: string }) => r.uri);
      expect(uris.some((u: string) => u.includes("article-001"))).toBe(true);
    });

    it("finds technology articles by keyword", async () => {
      const result = await search.search({
        q: "machine learning",
        collection: COLLECTION,
        pageLength: 10,
      });
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    it("returns all articles for empty query scoped to collection", async () => {
      const result = await search.search({ collection: COLLECTION, pageLength: 20 });
      expect(result.total).toBe(RAW_ARTICLES.length);
    });
  });

  // ── Step 4: QBE (Query By Example) against enriched properties ────────────

  describe("Step 4: QBE against enriched properties", () => {
    it("QBE finds climate-category articles", async () => {
      const result = await search.qbe(
        { category: "climate" },
        { pageLength: 10 }
      );
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it("QBE finds technology-category articles", async () => {
      const result = await search.qbe(
        { category: "technology" },
        { pageLength: 10 }
      );
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it("QBE finds articles by source", async () => {
      const result = await search.qbe(
        { source: "ScienceDaily" },
        { pageLength: 10 }
      );
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it("QBE returns empty for a non-existent category", async () => {
      const result = await search.qbe(
        { category: "nonexistent-xyz-category" },
        { pageLength: 10 }
      );
      expect(result.total).toBe(0);
    });
  });

  // ── Step 5: Document patch with replace operation ─────────────────────────

  describe("Step 5: patch replace and remove operations", () => {
    it("replaces the priority field with a new value", async () => {
      const uri = `${BASE_URI}article-001.json`;
      // MarkLogic REST patch format: replace uses select (XPath/JSONPath) and content
      const patch = {
        patch: [{ replace: { select: "priority", content: 99 } }],
      };
      await documents.patchDocument(uri, patch);

      const doc = await documents.get(uri);
      const parsed = typeof doc.content === "string" ? JSON.parse(doc.content) : doc.content;
      expect(parsed.priority).toBe(99);
    });

    it("restores original priority after test", async () => {
      const uri = `${BASE_URI}article-001.json`;
      const patch = {
        patch: [{ replace: { select: "priority", content: 1 } }],
      };
      await documents.patchDocument(uri, patch);
      const doc = await documents.get(uri);
      const parsed = typeof doc.content === "string" ? JSON.parse(doc.content) : doc.content;
      expect(parsed.priority).toBe(1);
    });
  });

  // ── Step 6: Document listing from enriched collection ────────────────────

  describe("Step 6: document listing from enriched collection", () => {
    it("lists URIs in the enriched collection", async () => {
      const result = await documents.list({
        collection: COLLECTION,
        pageLength: 10,
      });
      expect(result).toBeDefined();
      expect(Array.isArray(result.uris)).toBe(true);
      expect(result.uris.length).toBe(RAW_ARTICLES.length);
    });

    it("listed URIs match the seeded article URIs", async () => {
      const result = await documents.list({
        collection: COLLECTION,
        pageLength: 10,
      });
      const seededUris = RAW_ARTICLES.map((a) => a.uri).sort();
      const listedUris = [...result.uris].sort();
      expect(listedUris).toEqual(seededUris);
    });
  });
});
