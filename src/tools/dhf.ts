/**
 * Data Hub Framework (DHF) 5.x MCP tools.
 *
 * Prerequisites:
 *   DHF 5.x must be deployed to MarkLogic (databases data-hub-STAGING,
 *   data-hub-FINAL, data-hub-JOBS must exist).
 *
 * Tool registration gating:
 *   dhf_status       — always registered (read-only, detection probe)
 *   dhf_flows_list   — always registered (read-only)
 *   dhf_flow_run     — registered only when allowEval=true AND readonly=false
 *   dhf_job_status   — always registered (read-only)
 *
 * Async execution model:
 *   dhf_flow_run returns a job ID immediately. The flow steps run asynchronously
 *   in MarkLogic background tasks. Use dhf_job_status with the job ID to poll
 *   for completion. Typical poll interval: 5–30 seconds for small flows.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";
import type { FlowDoc, FlowStepDef, JobDoc, StepResult } from "../client/dhf.js";

export function registerDhfTools(
  server: McpServer,
  clients: MarkLogicClients,
  allowEval: boolean,
  readonly: boolean
): void {
  const { dhf } = clients;

  // ── dhf_status ──────────────────────────────────────────────────────────────
  server.tool(
    "dhf_status",
    "Check whether MarkLogic Data Hub Framework (DHF) 5.x is installed and return version info.\n\n" +
    "DHF extends MarkLogic with three extra databases (data-hub-STAGING, data-hub-FINAL, data-hub-JOBS) " +
    "and an entity-oriented pipeline framework (flows, steps, entity models, mappings). " +
    "It is an optional layer on top of MarkLogic — not all deployments have DHF installed.\n\n" +
    "Run this first before any other dhf_* tool to confirm DHF is present.\n\n" +
    "WHEN TO USE DHF FLOWS vs FLUX:\n" +
    "  • Use dhf_flow_run when your project already has DHF flows and step definitions.\n" +
    "  • Use flux_import for general-purpose bulk data loading without DHF.\n" +
    "  • DHF flows add entity modelling, mapping, matching, and mastering steps on top of basic ingestion.",
    {},
    async () => {
      try {
        const result = await dhf.detect();
        if (!result.installed) {
          const missing = result.missingDatabases.join(", ");
          return {
            content: [{
              type: "text" as const,
              text:
                "DHF 5.x is NOT installed (or not fully deployed).\n\n" +
                (result.missingDatabases.length > 0
                  ? `Missing databases: ${missing}\n`
                  : "No DHF databases found.\n") +
                "\nExpected databases: data-hub-STAGING, data-hub-FINAL, data-hub-JOBS\n" +
                "Deploy DHF 5.x via: gradle hubDeploy",
            }],
            isError: true,
          };
        }
        const versionStr = result.version ? `DHF version: ${result.version}` : "DHF version: unknown (config document not found)";
        return {
          content: [{
            type: "text" as const,
            text:
              `DHF 5.x is installed.\n\n` +
              `${versionStr}\n` +
              `Databases found: ${result.foundDatabases.join(", ")}\n\n` +
              `dhf_flow_run available: ${allowEval && !readonly ? "yes" : "no (requires ML_ALLOW_EVAL=true and ML_READONLY=false)"}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: toToolError(err) }],
          isError: true,
        };
      }
    }
  );

  // ── dhf_flows_list ──────────────────────────────────────────────────────────
  server.tool(
    "dhf_flows_list",
    "List all Data Hub Framework (DHF) 5.x flows deployed in the staging database, " +
    "including each flow's steps with their type, source/target databases, and collections.\n\n" +
    "Flow step types: ingestion, mapping, matching, merging, mastering, custom\n\n" +
    "Prerequisite: DHF 5.x must be installed. Run dhf_status first to confirm.\n\n" +
    "USE BEFORE: dhf_flow_run — to identify the flow name and which step numbers to run.",
    {
      flow_name: z.string().optional().describe(
        "Filter to a specific flow by name. Omit to list all flows."
      ),
    },
    async ({ flow_name }) => {
      try {
        let flows: FlowDoc[];
        if (flow_name) {
          flows = [await dhf.getFlow(flow_name)];
        } else {
          flows = await dhf.listFlows();
        }

        if (flows.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: "No flows found in data-hub-STAGING.\n\n" +
                "Deploy flows with: gradle hubDeployArtifacts",
            }],
          };
        }

        const text = flows.map((flow) => formatFlow(flow)).join("\n\n---\n\n");
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: toToolError(err) }],
          isError: true,
        };
      }
    }
  );

  // ── dhf_flow_run ────────────────────────────────────────────────────────────
  if (!readonly && allowEval) {
    server.tool(
      "dhf_flow_run",
      "Run a Data Hub Framework (DHF) 5.x flow (or specific steps of a flow).\n\n" +
      "IMPORTANT — ASYNC EXECUTION:\n" +
      "  This tool returns a job ID immediately. The actual step processing runs " +
      "asynchronously in MarkLogic background tasks. Use dhf_job_status with the " +
      "returned job ID to monitor progress and check for errors.\n\n" +
      "  Typical poll strategy: wait 5–10 seconds, then call dhf_job_status repeatedly " +
      "until jobStatus is 'finished', 'failed', or 'finished_with_errors'.\n\n" +
      "PREREQUISITES:\n" +
      "  • DHF 5.x must be installed (run dhf_status to confirm)\n" +
      "  • Flow must exist in data-hub-STAGING (run dhf_flows_list to confirm)\n" +
      "  • For ingestion steps: inputFilePath must be accessible by MarkLogic\n" +
      "  • For mapping/mastering: source documents must already be in staging\n\n" +
      "Requires: ML_ALLOW_EVAL=true, ML_READONLY=false",
      {
        flow_name: z.string().describe(
          "Name of the DHF flow to run. Must match a flow in dhf_flows_list exactly."
        ),
        step_numbers: z.array(z.string()).optional().describe(
          "Specific step numbers to run, e.g. ['1', '2']. Omit to run all steps in the flow."
        ),
        options: z.record(z.unknown()).optional().describe(
          "Runtime option overrides passed to the flow runner. Use to override step-level " +
          "settings such as batchSize, targetDatabase, sourceQuery, inputFilePath, etc. " +
          "Example: { 'sourceQuery': 'cts.collectionQuery([\"raw-data\"])' }"
        ),
      },
      async ({ flow_name, step_numbers, options }) => {
        try {
          const jobId = await dhf.runFlow(
            flow_name,
            step_numbers as string[] | undefined,
            options as Record<string, unknown> | undefined
          );
          return {
            content: [{
              type: "text" as const,
              text:
                `Flow '${flow_name}' started successfully.\n\n` +
                `Job ID: ${jobId}\n\n` +
                `Steps: ${step_numbers && step_numbers.length > 0 ? step_numbers.join(", ") : "all"}\n\n` +
                `The flow is running asynchronously. Call dhf_job_status with jobId='${jobId}' ` +
                `to check progress. Poll every 5–30 seconds until jobStatus is ` +
                `'finished', 'failed', or 'finished_with_errors'.`,
            }],
          };
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: toToolError(err) +
                "\n\nNOTE: dhf_flow_run requires DHF 5.8.x modules in the Modules database " +
                "(/data-hub/5/impl/flow.sjs, /data-hub/5/flow/job.sjs, and dependencies). " +
                "If modules are missing, deploy via: gradle hubDeploy " +
                "or load them manually using ml_document_put (database=Modules).",
            }],
            isError: true,
          };
        }
      }
    );
  }

  // ── dhf_job_status ──────────────────────────────────────────────────────────
  server.tool(
    "dhf_job_status",
    "Get the status and results of a Data Hub Framework (DHF) 5.x flow run.\n\n" +
    "Returns: job status, start/end times, per-step results including success/failure counts " +
    "and error messages.\n\n" +
    "Job statuses:\n" +
    "  running             — steps are still processing\n" +
    "  finished            — all steps completed successfully\n" +
    "  finished_with_errors — some steps had failures (check stepResults for details)\n" +
    "  failed              — the job itself failed (not just individual documents)\n" +
    "  canceled            — job was stopped before completion\n\n" +
    "Prerequisite: DHF 5.x must be installed. Job ID is returned by dhf_flow_run.\n\n" +
    "POLLING: Call this repeatedly (every 5–30 seconds) until status is not 'running'.",
    {
      job_id: z.string().describe(
        "The job ID returned by dhf_flow_run. Jobs are stored in data-hub-JOBS at /jobs/<jobId>.json."
      ),
    },
    async ({ job_id }) => {
      try {
        const job = await dhf.getJobStatus(job_id as string);
        return {
          content: [{ type: "text" as const, text: formatJob(job) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: toToolError(err) }],
          isError: true,
        };
      }
    }
  );
}

// ── Formatters ─────────────────────────────────────────────────────────────

function formatFlow(flow: FlowDoc): string {
  const lines: string[] = [];
  lines.push(`Flow: ${flow.name}`);
  if (flow.description) lines.push(`Description: ${flow.description}`);

  const steps = flow.steps ?? {};
  const stepKeys = Object.keys(steps).sort((a, b) => Number(a) - Number(b));

  if (stepKeys.length === 0) {
    lines.push("Steps: (none defined)");
  } else {
    lines.push(`Steps (${stepKeys.length}):`);
    for (const key of stepKeys) {
      lines.push(formatStep(key, steps[key]));
    }
  }
  return lines.join("\n");
}

function formatStep(stepNum: string, step: FlowStepDef): string {
  const lines: string[] = [`  Step ${stepNum}: ${step.stepDefinitionName} (${step.stepDefinitionType})`];
  if (step.description) lines.push(`    Description: ${step.description}`);
  if (step.sourceDatabase) lines.push(`    Source DB:   ${step.sourceDatabase}`);
  if (step.targetDatabase) lines.push(`    Target DB:   ${step.targetDatabase}`);
  if (step.collections?.length) lines.push(`    Collections: ${step.collections.join(", ")}`);
  if (step.batchSize) lines.push(`    Batch size:  ${step.batchSize}`);
  return lines.join("\n");
}

function formatJob(job: JobDoc): string {
  const lines: string[] = [];
  lines.push(`Job ID:     ${job.jobId}`);
  lines.push(`Flow:       ${job.flow}`);
  lines.push(`Status:     ${job.jobStatus}`);
  if (job.user) lines.push(`User:       ${job.user}`);
  if (job.timeStarted) lines.push(`Started:    ${job.timeStarted}`);
  if (job.timeEnded) lines.push(`Ended:      ${job.timeEnded}`);
  if (job.lastCompletedStep) lines.push(`Last step completed: ${job.lastCompletedStep}`);
  if (job.lastAttemptedStep) lines.push(`Last step attempted: ${job.lastAttemptedStep}`);

  const stepResults = job.stepResults ?? {};
  const stepKeys = Object.keys(stepResults);
  if (stepKeys.length > 0) {
    lines.push(`\nStep Results:`);
    for (const key of stepKeys.sort((a, b) => Number(a) - Number(b))) {
      lines.push(formatStepResult(key, stepResults[key]));
    }
  }
  return lines.join("\n");
}

function formatStepResult(stepNum: string, result: StepResult): string {
  const lines: string[] = [
    `  Step ${stepNum}: ${result.stepDefinitionName ?? "(unknown)"} ` +
    `[${result.success === false ? "FAILED" : "OK"}]`,
  ];
  if (result.totalEvents !== undefined) {
    lines.push(
      `    Events: ${result.totalEvents} total, ` +
      `${result.successfulEvents ?? 0} succeeded, ` +
      `${result.failedEvents ?? 0} failed`
    );
  }
  if (result.stepStartTime) lines.push(`    Started: ${result.stepStartTime}`);
  if (result.stepEndTime) lines.push(`    Ended:   ${result.stepEndTime}`);
  if (result.errorMessages?.length) {
    lines.push(`    Errors:`);
    for (const msg of result.errorMessages.slice(0, 5)) {
      lines.push(`      - ${msg}`);
    }
    if (result.errorMessages.length > 5) {
      lines.push(`      ... and ${result.errorMessages.length - 5} more errors`);
    }
  }
  return lines.join("\n");
}
