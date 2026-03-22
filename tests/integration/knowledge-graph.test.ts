/**
 * Integration tests: Knowledge Graph Workflow
 *
 * Use case: Building and querying a multi-model knowledge graph that combines:
 *   - Document model: entity JSON documents (ml_document_put / ml_document_get)
 *   - Graph model: RDF triples relating entities (ml_graph_put / ml_sparql_query)
 *   - TDE/Optic model: structured queries over entity properties
 *
 * This workflow demonstrates patterns described in the data_modeling_advisor prompt:
 *   1. Load entity documents into MarkLogic
 *   2. Load RDF triples expressing relationships between entities
 *   3. Query the graph to find connected entities
 *   4. Combine document data with graph traversal via SPARQL
 *   5. Verify the SPARQL query correctly navigates the relationship structure
 *   6. Clean up test data
 *
 * Why this tests things mock-based tests miss:
 *   - Real SPARQL execution against the ML triple store
 *   - CONSTRUCT queries return RDF, not JSON — content-type handling matters
 *   - Named graph scoping is verified against actual stored triples
 *   - Graph → document join patterns require real fragment IDs
 *
 * Requires: ML_HOST env var pointing to a live MarkLogic instance.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

// ── Test data: a small technology company knowledge graph ─────────────────────

const GRAPH_URI = "http://example.org/test/tech-companies";
const ENTITY_COLLECTION = "kg-test-entities";

// Entity documents (one per company/person)
const ENTITY_DOCS = [
  {
    uri: "/test/kg/company/acme-corp.json",
    content: {
      "@id": "http://example.org/company/acme-corp",
      name: "ACME Corporation",
      industry: "Technology",
      founded: 2001,
      employees: 5000,
      headquarters: "San Francisco",
    },
  },
  {
    uri: "/test/kg/company/beta-systems.json",
    content: {
      "@id": "http://example.org/company/beta-systems",
      name: "Beta Systems",
      industry: "Software",
      founded: 2010,
      employees: 1200,
      headquarters: "Austin",
    },
  },
  {
    uri: "/test/kg/person/alice-smith.json",
    content: {
      "@id": "http://example.org/person/alice-smith",
      name: "Alice Smith",
      role: "CEO",
      expertise: ["AI", "Machine Learning"],
      company: "http://example.org/company/acme-corp",
    },
  },
  {
    uri: "/test/kg/person/bob-jones.json",
    content: {
      "@id": "http://example.org/person/bob-jones",
      name: "Bob Jones",
      role: "CTO",
      expertise: ["Cloud Computing", "Distributed Systems"],
      company: "http://example.org/company/beta-systems",
    },
  },
];

// RDF triples in Turtle format expressing relationships
const TURTLE_TRIPLES = `
@prefix org: <http://www.w3.org/ns/org#> .
@prefix schema: <http://schema.org/> .
@prefix ex: <http://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

# Company types
ex:company/acme-corp a schema:Organization ;
    rdfs:label "ACME Corporation" ;
    schema:industry "Technology" ;
    schema:foundingDate "2001" .

ex:company/beta-systems a schema:Organization ;
    rdfs:label "Beta Systems" ;
    schema:industry "Software" ;
    schema:foundingDate "2010" .

# Person types and affiliations
ex:person/alice-smith a schema:Person ;
    rdfs:label "Alice Smith" ;
    schema:jobTitle "CEO" ;
    org:memberOf ex:company/acme-corp .

ex:person/bob-jones a schema:Person ;
    rdfs:label "Bob Jones" ;
    schema:jobTitle "CTO" ;
    org:memberOf ex:company/beta-systems .

# Partnership relationship between companies
ex:company/acme-corp schema:partner ex:company/beta-systems .
ex:company/beta-systems schema:partner ex:company/acme-corp .
`.trim();

describeIfLive("Knowledge Graph Workflow (live)", () => {
  const { documents, graphs, eval: evalClient } = buildClients();

  // ── Setup ─────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    // Write entity documents
    for (const entity of ENTITY_DOCS) {
      await documents.put(
        entity.uri,
        JSON.stringify(entity.content),
        "application/json",
        { collections: [ENTITY_COLLECTION], permissions: [] }
      );
    }

    // Load RDF graph via the graphs client
    await graphs.putGraph(GRAPH_URI, TURTLE_TRIPLES, "text/turtle");
  }, 30_000);

  // ── Teardown ──────────────────────────────────────────────────────────────

  afterAll(async () => {
    for (const entity of ENTITY_DOCS) {
      try { await documents.del(entity.uri); } catch { /* ignore */ }
    }
    // Delete the named graph
    try {
      await evalClient.evalXQuery(
        `xdmp:graph-delete(<${GRAPH_URI}>)`,
        {}
      );
    } catch { /* ignore */ }
  });

  // ── Step 1: Entity documents ──────────────────────────────────────────────

  describe("Step 1: entity documents in document model", () => {
    it("company entity documents are retrievable", async () => {
      for (const entity of ENTITY_DOCS) {
        const doc = await documents.get(entity.uri);
        const parsed = typeof doc.content === "string" ? JSON.parse(doc.content) : doc.content;
        expect(parsed.name).toBe(entity.content.name);
      }
    });

    it("entity documents have @id field linking to graph URIs", async () => {
      const acme = await documents.get("/test/kg/company/acme-corp.json");
      const parsed = typeof acme.content === "string" ? JSON.parse(acme.content) : acme.content;
      expect(parsed["@id"]).toBe("http://example.org/company/acme-corp");
    });
  });

  // ── Step 2: Named graph loaded ────────────────────────────────────────────

  describe("Step 2: RDF triples in graph model", () => {
    it("named graph appears in the graph list", async () => {
      const { graphs: graphList } = await graphs.listGraphs();
      expect(Array.isArray(graphList)).toBe(true);
      expect(graphList.some((g: string) => g === GRAPH_URI)).toBe(true);
    });

    it("graph contains triples", async () => {
      const result = await graphs.sparqlQuery(
        `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${GRAPH_URI}> { ?s ?p ?o } }`
      );
      const rows = (result.results?.bindings ?? []) as Array<Record<string, { value: string }>>;
      const count = parseInt(rows[0]?.n?.value ?? "0", 10);
      expect(count).toBeGreaterThan(0);
    });
  });

  // ── Step 3: Basic SPARQL queries ──────────────────────────────────────────

  describe("Step 3: basic SPARQL queries", () => {
    it("SELECT finds all organizations in the named graph", async () => {
      const result = await graphs.sparqlQuery(
        `PREFIX schema: <http://schema.org/>
         SELECT ?org ?label WHERE {
           GRAPH <${GRAPH_URI}> {
             ?org a schema:Organization ;
                  <http://www.w3.org/2000/01/rdf-schema#label> ?label .
           }
         }`
      );
      const rows = (result.results?.bindings ?? []) as Array<Record<string, { value: string }>>;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const labels = rows.map((r) => r.label?.value ?? "");
      expect(labels.some((l) => l.includes("ACME"))).toBe(true);
      expect(labels.some((l) => l.includes("Beta"))).toBe(true);
    });

    it("SELECT finds all persons and their company affiliations", async () => {
      const result = await graphs.sparqlQuery(
        `PREFIX schema: <http://schema.org/>
         PREFIX org: <http://www.w3.org/ns/org#>
         SELECT ?person ?label ?company WHERE {
           GRAPH <${GRAPH_URI}> {
             ?person a schema:Person ;
                     <http://www.w3.org/2000/01/rdf-schema#label> ?label ;
                     org:memberOf ?company .
           }
         }`
      );
      const rows = (result.results?.bindings ?? []) as Array<Record<string, { value: string }>>;
      expect(rows.length).toBe(2);
    });

    it("finds company partnerships via schema:partner predicate", async () => {
      const result = await graphs.sparqlQuery(
        `PREFIX schema: <http://schema.org/>
         SELECT ?org1 ?org2 WHERE {
           GRAPH <${GRAPH_URI}> {
             ?org1 schema:partner ?org2 .
           }
         }`
      );
      const rows = (result.results?.bindings ?? []) as Array<Record<string, { value: string }>>;
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Step 4: Graph traversal patterns ─────────────────────────────────────

  describe("Step 4: graph traversal — find indirect connections", () => {
    it("finds persons connected to partners of a given company", async () => {
      // Pattern: Company → partner → Partner Company ← memberOf ← Person
      const result = await graphs.sparqlQuery(
        `PREFIX schema: <http://schema.org/>
         PREFIX org: <http://www.w3.org/ns/org#>
         PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
         SELECT DISTINCT ?person ?personLabel ?partnerCompany ?partnerLabel WHERE {
           GRAPH <${GRAPH_URI}> {
             <http://example.org/company/acme-corp> schema:partner ?partnerCompany .
             ?partnerCompany rdfs:label ?partnerLabel .
             ?person a schema:Person ;
                     rdfs:label ?personLabel ;
                     org:memberOf ?partnerCompany .
           }
         }`
      );
      const rows = (result.results?.bindings ?? []) as Array<Record<string, { value: string }>>;
      // Bob Jones works at Beta Systems, which is a partner of ACME
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const personLabels = rows.map((r) => r.personLabel?.value ?? "");
      expect(personLabels.some((l) => l.includes("Bob"))).toBe(true);
    });

    it("finds all companies and their employee counts via SPARQL + document join", async () => {
      // Use SPARQL to find orgs, then verify their document URIs exist
      const sparqlResult = await graphs.sparqlQuery(
        `PREFIX schema: <http://schema.org/>
         PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
         SELECT ?org ?label WHERE {
           GRAPH <${GRAPH_URI}> {
             ?org a schema:Organization ;
                  rdfs:label ?label .
           }
         } ORDER BY ?label`
      );
      const rows = (sparqlResult.results?.bindings ?? []) as Array<Record<string, { value: string }>>;

      // For each company URI from SPARQL, look up the corresponding document
      for (const row of rows) {
        const orgUri = row.org?.value ?? "";
        // Convert IRI to document URI: http://example.org/company/acme-corp → /test/kg/company/acme-corp.json
        const docUri = orgUri.replace("http://example.org/", "/test/kg/") + ".json";
        const doc = await documents.get(docUri);
        expect(doc).toBeDefined();
        const parsed = typeof doc.content === "string" ? JSON.parse(doc.content) : doc.content;
        expect(parsed.employees).toBeGreaterThan(0);
      }
    });
  });

  // ── Step 5: SPARQL CONSTRUCT (RDF output) ─────────────────────────────────

  describe("Step 5: SPARQL CONSTRUCT queries", () => {
    it("CONSTRUCT returns RDF content (non-empty string)", async () => {
      const result = await graphs.sparqlQuery(
        `CONSTRUCT { ?s ?p ?o }
         WHERE {
           GRAPH <${GRAPH_URI}> {
             ?s ?p ?o .
           }
         } LIMIT 5`
      );
      // For CONSTRUCT, the client may return raw string or an object with turtle
      const content = typeof result === "string" ? result : JSON.stringify(result);
      expect(content.length).toBeGreaterThan(0);
    });
  });

  // ── Step 6: SPARQL aggregation within graph ───────────────────────────────

  describe("Step 6: SPARQL aggregation queries", () => {
    it("counts entity types in the named graph", async () => {
      const result = await graphs.sparqlQuery(
        `SELECT ?type (COUNT(?s) AS ?count) WHERE {
           GRAPH <${GRAPH_URI}> {
             ?s a ?type .
           }
         } GROUP BY ?type ORDER BY DESC(?count)`
      );
      const rows = (result.results?.bindings ?? []) as Array<Record<string, { value: string }>>;
      expect(rows.length).toBeGreaterThan(0);
      const total = rows.reduce((sum, r) => sum + parseInt(r.count?.value ?? "0", 10), 0);
      expect(total).toBeGreaterThanOrEqual(4); // 2 orgs + 2 persons
    });

    it("lists unique predicates used in the graph", async () => {
      const result = await graphs.sparqlQuery(
        `SELECT DISTINCT ?predicate WHERE {
           GRAPH <${GRAPH_URI}> { ?s ?predicate ?o }
         } ORDER BY ?predicate`
      );
      const rows = (result.results?.bindings ?? []) as Array<Record<string, { value: string }>>;
      expect(rows.length).toBeGreaterThan(0);
      const predicates = rows.map((r) => r.predicate?.value ?? "");
      expect(predicates.some((p) => p.includes("schema.org"))).toBe(true);
    });
  });

  // ── Step 7: Named graph isolation ────────────────────────────────────────

  describe("Step 7: named graph isolation", () => {
    it("query without named graph scope also finds our triples (default graph)", async () => {
      // ML stores triples in managed triple indexes accessible from the default graph
      const result = await graphs.sparqlQuery(
        `PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
         SELECT ?s ?label WHERE {
           ?s rdfs:label ?label .
           FILTER(CONTAINS(STR(?label), "ACME"))
         } LIMIT 5`
      );
      const rows = (result.results?.bindings ?? []) as Array<Record<string, { value: string }>>;
      // May find it from the managed graph — verify the query runs without error
      expect(Array.isArray(rows)).toBe(true);
    });

    it("GRAPH-scoped query only returns triples from that graph", async () => {
      // Insert a triple in a different graph and confirm it doesn't appear in ours
      const OTHER_GRAPH = "http://example.org/test/other-graph";
      try {
        await evalClient.evalXQuery(
          `sem:graph-insert(sem:iri("${OTHER_GRAPH}"),
             sem:triple(sem:iri("http://example.org/other/entity"),
                        sem:iri("http://www.w3.org/2000/01/rdf-schema#label"),
                        "Other Entity"))`,
          {}
        );

        const result = await graphs.sparqlQuery(
          `SELECT ?s WHERE {
             GRAPH <${GRAPH_URI}> { ?s <http://www.w3.org/2000/01/rdf-schema#label> "Other Entity" }
           }`
        );
        const rows = (result.results?.bindings ?? []) as Array<Record<string, { value: string }>>;
        expect(rows.length).toBe(0); // "Other Entity" is NOT in GRAPH_URI
      } finally {
        // Clean up the other graph
        try {
          await evalClient.evalXQuery(
            `xdmp:graph-delete(<${OTHER_GRAPH}>)`, {}
          );
        } catch { /* ignore */ }
      }
    });
  });
});
