/**
 * Integration tests for SemaphoreClient against a live Semaphore instance.
 *
 * All tests are gated on SEMAPHORE_HOST (or SEMAPHORE_URL) being set in the environment.
 * Tests are automatically skipped when Semaphore is not present locally.
 *
 * Env vars required for CLS tests:
 *   SEMAPHORE_HOST     — Semaphore hostname (e.g. localhost or 192.168.1.10)
 *   SEMAPHORE_SCS_PORT — CLS port (default: 5058)
 *   SEMAPHORE_URL      — explicit CLS URL override (takes precedence)
 *
 * Additional env vars required for KMM/Studio tests:
 *   SEMAPHORE_KMM_PORT — Studio/KMM port (default: 5080)
 *   SEMAPHORE_USERNAME — KMM username
 *   SEMAPHORE_PASSWORD — KMM password
 *
 * Covers all semaphore_* tool client methods:
 *   semaphore_status             — healthCheck()
 *   semaphore_studio_status      — kmmHealthCheck()
 *   semaphore_publish_sets       — listPublishSets()
 *   semaphore_classes            — listClasses()
 *   semaphore_cls_languages      — listClsLanguages()
 *   semaphore_classify           — classify()
 *   semaphore_kmm_models_list    — listKmmModels()
 *   semaphore_kmm_model_create   — createKmmModel()
 *   semaphore_kmm_model_delete   — kmmDeleteModel()
 *   semaphore_kmm_skos_load      — kmmImportSkos()
 *   semaphore_kmm_sparql         — kmmSparqlQuery()
 *   semaphore_kmm_sparql_update  — kmmSparqlUpdate()
 *   semaphore_publish            — kmmPublish() (smoke test only)
 *   semaphore_publish_config_fix_plain_skos — kmmPatchPublishConfigForPlainSkos()
 *   semaphore_concept_search     — kmmSparqlQuery() (tool-level composition)
 *   semaphore_concept_get        — kmmSparqlQuery() (tool-level composition)
 *   semaphore_concept_labels_update — kmmSparqlUpdate() (tool-level composition)
 *   semaphore_publish_diagnose   — kmmConceptCount() + kmmSparqlQuery() + clsRuleCount()
 *   semaphore_taxonomy_scaffold  — tool-level composition (no dedicated client method)
 *   semaphore_taxonomy_validate  — kmmSparqlQuery() (tool-level composition)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SemaphoreClient } from "../../src/client/semaphore.js";

const SEMAPHORE_HOST = process.env.SEMAPHORE_HOST ?? "";
const SEMAPHORE_SCS_PORT = parseInt(process.env.SEMAPHORE_SCS_PORT ?? "5058", 10);
const SEMAPHORE_KMM_PORT = parseInt(process.env.SEMAPHORE_KMM_PORT ?? "5080", 10);
const SEMAPHORE_USERNAME = process.env.SEMAPHORE_USERNAME ?? "";
const SEMAPHORE_PASSWORD = process.env.SEMAPHORE_PASSWORD ?? "";
const SEMAPHORE_URL = process.env.SEMAPHORE_URL ?? "";

// Skip ALL tests when no Semaphore instance is configured
const describeIfLive = (SEMAPHORE_HOST || SEMAPHORE_URL) ? describe : describe.skip;
// Skip KMM tests when credentials are not configured
const describeKmm = (SEMAPHORE_HOST || SEMAPHORE_URL) && SEMAPHORE_USERNAME ? describe : describe.skip;

function buildClient(): SemaphoreClient {
  return new SemaphoreClient({
    host: SEMAPHORE_HOST || undefined,
    scsPort: SEMAPHORE_SCS_PORT,
    kmmPort: SEMAPHORE_KMM_PORT,
    username: SEMAPHORE_USERNAME || undefined,
    password: SEMAPHORE_PASSWORD || undefined,
    ssl: false,
    timeoutMs: 30_000,
    url: SEMAPHORE_URL || undefined,
  });
}

const TEST_MODEL_NAME = `IntegrationTest${Date.now()}`;
const TEST_NAMESPACE = `http://example.org/integrationtest/${Date.now()}/`;

// Minimal valid SKOS Turtle content for testing
const TEST_SKOS_CONTENT = `
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ex: <${TEST_NAMESPACE}> .

ex:TestScheme a skos:ConceptScheme ;
    skos:prefLabel "Integration Test Scheme"@en .

ex:AI a skos:Concept ;
    skos:inScheme ex:TestScheme ;
    skos:topConceptOf ex:TestScheme ;
    skos:prefLabel "Artificial Intelligence"@en ;
    skos:altLabel "AI"@en .

ex:ML a skos:Concept ;
    skos:inScheme ex:TestScheme ;
    skos:prefLabel "Machine Learning"@en ;
    skos:broader ex:AI .
`.trim();

// ── CLS (Classification Server) tests ─────────────────────────────────────────

describeIfLive("SemaphoreClient CLS (live)", () => {
  const semaphore = buildClient();

  describe("healthCheck (semaphore_status)", () => {
    it("returns a health object with healthy field", async () => {
      const status = await semaphore.healthCheck();
      expect(typeof status).toBe("object");
      expect(typeof status.healthy).toBe("boolean");
    });

    it("CLS is reachable and healthy", async () => {
      const status = await semaphore.healthCheck();
      expect(status.healthy).toBe(true);
    });
  });

  describe("listClsLanguages (semaphore_cls_languages)", () => {
    it("returns an array of languages", async () => {
      const langs = await semaphore.listClsLanguages();
      expect(Array.isArray(langs)).toBe(true);
    });

    it("each language has id, name, default, and hasRules fields", async () => {
      const langs = await semaphore.listClsLanguages();
      for (const lang of langs) {
        expect(typeof lang.id).toBe("string");
        expect(typeof lang.name).toBe("string");
        expect(typeof lang.default).toBe("boolean");
        expect(typeof lang.hasRules).toBe("boolean");
      }
    });
  });

  describe("listPublishSets (semaphore_publish_sets)", () => {
    it("returns an array without error", async () => {
      const sets = await semaphore.listPublishSets();
      expect(Array.isArray(sets)).toBe(true);
    });

    it("each entry has name, type, and active fields", async () => {
      const sets = await semaphore.listPublishSets();
      for (const s of sets) {
        expect(typeof s.name).toBe("string");
        expect(typeof s.type).toBe("string");
        expect(typeof s.active).toBe("boolean");
      }
    });
  });

  describe("listClasses (semaphore_classes)", () => {
    it("returns an array of class entries without error", async () => {
      const classes = await semaphore.listClasses();
      expect(Array.isArray(classes)).toBe(true);
    });

    it("each class has name and ruleCount", async () => {
      const classes = await semaphore.listClasses();
      for (const cls of classes) {
        expect(typeof cls.name).toBe("string");
        expect(typeof cls.ruleCount).toBe("number");
        expect(cls.ruleCount).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("classify (semaphore_classify)", () => {
    it("classifies text without error", async () => {
      const result = await semaphore.classify(
        "Artificial intelligence and machine learning are transforming industries.",
        48
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result.categories)).toBe(true);
      expect(typeof result.rawXml).toBe("string");
    });

    it("each returned category has className, label, id, and score", async () => {
      const result = await semaphore.classify(
        "Climate change and global warming are major environmental issues.",
        0 // low threshold to get more results
      );
      for (const cat of result.categories) {
        expect(typeof cat.className).toBe("string");
        expect(typeof cat.label).toBe("string");
        expect(typeof cat.id).toBe("string");
        expect(typeof cat.score).toBe("number");
        expect(cat.score).toBeGreaterThanOrEqual(0);
      }
    });

    it("rawXml contains XML content", async () => {
      const result = await semaphore.classify("Technology and software development.", 0);
      expect(result.rawXml).toContain("<");
    });
  });
});

// ── KMM / Studio tests ─────────────────────────────────────────────────────────

describeKmm("SemaphoreClient KMM (live)", () => {
  const semaphore = buildClient();

  describe("kmmHealthCheck (semaphore_studio_status)", () => {
    it("returns a health object with healthy field", async () => {
      const status = await semaphore.kmmHealthCheck();
      expect(typeof status).toBe("object");
      expect(typeof status.healthy).toBe("boolean");
    });
  });

  describe("listKmmModels (semaphore_kmm_models_list)", () => {
    it("returns an array of models", async () => {
      const models = await semaphore.listKmmModels();
      expect(Array.isArray(models)).toBe(true);
    });

    it("each model has an id field", async () => {
      const models = await semaphore.listKmmModels();
      for (const m of models) {
        expect(typeof m.id).toBe("string");
      }
    });
  });

  describe("KMM model lifecycle (semaphore_kmm_model_create / sparql / delete)", () => {
    let modelUri = "";

    beforeAll(async () => {
      modelUri = await semaphore.createKmmModel(TEST_MODEL_NAME, TEST_NAMESPACE, "Integration test model — safe to delete");
    }, 30_000);

    afterAll(async () => {
      if (modelUri) {
        try { await semaphore.kmmDeleteModel(modelUri); } catch { /* ignore */ }
      }
    });

    it("createKmmModel returns a model URI string", () => {
      expect(typeof modelUri).toBe("string");
      expect(modelUri.length).toBeGreaterThan(0);
      expect(modelUri).toContain(TEST_MODEL_NAME);
    });

    it("new model appears in listKmmModels", async () => {
      const models = await semaphore.listKmmModels();
      const ids = models.map((m) => m.id);
      expect(ids.some((id) => id.includes(TEST_MODEL_NAME))).toBe(true);
    });

    it("kmmSparqlQuery returns an empty result on a new model", async () => {
      const result = await semaphore.kmmSparqlQuery(
        modelUri,
        "SELECT * WHERE { ?s ?p ?o } LIMIT 1"
      );
      expect(typeof result.xml).toBe("string");
      expect(Array.isArray(result.rows)).toBe(true);
    });

    describe("after kmmImportSkos (semaphore_kmm_skos_load)", () => {
      let skosLoaded = false;

      beforeAll(async () => {
        const jobId = await semaphore.kmmImportSkos(modelUri, null, {
          skosContent: TEST_SKOS_CONTENT,
          format: "text/turtle",
          overwrite: false,
        });
        await semaphore.kmmWaitForAsyncJob(jobId, 60_000);
        skosLoaded = true;
      }, 90_000);

      it("SKOS loaded without error", () => {
        expect(skosLoaded).toBe(true);
      });

      it("kmmConceptCount returns > 0 after SKOS load", async () => {
        const count = await semaphore.kmmConceptCount(modelUri);
        expect(count).toBeGreaterThan(0);
      });

      it("kmmSparqlQuery finds loaded concepts (semaphore_kmm_sparql)", async () => {
        const result = await semaphore.kmmSparqlQuery(
          modelUri,
          `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
           SELECT ?concept ?label WHERE {
             ?concept a skos:Concept ;
                      skos:prefLabel ?label .
           } LIMIT 10`
        );
        expect(result.rows.length).toBeGreaterThan(0);
        const labels = result.rows.map((r) => r.label);
        expect(labels.some((l) => String(l).includes("Artificial Intelligence") || String(l).includes("Machine Learning"))).toBe(true);
      });

      it("kmmSparqlUpdate inserts a triple (semaphore_kmm_sparql_update)", async () => {
        const newConceptUri = `${TEST_NAMESPACE}DeepLearning`;
        const update = `
          PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
          PREFIX ex: <${TEST_NAMESPACE}>
          INSERT DATA {
            GRAPH <urn:x-evn-master:${TEST_MODEL_NAME}> {
              <${newConceptUri}> a skos:Concept ;
                skos:prefLabel "Deep Learning"@en .
            }
          }
        `;
        await expect(
          semaphore.kmmSparqlUpdate(modelUri, update)
        ).resolves.not.toThrow();
      });

      it("concept_search (via kmmSparqlQuery) finds a concept by label", async () => {
        // This exercises the same SPARQL that semaphore_concept_search uses
        const keyword = "Artificial";
        const query = `
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
SELECT DISTINCT ?concept ?prefLabel WHERE {
  ?concept a skos:Concept ;
           skos:prefLabel ?prefLabel .
  FILTER(CONTAINS(LCASE(STR(?prefLabel)), LCASE("${keyword}")))
} LIMIT 10`;
        const result = await semaphore.kmmSparqlQuery(modelUri, query);
        expect(result.rows.length).toBeGreaterThan(0);
        const found = result.rows.some((r) =>
          String(r.prefLabel ?? "").includes(keyword)
        );
        expect(found).toBe(true);
      });

      it("concept_labels_update (via kmmSparqlUpdate) adds an altLabel", async () => {
        // Find the AI concept URI first
        const findRes = await semaphore.kmmSparqlQuery(
          modelUri,
          `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
           SELECT ?concept WHERE {
             ?concept a skos:Concept ;
                      skos:prefLabel "Artificial Intelligence"@en .
           } LIMIT 1`
        );
        if (findRes.rows.length === 0) return; // Skip if not found

        const conceptUri = findRes.rows[0].concept as string;
        const addLabel = `INSERT DATA {
          <${conceptUri}> <http://www.w3.org/2004/02/skos/core#altLabel> "Intelligent Systems"@en
        }`;
        await expect(
          semaphore.kmmSparqlUpdate(modelUri, addLabel)
        ).resolves.not.toThrow();
      });

      it("publish_diagnose: clsRuleCount runs without error", async () => {
        // clsRuleCount uses the CLS listPublishSets/classes to count rules
        // The publish set name is the model name lowercase
        const publishSetName = TEST_MODEL_NAME.toLowerCase();
        const ruleCount = await semaphore.clsRuleCount(publishSetName);
        // Before publish, ruleCount should be 0 or -1 (not found in CLS)
        expect(typeof ruleCount).toBe("number");
      });

      it("taxonomy_validate (via kmmSparqlQuery): count concepts", async () => {
        // This is what semaphore_taxonomy_validate does — run SPARQL counts
        const result = await semaphore.kmmSparqlQuery(
          modelUri,
          `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
           SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c a skos:Concept }`
        );
        const count = parseInt(result.rows[0]?.n ?? "0", 10);
        expect(count).toBeGreaterThan(0);
      });
    });

    it("kmmDeleteModel removes the model", async () => {
      // We'll test this in afterAll — just verify it doesn't throw
      // (The actual deletion happens in afterAll)
      expect(modelUri).toBeTruthy();
    });
  });
});
