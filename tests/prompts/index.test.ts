import { describe, it, expect, vi } from "vitest";
import { registerAllPrompts } from "../../src/prompts/index.js";

type PromptHandler = (args: Record<string, string | undefined>) => {
  messages: Array<{
    role: string;
    content: { type: string; text: string };
  }>;
};

function createMockServer() {
  const prompts = new Map<string, PromptHandler>();
  const server = {
    prompt: vi.fn((_name: string, _desc: string, _schema: unknown, handler: PromptHandler) => {
      prompts.set(_name, handler);
    }),
  };
  return { server, prompts };
}

// ── Registration ──────────────────────────────────────────────────────────────

describe("registerAllPrompts – registration", () => {
  it("registers all expected prompts", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const expectedPrompts = [
      "xquery_function_generator",
      "sjs_module_generator",
      "tde_schema_generator",
      "rest_extension_generator",
      "structured_query_builder",
      "optic_query_builder",
      "sparql_query_builder",
      "problem_advisor",
    ];

    for (const name of expectedPrompts) {
      expect(prompts.has(name), `Expected prompt ${name} to be registered`).toBe(true);
    }
  });

  it("registers at least 10 prompts total", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);
    expect(prompts.size).toBeGreaterThanOrEqual(10);
  });
});

// ── Prompt output structure ───────────────────────────────────────────────────

describe("prompt output structure", () => {
  it("each prompt returns a messages array with at least one message", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    for (const [name, handler] of prompts) {
      // Call with empty args — required params may produce partial text, but structure should be correct
      let result: ReturnType<PromptHandler>;
      try {
        result = handler({});
      } catch {
        // Some prompts may throw on truly missing required params — skip those
        continue;
      }

      expect(result, `${name}: result should be defined`).toBeDefined();
      expect(Array.isArray(result.messages), `${name}: messages should be an array`).toBe(true);
      expect(result.messages.length, `${name}: messages should be non-empty`).toBeGreaterThan(0);

      const msg = result.messages[0];
      expect(msg.role, `${name}: role should be 'user'`).toBe("user");
      expect(msg.content.type, `${name}: content type should be 'text'`).toBe("text");
      expect(typeof msg.content.text, `${name}: text should be a string`).toBe("string");
      expect(msg.content.text.length, `${name}: text should not be empty`).toBeGreaterThan(0);
    }
  });
});

// ── xquery_function_generator ─────────────────────────────────────────────────

describe("xquery_function_generator prompt", () => {
  it("includes function_purpose in output text", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const result = prompts.get("xquery_function_generator")!({
      function_purpose: "search for employee documents",
      input_type: "json",
      database: "Documents",
    });

    expect(result.messages[0].content.text).toContain("search for employee documents");
  });

  it("defaults input_type to json when not provided", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const result = prompts.get("xquery_function_generator")!({
      function_purpose: "test",
    });

    expect(result.messages[0].content.text).toContain("json");
  });

  it("includes Generate instruction at the end", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const result = prompts.get("xquery_function_generator")!({
      function_purpose: "test",
    });

    expect(result.messages[0].content.text).toContain("Generate");
  });
});

// ── sjs_module_generator ──────────────────────────────────────────────────────

describe("sjs_module_generator prompt", () => {
  it("includes module_purpose in output text", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const result = prompts.get("sjs_module_generator")!({
      module_purpose: "transform customer records",
      module_type: "library",
    });

    expect(result.messages[0].content.text).toContain("transform customer records");
  });

  it("defaults module_type to library", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const result = prompts.get("sjs_module_generator")!({
      module_purpose: "test",
    });

    expect(result.messages[0].content.text).toContain("library");
  });
});

// ── tde_schema_generator ──────────────────────────────────────────────────────

describe("tde_schema_generator prompt", () => {
  it("includes collection and view name in output", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const result = prompts.get("tde_schema_generator")!({
      collection: "my-collection",
      target_view_name: "employees",
    });

    expect(result.messages[0].content.text).toContain("my-collection");
    expect(result.messages[0].content.text).toContain("employees");
  });
});

// ── problem_advisor prompt ────────────────────────────────────────────────────

describe("problem_advisor prompt", () => {
  it("includes the user goal in output", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const result = prompts.get("problem_advisor")!({
      goal: "count distinct values of a field",
    });

    expect(result.messages[0].content.text).toContain("count distinct values of a field");
  });

  it("output text is substantial (contains guidance content)", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const result = prompts.get("problem_advisor")!({
      goal: "import CSV data",
    });

    // The prompt template is large (comprehensive guide); must be substantial
    expect(result.messages[0].content.text.length).toBeGreaterThan(500);
  });
});

// ── structured_query_builder ──────────────────────────────────────────────────

describe("structured_query_builder prompt", () => {
  it("includes search description in output", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const result = prompts.get("structured_query_builder")!({
      natural_language: "find all documents from 2024",
    });

    expect(result.messages[0].content.text).toContain("find all documents from 2024");
  });
});

// ── optic_query_builder ───────────────────────────────────────────────────────

describe("optic_query_builder prompt", () => {
  it("includes requirements in output", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const result = prompts.get("optic_query_builder")!({
      requirements: "aggregate sales by region",
      schema_name: "mySchema",
      view_name: "salesView",
    });

    expect(result.messages[0].content.text).toContain("aggregate sales by region");
  });
});

// ── rest_extension_generator ──────────────────────────────────────────────────

describe("rest_extension_generator prompt", () => {
  it("includes extension description in output", () => {
    const { server, prompts } = createMockServer();
    registerAllPrompts(server as never);

    const result = prompts.get("rest_extension_generator")!({
      extension_name: "employee-search",
      http_methods: ["GET"],
      description: "search employees by department",
    });

    expect(result.messages[0].content.text).toContain("search employees by department");
  });
});
