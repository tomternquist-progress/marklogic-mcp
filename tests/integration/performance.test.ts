/**
 * Integration tests for PerformanceClient against a live MarkLogic instance.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - analyzeForestStatus() navigated forest-status.status.* instead of
 *    forest-status.status-properties.* — state was always "unknown" (fixed)
 *  - fragment/stand counts not in Management API — now fetched via
 *    xdmp:forest-counts() XQuery (fixed)
 *  - searchDebug() passed debug=true which ML 12 rejects — now falls back
 *    to a plain pageLength=0 search on UNSUPPORTEDPARAM error (fixed)
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

describeIfLive("PerformanceClient (live)", () => {
  const { performance, admin } = buildClients();

  describe("getForestStatus", () => {
    it("returns a forest-status object with a state field", async () => {
      // Regression: code navigated .status.* instead of .status-properties.*
      // so state was always "unknown".
      const forests = await admin.listForests("Documents");
      expect(forests.length).toBeGreaterThan(0);
      const status = await performance.getForestStatus(forests[0].name);
      const forestStatus = (status["forest-status"] as Record<string, unknown>) ?? status;
      const sp = forestStatus["status-properties"] as Record<string, unknown>;
      expect(sp).toBeDefined();
      const stateVal = (sp["state"] as { value?: string } | string | undefined);
      const state = typeof stateVal === "object" ? stateVal?.value : stateVal;
      expect(["open", "closed", "sync-replicating"]).toContain(state);
    });
  });

  describe("getForestCounts", () => {
    it("returns fragment and stand counts via xdmp:forest-counts()", async () => {
      // Regression: fragment counts are not in the Management API view=status response;
      // now fetched via XQuery eval.
      const forests = await admin.listForests("Documents");
      const counts = await performance.getForestCounts(forests[0].name);
      expect(counts).not.toBeNull();
      expect(typeof counts!.active).toBe("number");
      expect(typeof counts!.deleted).toBe("number");
      expect(typeof counts!.standCount).toBe("number");
      expect(typeof counts!.docCount).toBe("number");
      expect(counts!.standCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("searchDebug", () => {
    it("returns search results without error (falls back from debug=true on ML 12)", async () => {
      // Regression: ML 12 removed debug=true — previously threw UNSUPPORTEDPARAM.
      const result = await performance.searchDebug({ q: "climate" });
      expect(typeof result).toBe("object");
      // Should have total or results info
      expect(result).toHaveProperty("total");
    });
  });
});
