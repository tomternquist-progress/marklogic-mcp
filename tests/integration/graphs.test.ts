/**
 * Integration tests for GraphsClient (and OpticClient via fromTriples) against a
 * live MarkLogic instance.
 *
 * Tests create a named graph, query it via SPARQL, then clean up.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - listGraphs() used /v1/graphs which doesn't support listing; fixed to use
 *    SPARQL "SELECT DISTINCT ?g WHERE { GRAPH ?g { } }"
 *  - CONSTRUCT queries need Accept: text/turtle not application/sparql-results+json
 *    (HTTP 406 otherwise); fixed by detecting query type before sending
 *  - putGraph() with merge=true uses PATCH not PUT
 */

import { describe, it, expect, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const TEST_GRAPH = "http://integration-test/graph-client-test";
const TURTLE = `
@prefix ex: <http://example.org/> .
ex:subject ex:predicate ex:object .
ex:alice ex:knows ex:bob .
`;

describeIfLive("GraphsClient (live)", () => {
  const { graphs } = buildClients();

  // Clean up after all tests in this suite
  afterAll(async () => {
    try {
      await graphs.putGraph(TEST_GRAPH, "", "text/turtle");
    } catch {
      // ignore — graph may already be gone
    }
  });

  describe("listGraphs", () => {
    it("returns an object with graphs array and total", async () => {
      const result = await graphs.listGraphs();
      expect(Array.isArray(result.graphs)).toBe(true);
      expect(typeof result.total).toBe("number");
    });
  });

  describe("putGraph", () => {
    it("creates a named graph with Turtle content", async () => {
      const result = await graphs.putGraph(TEST_GRAPH, TURTLE, "text/turtle");
      expect(result.graph).toBe(TEST_GRAPH);
      expect(typeof result.created).toBe("boolean");
    });
  });

  describe("sparqlQuery (SELECT)", () => {
    it("queries triples from the named graph", async () => {
      // Ensure the graph exists first
      await graphs.putGraph(TEST_GRAPH, TURTLE, "text/turtle");

      const sparql = `SELECT ?s ?p ?o WHERE { GRAPH <${TEST_GRAPH}> { ?s ?p ?o } }`;
      const result = await graphs.sparqlQuery(sparql) as {
        head: { vars: string[] };
        results: { bindings: Array<Record<string, { value: string }>> };
      };

      expect(result.head.vars).toEqual(expect.arrayContaining(["s", "p", "o"]));
      expect(result.results.bindings.length).toBeGreaterThanOrEqual(2);
    });

    it("returns results in SPARQL JSON format", async () => {
      const sparql = `SELECT ?g WHERE { GRAPH <${TEST_GRAPH}> { ?s ?p ?o } } LIMIT 1`;
      const result = await graphs.sparqlQuery(sparql) as {
        head: { vars: string[] };
        results: { bindings: unknown[] };
      };
      expect(result).toHaveProperty("head");
      expect(result).toHaveProperty("results");
    });
  });

  describe("sparqlQuery (CONSTRUCT)", () => {
    it("returns Turtle string for CONSTRUCT queries", async () => {
      // Regression: CONSTRUCT was sent with Accept: application/sparql-results+json
      // causing HTTP 406. Now detects query type and uses Accept: text/turtle.
      await graphs.putGraph(TEST_GRAPH, TURTLE, "text/turtle");

      const sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${TEST_GRAPH}> { ?s ?p ?o } }`;
      const result = await graphs.sparqlQuery(sparql);
      expect(typeof result).toBe("string");
      // ML re-serializes prefix aliases (ex: → p0:) so check for the local name
      expect(result as string).toContain("subject");
    });
  });

  describe("listGraphs (after insert)", () => {
    it("includes the test graph after putGraph", async () => {
      await graphs.putGraph(TEST_GRAPH, TURTLE, "text/turtle");
      const result = await graphs.listGraphs();
      expect(result.graphs).toContain(TEST_GRAPH);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });
  });
});
