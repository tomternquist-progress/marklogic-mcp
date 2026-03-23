/**
 * Data Hub Framework (DHF) 5.x client.
 *
 * Provides client methods for:
 *   - Detecting DHF installation (checks for data-hub-JOBS database)
 *   - Listing flows from the staging database artifact store
 *   - Running flows via server-side JavaScript eval (requires allowEval=true)
 *   - Retrieving job status from the jobs database
 *
 * Minimum requirement: DHF 5.2+
 *
 * Architecture notes:
 *   Flow artifacts are stored as JSON documents in data-hub-STAGING under
 *   collection http://marklogic.com/data-hub/flow, URI /flows/<name>.flow.json.
 *
 *   Job records are stored in data-hub-JOBS at /jobs/<jobId>.json.
 *
 *   Flow execution uses DHF's internal FlowRunner SJS module via eval.
 *   Flows process documents from their configured source query/collection —
 *   there is no inline content passing. The call returns a job ID immediately;
 *   the actual step processing runs asynchronously.
 */

import type { MarkLogicBaseClient } from "./base.js";
import type { AdminClient } from "./admin.js";
import type { EvalClient } from "./eval.js";
import type { DocumentsClient } from "./documents.js";
import type { SearchClient } from "./search.js";
import { NotFoundError } from "../utils/errors.js";

export const DHF_STAGING_DB = "data-hub-STAGING";
export const DHF_FINAL_DB = "data-hub-FINAL";
export const DHF_JOBS_DB = "data-hub-JOBS";
export const DHF_FLOW_COLLECTION = "http://marklogic.com/data-hub/flow";
export const DHF_MODULES_DB = "data-hub-MODULES";

export interface FlowStepDef {
  stepId: string;
  stepDefinitionName: string;
  stepDefinitionType: string;
  description?: string;
  collections?: string[];
  additionalCollections?: string[];
  sourceDatabase?: string;
  targetDatabase?: string;
  inputFilePath?: string;
  outputFormat?: string;
  batchSize?: number;
  threadCount?: number;
  [key: string]: unknown;
}

export interface FlowDoc {
  name: string;
  description?: string;
  steps: Record<string, FlowStepDef>;
}

export interface StepResult {
  stepDefinitionName?: string;
  stepDefinitionType?: string;
  success?: boolean;
  totalEvents?: number;
  successfulEvents?: number;
  failedEvents?: number;
  stepStartTime?: string;
  stepEndTime?: string;
  errorMessages?: string[];
  [key: string]: unknown;
}

/**
 * Batch-level error record stored in data-hub-JOBS at /jobs/batches/<batchId>.json.
 * Each batch processes a subset of URIs for one step; failed batches contain
 * per-URI error details that the top-level job stepResults do not expose.
 */
export interface BatchDoc {
  batchId?: string;
  jobId?: string;
  stepName?: string;
  stepDefinitionType?: string;
  batchStatus?: string;
  urisLoadedSuccessfully?: string[];
  urisFailed?: string[];
  errorMessages?: string[];
  [key: string]: unknown;
}

export interface JobDoc {
  jobId: string;
  flow: string;
  user?: string;
  jobStatus: string;
  timeStarted?: string;
  timeEnded?: string;
  stepResults?: Record<string, StepResult>;
  lastAttemptedStep?: string;
  lastCompletedStep?: string;
  /** Populated by getJobStatus() when there are failures — batch-level error details. */
  batchErrors?: BatchDoc[];
}

export interface DhfDetectResult {
  installed: boolean;
  foundDatabases: string[];
  missingDatabases: string[];
  version?: string;
  /** Whether the data-hub-MODULES database exists (indicates DHF modules are deployed). */
  modulesDbFound?: boolean;
}

export class DhfClient {
  constructor(
    private readonly base: MarkLogicBaseClient,
    private readonly admin: AdminClient,
    private readonly evalClient: EvalClient,
    private readonly documents: DocumentsClient,
    private readonly search: SearchClient
  ) {}

  /**
   * Detect whether DHF 5.x is installed by checking for the expected databases.
   * Also attempts to read the DHF version from the hub-properties config document.
   */
  async detect(): Promise<DhfDetectResult> {
    const dbs = await this.admin.listDatabases();
    const dbNames = dbs.map((d) => d.name);
    const expectedDbs = [DHF_STAGING_DB, DHF_FINAL_DB, DHF_JOBS_DB];
    const foundDatabases = expectedDbs.filter((db) => dbNames.includes(db));
    const missingDatabases = expectedDbs.filter((db) => !dbNames.includes(db));
    const modulesDbFound = dbNames.includes(DHF_MODULES_DB);

    if (foundDatabases.length === 0) {
      return { installed: false, foundDatabases: [], missingDatabases: expectedDbs, modulesDbFound };
    }

    // Try to read the DHF version from the hub-properties config document.
    // Location varies slightly across DHF 5.x minor versions; try the most common URIs.
    let version: string | undefined;
    const versionUris = [
      "/config/hub-properties.json",
      "/config/hub-version.json",
    ];
    for (const uri of versionUris) {
      try {
        const doc = await this.documents.get(uri, DHF_STAGING_DB);
        const props = doc.content as Record<string, unknown>;
        version =
          (props?.dhfVersion as string | undefined) ??
          (props?.version as string | undefined) ??
          (props?.["hub-version"] as string | undefined);
        if (version) break;
      } catch {
        // Not found at this URI — try the next
      }
    }

    return {
      installed: foundDatabases.length === expectedDbs.length,
      foundDatabases,
      missingDatabases,
      version,
      modulesDbFound,
    };
  }

  /**
   * List all flows in the DHF staging database.
   * Returns the full flow document for each flow, including step definitions.
   */
  async listFlows(): Promise<FlowDoc[]> {
    const response = await this.search.search({
      collection: DHF_FLOW_COLLECTION,
      database: DHF_STAGING_DB,
      pageLength: 200,
      format: "json",
    });

    const flows: FlowDoc[] = [];
    for (const result of response.results) {
      try {
        const doc = await this.documents.get(result.uri, DHF_STAGING_DB);
        if (doc.content && typeof doc.content === "object") {
          flows.push(doc.content as FlowDoc);
        }
      } catch {
        // Skip flows that can't be read (permissions, corrupt doc, etc.)
      }
    }
    return flows;
  }

  /**
   * Get a specific flow by name.
   * Throws NotFoundError if the flow does not exist.
   */
  async getFlow(flowName: string): Promise<FlowDoc> {
    const uri = `/flows/${flowName}.flow.json`;
    const doc = await this.documents.get(uri, DHF_STAGING_DB);
    return doc.content as FlowDoc;
  }

  /**
   * Run a DHF 5.x flow via server-side JavaScript eval.
   *
   * This calls DHF's internal FlowRunner module, which:
   *   1. Creates a job record in data-hub-JOBS
   *   2. Spawns async tasks to process each step
   *   3. Returns the job ID immediately (before steps complete)
   *
   * Use dhf_job_status with the returned job ID to monitor progress.
   *
   * Requires allowEval=true (uses /v1/eval).
   * Requires ML_READONLY=false (flow execution writes job records and output docs).
   *
   * @param flowName  Name of the flow to run
   * @param stepNumbers  Array of step number strings to run, e.g. ["1", "2"].
   *                     Pass undefined or empty array to run all steps.
   * @param options   Runtime options object passed to the flow runner (optional).
   *                  Use to override step-level options such as batchSize, targetDatabase, etc.
   * @returns job ID string
   */
  async runFlow(
    flowName: string,
    stepNumbers?: string[],
    options?: Record<string, unknown>
  ): Promise<string> {
    // DHF 5.8.x flow execution via impl/flow.sjs.
    //
    // Execution model:
    //   1. Validate the flow exists (fail fast)
    //   2. Create a job record synchronously (caller gets jobId immediately)
    //   3. Spawn step execution as a background task via xdmp.spawnFunction()
    //      — this avoids eval timeouts on large datasets
    //   4. The spawned task updates the job status when all steps finish
    //
    // For very large batches (thousands of docs per step), prefer running via
    // the DHF client JAR or Gradle hubRunFlow which supports parallel batching.
    const code = `
'use strict';
declareUpdate();
var flowName = external.flowName;
var stepNumbers = external.stepNumbers;
var runtimeOptions = external.runtimeOptions || {};

const Flow = require('/data-hub/5/impl/flow.sjs');
const Job  = require('/data-hub/5/flow/job.sjs');

// Validate flow exists before spawning (fail fast, avoids orphaned job records)
var checkFlow = new Flow();
var flowDef = checkFlow.getFlow(flowName);
if (!flowDef) { throw new Error('Flow not found: ' + flowName); }
var allSteps = Object.keys(flowDef.steps || {}).sort();
var stepsToRun = (stepNumbers && stepNumbers.length > 0) ? stepNumbers : allSteps;

// Create job record synchronously so the caller gets a valid jobId immediately
var jobObj = Job.newJob(flowName, null);
jobObj.create();
var jobId = jobObj.jobId;

// Spawn step execution as a background task — avoids eval timeouts on large datasets
xdmp.spawnFunction(function() {
  'use strict';
  declareUpdate();
  var Flow = require('/data-hub/5/impl/flow.sjs');
  var runner = new Flow();
  var finalStatus = 'finished';
  for (var i = 0; i < stepsToRun.length; i++) {
    try {
      var content = runner.findMatchingContent(flowName, stepsToRun[i], runtimeOptions);
      runner.runFlow(flowName, jobId, content, runtimeOptions, stepsToRun[i]);
    } catch (e) {
      finalStatus = 'finished_with_errors';
    }
  }
  // Update top-level job status in the JOBS database once all steps finish.
  // Uses invokeFunction so the write targets data-hub-JOBS, not STAGING.
  var capturedJobId = jobId;
  var capturedStatus = finalStatus;
  xdmp.invokeFunction(function() {
    'use strict';
    declareUpdate();
    var uri = '/jobs/' + capturedJobId + '.json';
    var raw = cts.doc(uri);
    if (raw) {
      var n = raw.toObject();
      var j = (n.job !== undefined) ? n.job : n;
      j.jobStatus = capturedStatus;
      j.timeEnded = new Date().toISOString();
      xdmp.documentInsert(uri, n,
        xdmp.documentGetPermissions(uri),
        xdmp.documentGetCollections(uri));
    }
  }, { database: xdmp.database('data-hub-JOBS') });
}, { database: xdmp.database(), modules: xdmp.modulesDatabase() });

xdmp.toJsonString({ jobId: jobId, flow: flowName, steps: stepsToRun });
`.trim();

    const vars: Record<string, unknown> = {
      flowName,
      stepNumbers: stepNumbers && stepNumbers.length > 0 ? stepNumbers : null,
      runtimeOptions: options ?? {},
    };

    const results = await this.evalClient.evalJavaScript(code, vars, DHF_STAGING_DB);
    if (!results || results.length === 0) {
      throw new Error("Flow runner returned no output. Verify the flow name exists and the DHF modules are installed.");
    }

    // The return value is a JSON-stringified result object.
    // Extract the job ID from whichever shape DHF returned.
    const raw = results[0].value;
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      throw new Error(`Flow runner returned unexpected output: ${String(raw).slice(0, 200)}`);
    }

    const jobId = extractJobId(parsed);
    if (!jobId) {
      throw new Error(
        `Flow runner completed but could not extract job ID from response: ${JSON.stringify(parsed).slice(0, 300)}`
      );
    }
    return jobId;
  }

  /**
   * Get the status of a specific job from the data-hub-JOBS database.
   * Job documents are stored at /jobs/<jobId>.json.
   *
   * For failed/errored jobs, also fetches batch-level error documents from
   * /jobs/batches/<batchId>.json which contain per-URI failure details that
   * the top-level stepResults do not expose.
   */
  async getJobStatus(jobId: string): Promise<JobDoc> {
    // Try the standard URI pattern first, then an alternate pattern.
    const uris = [`/jobs/${jobId}.json`, `/${jobId}.json`];
    for (const uri of uris) {
      try {
        const doc = await this.documents.get(uri, DHF_JOBS_DB);
        const content = doc.content as Record<string, unknown>;
        // In some DHF versions the job is nested under a "job" property
        const job = (content?.job as JobDoc | undefined) ?? (content as unknown as JobDoc);

        // Augment with batch-level error details when the job had failures
        if (job.jobStatus && job.jobStatus !== "finished") {
          const batchErrors = await this.getBatchErrors(jobId);
          if (batchErrors.length > 0) {
            job.batchErrors = batchErrors;
          }
        }

        return job;
      } catch (err) {
        if (err instanceof NotFoundError) continue;
        throw err;
      }
    }
    throw new NotFoundError(`/jobs/${jobId}.json`);
  }

  /**
   * Fetch batch-level error documents for a job from data-hub-JOBS.
   *
   * DHF stores batch records at /jobs/batches/<batchId>.json with a jobId
   * property linking them to the parent job. Failed batches contain per-URI
   * error details (urisFailed, errorMessages) that are not surfaced in the
   * top-level job stepResults.
   *
   * Returns only failed batches (batchStatus="failed" or urisFailed non-empty).
   */
  private async getBatchErrors(jobId: string): Promise<BatchDoc[]> {
    try {
      const response = await this.search.search({
        database: DHF_JOBS_DB,
        structuredQuery: {
          query: {
            "value-query": {
              "json-property": "jobId",
              text: [jobId],
            },
          },
        },
        pageLength: 100,
        format: "json",
      });

      const batches: BatchDoc[] = [];
      for (const result of response.results) {
        // Only process batch documents, not the job doc itself
        if (!result.uri.includes("/batches/")) continue;
        try {
          const doc = await this.documents.get(result.uri, DHF_JOBS_DB);
          const content = doc.content as BatchDoc;
          // Only include batches that actually failed
          if (content.batchStatus === "failed" || (content.urisFailed && content.urisFailed.length > 0)) {
            batches.push(content);
          }
        } catch {
          // Skip unreadable batch docs
        }
      }
      return batches;
    } catch {
      // Best-effort: don't fail getJobStatus if batch query fails
      return [];
    }
  }

  /**
   * List recent jobs from the data-hub-JOBS database.
   *
   * @param flowName  Optional filter by flow name
   * @param limit     Maximum number of jobs to return (default: 20)
   */
  async listJobs(flowName?: string, limit = 20): Promise<JobDoc[]> {
    const searchParams: Parameters<SearchClient["search"]>[0] = {
      database: DHF_JOBS_DB,
      pageLength: limit,
      format: "json",
    };

    if (flowName) {
      searchParams.structuredQuery = {
        query: {
          "value-query": {
            "json-property": "flow",
            text: [flowName],
          },
        },
      };
    }

    const response = await this.search.search(searchParams);
    const jobs: JobDoc[] = [];

    for (const result of response.results) {
      try {
        const doc = await this.documents.get(result.uri, DHF_JOBS_DB);
        const content = doc.content as Record<string, unknown>;
        // Handle both flat and nested job document shapes
        const job = (content?.job as JobDoc | undefined) ?? (content as unknown as JobDoc);
        if (job?.jobId || job?.flow) jobs.push(job);
      } catch {
        // Skip unreadable jobs
      }
    }
    return jobs;
  }
}

/** Extract a job ID from the various shapes DHF 5.x returns from FlowRunner.run(). */
function extractJobId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  // Direct jobId on result object
  if (typeof r.jobId === "string") return r.jobId;
  // Nested under a "job" property
  if (r.job && typeof r.job === "object") {
    const job = r.job as Record<string, unknown>;
    if (typeof job.jobId === "string") return job.jobId;
  }
  // Some versions wrap under "jobReport"
  if (r.jobReport && typeof r.jobReport === "object") {
    const report = r.jobReport as Record<string, unknown>;
    if (typeof report.jobId === "string") return report.jobId;
  }
  return undefined;
}
