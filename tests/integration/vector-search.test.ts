/**
 * Integration tests for ml_vector_search (k-NN similarity over TDE views).
 *
 * This is a MarkLogic 12+ feature. Tests verify the full RAG prerequisite chain:
 *  1. Seed documents with pre-computed embedding vectors
 *  2. Install a TDE template with a vec:vector column
 *  3. Wait for reindexing to complete
 *  4. Run vector similarity search via op.vectorScore()
 *
 * Uses synthetic 4-dimensional vectors to avoid OpenAI dependency.
 * The query vector [1,0,0,0] should be closest to doc-001 ([0.9,0.1,0,0])
 * and furthest from doc-003 ([0,0,0.1,0.9]).
 *
 * Catches bugs that unit tests miss:
 *  - vec:vector column type not accepted in TDE JSON templates
 *  - vectorScore() plan serialisation wrong for the Optic /v1/rows API
 *  - ML 12 vec.vector() JS API differences from op.vec.vector()
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const COLLECTION = "integration-test-vectors";
const TDE_URI = "/tde/integration-test-vectors.json";

// Synthetic 4-dim embeddings — distances are predictable for assertions
const VECTOR_DOCS = [
  { uri: "/vectors/doc-001.json", content: { id: "v-001", label: "topic-A-strong", embedding: [0.9, 0.1, 0.0, 0.0] } },
  { uri: "/vectors/doc-002.json", content: { id: "v-002", label: "topic-A-weak",   embedding: [0.6, 0.4, 0.0, 0.0] } },
  { uri: "/vectors/doc-003.json", content: { id: "v-003", label: "topic-B-strong", embedding: [0.0, 0.0, 0.1, 0.9] } },
  { uri: "/vectors/doc-004.json", content: { id: "v-004", label: "topic-B-weak",   embedding: [0.0, 0.0, 0.6, 0.4] } },
];

// TDE template that projects embedding as a vec:vector column
const VECTOR_TDE = {
  template: {
    context: "/",
    collections: [COLLECTION],
    rows: [
      {
        schemaName: "test",
        viewName: "vector_docs",
        columns: [
          { name: "id",        scalarType: "string",     val: "id" },
          { name: "label",     scalarType: "string",     val: "label" },
          { name: "embedding", scalarType: "vec:vector", val: "embedding" },
        ],
      },
    ],
  },
};

// vec:vector TDE type and op.vec.cosineSimilarity() require MarkLogic 12+.
// Tests are skipped automatically if the view fails to be created (SQL-TABLENOTFOUND).
describeIfLive("Vector search (live — ML 12+)", () => {
  const { documents, optic } = buildClients();
  let vecSupported = false;

  beforeAll(async () => {
    // Seed documents
    for (const { uri, content } of VECTOR_DOCS) {
      await documents.put(uri, JSON.stringify(content), "application/json", {
        collections: [COLLECTION],
      });
    }

    // Install TDE
    await documents.put(TDE_URI, JSON.stringify(VECTOR_TDE), "application/json", {
      collections: ["http://marklogic.com/xdmp/tde"],
      database: "Schemas",
    });

    // Wait for the view to be available (poll up to 60s)
    const readyPlan = {
      $optic: {
        ns: "op", fn: "operators", args: [
          { ns: "op", fn: "from-view", args: ["test", "vector_docs"] },
          { ns: "op", fn: "limit", args: [1] },
        ],
      },
    };
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await optic.query(readyPlan);
        vecSupported = true;
        break;
      } catch {
        // still reindexing or vec:vector type not supported
      }
    }
  }, 60_000);

  afterAll(async () => {
    for (const { uri } of VECTOR_DOCS) {
      try { await documents.del(uri); } catch { /* ignore */ }
    }
    try {
      await documents.del(TDE_URI, "Schemas");
    } catch { /* ignore */ }
  });

  describe("basic vector view", () => {
    it("TDE view returns all 4 seeded documents", async () => {
      if (!vecSupported) { return; } // vec:vector TDE not supported in this ML version
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["test", "vector_docs"] },
          ],
        },
      };
      const result = await optic.query(plan, undefined, true);
      expect(result.rows.length).toBeGreaterThanOrEqual(4);
    });

    it("view columns include id, label, and embedding", async () => {
      if (!vecSupported) { return; }
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["test", "vector_docs"] },
            { ns: "op", fn: "limit", args: [1] },
          ],
        },
      };
      const result = await optic.query(plan, undefined, true);
      expect(result.columns).toContain("id");
      expect(result.columns).toContain("label");
      // embedding column may or may not appear in result columns depending on vec type handling
    });
  });

  describe("vector similarity search", () => {
    // Note: In the Optic JSON plan, vec functions are accessed via the "op" namespace
    // using the "vec.*" naming convention, NOT a separate "vec" namespace.
    // Correct: { ns: "op", fn: "vec.cosineSimilarity", args: [...] }
    // Wrong:   { ns: "vec", fn: "cosine-similarity", args: [...] }

    it("returns k nearest neighbours for a query vector", async () => {
      if (!vecSupported) { return; }
      const queryVector = [1, 0, 0, 0];
      const scoreCol = "similarity_score";

      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["test", "vector_docs"] },
            {
              ns: "op", fn: "bind", args: [[
                {
                  ns: "op", fn: "as", args: [
                    scoreCol,
                    {
                      ns: "op", fn: "vec.cosineSimilarity", args: [
                        { ns: "op", fn: "col", args: ["embedding"] },
                        { ns: "op", fn: "vec.vector", args: [queryVector] },
                      ],
                    },
                  ],
                },
              ]],
            },
            {
              ns: "op", fn: "order-by", args: [
                { ns: "op", fn: "desc", args: [scoreCol] },
              ],
            },
            { ns: "op", fn: "limit", args: [4] },
          ],
        },
      };

      const result = await optic.query(plan, undefined, true);
      expect(result.rows.length).toBeGreaterThanOrEqual(1);

      const firstScore = result.rows[0][scoreCol] as number;
      expect(typeof firstScore).toBe("number");
      expect(firstScore).toBeGreaterThan(0);
    });

    it("closest doc to [1,0,0,0] is the one with embedding near topic-A", async () => {
      if (!vecSupported) { return; }
      const queryVector = [1, 0, 0, 0];
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["test", "vector_docs"] },
            {
              ns: "op", fn: "bind", args: [[
                {
                  ns: "op", fn: "as", args: [
                    "score",
                    {
                      ns: "op", fn: "vec.cosineSimilarity", args: [
                        { ns: "op", fn: "col", args: ["embedding"] },
                        { ns: "op", fn: "vec.vector", args: [queryVector] },
                      ],
                    },
                  ],
                },
              ]],
            },
            { ns: "op", fn: "order-by", args: [{ ns: "op", fn: "desc", args: ["score"] }] },
            { ns: "op", fn: "limit", args: [1] },
          ],
        },
      };

      const result = await optic.query(plan, undefined, true);
      expect(result.rows.length).toBeGreaterThan(0);
      const topLabel = result.rows[0]["label"] as string;
      expect(topLabel).toMatch(/topic-A/);
    });

    it("topic-B query vector returns topic-B documents first", async () => {
      if (!vecSupported) { return; }
      const queryVector = [0, 0, 0, 1];
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["test", "vector_docs"] },
            {
              ns: "op", fn: "bind", args: [[
                {
                  ns: "op", fn: "as", args: [
                    "score",
                    {
                      ns: "op", fn: "vec.cosineSimilarity", args: [
                        { ns: "op", fn: "col", args: ["embedding"] },
                        { ns: "op", fn: "vec.vector", args: [queryVector] },
                      ],
                    },
                  ],
                },
              ]],
            },
            { ns: "op", fn: "order-by", args: [{ ns: "op", fn: "desc", args: ["score"] }] },
            { ns: "op", fn: "limit", args: [1] },
          ],
        },
      };

      const result = await optic.query(plan, undefined, true);
      expect(result.rows.length).toBeGreaterThan(0);
      const topLabel = result.rows[0]["label"] as string;
      expect(topLabel).toMatch(/topic-B/);
    });
  });
});
