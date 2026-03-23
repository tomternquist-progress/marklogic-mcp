import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// Mock child_process before any module that imports it is loaded.
// vi.mock is hoisted by vitest so this runs before all imports.
vi.mock("child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "child_process";
import { registerDhfTools } from "../../src/tools/dhf.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn(
      (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
        tools.set(_name, handler);
      }
    ),
  };
  return { server, tools };
}

function createMockDhfClient() {
  return {
    dhf: {
      detect: vi.fn(),
      listFlows: vi.fn(),
      getFlow: vi.fn(),
      runFlow: vi.fn(),
      getJobStatus: vi.fn(),
      listJobs: vi.fn(),
    },
  };
}

/**
 * Create a fake ChildProcess that emits stdout data, then closes.
 * Pass exitCode != 0 to simulate failure; pass errorEvent to simulate spawn failure (e.g. ENOENT).
 */
function makeFakeChild(exitCode: number, stdout: string, stderr = "", errorEvent?: NodeJS.ErrnoException) {
  const child = new EventEmitter() as NodeJS.EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  setImmediate(() => {
    if (errorEvent) {
      child.emit("error", errorEvent);
      return;
    }
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });

  return child;
}

const FAKE_JAR_PATH = "/app/marklogic-data-hub-client.jar";
const FAKE_CONNECTION = {
  host: "localhost",
  port: 8010,
  managementPort: 8002,
  username: "admin",
  password: "admin",
  database: "Documents",
  ssl: false,
  rejectUnauthorized: true,
  authType: "digest" as const,
  timeoutMs: 30_000,
};

// ─── Tool registration ──────────────────────────────────────────────────────

describe("registerDhfTools – tool registration", () => {
  it("registers 3 tools when allowEval=false (dhf_flow_run excluded)", () => {
    const { server, tools } = createMockServer();
    registerDhfTools(server as never, createMockDhfClient() as never, false, false);

    expect(tools.has("dhf_status")).toBe(true);
    expect(tools.has("dhf_flows_list")).toBe(true);
    expect(tools.has("dhf_job_status")).toBe(true);
    expect(tools.has("dhf_flow_run")).toBe(false);
    expect(tools.has("dhf_flow_run_jar")).toBe(false);
    expect(tools.size).toBe(3);
  });

  it("registers 3 tools when readonly=true (dhf_flow_run excluded)", () => {
    const { server, tools } = createMockServer();
    registerDhfTools(server as never, createMockDhfClient() as never, true, true);

    expect(tools.has("dhf_flow_run")).toBe(false);
    expect(tools.has("dhf_flow_run_jar")).toBe(false);
    expect(tools.size).toBe(3);
  });

  it("registers all 4 tools when allowEval=true and readonly=false (no JAR configured)", () => {
    const { server, tools } = createMockServer();
    registerDhfTools(server as never, createMockDhfClient() as never, true, false);

    expect(tools.has("dhf_status")).toBe(true);
    expect(tools.has("dhf_flows_list")).toBe(true);
    expect(tools.has("dhf_flow_run")).toBe(true);
    expect(tools.has("dhf_job_status")).toBe(true);
    expect(tools.has("dhf_flow_run_jar")).toBe(false);
    expect(tools.size).toBe(4);
  });

  it("registers dhf_flow_run_jar when clientJarPath is set and readonly=false", () => {
    const { server, tools } = createMockServer();
    registerDhfTools(
      server as never, createMockDhfClient() as never,
      false, false,
      { clientJarPath: FAKE_JAR_PATH }, FAKE_CONNECTION as never
    );
    expect(tools.has("dhf_flow_run_jar")).toBe(true);
  });

  it("does not register dhf_flow_run_jar when readonly=true even if clientJarPath is set", () => {
    const { server, tools } = createMockServer();
    registerDhfTools(
      server as never, createMockDhfClient() as never,
      true, true,
      { clientJarPath: FAKE_JAR_PATH }, FAKE_CONNECTION as never
    );
    expect(tools.has("dhf_flow_run_jar")).toBe(false);
  });

  it("registers 5 tools when allowEval=true, readonly=false, and clientJarPath is set", () => {
    const { server, tools } = createMockServer();
    registerDhfTools(
      server as never, createMockDhfClient() as never,
      true, false,
      { clientJarPath: FAKE_JAR_PATH }, FAKE_CONNECTION as never
    );
    expect(tools.has("dhf_status")).toBe(true);
    expect(tools.has("dhf_flows_list")).toBe(true);
    expect(tools.has("dhf_flow_run")).toBe(true);
    expect(tools.has("dhf_job_status")).toBe(true);
    expect(tools.has("dhf_flow_run_jar")).toBe(true);
    expect(tools.size).toBe(5);
  });
});

// ─── dhf_status ────────────────────────────────────────────────────────────

describe("dhf_status handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockDhfClient>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockDhfClient();
    registerDhfTools(mock.server as never, clients as never, true, false);
    tools = mock.tools;
  });

  it("returns installed=true with version when DHF is present", async () => {
    clients.dhf.detect.mockResolvedValue({
      installed: true,
      foundDatabases: ["data-hub-STAGING", "data-hub-FINAL", "data-hub-JOBS"],
      missingDatabases: [],
      version: "5.8.1",
    });
    const result = await tools.get("dhf_status")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("DHF 5.x is installed");
    expect(result.content[0].text).toContain("5.8.1");
    expect(result.content[0].text).toContain("data-hub-STAGING");
  });

  it("shows data-hub-MODULES found when modulesDbFound=true", async () => {
    clients.dhf.detect.mockResolvedValue({
      installed: true,
      foundDatabases: ["data-hub-STAGING", "data-hub-FINAL", "data-hub-JOBS"],
      missingDatabases: [],
      modulesDbFound: true,
    });
    const result = await tools.get("dhf_status")!({});
    expect(result.content[0].text).toContain("data-hub-MODULES: found");
  });

  it("shows data-hub-MODULES NOT FOUND when modulesDbFound=false", async () => {
    clients.dhf.detect.mockResolvedValue({
      installed: true,
      foundDatabases: ["data-hub-STAGING", "data-hub-FINAL", "data-hub-JOBS"],
      missingDatabases: [],
      modulesDbFound: false,
    });
    const result = await tools.get("dhf_status")!({});
    expect(result.content[0].text).toContain("NOT FOUND");
    expect(result.content[0].text).toContain("gradle hubDeploy");
  });

  it("returns error with missing databases when DHF is not installed", async () => {
    clients.dhf.detect.mockResolvedValue({
      installed: false,
      foundDatabases: [],
      missingDatabases: ["data-hub-STAGING", "data-hub-FINAL", "data-hub-JOBS"],
    });
    const result = await tools.get("dhf_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("NOT installed");
    expect(result.content[0].text).toContain("data-hub-STAGING");
  });

  it("indicates dhf_flow_run is available when allowEval=true and readonly=false", async () => {
    clients.dhf.detect.mockResolvedValue({
      installed: true,
      foundDatabases: ["data-hub-STAGING", "data-hub-FINAL", "data-hub-JOBS"],
      missingDatabases: [],
    });
    const result = await tools.get("dhf_status")!({});
    expect(result.content[0].text).toContain("dhf_flow_run available: yes");
  });

  it("indicates dhf_flow_run is unavailable when readonly=true", async () => {
    const { server: s2, tools: t2 } = createMockServer();
    const c2 = createMockDhfClient();
    c2.dhf.detect.mockResolvedValue({
      installed: true,
      foundDatabases: ["data-hub-STAGING", "data-hub-FINAL", "data-hub-JOBS"],
      missingDatabases: [],
    });
    registerDhfTools(s2 as never, c2 as never, true, true);  // readonly=true
    const result = await t2.get("dhf_status")!({});
    expect(result.content[0].text).toContain("dhf_flow_run available: no");
  });

  it("returns isError on detect() failure", async () => {
    clients.dhf.detect.mockRejectedValue(new Error("Management API unreachable"));
    const result = await tools.get("dhf_status")!({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Management API unreachable");
  });
});

// ─── dhf_flows_list ────────────────────────────────────────────────────────

describe("dhf_flows_list handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockDhfClient>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockDhfClient();
    registerDhfTools(mock.server as never, clients as never, true, false);
    tools = mock.tools;
  });

  const sampleFlow = {
    name: "CustomerFlow",
    description: "Customer onboarding pipeline",
    steps: {
      "1": {
        stepId: "CustomerFlow|1",
        stepDefinitionName: "default-ingestion",
        stepDefinitionType: "ingestion",
        collections: ["raw-customer"],
        sourceDatabase: "data-hub-STAGING",
        targetDatabase: "data-hub-STAGING",
      },
      "2": {
        stepId: "CustomerFlow|2",
        stepDefinitionName: "CustomerMap",
        stepDefinitionType: "mapping",
        sourceDatabase: "data-hub-STAGING",
        targetDatabase: "data-hub-FINAL",
      },
    },
  };

  it("lists all flows when no filter given", async () => {
    clients.dhf.listFlows.mockResolvedValue([sampleFlow]);
    const result = await tools.get("dhf_flows_list")!({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("CustomerFlow");
    expect(result.content[0].text).toContain("default-ingestion");
    expect(result.content[0].text).toContain("CustomerMap");
    expect(result.content[0].text).toContain("ingestion");
    expect(result.content[0].text).toContain("mapping");
  });

  it("gets a specific flow when flow_name is provided", async () => {
    clients.dhf.getFlow.mockResolvedValue(sampleFlow);
    const result = await tools.get("dhf_flows_list")!({ flow_name: "CustomerFlow" });
    expect(clients.dhf.getFlow).toHaveBeenCalledWith("CustomerFlow");
    expect(clients.dhf.listFlows).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("CustomerFlow");
  });

  it("returns a message when no flows are found", async () => {
    clients.dhf.listFlows.mockResolvedValue([]);
    const result = await tools.get("dhf_flows_list")!({});
    expect(result.content[0].text).toContain("No flows found");
    expect(result.content[0].text).toContain("hubDeployArtifacts");
  });

  it("shows step source and target databases", async () => {
    clients.dhf.listFlows.mockResolvedValue([sampleFlow]);
    const result = await tools.get("dhf_flows_list")!({});
    expect(result.content[0].text).toContain("data-hub-STAGING");
    expect(result.content[0].text).toContain("data-hub-FINAL");
  });

  it("returns isError on getFlow() failure", async () => {
    clients.dhf.getFlow.mockRejectedValue(new Error("Document not found: /flows/NoSuchFlow.flow.json"));
    const result = await tools.get("dhf_flows_list")!({ flow_name: "NoSuchFlow" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });
});

// ─── dhf_flow_run ──────────────────────────────────────────────────────────

describe("dhf_flow_run handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockDhfClient>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockDhfClient();
    registerDhfTools(mock.server as never, clients as never, true, false);
    tools = mock.tools;
  });

  it("returns job ID and polling instructions on success", async () => {
    clients.dhf.runFlow.mockResolvedValue("job-abc-123");
    const result = await tools.get("dhf_flow_run")!({ flow_name: "CustomerFlow" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("job-abc-123");
    expect(result.content[0].text).toContain("dhf_job_status");
    expect(result.content[0].text).toContain("CustomerFlow");
  });

  it("passes step_numbers to runFlow", async () => {
    clients.dhf.runFlow.mockResolvedValue("job-xyz-456");
    await tools.get("dhf_flow_run")!({
      flow_name: "CustomerFlow",
      step_numbers: ["1", "2"],
    });
    expect(clients.dhf.runFlow).toHaveBeenCalledWith(
      "CustomerFlow",
      ["1", "2"],
      undefined
    );
  });

  it("passes options to runFlow", async () => {
    clients.dhf.runFlow.mockResolvedValue("job-opt-789");
    await tools.get("dhf_flow_run")!({
      flow_name: "CustomerFlow",
      options: { batchSize: 50 },
    });
    expect(clients.dhf.runFlow).toHaveBeenCalledWith(
      "CustomerFlow",
      undefined,
      { batchSize: 50 }
    );
  });

  it("shows step numbers in output when provided", async () => {
    clients.dhf.runFlow.mockResolvedValue("job-steps-001");
    const result = await tools.get("dhf_flow_run")!({
      flow_name: "CustomerFlow",
      step_numbers: ["2"],
    });
    expect(result.content[0].text).toContain("Steps: 2");
  });

  it("shows 'all' steps when step_numbers is omitted", async () => {
    clients.dhf.runFlow.mockResolvedValue("job-all-002");
    const result = await tools.get("dhf_flow_run")!({ flow_name: "CustomerFlow" });
    expect(result.content[0].text).toContain("Steps: all");
  });

  it("returns isError with actionable note on runFlow failure", async () => {
    clients.dhf.runFlow.mockRejectedValue(
      new Error("Module not found: /data-hub/5/flow/flow-runner.sjs")
    );
    const result = await tools.get("dhf_flow_run")!({ flow_name: "CustomerFlow" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("flow-runner.sjs");
    expect(result.content[0].text).toContain("NOTE:");
  });

  it("is not registered when allowEval=false", () => {
    const { server, tools: readonlyTools } = createMockServer();
    registerDhfTools(server as never, createMockDhfClient() as never, false, false);
    expect(readonlyTools.has("dhf_flow_run")).toBe(false);
  });

  it("is not registered when readonly=true", () => {
    const { server, tools: readonlyTools } = createMockServer();
    registerDhfTools(server as never, createMockDhfClient() as never, true, true);
    expect(readonlyTools.has("dhf_flow_run")).toBe(false);
  });
});

// ─── dhf_job_status ────────────────────────────────────────────────────────

describe("dhf_job_status handler", () => {
  let tools: Map<string, ToolHandler>;
  let clients: ReturnType<typeof createMockDhfClient>;

  beforeEach(() => {
    const mock = createMockServer();
    clients = createMockDhfClient();
    registerDhfTools(mock.server as never, clients as never, true, false);
    tools = mock.tools;
  });

  const sampleJob = {
    jobId: "job-abc-123",
    flow: "CustomerFlow",
    jobStatus: "finished",
    user: "data-hub-operator",
    timeStarted: "2026-03-22T10:00:00Z",
    timeEnded: "2026-03-22T10:01:30Z",
    lastCompletedStep: "2",
    stepResults: {
      "1": {
        stepDefinitionName: "default-ingestion",
        stepDefinitionType: "ingestion",
        success: true,
        totalEvents: 1000,
        successfulEvents: 1000,
        failedEvents: 0,
        stepStartTime: "2026-03-22T10:00:00Z",
        stepEndTime: "2026-03-22T10:00:45Z",
      },
      "2": {
        stepDefinitionName: "CustomerMap",
        stepDefinitionType: "mapping",
        success: true,
        totalEvents: 1000,
        successfulEvents: 998,
        failedEvents: 2,
        stepStartTime: "2026-03-22T10:00:46Z",
        stepEndTime: "2026-03-22T10:01:30Z",
        errorMessages: [
          "Mapping error on field 'birthDate': invalid date format",
          "Mapping error on field 'postalCode': value too long",
        ],
      },
    },
  };

  it("displays job status with all fields", async () => {
    clients.dhf.getJobStatus.mockResolvedValue(sampleJob);
    const result = await tools.get("dhf_job_status")!({ job_id: "job-abc-123" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("job-abc-123");
    expect(text).toContain("CustomerFlow");
    expect(text).toContain("finished");
    expect(text).toContain("data-hub-operator");
    expect(text).toContain("2026-03-22T10:00:00Z");
  });

  it("displays step results with event counts", async () => {
    clients.dhf.getJobStatus.mockResolvedValue(sampleJob);
    const result = await tools.get("dhf_job_status")!({ job_id: "job-abc-123" });
    const text = result.content[0].text;
    expect(text).toContain("1000 total");
    expect(text).toContain("998 succeeded");
    expect(text).toContain("2 failed");
  });

  it("displays error messages from step results", async () => {
    clients.dhf.getJobStatus.mockResolvedValue(sampleJob);
    const result = await tools.get("dhf_job_status")!({ job_id: "job-abc-123" });
    const text = result.content[0].text;
    expect(text).toContain("birthDate");
    expect(text).toContain("postalCode");
  });

  it("truncates error messages beyond 5", async () => {
    const jobWithManyErrors = {
      ...sampleJob,
      stepResults: {
        "1": {
          ...sampleJob.stepResults["1"],
          errorMessages: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"],
          failedEvents: 7,
        },
      },
    };
    clients.dhf.getJobStatus.mockResolvedValue(jobWithManyErrors);
    const result = await tools.get("dhf_job_status")!({ job_id: "job-abc-123" });
    const text = result.content[0].text;
    expect(text).toContain("e5");
    expect(text).toContain("2 more errors");
    expect(text).not.toContain("e6");
  });

  it("calls getJobStatus with the provided job_id", async () => {
    clients.dhf.getJobStatus.mockResolvedValue(sampleJob);
    await tools.get("dhf_job_status")!({ job_id: "job-abc-123" });
    expect(clients.dhf.getJobStatus).toHaveBeenCalledWith("job-abc-123");
  });

  it("returns isError when job is not found", async () => {
    clients.dhf.getJobStatus.mockRejectedValue(
      new Error("Document not found: /jobs/unknown-job.json")
    );
    const result = await tools.get("dhf_job_status")!({ job_id: "unknown-job" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("displays Failed Batches section when batchErrors are present", async () => {
    const jobWithBatchErrors = {
      ...sampleJob,
      jobStatus: "finished_with_errors",
      batchErrors: [
        {
          batchId: "batch-001",
          stepName: "CustomerMap",
          batchStatus: "failed",
          urisFailed: ["/raw/customer-42.json", "/raw/customer-99.json"],
          errorMessages: ["XSLT transform failed: missing required field 'id'"],
        },
      ],
    };
    clients.dhf.getJobStatus.mockResolvedValue(jobWithBatchErrors);
    const result = await tools.get("dhf_job_status")!({ job_id: "job-abc-123" });
    const text = result.content[0].text;
    expect(text).toContain("Failed Batches");
    expect(text).toContain("batch-001");
    expect(text).toContain("CustomerMap");
    expect(text).toContain("/raw/customer-42.json");
    expect(text).toContain("XSLT transform failed");
  });

  it("truncates failed URIs beyond 5 in a batch", async () => {
    const manyUris = Array.from({ length: 8 }, (_, i) => `/raw/doc-${i}.json`);
    const jobWithManyUris = {
      ...sampleJob,
      jobStatus: "finished_with_errors",
      batchErrors: [{
        batchId: "batch-002",
        batchStatus: "failed",
        urisFailed: manyUris,
      }],
    };
    clients.dhf.getJobStatus.mockResolvedValue(jobWithManyUris);
    const result = await tools.get("dhf_job_status")!({ job_id: "job-abc-123" });
    const text = result.content[0].text;
    expect(text).toContain("/raw/doc-4.json");
    expect(text).toContain("3 more");
    expect(text).not.toContain("/raw/doc-5.json");
  });

  it("does not show Failed Batches section when batchErrors is empty", async () => {
    clients.dhf.getJobStatus.mockResolvedValue(sampleJob);
    const result = await tools.get("dhf_job_status")!({ job_id: "job-abc-123" });
    expect(result.content[0].text).not.toContain("Failed Batches");
  });
});

// ─── dhf_flow_run_jar ──────────────────────────────────────────────────────

describe("dhf_flow_run_jar handler", () => {
  let tools: Map<string, ToolHandler>;
  const mockSpawn = vi.mocked(spawn);

  beforeEach(() => {
    mockSpawn.mockReset();
    const mock = createMockServer();
    registerDhfTools(
      mock.server as never,
      createMockDhfClient() as never,
      false, false,
      { clientJarPath: FAKE_JAR_PATH },
      FAKE_CONNECTION as never
    );
    tools = mock.tools;
  });

  it("spawns java with correct base args", async () => {
    mockSpawn.mockReturnValue(makeFakeChild(0, "Flow completed. Job ID: abc-123") as never);
    await tools.get("dhf_flow_run_jar")!({ flow_name: "CustomerFlow" });

    expect(mockSpawn).toHaveBeenCalledWith(
      "java",
      expect.arrayContaining([
        "-jar", FAKE_JAR_PATH,
        "runFlow",
        "-host", "localhost",
        "-username", "admin",
        "-password", "admin",
        "-flowName", "CustomerFlow",
      ]),
      expect.anything()
    );
  });

  it("includes -steps arg when step_numbers are provided", async () => {
    mockSpawn.mockReturnValue(makeFakeChild(0, "Done") as never);
    await tools.get("dhf_flow_run_jar")!({ flow_name: "CustomerFlow", step_numbers: ["2", "3"] });

    expect(mockSpawn).toHaveBeenCalledWith(
      "java",
      expect.arrayContaining(["-steps", "2,3"]),
      expect.anything()
    );
  });

  it("returns success output from stdout", async () => {
    mockSpawn.mockReturnValue(
      makeFakeChild(0, "Running flow: CustomerFlow\nStatus: finished\nDocuments processed: 500") as never
    );
    const result = await tools.get("dhf_flow_run_jar")!({ flow_name: "CustomerFlow" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("CustomerFlow");
    expect(result.content[0].text).toContain("Documents processed: 500");
  });

  it("returns isError when JAR exits with non-zero code", async () => {
    mockSpawn.mockReturnValue(
      makeFakeChild(1, "", "Error: Flow not found: BadFlow") as never
    );
    const result = await tools.get("dhf_flow_run_jar")!({ flow_name: "BadFlow" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exited with code 1");
    expect(result.content[0].text).toContain("Flow not found");
  });

  it("returns isError with java-not-found hint when spawn emits ENOENT", async () => {
    const enoent = Object.assign(new Error("spawn java ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
    mockSpawn.mockReturnValue(makeFakeChild(0, "", "", enoent) as never);
    const result = await tools.get("dhf_flow_run_jar")!({ flow_name: "CustomerFlow" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("java executable not found");
    expect(result.content[0].text).toContain(FAKE_JAR_PATH);
  });

  it("includes port override args including mlJobPort defaulting to staging+2", async () => {
    mockSpawn.mockReturnValue(makeFakeChild(0, "Done") as never);
    await tools.get("dhf_flow_run_jar")!({ flow_name: "CustomerFlow" });
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.some((a) => a.includes("mlStagingPort=8010"))).toBe(true);
    expect(args.some((a) => a.includes("mlPort=8010"))).toBe(true);
    // Jobs port defaults to staging+2 (8010+2 = 8012) when dhfJobsPort not set
    expect(args.some((a) => a.includes("mlJobPort=8012"))).toBe(true);
  });
});
