/**
 * Live integration tests for the chat → MarkLogic translation pipeline.
 *
 * Exercises the four-stage flow against a real MarkLogic instance with the
 * wikipedia-articles seed (scripts/integration-seed.mjs):
 *
 *   STAGE 1  EvalClient.parseCtsQuery — cts.parse() round-trips a string query
 *   STAGE 2  ml_search_surface tool   — aggregates discoverSchema + listSearchOptions
 *   STAGE 3  parse → search           — the parsed JSON is executable via /v1/search
 *   STAGE 4  string-grammar → search  — the same query also runs via q=
 *
 * Seed (relevant fields per doc):
 *   /wikipedia/climate-change.json           in "wikipedia-articles"
 *     { id, title, source: "wikipedia", url, importedAt (dateTime range-indexed),
 *       summary, classification: { topCategory: { label, score, class }, categories: [...] } }
 *   /wikipedia/artificial-intelligence.json  in "wikipedia-articles"  (same shape)
 *
 * These tests are SKIPPED when ML_HOST is unset, matching every other integration test.
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";
import { registerSchemaTools } from "../../src/tools/schema.js";
import { registerSearchTools } from "../../src/tools/search.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function buildToolMap(clients: ReturnType<typeof buildClients>) {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(_name, handler);
    },
  };
  registerSchemaTools(server as never, clients as never);
  registerSearchTools(server as never, clients as never);
  return tools;
}

describeIfLive("chat → MarkLogic pipeline (live)", () => {
  const clients = buildClients();

  // ───────────────────────── STAGE 1 ─────────────────────────
  describe("EvalClient.parseCtsQuery (cts.parse round-trip)", () => {
    it("parses a bareword into a word-style query", async () => {
      const res = await clients.eval.parseCtsQuery("climate");
      expect(res.length).toBeGreaterThan(0);
      const value = res[0].value;
      // cts.parse may return a word-query or wrapped-query — accept any cts-shape
      // as long as the JSON references "climate"
      const dump = JSON.stringify(value).toLowerCase();
      expect(dump).toContain("climate");
    });

    it("parses an AND/NOT boolean expression into a composite query", async () => {
      const res = await clients.eval.parseCtsQuery("climate AND change NOT wikipedia");
      const dump = JSON.stringify(res[0].value).toLowerCase();
      // Composite must contain all three terms; the exact wrapper (and-query, and-not-query)
      // is implementation-defined across MarkLogic versions.
      expect(dump).toContain("climate");
      expect(dump).toContain("change");
      expect(dump).toContain("wikipedia");
    });

    it("parses a tagged equality against a range-indexed field", async () => {
      // importedAt has a seeded range-element-index of scalarType dateTime — the only
      // range-indexed field on the wiki seed. cts.parse SJS requires a range index for
      // every tagged binding, so this is the only seeded field eligible for tagging.
      const res = await clients.eval.parseCtsQuery("importedAt:2026-01-01T00:00:00Z", {
        importedAt: { type: "element-range", name: "importedAt", scalar_type: "dateTime" },
      });
      const dump = JSON.stringify(res[0].value).toLowerCase();
      expect(dump).toContain("importedat");
      expect(dump).toContain("2026");
    });

    it("parses a range tag (spaced named operator) against the seeded importedAt dateTime range index", async () => {
      // Range grammar requires SPACES around the operator: "field GE value", not "field:>=value".
      const res = await clients.eval.parseCtsQuery("importedAt GE 2025-01-01", {
        importedAt: { type: "element-range", name: "importedAt", scalar_type: "dateTime" },
      });
      const dump = JSON.stringify(res[0].value).toLowerCase();
      expect(dump).toContain("importedat");
      expect(dump).toContain("2025");
    });

    it("rejects tagged binding on a field without a range index (XDMP-ELEMRIDXNOTFOUND)", async () => {
      // 'source' is a json-property in the seed but has NO range index. cts.parse SJS
      // function bindings are XQuery-only — there is no SJS path that does tagged
      // equality without a range index. This MUST surface as an error so the agent
      // falls back to bareword text search.
      await expect(
        clients.eval.parseCtsQuery("source:wikipedia", {
          source: { type: "json-property", name: "source" },
        })
      ).rejects.toThrow();
    });

    it("raises on a malformed grammar (unmatched quote)", async () => {
      await expect(clients.eval.parseCtsQuery('"unmatched')).rejects.toThrow();
    });
  });

  // ───────────────────────── STAGE 2 ─────────────────────────
  describe("ml_search_surface (live discovery)", () => {
    it("returns inferredFields, rangeIndexes, and suggestedBindings for the wikipedia collection", async () => {
      const tools = buildToolMap(clients);
      const resp = await tools.get("ml_search_surface")!({
        collection: "wikipedia-articles",
        database: "Documents",
        sample_size: 5,
      });
      expect(resp.isError).toBeUndefined();
      const surface = JSON.parse(resp.content[0].text);

      // Seed docs guarantee at least these top-level fields exist
      const fieldNames = (surface.inferredFields as Array<{ path: string }>).map((f) => f.path);
      expect(fieldNames).toEqual(expect.arrayContaining(["title", "source", "importedAt"]));

      // The integration-seed configures importedAt as a range-element-index
      const indexLocalnames = (surface.rangeIndexes as Array<{ localname?: string }>).map((i) => i.localname);
      expect(indexLocalnames).toContain("importedAt");

      // suggestedBindings must include an element-range binding for importedAt
      // (the only seeded field with a range index), ready to feed into ml_parse_query.
      expect(surface.suggestedBindings.importedAt).toBeDefined();
      expect(surface.suggestedBindings.importedAt.type).toBe("element-range");
      expect(surface.suggestedBindings.importedAt.scalar_type).toBe("dateTime");

      // 'source' has no range index → must appear in barewordFields, NOT in suggestedBindings.
      expect(surface.suggestedBindings.source).toBeUndefined();
      expect(surface.barewordFields).toEqual(expect.arrayContaining(["source", "title"]));

      // searchOptionsNames must be an array (default options set may or may not be present)
      expect(Array.isArray(surface.searchOptionsNames)).toBe(true);
    });
  });

  // ───────────────────────── STAGE 3 & 4 ─────────────────────
  describe("end-to-end: surface → parse → search (LLM-style flow)", () => {
    it("executes the same query via string grammar AND via structured-query JSON, with matching hits", async () => {
      const tools = buildToolMap(clients);

      // STAGE 1 — discover
      const surfaceResp = await tools.get("ml_search_surface")!({
        collection: "wikipedia-articles",
        database: "Documents",
      });
      const surface = JSON.parse(surfaceResp.content[0].text);

      // STAGE 2 — translate. In production the LLM picks tags from suggestedBindings and
      // drops to bareword for everything else (per barewordFields). 'source' has no range
      // index → the LLM searches it as the bareword "wikipedia" against the universal index.
      // 'importedAt' is range-indexed → tag it.
      const qtext = "climate AND wikipedia AND importedAt GE 2025-01-01";
      const bindings = { importedAt: surface.suggestedBindings.importedAt };

      // STAGE 3 — validate (real cts.parse via the parseCtsQuery client)
      const parseResp = await tools.get("ml_parse_query")!({ qtext, bindings });
      expect(parseResp.isError).toBeUndefined();
      const parsedStructuredQuery = JSON.parse(parseResp.content[0].text);
      const dump = JSON.stringify(parsedStructuredQuery).toLowerCase();
      expect(dump).toContain("climate");
      expect(dump).toContain("wikipedia");
      expect(dump).toContain("importedat");

      // STAGE 4a — execute via string grammar
      const stringExec = await tools.get("ml_search")!({
        q: qtext,
        collection: "wikipedia-articles",
        page_length: 10,
      });
      expect(stringExec.isError).toBeUndefined();
      const stringHits = JSON.parse(stringExec.content[0].text);
      const stringUris = (stringHits.results as Array<{ uri: string }>).map((r) => r.uri);
      expect(stringUris).toContain("/wikipedia/climate-change.json");

      // STAGE 4b — execute via the parsed structured-query JSON.
      // CRITICAL CONTRACT: ml_parse_query's output is consumable by ml_search.structured_query.
      const structExec = await tools.get("ml_search")!({
        structured_query: parsedStructuredQuery,
        collection: "wikipedia-articles",
        page_length: 10,
      });
      expect(structExec.isError).toBeUndefined();
      const structHits = JSON.parse(structExec.content[0].text);
      const structUris = (structHits.results as Array<{ uri: string }>).map((r) => r.uri);
      expect(structUris).toContain("/wikipedia/climate-change.json");

      // Both paths must converge on the same matching document
      const inBoth = stringUris.filter((u) => structUris.includes(u));
      expect(inBoth).toContain("/wikipedia/climate-change.json");
    });

    it("range-tag query against importedAt (seeded range index) parses + executes", async () => {
      const tools = buildToolMap(clients);

      const surfaceResp = await tools.get("ml_search_surface")!({
        collection: "wikipedia-articles",
        database: "Documents",
      });
      const surface = JSON.parse(surfaceResp.content[0].text);
      const importedAtBinding = surface.suggestedBindings.importedAt;
      expect(importedAtBinding).toBeDefined();

      // A range query that should match BOTH seed docs (their importedAt is 2026-01-01).
      // Grammar: SPACED named operator — "field GE value", not "field:>=value".
      const qtext = "importedAt GE 2025-01-01";
      const parseResp = await tools.get("ml_parse_query")!({
        qtext, bindings: { importedAt: importedAtBinding },
      });
      expect(parseResp.isError).toBeUndefined();
      const parsedSq = JSON.parse(parseResp.content[0].text);

      const exec = await tools.get("ml_search")!({
        structured_query: parsedSq,
        collection: "wikipedia-articles",
        page_length: 10,
      });
      expect(exec.isError).toBeUndefined();
      const hits = JSON.parse(exec.content[0].text);
      expect(hits.total).toBeGreaterThanOrEqual(2);
      const uris = (hits.results as Array<{ uri: string }>).map((r) => r.uri);
      expect(uris).toContain("/wikipedia/climate-change.json");
      expect(uris).toContain("/wikipedia/artificial-intelligence.json");
    });

    it("malformed grammar fails at parse — does not execute against the database", async () => {
      const tools = buildToolMap(clients);
      const parseResp = await tools.get("ml_parse_query")!({ qtext: '"unterminated' });
      expect(parseResp.isError).toBe(true);
      // Caller would now surface the error to the user without hitting /v1/search.
    });
  });
});
