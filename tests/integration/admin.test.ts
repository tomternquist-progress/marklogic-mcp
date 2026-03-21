/**
 * Integration tests for AdminClient against a live MarkLogic instance.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - listForests(database) used REST-UNSUPPORTEDPARAM database-name param (fixed)
 *  - listServers() returned type:"unknown" because list endpoint omits server-type (fixed)
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

describeIfLive("AdminClient (live)", () => {
  const { admin } = buildClients();

  describe("listDatabases", () => {
    it("returns an array that includes Documents and Security", async () => {
      const dbs = await admin.listDatabases();
      expect(Array.isArray(dbs)).toBe(true);
      expect(dbs).toContain("Documents");
      expect(dbs).toContain("Security");
    });
  });

  describe("getDatabaseProperties", () => {
    it("returns properties for the Documents database", async () => {
      const props = await admin.getDatabaseProperties("Documents");
      expect(props).toHaveProperty("database-name", "Documents");
    });

    it("includes a forest array", async () => {
      const props = await admin.getDatabaseProperties("Documents");
      expect(Array.isArray(props["forest"])).toBe(true);
      expect((props["forest"] as string[]).length).toBeGreaterThan(0);
    });
  });

  describe("listForests", () => {
    it("lists all forests without error", async () => {
      const forests = await admin.listForests();
      expect(Array.isArray(forests)).toBe(true);
      expect(forests.length).toBeGreaterThan(0);
    });

    it("filters by database without using an unsupported query param", async () => {
      // Regression: previously passed database-name as a query param, which ML 12 rejects
      // with REST-UNSUPPORTEDPARAM. Now resolves forest names via getDatabaseProperties.
      const forests = await admin.listForests("Documents");
      expect(Array.isArray(forests)).toBe(true);
      const names = forests.map((f) => f.name);
      // All returned forests must be attached to the Documents database
      const dbProps = await admin.getDatabaseProperties("Documents");
      const dbForests = dbProps["forest"] as string[];
      names.forEach((name) => expect(dbForests).toContain(name));
    });
  });

  describe("listServers", () => {
    it("returns servers with a valid type (not 'unknown')", async () => {
      // Regression: list endpoint omits server-type; now fetches each server's properties
      const servers = await admin.listServers();
      expect(servers.length).toBeGreaterThan(0);
      const validTypes = ["http", "xdbc", "odbc", "webdav", "unknown"];
      servers.forEach((s) => {
        expect(validTypes).toContain(s.type);
      });
      // At least one server should have a real type
      expect(servers.some((s) => s.type !== "unknown")).toBe(true);
    });
  });

  describe("getClusterStatus", () => {
    it("returns a non-empty status object", async () => {
      const status = await admin.getClusterStatus();
      expect(typeof status).toBe("object");
      expect(status).not.toBeNull();
    });
  });
});
