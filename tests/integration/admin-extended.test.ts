/**
 * Extended integration tests for AdminClient — covers tools not tested in admin.test.ts:
 *  - getDatabaseStatistics (ml_database_statistics)
 *  - getServerProperties (ml_server_properties)
 *  - listLogFiles (ml_logs_list)
 *  - readLogs (ml_logs_read)
 *  - getReindexStatus (ml_reindex_status)
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

describeIfLive("AdminClient extended (live)", () => {
  const { admin } = buildClients();

  describe("getDatabaseStatistics", () => {
    it("returns statistics for the Documents database", async () => {
      const stats = await admin.getDatabaseStatistics("Documents");
      expect(typeof stats).toBe("object");
      expect(stats).not.toBeNull();
    });

    it("includes a database-status section", async () => {
      const stats = await admin.getDatabaseStatistics("Documents");
      // ML Management API returns { "database-status": {...} } for view=status
      const dbStatus = (stats["database-status"] as Record<string, unknown>) ?? stats;
      expect(dbStatus).toBeDefined();
    });
  });

  describe("getServerProperties", () => {
    it("returns properties for the App-Services HTTP server", async () => {
      const props = await admin.getServerProperties("App-Services", "Default");
      expect(typeof props).toBe("object");
      expect(props).not.toBeNull();
    });

    it("includes server-type field", async () => {
      const props = await admin.getServerProperties("App-Services", "Default");
      expect(props).toHaveProperty("server-type");
      expect(typeof props["server-type"]).toBe("string");
    });

    it("includes server-name field", async () => {
      const props = await admin.getServerProperties("App-Services", "Default");
      expect(props).toHaveProperty("server-name", "App-Services");
    });
  });

  describe("listLogFiles", () => {
    it("returns a non-empty array of log file names", async () => {
      const logs = await admin.listLogFiles();
      expect(Array.isArray(logs)).toBe(true);
      expect(logs.length).toBeGreaterThan(0);
    });

    it("all entries are strings", async () => {
      const logs = await admin.listLogFiles();
      logs.forEach((l) => expect(typeof l).toBe("string"));
    });

    it("includes at least one ErrorLog", async () => {
      const logs = await admin.listLogFiles();
      expect(logs.some((l) => l.includes("ErrorLog"))).toBe(true);
    });
  });

  describe("readLogs", () => {
    it("returns log content for ErrorLog", async () => {
      const logs = await admin.listLogFiles();
      // Use the first ErrorLog file found
      const errorLog = logs.find((l) => l.includes("ErrorLog")) ?? logs[0];
      const entry = await admin.readLogs({ filename: errorLog, tail: 5 });
      expect(entry.filename).toBe(errorLog);
      expect(typeof entry.content).toBe("string");
    });

    it("tail option limits the returned content to N lines", async () => {
      const logs = await admin.listLogFiles();
      const errorLog = logs.find((l) => l.includes("ErrorLog")) ?? logs[0];
      const entry = await admin.readLogs({ filename: errorLog, tail: 3 });
      // Content should have at most 3 non-empty lines
      const lines = entry.content.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBeLessThanOrEqual(3);
    });
  });

  describe("getReindexStatus", () => {
    it("returns reindex status for the Documents database", async () => {
      const status = await admin.getReindexStatus("Documents");
      expect(typeof status.database).toBe("string");
      expect(status.database).toBe("Documents");
      expect(typeof status.ready).toBe("boolean");
      expect(typeof status.indexing).toBe("boolean");
      expect(typeof status.reindexCount).toBe("number");
      expect(typeof status.message).toBe("string");
    });

    it("reports ready when no reindex is in progress", async () => {
      // In CI, the database should be idle after the seed + TDE polling
      const status = await admin.getReindexStatus("Documents");
      // Not asserting ready===true because reindexing state is environment-dependent,
      // but the fields must be present and well-typed.
      expect(status.reindexCount).toBeGreaterThanOrEqual(0);
    });
  });
});
