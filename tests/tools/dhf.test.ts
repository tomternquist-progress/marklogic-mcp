import { describe, it, expect, vi, beforeEach } from "vitest";
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

// ─── Tool registration ──────────────────────────────────────────────────────

describe("registerDhfTools – tool registration", () => {
  it("registers 3 tools when allowEval=false (dhf_flow_run excluded)", () => {
    const { server, tools } = createMockServer();
    registerDhfTools(server as never, createMockDhfClient() as never, false, false);

    expect(tools.has("dhf_status")).toBe(true);
    expect(tools.has("dhf_flows_list")).toBe(true);
    expect(tools.has("dhf_job_status")).toBe(true);
    expect(tools.has("dhf_flow_run")).toBe(false);
    expect(tools.size).toBe(3);
  });

  it("registers 3 tools when readonly=true (dhf_flow_run excluded)", () => {
    const { server, tools } = createMockServer();
    registerDhfTools(server as never, createMockDhfClient() as never, true, true);

    expect(tools.has("dhf_flow_run")).toBe(false);
    expect(tools.size).toBe(3);
  });

  it("registers all 4 tools when allowEval=true and readonly=false", () => {
    const { server, tools } = createMockServer();
    registerDhfTools(server as never, createMockDhfClient() as never, true, false);

    expect(tools.has("dhf_status")).toBe(true);
    expect(tools.has("dhf_flows_list")).toBe(true);
    expect(tools.has("dhf_flow_run")).toBe(true);
    expect(tools.has("dhf_job_status")).toBe(true);
    expect(tools.size).toBe(4);
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
});
