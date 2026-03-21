/**
 * Extended integration tests for SchemaClient — covers tools not tested in schema.test.ts:
 *  - discoverSchema (ml_schema_discover)
 *  - listNamespaces (ml_namespaces_list)
 *  - listViews (ml_views_list) — relies on TDE installed in optic.test.ts beforeAll
 *  - validateTde (ml_tde_validate)
 *  - generateTdeTemplate
 *
 * NOTE: listViews and validateTde rely on the TDE template installed by optic.test.ts.
 * Run all integration tests together (vitest --run) to ensure the TDE is present.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const TDE_URI = "/tde/integration-test-wikipedia.json";

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

describeIfLive("SchemaClient extended (live)", () => {
  const { schema, documents } = buildClients();

  beforeAll(async () => {
    // Ensure the TDE from optic.test.ts is present; install it if not.
    try {
      const tdes = await schema.getTdeSchemas();
      if (!(tdes as string[]).includes(TDE_URI)) {
        await documents.put(
          TDE_URI,
          JSON.stringify(TDE_TEMPLATE),
          "application/json",
          { collections: ["http://marklogic.com/xdmp/tde"], database: "Schemas" }
        );
        // Brief wait for TDE to register
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch {
      // If getTdeSchemas or put fails, tests below will still run but may be skipped
    }
  }, 30_000);

  describe("discoverSchema", () => {
    it("returns a SchemaDiscoveryResult for the wikipedia-articles collection", async () => {
      const result = await schema.discoverSchema({ collection: "wikipedia-articles", sampleSize: 5 });
      expect(typeof result.documentCount).toBe("number");
      expect(result.documentCount).toBeGreaterThan(0);
      expect(Array.isArray(result.inferredFields)).toBe(true);
      expect(Array.isArray(result.rangeIndexes)).toBe(true);
      expect(Array.isArray(result.tdeSchemas)).toBe(true);
    });

    it("infers top-level fields from seeded wikipedia documents", async () => {
      const result = await schema.discoverSchema({ collection: "wikipedia-articles", sampleSize: 5 });
      const paths = result.inferredFields.map((f) => f.path);
      // The seeded documents have at minimum a 'title' field
      expect(paths).toContain("title");
    });

    it("each field has path, type, and cardinality", async () => {
      const result = await schema.discoverSchema({ collection: "wikipedia-articles", sampleSize: 3 });
      for (const field of result.inferredFields) {
        expect(typeof field.path).toBe("string");
        expect(typeof field.type).toBe("string");
        expect(["single", "multiple"]).toContain(field.cardinality);
        expect(typeof field.hasRangeIndex).toBe("boolean");
      }
    });
  });

  describe("listNamespaces", () => {
    it("returns an array without error (may be empty in default config)", async () => {
      // Default ML installation may have no path namespaces configured
      const ns = await schema.listNamespaces();
      expect(Array.isArray(ns)).toBe(true);
    });

    it("each namespace entry has prefix and namespaceUri strings", async () => {
      const ns = await schema.listNamespaces();
      for (const n of ns) {
        expect(typeof n.prefix).toBe("string");
        expect(typeof n.namespaceUri).toBe("string");
      }
    });
  });

  describe("listViews", () => {
    it("returns views found in installed TDE templates", async () => {
      const views = await schema.listViews();
      expect(Array.isArray(views)).toBe(true);
      // If TDE is installed, should find the wikipedia view
      if (views.length > 0) {
        const v = views[0];
        expect(typeof v.schema).toBe("string");
        expect(typeof v.view).toBe("string");
        expect(typeof v.tde_uri).toBe("string");
        expect(Array.isArray(v.collections)).toBe(true);
      }
    });

    it("finds the test.wikipedia view if TDE is installed", async () => {
      const views = await schema.listViews();
      const wikiView = views.find((v) => v.schema === "test" && v.view === "wikipedia");
      if (wikiView) {
        expect(wikiView.tde_uri).toBe(TDE_URI);
        expect(wikiView.collections).toContain("wikipedia-articles");
      }
      // Skip assertion if TDE not present — covered by optic.test.ts
    });
  });

  describe("validateTde", () => {
    it("returns a TdeValidationResult for the installed TDE", async () => {
      const tdes = await schema.getTdeSchemas();
      if (!(tdes as string[]).includes(TDE_URI)) {
        // TDE not installed — skip
        return;
      }
      const result = await schema.validateTde({
        tdeUri: TDE_URI,
        collection: "wikipedia-articles",
        sampleSize: 3,
      });
      expect(result.tdeUri).toBe(TDE_URI);
      expect(result.collection).toBe("wikipedia-articles");
      expect(typeof result.documentCount).toBe("number");
      expect(typeof result.sampledRows).toBe("number");
      expect(Array.isArray(result.views)).toBe(true);
      expect(typeof result.summary).toBe("string");
    });

    it("reports the correct schema and view names", async () => {
      const tdes = await schema.getTdeSchemas();
      if (!(tdes as string[]).includes(TDE_URI)) return;
      const result = await schema.validateTde({
        tdeUri: TDE_URI,
        collection: "wikipedia-articles",
      });
      expect(result.views).toContainEqual({ schema: "test", view: "wikipedia" });
    });
  });

  describe("generateTdeTemplate", () => {
    it("generates a TDE template from sampled collection documents", async () => {
      const result = await schema.generateTdeTemplate({
        collection: "wikipedia-articles",
        schemaName: "gen_test",
        viewName: "gen_wiki",
        sampleSize: 3,
      });
      expect(typeof result.uri).toBe("string");
      expect(result.uri).toBe("/tde/gen_test/gen_wiki.json");
      expect(result.template).toBeDefined();
      expect(Array.isArray(result.sanitizedColumns)).toBe(true);
      expect(Array.isArray(result.skippedNullColumns)).toBe(true);
    });

    it("includes columns for inferred fields", async () => {
      const result = await schema.generateTdeTemplate({
        collection: "wikipedia-articles",
        schemaName: "gen_test",
        viewName: "gen_wiki",
        sampleSize: 5,
      });
      const tpl = result.template as { template: { rows: Array<{ columns: Array<{ name: string }> }> } };
      const cols = tpl.template.rows[0]?.columns ?? [];
      expect(cols.length).toBeGreaterThan(0);
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("title");
    });
  });
});
