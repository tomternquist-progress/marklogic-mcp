/**
 * Integration tests for OpticClient against a live MarkLogic instance.
 *
 * Seeds a TDE template against the wikipedia-articles collection (already seeded
 * by scripts/integration-seed.mjs), waits for reindexing, then queries via Optic.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - normalizeOpticResponse() column/row shape mismatch for ML 12 response format
 *  - stripSchemaPrefix option incorrectly split column names with < 3 parts
 *  - TDE must be in the Schemas database, not Documents
 */

import { describe, it, expect, beforeAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const TDE_URI = "/tde/integration-test-wikipedia.json";

// TDE template for the seeded wikipedia-articles collection
const TDE_TEMPLATE = {
  template: {
    context: "/",
    collections: ["wikipedia-articles"],
    rows: [
      {
        schemaName: "test",
        viewName: "wikipedia",
        columns: [
          { name: "id",     scalarType: "string",  val: "id" },
          { name: "title",  scalarType: "string",  val: "title" },
          { name: "source", scalarType: "string",  val: "source" },
        ],
      },
    ],
  },
};

describeIfLive("OpticClient (live)", () => {
  const { optic, documents } = buildClients();

  beforeAll(async () => {
    // Install TDE into the Schemas database via the REST documents API with database=Schemas.
    // xdmp.documentInsert() in SJS eval does not support the database option;
    // using documents.put() with database:"Schemas" is the reliable alternative.
    await documents.put(
      TDE_URI,
      JSON.stringify(TDE_TEMPLATE),
      "application/json",
      { collections: ["http://marklogic.com/xdmp/tde"], database: "Schemas" }
    );
    // Poll until the view is ready (SQL-TABLEREINDEXING clears once reindexing completes)
    const plan = {
      $optic: { ns: "op", fn: "operators", args: [{ ns: "op", fn: "from-view", args: ["test", "wikipedia"] }] },
    };
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await optic.query(plan);
        break; // view is ready
      } catch {
        // still reindexing — keep waiting
      }
    }
  }, 60_000);

  describe("query", () => {
    it("returns an OpticResult with columns and rows arrays", async () => {
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["test", "wikipedia"] },
          ],
        },
      };
      const result = await optic.query(plan);
      expect(Array.isArray(result.columns)).toBe(true);
      expect(Array.isArray(result.rows)).toBe(true);
    });

    it("returns rows matching the seeded wikipedia documents", async () => {
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["test", "wikipedia"] },
          ],
        },
      };
      const result = await optic.query(plan);
      expect(result.rows.length).toBeGreaterThanOrEqual(2);
      const titles = result.rows.map((r) => r["test.wikipedia.title"] ?? r["title"]);
      expect(titles).toContain("Climate change");
      expect(titles).toContain("Artificial intelligence");
    });

    it("stripSchemaPrefix removes schema.view. prefix from column names", async () => {
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["test", "wikipedia"] },
          ],
        },
      };
      const result = await optic.query(plan, undefined, true);
      // With stripSchemaPrefix, columns should be "id", "title", "source" not "test.wikipedia.id"
      expect(result.columns).toContain("title");
      expect(result.columns.some((c) => c.includes("."))).toBe(false);
    });

    it("rows have values accessible by stripped column names", async () => {
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["test", "wikipedia"] },
          ],
        },
      };
      const result = await optic.query(plan, undefined, true);
      result.rows.forEach((row) => {
        expect(typeof row["title"]).toBe("string");
        expect(typeof row["source"]).toBe("string");
      });
    });
  });
});
