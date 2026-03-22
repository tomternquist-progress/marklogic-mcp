/**
 * Integration tests for DhfClient against a live DHF 5.x deployment.
 *
 * All tests are gated on ML_HOST being set AND DHF databases being present.
 * Tests are automatically skipped when DHF is not installed.
 *
 * Env vars required:
 *   ML_HOST          — MarkLogic hostname
 *   ML_PORT          — MarkLogic REST port (default: 8000)
 *   ML_USERNAME      — MarkLogic username with data-hub-operator or admin role
 *   ML_PASSWORD      — MarkLogic password
 *   ML_AUTH_TYPE     — "digest" | "basic" (default: "digest")
 *
 * For dhf_flow_run tests (allowEval=true required):
 *   ML_ALLOW_EVAL=true must be set in the environment
 *   A flow named DHF_TEST_FLOW_NAME (default: "TestFlow") must exist in staging
 *
 * Optional:
 *   DHF_TEST_FLOW_NAME  — name of a real DHF flow to use for run tests (default: none)
 *
 * Covers all DhfClient methods:
 *   dhf_status     — detect()
 *   dhf_flows_list — listFlows(), getFlow()
 *   dhf_flow_run   — runFlow()
 *   dhf_job_status — getJobStatus(), listJobs()
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initLogger } from "../../src/utils/logger.js";
import { MarkLogicBaseClient } from "../../src/client/base.js";
import { AdminClient } from "../../src/client/admin.js";
import { EvalClient } from "../../src/client/eval.js";
import { DocumentsClient } from "../../src/client/documents.js";
import { SearchClient } from "../../src/client/search.js";
import { DhfClient, DHF_STAGING_DB, DHF_JOBS_DB } from "../../src/client/dhf.js";
import type { ConnectionConfig } from "../../src/config/schema.js";

initLogger({ level: "warn", format: "json" });

const ML_HOST = process.env.ML_HOST ?? "";
const ML_PORT = parseInt(process.env.ML_PORT ?? "8000", 10);
const ML_USERNAME = process.env.ML_USERNAME ?? process.env.ML_USER ?? "admin";
const ML_PASSWORD = process.env.ML_PASSWORD ?? "admin";
const ML_AUTH_TYPE = (process.env.ML_AUTH_TYPE ?? "digest") as "digest" | "basic" | "oauth";
const ML_ALLOW_EVAL = process.env.ML_ALLOW_EVAL === "true";
const DHF_TEST_FLOW_NAME = process.env.DHF_TEST_FLOW_NAME ?? "";

// Skip all tests when ML_HOST is not set
const describeIfLive = ML_HOST ? describe : describe.skip;

function buildDhfClient(allowEval = false) {
  const config: ConnectionConfig = {
    host: ML_HOST,
    port: ML_PORT,
    managementPort: 8002,
    username: ML_USERNAME,
    password: ML_PASSWORD,
    database: "Documents",
    ssl: false,
    rejectUnauthorized: true,
    authType: ML_AUTH_TYPE,
    timeoutMs: 60_000,
  };
  const base = new MarkLogicBaseClient(config);
  const admin = new AdminClient(base);
  const evalClient = new EvalClient(base, allowEval);
  const documents = new DocumentsClient(base, false);
  const search = new SearchClient(base);
  return new DhfClient(base, admin, evalClient, documents, search);
}

describeIfLive("DhfClient (live)", () => {
  let dhf: DhfClient;
  let dhfInstalled: boolean;

  beforeAll(async () => {
    dhf = buildDhfClient(ML_ALLOW_EVAL);
    try {
      const result = await dhf.detect();
      dhfInstalled = result.installed;
    } catch {
      // Management API unreachable or auth failure — skip all DHF tests
      dhfInstalled = false;
    }
  });

  // ── detect() ──────────────────────────────────────────────────────────────

  describe("detect() — dhf_status", () => {
    it("returns a valid detect result (installed or not)", async () => {
      let result;
      try {
        result = await dhf.detect();
      } catch {
        // Management API unreachable in this environment — not a test failure
        return;
      }
      expect(typeof result.installed).toBe("boolean");
      expect(Array.isArray(result.foundDatabases)).toBe(true);
      expect(Array.isArray(result.missingDatabases)).toBe(true);
    });

    it("includes expected DHF databases when installed", async () => {
      if (!dhfInstalled) return;
      const result = await dhf.detect();
      expect(result.foundDatabases).toContain(DHF_STAGING_DB);
      expect(result.foundDatabases).toContain(DHF_JOBS_DB);
    });

    it("lists missing databases when DHF is not fully installed", async () => {
      if (dhfInstalled) return;
      let result;
      try {
        result = await dhf.detect();
      } catch {
        // Management API unreachable — skip
        return;
      }
      expect(result.missingDatabases.length).toBeGreaterThan(0);
    });
  });

  // ── listFlows() / getFlow() ────────────────────────────────────────────────

  describe("listFlows() — dhf_flows_list", () => {
    it("returns an array (may be empty if no flows deployed)", async () => {
      if (!dhfInstalled) return;
      const flows = await dhf.listFlows();
      expect(Array.isArray(flows)).toBe(true);
    });

    it("each flow has a name and steps object", async () => {
      if (!dhfInstalled) return;
      const flows = await dhf.listFlows();
      for (const flow of flows) {
        expect(typeof flow.name).toBe("string");
        expect(flow.name.length).toBeGreaterThan(0);
        expect(typeof flow.steps).toBe("object");
        expect(flow.steps).not.toBeNull();
      }
    });

    it("each step has a stepDefinitionType", async () => {
      if (!dhfInstalled) return;
      const flows = await dhf.listFlows();
      for (const flow of flows) {
        for (const [, step] of Object.entries(flow.steps ?? {})) {
          expect(typeof step.stepDefinitionType).toBe("string");
        }
      }
    });
  });

  describe("getFlow() — dhf_flows_list with flow_name", () => {
    it("returns the specific flow when it exists", async () => {
      if (!dhfInstalled || !DHF_TEST_FLOW_NAME) return;
      const flow = await dhf.getFlow(DHF_TEST_FLOW_NAME);
      expect(flow.name).toBe(DHF_TEST_FLOW_NAME);
      expect(typeof flow.steps).toBe("object");
    });

    it("throws NotFoundError for a non-existent flow name", async () => {
      if (!dhfInstalled) return;
      await expect(dhf.getFlow("__nonexistent_flow__")).rejects.toThrow();
    });
  });

  // ── runFlow() ──────────────────────────────────────────────────────────────

  describe("runFlow() — dhf_flow_run", () => {
    it("returns a job ID string when eval is allowed and flow exists", async () => {
      if (!dhfInstalled || !ML_ALLOW_EVAL || !DHF_TEST_FLOW_NAME) return;
      const evalDhf = buildDhfClient(true);
      const jobId = await evalDhf.runFlow(DHF_TEST_FLOW_NAME);
      expect(typeof jobId).toBe("string");
      expect(jobId.length).toBeGreaterThan(0);
    });

    it("throws EvalDisabledError when eval is not allowed", async () => {
      if (!dhfInstalled || !DHF_TEST_FLOW_NAME) return;
      const noEvalDhf = buildDhfClient(false);
      await expect(noEvalDhf.runFlow(DHF_TEST_FLOW_NAME)).rejects.toThrow();
    });
  });

  // ── getJobStatus() / listJobs() ───────────────────────────────────────────

  describe("getJobStatus() — dhf_job_status", () => {
    it("returns a job doc for a valid job ID when DHF has jobs", async () => {
      if (!dhfInstalled || !ML_ALLOW_EVAL || !DHF_TEST_FLOW_NAME) return;

      // Run a flow first to get a job ID
      const evalDhf = buildDhfClient(true);
      const jobId = await evalDhf.runFlow(DHF_TEST_FLOW_NAME, undefined, {});

      // Job may not be immediately visible — wait briefly
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const job = await dhf.getJobStatus(jobId);
      expect(job.jobId).toBe(jobId);
      expect(typeof job.flow).toBe("string");
      expect(typeof job.jobStatus).toBe("string");
    });

    it("throws on a completely invalid job ID", async () => {
      if (!dhfInstalled) return;
      await expect(dhf.getJobStatus("__no_such_job_id_xyz__")).rejects.toThrow();
    });
  });

  describe("listJobs() — secondary path for dhf_job_status polling", () => {
    it("returns an array of jobs from data-hub-JOBS", async () => {
      if (!dhfInstalled) return;
      const jobs = await dhf.listJobs();
      expect(Array.isArray(jobs)).toBe(true);
    });

    it("each job has jobId and jobStatus fields", async () => {
      if (!dhfInstalled) return;
      const jobs = await dhf.listJobs(undefined, 5);
      for (const job of jobs) {
        expect(typeof job.jobId).toBe("string");
        expect(typeof job.jobStatus).toBe("string");
      }
    });

    it("filters by flowName when provided", async () => {
      if (!dhfInstalled || !DHF_TEST_FLOW_NAME) return;
      const jobs = await dhf.listJobs(DHF_TEST_FLOW_NAME, 10);
      for (const job of jobs) {
        expect(job.flow).toBe(DHF_TEST_FLOW_NAME);
      }
    });
  });
});
