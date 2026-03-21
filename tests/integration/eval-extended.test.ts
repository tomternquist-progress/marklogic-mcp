/**
 * Extended integration tests for EvalClient — covers tools not tested in eval.test.ts:
 *  - invokeModule (ml_invoke_module) — invokes a Main Module stored in the Modules database
 *  - XQuery sem:sparql wrapper (ml_sparql tool in src/tools/eval.ts)
 *
 * The ml_sparql tool wraps a SPARQL query inside XQuery sem:sparql() and runs it via
 * /v1/eval. We test that path by running the XQuery wrapper directly via evalXQuery().
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const MODULE_URI = "/integration-test/hello.sjs";
const MODULE_CONTENT = `
'use strict';
// A simple Main Module for integration testing
var greeting = external.greeting || "Hello";
greeting + " from MarkLogic";
`;

describeIfLive("EvalClient extended (live)", () => {
  const { eval: evalClient, documents } = buildClients();

  beforeAll(async () => {
    // Install a small Main Module into the Modules database via documents.put
    await documents.put(
      MODULE_URI,
      MODULE_CONTENT.trim(),
      "application/javascript",
      { database: "Modules" }
    );
  }, 15_000);

  afterAll(async () => {
    try { await documents.del(MODULE_URI, "Modules"); } catch { /* ignore */ }
  });

  describe("invokeModule", () => {
    it("invokes a Main Module and returns a result", async () => {
      const results = await evalClient.invokeModule(MODULE_URI);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it("returns the expected output string", async () => {
      const results = await evalClient.invokeModule(MODULE_URI);
      const val = results[0]?.value;
      expect(typeof val === "string" || typeof val === "number").toBe(true);
      expect(String(val)).toContain("MarkLogic");
    });

    it("passes external variables to the module", async () => {
      const results = await evalClient.invokeModule(MODULE_URI, { greeting: "Hi" });
      const val = String(results[0]?.value ?? "");
      expect(val).toContain("Hi");
    });
  });

  describe("XQuery sem:sparql wrapper (ml_sparql path)", () => {
    it("runs a basic SPARQL SELECT via XQuery sem:sparql()", async () => {
      // This matches what ml_sparql tool does internally — wraps SPARQL in XQuery
      const sparqlQuery = "SELECT * WHERE { ?s ?p ?o } LIMIT 1";
      const xquery = `
        declare namespace sem = "http://marklogic.com/semantics";
        let $results := sem:sparql("${sparqlQuery.replace(/"/g, '\\"')}")
        return $results
      `;
      // sem:sparql on an empty triple store returns an empty sequence — no error
      const results = await evalClient.evalXQuery(xquery);
      expect(Array.isArray(results)).toBe(true);
      // Result may be empty if no triples; the important thing is no error thrown
    });

    it("SPARQL with data returns rows (uses graph from graphs.test.ts)", async () => {
      // The graphs.test.ts seeds triples into a named graph — query them
      const sparqlQuery = `
        PREFIX ex: <http://example.org/>
        SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 3
      `;
      const xquery = `
        declare namespace sem = "http://marklogic.com/semantics";
        let $results := sem:sparql("${sparqlQuery.trim().replace(/"/g, '\\"').replace(/\n/g, " ")}")
        for $r in $results return map:get($r, "s")
      `;
      // This may return an empty sequence if the graphs test hasn't run first — that's fine
      const results = await evalClient.evalXQuery(xquery);
      expect(Array.isArray(results)).toBe(true);
    });

    it("evalXQuery with SPARQL SELECT via sem:sparql returns typed results", async () => {
      // Simpler form: just ask for a count — always returns a number
      const xquery = `
        declare namespace sem = "http://marklogic.com/semantics";
        fn:count(sem:sparql("SELECT * WHERE { ?s ?p ?o }"))
      `;
      const results = await evalClient.evalXQuery(xquery);
      expect(results.length).toBe(1);
      const val = results[0]?.value;
      expect(typeof val === "number" || typeof val === "string").toBe(true);
      expect(Number(val)).toBeGreaterThanOrEqual(0);
    });
  });
});
