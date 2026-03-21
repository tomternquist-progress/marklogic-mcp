/**
 * Extended integration tests for SecurityClient — covers tools not tested in security.test.ts:
 *  - listUsers (ml_users_list)
 *
 * security.test.ts already covers:
 *  - listRoles, getRoleProperties, getDocumentPermissions
 */

import { describe, it, expect } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

describeIfLive("SecurityClient extended (live)", () => {
  const { security } = buildClients();

  describe("listUsers", () => {
    it("returns a non-empty array of users", async () => {
      const users = await security.listUsers();
      expect(Array.isArray(users)).toBe(true);
      expect(users.length).toBeGreaterThan(0);
    });

    it("each user has name (string) and id (string)", async () => {
      const users = await security.listUsers();
      for (const user of users) {
        expect(typeof user.name).toBe("string");
        expect(user.name.length).toBeGreaterThan(0);
        expect(typeof user.id).toBe("string");
        expect(user.id.length).toBeGreaterThan(0);
      }
    });

    it("includes the 'admin' user", async () => {
      const users = await security.listUsers();
      const names = users.map((u) => u.name);
      expect(names).toContain("admin");
    });

    it("respects the limit parameter", async () => {
      const users = await security.listUsers(1);
      expect(users.length).toBeLessThanOrEqual(1);
    });
  });
});
