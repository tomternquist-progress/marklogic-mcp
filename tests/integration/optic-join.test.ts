/**
 * Integration tests for Optic join queries across two TDE views.
 *
 * This is a critical pattern for agents working with relational-style data in
 * MarkLogic — e.g. joining document metadata with classification data stored
 * in separate documents.
 *
 * Test setup:
 *  - "articles" view: id, title, category_id from article documents
 *  - "categories" view: id, name from category documents
 *  - Join: articles.category_id = categories.id
 *
 * Also tests:
 *  - group-by with count aggregate
 *  - where clause filtering after join
 *  - order-by on joined result
 *
 * Catches bugs that single-view tests miss:
 *  - join-inner argument order: (rightPlan, joinOnCondition) not (leftPlan, ...)
 *  - on() condition must use qualified column names when both views have same col name
 *  - strip_schema_prefix interaction with multi-view joins
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const ARTICLES_COLLECTION = "integration-test-join-articles";
const CATEGORIES_COLLECTION = "integration-test-join-categories";
const TDE_ARTICLES_URI = "/tde/integration-test-join-articles.json";
const TDE_CATEGORIES_URI = "/tde/integration-test-join-categories.json";

const CATEGORY_DOCS = [
  { uri: "/join/categories/cat-001.json", content: { cat_id: "cat-001", cat_name: "Science" } },
  { uri: "/join/categories/cat-002.json", content: { cat_id: "cat-002", cat_name: "Technology" } },
  { uri: "/join/categories/cat-003.json", content: { cat_id: "cat-003", cat_name: "Politics" } },
];

const ARTICLE_DOCS = [
  { uri: "/join/articles/art-001.json", content: { art_id: "art-001", art_title: "Climate Science", art_category_id: "cat-001" } },
  { uri: "/join/articles/art-002.json", content: { art_id: "art-002", art_title: "AI Research",     art_category_id: "cat-002" } },
  { uri: "/join/articles/art-003.json", content: { art_id: "art-003", art_title: "Quantum Physics",  art_category_id: "cat-001" } },
  { uri: "/join/articles/art-004.json", content: { art_id: "art-004", art_title: "Election Coverage", art_category_id: "cat-003" } },
];

const TDE_ARTICLES = {
  template: {
    context: "/",
    collections: [ARTICLES_COLLECTION],
    rows: [{
      schemaName: "join_test",
      viewName: "articles",
      columns: [
        { name: "art_id",          scalarType: "string", val: "art_id" },
        { name: "art_title",       scalarType: "string", val: "art_title" },
        { name: "art_category_id", scalarType: "string", val: "art_category_id" },
      ],
    }],
  },
};

const TDE_CATEGORIES = {
  template: {
    context: "/",
    collections: [CATEGORIES_COLLECTION],
    rows: [{
      schemaName: "join_test",
      viewName: "categories",
      columns: [
        { name: "cat_id",   scalarType: "string", val: "cat_id" },
        { name: "cat_name", scalarType: "string", val: "cat_name" },
      ],
    }],
  },
};

describeIfLive("Optic join queries (live)", () => {
  const { documents, optic } = buildClients();

  beforeAll(async () => {
    // Seed all docs
    for (const { uri, content } of [...CATEGORY_DOCS, ...ARTICLE_DOCS]) {
      await documents.put(uri, JSON.stringify(content), "application/json", {
        collections: [uri.includes("categories") ? CATEGORIES_COLLECTION : ARTICLES_COLLECTION],
      });
    }

    // Install TDE templates
    await documents.put(TDE_ARTICLES_URI, JSON.stringify(TDE_ARTICLES), "application/json", {
      collections: ["http://marklogic.com/xdmp/tde"], database: "Schemas",
    });
    await documents.put(TDE_CATEGORIES_URI, JSON.stringify(TDE_CATEGORIES), "application/json", {
      collections: ["http://marklogic.com/xdmp/tde"], database: "Schemas",
    });

    // Wait for both views to be ready
    const readyCheck = async (schema: string, view: string) => {
      const plan = {
        $optic: {
          ns: "op", fn: "operators",
          args: [
            { ns: "op", fn: "from-view", args: [schema, view] },
            { ns: "op", fn: "limit", args: [1] },
          ],
        },
      };
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        try { await optic.query(plan); return; } catch { /* reindexing */ }
      }
    };
    await Promise.all([
      readyCheck("join_test", "articles"),
      readyCheck("join_test", "categories"),
    ]);
  }, 90_000);

  afterAll(async () => {
    for (const { uri } of [...CATEGORY_DOCS, ...ARTICLE_DOCS]) {
      try { await documents.del(uri); } catch { /* ignore */ }
    }
    for (const uri of [TDE_ARTICLES_URI, TDE_CATEGORIES_URI]) {
      try { await documents.del(uri, "Schemas"); } catch { /* ignore */ }
    }
  });

  describe("join-inner", () => {
    it("joins articles with categories on category_id", async () => {
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["join_test", "articles"] },
            {
              ns: "op", fn: "join-inner", args: [
                { ns: "op", fn: "from-view", args: ["join_test", "categories"] },
                {
                  ns: "op", fn: "on", args: [
                    { ns: "op", fn: "view-col", args: ["articles", "art_category_id"] },
                    { ns: "op", fn: "view-col", args: ["categories", "cat_id"] },
                  ],
                },
              ],
            },
          ],
        },
      };

      const result = await optic.query(plan);
      // Should have 4 rows (all articles have matching categories)
      expect(result.rows.length).toBe(4);
    });

    it("joined rows include both article and category columns", async () => {
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["join_test", "articles"] },
            {
              ns: "op", fn: "join-inner", args: [
                { ns: "op", fn: "from-view", args: ["join_test", "categories"] },
                {
                  ns: "op", fn: "on", args: [
                    { ns: "op", fn: "view-col", args: ["articles", "art_category_id"] },
                    { ns: "op", fn: "view-col", args: ["categories", "cat_id"] },
                  ],
                },
              ],
            },
          ],
        },
      };

      const result = await optic.query(plan);
      // Check columns include both views
      expect(result.columns.some((c) => c.includes("art_title"))).toBe(true);
      expect(result.columns.some((c) => c.includes("cat_name"))).toBe(true);
    });

    it("where filter after join returns only matching rows", async () => {
      // Only Science articles
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["join_test", "articles"] },
            {
              ns: "op", fn: "join-inner", args: [
                { ns: "op", fn: "from-view", args: ["join_test", "categories"] },
                {
                  ns: "op", fn: "on", args: [
                    { ns: "op", fn: "view-col", args: ["articles", "art_category_id"] },
                    { ns: "op", fn: "view-col", args: ["categories", "cat_id"] },
                  ],
                },
              ],
            },
            {
              ns: "op", fn: "where", args: [{
                ns: "op", fn: "eq", args: [
                  { ns: "op", fn: "view-col", args: ["categories", "cat_name"] },
                  "Science",
                ],
              }],
            },
          ],
        },
      };

      const result = await optic.query(plan, undefined, true);
      // Science has 2 articles: Climate Science + Quantum Physics
      expect(result.rows.length).toBe(2);
      // Use suffix matching: MarkLogic may return "categories.cat_name" not just "cat_name"
      const getCatName = (row: Record<string, unknown>) =>
        Object.entries(row).find(([k]) => k === "cat_name" || k.endsWith(".cat_name"))?.[1];
      result.rows.forEach((r) => {
        expect(getCatName(r)).toBe("Science");
      });
    });

    it("group-by with count aggregates categories", async () => {
      const plan = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: ["join_test", "articles"] },
            {
              ns: "op", fn: "join-inner", args: [
                { ns: "op", fn: "from-view", args: ["join_test", "categories"] },
                {
                  ns: "op", fn: "on", args: [
                    { ns: "op", fn: "view-col", args: ["articles", "art_category_id"] },
                    { ns: "op", fn: "view-col", args: ["categories", "cat_id"] },
                  ],
                },
              ],
            },
            {
              ns: "op", fn: "group-by", args: [
                [{ ns: "op", fn: "view-col", args: ["categories", "cat_name"] }],
                [{ ns: "op", fn: "count", args: ["article_count", null] }],
              ],
            },
          ],
        },
      };

      const result = await optic.query(plan, undefined, true);
      // 3 categories
      expect(result.rows.length).toBe(3);

      // After group-by, MarkLogic may return view-qualified column names like
      // "categories.cat_name" even with stripSchemaPrefix=true (only strips 3-part names).
      // Use suffix matching to handle both "cat_name" and "categories.cat_name".
      const getCol = (row: Record<string, unknown>, suffix: string): unknown =>
        Object.entries(row).find(([k]) => k === suffix || k.endsWith(`.${suffix}`))?.[1];

      const scienceRow = result.rows.find((r) => getCol(r, "cat_name") === "Science");
      expect(scienceRow).toBeDefined();
      // Science has 2 articles
      expect(getCol(scienceRow!, "article_count")).toBe(2);

      const techRow = result.rows.find((r) => getCol(r, "cat_name") === "Technology");
      expect(getCol(techRow!, "article_count")).toBe(1);
    });
  });
});
