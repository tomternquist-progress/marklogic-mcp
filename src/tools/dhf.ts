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

import { spawn } from "child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";
import type { FlowDoc, FlowStepDef, JobDoc, StepResult } from "../client/dhf.js";
import type { ConnectionConfig, DhfConfig } from "../config/schema.js";

export function registerDhfTools(
  server: McpServer,
  clients: MarkLogicClients,
  allowEval: boolean,
  readonly: boolean,
  dhfConfig: DhfConfig = {},
  connection: ConnectionConfig = {} as ConnectionConfig
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
        const modulesNote = result.modulesDbFound
          ? `data-hub-MODULES: found\n`
          : `data-hub-MODULES: NOT FOUND — DHF modules may not be deployed; run 'gradle hubDeploy'\n`;
        return {
          content: [{
            type: "text" as const,
            text:
              `DHF 5.x is installed.\n\n` +
              `${versionStr}\n` +
              `Databases found: ${result.foundDatabases.join(", ")}\n` +
              `${modulesNote}\n` +
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
      "EXECUTION MODEL:\n" +
      "  Returns a job ID immediately. Steps run as a background task via\n" +
      "  xdmp.spawnFunction() — avoids eval timeouts on large datasets.\n" +
      "  Poll dhf_job_status every 5–30 seconds until jobStatus is\n" +
      "  'finished', 'finished_with_errors', or 'failed'.\n\n" +
      "  For very large datasets (thousands of docs per step), prefer the\n" +
      "  DHF client JAR or Gradle hubRunFlow which support parallel batching.\n\n" +
      "PREREQUISITES (run dhf_status first to check databases):\n" +
      "  • DHF 5.x installed: data-hub-STAGING, data-hub-FINAL, data-hub-JOBS, data-hub-MODULES\n" +
      "  • Flow must exist in data-hub-STAGING (run dhf_flows_list to confirm)\n" +
      "  • Steps must be in data-hub-STAGING with collection http://marklogic.com/data-hub/steps\n" +
      "    (not http://marklogic.com/data-hub/STEP_DEFINITION — deploy via gradle hubDeployArtifacts)\n" +
      "  • For ingestion: inputFilePath must be accessible by the MarkLogic server process\n" +
      "  • For mapping: compiled XSLT must be in Modules DB at\n" +
      "    /mappings/<Name>/<Name>-<v>.mapping.xml.xslt (generated from mapping artifact)\n" +
      "  • For mastering: entity model must be in data-hub-FINAL with collection\n" +
      "    http://marklogic.com/entity-services/models and triple indexing enabled\n" +
      "  • ~17 DHF security roles required (data-hub-common, data-hub-operator,\n" +
      "    data-hub-developer, data-hub-ingestion-reader/writer, etc.)\n\n" +
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
                "\n\nNOTE: dhf_flow_run requires all of the following:\n" +
                "  • DHF 5.8.x modules in Modules DB (/data-hub/5/impl/flow.sjs, /data-hub/5/flow/job.sjs)\n" +
                "    → deploy via: gradle hubDeploy\n" +
                "  • Step documents in data-hub-STAGING with collection http://marklogic.com/data-hub/steps\n" +
                "    (NOT http://marklogic.com/data-hub/STEP_DEFINITION)\n" +
                "    → deploy via: gradle hubDeployArtifacts\n" +
                "  • For mapping steps: compiled XSLT in Modules DB at\n" +
                "    /mappings/<Name>/<Name>-<v>.mapping.xml.xslt\n" +
                "    → generate using buildMappingXML() + mapping-compile.xsl from STAGING eval context\n" +
                "  • For mastering steps: entity model in data-hub-FINAL with collection\n" +
                "    http://marklogic.com/entity-services/models and triple indexing enabled\n" +
                "  • ~17 DHF security roles (data-hub-common, data-hub-operator, data-hub-developer,\n" +
                "    data-hub-ingestion-reader/writer, data-hub-mapping-reader/writer,\n" +
                "    data-hub-match-merge-reader/writer, and others)\n" +
                "    → create via sec:create-role() in Security DB, one role per transaction",
            }],
            isError: true,
          };
        }
      }
    );
  }

  // ── dhf_flow_run_jar ────────────────────────────────────────────────────────
  if (!readonly && dhfConfig.clientJarPath) {
    server.tool(
      "dhf_flow_run_jar",
      "Run a Data Hub Framework (DHF) 5.x flow using the DHF client JAR.\n\n" +
      "USE THIS INSTEAD OF dhf_flow_run when:\n" +
      "  • The dataset is large (hundreds or thousands of documents per step)\n" +
      "  • You hit eval timeouts with dhf_flow_run\n" +
      "  • You want parallel batch processing (the JAR uses DHF's native Java client)\n\n" +
      "EXECUTION MODEL:\n" +
      "  Runs the JAR synchronously as a child process — blocks until the flow\n" +
      "  completes and returns the full output. No polling required.\n" +
      "  Default timeout: 10 minutes. Increase via timeout_minutes for very large flows.\n\n" +
      "ADVANTAGES OVER dhf_flow_run:\n" +
      "  • No ML_ALLOW_EVAL required (JAR uses Java Client API directly)\n" +
      "  • No MarkLogic-side eval timeout\n" +
      "  • Built-in parallel batch processing for large document sets\n\n" +
      "PREREQUISITES (same as dhf_flow_run):\n" +
      "  • DHF 5.x installed with all databases and modules\n" +
      "  • Flow and steps deployed in data-hub-STAGING\n" +
      "  • For mapping/mastering steps: compiled XSLT and entity model in place\n" +
      "  • ML_DHF_PORT set if your DHF staging server uses a port other than ML_PORT\n\n" +
      "Requires: ML_READONLY=false",
      {
        flow_name: z.string().describe(
          "Name of the DHF flow to run. Must match a flow in dhf_flows_list exactly."
        ),
        step_numbers: z.array(z.string()).optional().describe(
          "Specific step numbers to run, e.g. ['1', '2']. Omit to run all steps."
        ),
        timeout_minutes: z.number().int().min(1).max(120).optional().describe(
          "Maximum time to wait for the flow to complete in minutes. Default: 10."
        ),
      },
      async ({ flow_name, step_numbers, timeout_minutes }) => {
        try {
          const output = await runFlowViaJar({
            jarPath: dhfConfig.clientJarPath!,
            connection,
            dhfPort: dhfConfig.port,
            dhfJobsPort: dhfConfig.jobsPort,
            flowName: flow_name,
            stepNumbers: step_numbers,
            timeoutMs: (timeout_minutes ?? 10) * 60 * 1000,
          });
          return {
            content: [{
              type: "text" as const,
              text:
                `Flow '${flow_name}' completed via DHF client JAR.\n\n` +
                `Steps: ${step_numbers && step_numbers.length > 0 ? step_numbers.join(", ") : "all"}\n\n` +
                `Output:\n${output}`,
            }],
          };
        } catch (err) {
          return {
            content: [{
              type: "text" as const,
              text: toToolError(err) +
                "\n\nHints:\n" +
                "  • Verify ML_DHF_PORT matches your DHF staging app server port (often 8010)\n" +
                "  • Ensure the user has the flow-operator and data-hub-operator roles\n" +
                "  • Check ML_HOST, ML_USERNAME, ML_PASSWORD are correct\n" +
                "  • For SSL deployments set ML_SSL=true",
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
    "and error messages. For failed jobs, also returns batch-level error details from " +
    "/jobs/batches/ documents — these contain per-URI failure lists not visible in top-level step results.\n\n" +
    "Job statuses:\n" +
    "  started             — job created, background task not yet complete (keep polling)\n" +
    "  finished            — all steps completed successfully\n" +
    "  finished_with_errors — some steps had failures (check stepResults and batchErrors)\n" +
    "  failed              — the job itself failed (not just individual documents)\n" +
    "  canceled            — job was stopped before completion\n\n" +
    "Prerequisite: DHF 5.x must be installed. Job ID is returned by dhf_flow_run.\n\n" +
    "POLLING: Call this repeatedly (every 5–30 seconds) until status is not 'started'.",
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

// ── DHF client JAR runner ───────────────────────────────────────────────────

interface JarRunParams {
  jarPath: string;
  connection: ConnectionConfig;
  dhfPort?: number;
  /** DHF jobs app server port. Defaults to dhfPort + 2 (standard on-premise offset). */
  dhfJobsPort?: number;
  flowName: string;
  stepNumbers?: string[];
  timeoutMs: number;
}

/**
 * Run a DHF flow via the standalone DHF client JAR.
 *
 * The JAR uses the MarkLogic Java Client API directly — no eval, no Gradle.
 * It connects to the DHF staging app server (defaulting to ML_PORT unless
 * ML_DHF_PORT overrides it) and runs the flow synchronously.
 *
 * Password is passed as a command-line argument. In a containerised environment
 * this is acceptable; for higher-security deployments consider a vault integration.
 */
async function runFlowViaJar(params: JarRunParams): Promise<string> {
  const { jarPath, connection, dhfPort, dhfJobsPort, flowName, stepNumbers, timeoutMs } = params;
  const port = dhfPort ?? connection.port;
  // Jobs port defaults to staging port + 2 (standard DHF on-premise offset: e.g. 8020→8022)
  const jobsPort = dhfJobsPort ?? (port + 2);

  const args: string[] = [
    "-jar", jarPath,
    "runFlow",
    "-host", connection.host,
    "-username", connection.username,
    "-password", connection.password,
    "-flowName", flowName,
    // Override ports — the JAR defaults to DHS ports (8010/8013); override for on-premise
    `-PmlStagingPort=${port}`,
    `-PmlPort=${port}`,
    `-PmlJobPort=${jobsPort}`,
  ];

  if (stepNumbers && stepNumbers.length > 0) {
    args.push("-steps", stepNumbers.join(","));
  }

  if (connection.authType === "basic") {
    args.push("-auth", "basic");
  }

  if (connection.ssl) {
    args.push("-ssl");
    if (!connection.rejectUnauthorized) {
      // Self-signed certs — tell the JAR not to verify the server certificate
      args.push("-PmlSslHostnameVerifier=ANY");
    }
  }

  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("java", args, { stdio: "pipe" });

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(
        `DHF client JAR timed out after ${timeoutMs / 1000}s.\n` +
        `Partial output:\n${stdout || "(none)"}\n${stderr || ""}`
      ));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\nSTDERR:\n");
      if (code !== 0) {
        reject(new Error(`DHF client JAR exited with code ${code}.\n${combined}`));
      } else {
        resolve(combined || "(no output)");
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error(
          "java executable not found. Ensure Java (JRE 11+) is installed and on PATH.\n" +
          `JAR path: ${jarPath}`
        ));
      } else {
        reject(err);
      }
    });
  });
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

  // Batch-level errors — per-URI failure details not visible in stepResults
  if (job.batchErrors && job.batchErrors.length > 0) {
    lines.push(`\nFailed Batches (${job.batchErrors.length}):`);
    for (const batch of job.batchErrors.slice(0, 10)) {
      lines.push(`  Batch: ${batch.batchId ?? "(unknown)"} [${batch.batchStatus ?? "failed"}]`);
      if (batch.stepName) lines.push(`    Step: ${batch.stepName}`);
      if (batch.urisFailed && batch.urisFailed.length > 0) {
        lines.push(`    Failed URIs (${batch.urisFailed.length}):`);
        for (const uri of batch.urisFailed.slice(0, 5)) {
          lines.push(`      - ${uri}`);
        }
        if (batch.urisFailed.length > 5) {
          lines.push(`      ... and ${batch.urisFailed.length - 5} more`);
        }
      }
      if (batch.errorMessages && batch.errorMessages.length > 0) {
        lines.push(`    Errors:`);
        for (const msg of batch.errorMessages.slice(0, 3)) {
          lines.push(`      - ${msg}`);
        }
        if (batch.errorMessages.length > 3) {
          lines.push(`      ... and ${batch.errorMessages.length - 3} more`);
        }
      }
    }
    if (job.batchErrors.length > 10) {
      lines.push(`  ... and ${job.batchErrors.length - 10} more failed batches`);
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
