import { describe, it, expect, vi } from "vitest";
import { registerMlGradleTools } from "../../src/tools/ml-gradle.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    }),
  };
  return { server, tools };
}

interface ScaffoldOutput {
  files: { path: string; content: string }[];
  next_steps: string[];
}

async function scaffold(args: Record<string, unknown>): Promise<ScaffoldOutput> {
  const { server, tools } = createMockServer();
  registerMlGradleTools(server as never);
  const handler = tools.get("ml_gradle_scaffold")!;
  const result = await handler(args);
  return JSON.parse(result.content[0].text) as ScaffoldOutput;
}

describe("ml_gradle_scaffold", () => {
  it("registers the ml_gradle_scaffold tool", () => {
    const { server, tools } = createMockServer();
    registerMlGradleTools(server as never);
    expect(tools.has("ml_gradle_scaffold")).toBe(true);
  });

  it("emits build.gradle, gradle.properties, settings.gradle for the minimum case", async () => {
    const out = await scaffold({ app_name: "demo", rest_port: 8042 });
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain("build.gradle");
    expect(paths).toContain("gradle.properties");
    expect(paths).toContain("settings.gradle");
    expect(paths).toContain(".gitignore");
  });

  it("settings.gradle uses the supplied app_name", async () => {
    const out = await scaffold({ app_name: "my-app", rest_port: 8050 });
    const settings = out.files.find((f) => f.path === "settings.gradle")!;
    expect(settings.content).toContain("rootProject.name = 'my-app'");
  });

  it("gradle.properties forces pre-emptive Basic auth across the four sub-services", async () => {
    const out = await scaffold({ app_name: "demo", rest_port: 8042 });
    const props = out.files.find((f) => f.path === "gradle.properties")!.content;
    expect(props).toContain("mlAuthentication=basic");
    expect(props).toContain("mlManageAuthentication=basic");
    expect(props).toContain("mlAdminAuthentication=basic");
    expect(props).toContain("mlAppServicesAuthentication=basic");
    expect(props).toContain("mlRestAuthentication=digest");
    expect(props).toContain("mlAppName=demo");
    expect(props).toContain("mlRestPort=8042");
  });

  it("emits schemas-database.json AND triggers-database.json stubs (CMA prerequisite)", async () => {
    const out = await scaffold({ app_name: "demo", rest_port: 8042 });
    const paths = out.files.map((f) => f.path);
    expect(paths).toContain("src/main/ml-config/databases/content-database.json");
    expect(paths).toContain("src/main/ml-config/databases/schemas-database.json");
    expect(paths).toContain("src/main/ml-config/databases/triggers-database.json");

    const schemasDb = out.files.find((f) => f.path === "src/main/ml-config/databases/schemas-database.json")!;
    expect(schemasDb.content).toContain("%%SCHEMAS_DATABASE%%");
  });

  it("TDE template uses the .tdej extension under ml-schemas/tde", async () => {
    const out = await scaffold({ app_name: "demo", rest_port: 8042 });
    const tde = out.files.find((f) => f.path === "src/main/ml-schemas/tde/items.tdej");
    expect(tde).toBeDefined();
    const parsed = JSON.parse(tde!.content);
    expect(parsed.template.context).toBe("/item");
    expect(parsed.template.collections).toEqual(["demo-items"]);
  });

  it("REST extension stub documents the rs: prefix requirement", async () => {
    const out = await scaffold({ app_name: "demo", rest_port: 8042 });
    const echo = out.files.find((f) => f.path === "src/main/ml-modules/services/echo.sjs")!;
    expect(echo.content).toContain("params['rs:text']");
    expect(echo.content).toContain("rs:text=hello");
    expect(echo.content).toContain("REST-UNSUPPORTEDPARAM");
  });

  it("collections.properties uses per-file syntax, not a global key", async () => {
    const out = await scaffold({ app_name: "demo", rest_port: 8042 });
    const collections = out.files.find(
      (f) => f.path === "src/main/ml-data/items/collections.properties"
    )!;
    // Per-file: filename=value
    expect(collections.content).toContain("item-001.json=demo-items");
    expect(collections.content).toContain("item-002.json=demo-items");
    // Global form would be a bug — make sure it's not emitted
    expect(collections.content).not.toMatch(/^collections=/m);
  });

  it("omits TDE / REST extension / data when their flags are false", async () => {
    const out = await scaffold({
      app_name: "demo",
      rest_port: 8042,
      include_tde: false,
      include_rest_extension: false,
      include_data: false,
    });
    const paths = out.files.map((f) => f.path);
    expect(paths.some((p) => p.startsWith("src/main/ml-schemas"))).toBe(false);
    expect(paths.some((p) => p.startsWith("src/main/ml-modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith("src/main/ml-data"))).toBe(false);
  });

  it("emits role files only when include_role=true", async () => {
    const noRole = await scaffold({ app_name: "demo", rest_port: 8042 });
    expect(noRole.files.some((f) => f.path.includes("/security/roles/"))).toBe(false);

    const withRole = await scaffold({ app_name: "demo", rest_port: 8042, include_role: true });
    const reader = withRole.files.find((f) => f.path === "src/main/ml-config/security/roles/1-demo-reader.json")!;
    const writer = withRole.files.find((f) => f.path === "src/main/ml-config/security/roles/2-demo-writer.json")!;
    expect(JSON.parse(reader.content)["role-name"]).toBe("demo-reader");
    expect(JSON.parse(writer.content).role).toContain("demo-reader");
  });

  it("emits environment overlays only when include_environments=true", async () => {
    const noEnv = await scaffold({ app_name: "demo", rest_port: 8042 });
    expect(noEnv.files.some((f) => f.path === "gradle-dev.properties")).toBe(false);

    const withEnv = await scaffold({ app_name: "demo", rest_port: 8042, include_environments: true });
    const paths = withEnv.files.map((f) => f.path);
    expect(paths).toContain("gradle-dev.properties");
    expect(paths).toContain("gradle-prod.properties");
    expect(paths).toContain("src/main/dev-config/databases/content-database.json");

    const buildGradle = withEnv.files.find((f) => f.path === "build.gradle")!.content;
    expect(buildGradle).toContain('id "net.saliman.properties"');
  });

  it("permissions.properties is emitted only when include_role=true AND include_data=true", async () => {
    const noRole = await scaffold({ app_name: "demo", rest_port: 8042 });
    expect(noRole.files.some((f) => f.path.endsWith("permissions.properties"))).toBe(false);

    const withBoth = await scaffold({
      app_name: "demo",
      rest_port: 8042,
      include_role: true,
      include_data: true,
    });
    const perms = withBoth.files.find((f) => f.path === "src/main/ml-data/items/permissions.properties")!;
    expect(perms.content).toContain("item-001.json=demo-reader,read,demo-writer,update");
  });

  it("returns next_steps tailored to which features were included", async () => {
    const out = await scaffold({ app_name: "demo", rest_port: 8042, ml_host: "ml.example.com" });
    expect(out.next_steps[0]).toMatch(/Write each entry/);
    expect(out.next_steps.some((s) => s.includes("gradle mlDeploy"))).toBe(true);
    expect(out.next_steps.some((s) => s.includes("ml.example.com"))).toBe(true);
    expect(out.next_steps.some((s) => s.includes("rs:text="))).toBe(true);
    expect(out.next_steps.some((s) => s.includes("mlUndeploy"))).toBe(true);
  });

  it("respects custom ml_gradle_version", async () => {
    const out = await scaffold({ app_name: "demo", rest_port: 8042, ml_gradle_version: "5.6.0" });
    const buildGradle = out.files.find((f) => f.path === "build.gradle")!.content;
    expect(buildGradle).toContain('"com.marklogic.ml-gradle" version "5.6.0"');
  });
});
