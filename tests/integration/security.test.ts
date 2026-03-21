/**
 * Integration tests for SecurityClient against a live MarkLogic instance.
 *
 * Catches bugs that mock-based unit tests miss:
 *  - getDocumentPermissions() returned capabilities:[null] because REST API returns
 *    string[] not Array<{capability:string}> — the map was doing c.capability (fixed)
 *  - getRoleProperties() returned roles:[null] because ML 12 returns string[] not
 *    Array<{roleref:string}> (fixed)
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const TEST_URI = "/wikipedia/climate-change.json";

describeIfLive("SecurityClient (live)", () => {
  const { security } = buildClients();

  describe("getDocumentPermissions", () => {
    it("returns an array of permissions", async () => {
      const perms = await security.getDocumentPermissions(TEST_URI);
      expect(Array.isArray(perms)).toBe(true);
    });

    it("each permission has a string role-name and string[] capabilities", async () => {
      // Regression: capabilities was mapped as c.capability on string elements,
      // producing [null] instead of ["read","update",...].
      const perms = await security.getDocumentPermissions(TEST_URI);
      for (const perm of perms) {
        expect(typeof perm["role-name"]).toBe("string");
        expect(perm["role-name"].length).toBeGreaterThan(0);
        expect(Array.isArray(perm.capabilities)).toBe(true);
        perm.capabilities.forEach((c) => {
          expect(typeof c).toBe("string");
          expect(["read", "update", "insert", "execute", "node-update"]).toContain(c);
        });
      }
    });
  });

  describe("listRoles", () => {
    it("returns a non-empty list of roles", async () => {
      const roles = await security.listRoles();
      expect(Array.isArray(roles)).toBe(true);
      expect(roles.length).toBeGreaterThan(0);
    });
  });

  describe("getRoleProperties", () => {
    it("returns properties for the 'rest-reader' role", async () => {
      const props = await security.getRoleProperties("rest-reader");
      expect(props["role-name"]).toBe("rest-reader");
    });

    it("roles is a string array (not array of objects)", async () => {
      // Regression: ML 12 returns role as string[] but code mapped as Array<{roleref}>
      const props = await security.getRoleProperties("rest-reader");
      expect(Array.isArray(props.roles)).toBe(true);
      props.roles.forEach((r) => expect(typeof r).toBe("string"));
    });

    it("privileges is a string array", async () => {
      const props = await security.getRoleProperties("rest-reader");
      expect(Array.isArray(props.privileges)).toBe(true);
      props.privileges.forEach((p) => expect(typeof p).toBe("string"));
    });
  });
});
