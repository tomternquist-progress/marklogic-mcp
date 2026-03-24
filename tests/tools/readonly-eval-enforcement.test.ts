/**
 * Tests for runtime enforcement of readonly and allowEval flags.
 *
 * Existing tests check that tool REGISTRATION is gated on these flags
 * (e.g. write tools are not registered when readonly=true). These tests
 * verify the RUNTIME behavior: that the underlying client methods throw
 * appropriately and that the tool handlers propagate errors correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerDocumentTools } from "../../src/tools/documents.js";
import { registerEvalTools } from "../../src/tools/eval.js";
import { registerExtensionTools } from "../../src/tools/extensions.js";
import { WriteProtectedError, EvalDisabledError } from "../../src/utils/errors.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: vi.fn((_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(_name, handler);
    }),
  };
  return { server, tools };
}

// ── Readonly enforcement: document write tools ─────────────────────────────────

describe("readonly enforcement – document write tools", () => {
  it("ml_document_put returns isError when client throws WriteProtectedError", async () => {
    const { server, tools } = createMockServer();
    const clients = {
      documents: {
        get: vi.fn(),
        list: vi.fn(),
        put: vi.fn().mockRejectedValue(new WriteProtectedError()),
        del: vi.fn(),
        patchDocument: vi.fn(),
      },
    };
    registerDocumentTools(server as never, clients as never, false);

    const result = await tools.get("ml_document_put")!({
      uri: "/doc.json",
      content: '{"x":1}',
      content_type: "application/json",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ML_READONLY");
  });

  it("ml_document_delete returns isError when client throws WriteProtectedError", async () => {
    const { server, tools } = createMockServer();
    const clients = {
      documents: {
        get: vi.fn(),
        list: vi.fn(),
        put: vi.fn(),
        del: vi.fn().mockRejectedValue(new WriteProtectedError()),
        patchDocument: vi.fn(),
      },
    };
    registerDocumentTools(server as never, clients as never, false);

    const result = await tools.get("ml_document_delete")!({ uri: "/doc.json" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ML_READONLY");
  });

  it("ml_document_patch returns isError when client throws WriteProtectedError", async () => {
    const { server, tools } = createMockServer();
    const clients = {
      documents: {
        get: vi.fn(),
        list: vi.fn(),
        put: vi.fn(),
        del: vi.fn(),
        patchDocument: vi.fn().mockRejectedValue(new WriteProtectedError()),
      },
    };
    registerDocumentTools(server as never, clients as never, false);

    const result = await tools.get("ml_document_patch")!({
      uri: "/doc.json",
      patch: { patch: [] },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ML_READONLY");
  });
});

// ── Readonly enforcement: write tools absent when readonly=true ────────────────

describe("readonly enforcement – tool registration", () => {
  it("does not register ml_document_put when readonly=true", () => {
    const { server, tools } = createMockServer();
    const clients = { documents: { get: vi.fn(), list: vi.fn(), put: vi.fn(), del: vi.fn(), patchDocument: vi.fn() } };
    registerDocumentTools(server as never, clients as never, true);

    expect(tools.has("ml_document_put")).toBe(false);
    expect(tools.has("ml_document_delete")).toBe(false);
    expect(tools.has("ml_document_patch")).toBe(false);
  });

  it("still registers read tools when readonly=true", () => {
    const { server, tools } = createMockServer();
    const clients = { documents: { get: vi.fn(), list: vi.fn(), put: vi.fn(), del: vi.fn(), patchDocument: vi.fn() } };
    registerDocumentTools(server as never, clients as never, true);

    expect(tools.has("ml_document_get")).toBe(true);
    expect(tools.has("ml_document_list")).toBe(true);
    expect(tools.has("ml_document_sample")).toBe(true);
  });
});

// ── Eval enforcement: tools not registered when allowEval=false ────────────────

describe("eval enforcement – tool registration", () => {
  it("registers NO eval tools when allowEval=false", () => {
    const { server, tools } = createMockServer();
    const clients = { eval: { evalXQuery: vi.fn(), evalJavaScript: vi.fn(), invokeModule: vi.fn(), staticCheckSjs: vi.fn() } };
    registerEvalTools(server as never, clients as never, false);

    expect(tools.size).toBe(0);
  });

  it("registers eval tools when allowEval=true", () => {
    const { server, tools } = createMockServer();
    const clients = { eval: { evalXQuery: vi.fn(), evalJavaScript: vi.fn(), invokeModule: vi.fn(), staticCheckSjs: vi.fn() } };
    registerEvalTools(server as never, clients as never, true);

    expect(tools.has("ml_eval_xquery")).toBe(true);
    expect(tools.has("ml_eval_javascript")).toBe(true);
    expect(tools.size).toBeGreaterThan(0);
  });
});

// ── Eval enforcement: client-level EvalDisabledError ──────────────────────────

describe("eval enforcement – EvalDisabledError propagation", () => {
  it("ml_eval_xquery returns isError when EvalDisabledError is thrown", async () => {
    const { server, tools } = createMockServer();
    const clients = {
      eval: {
        evalXQuery: vi.fn().mockRejectedValue(new EvalDisabledError()),
        evalJavaScript: vi.fn(),
        invokeModule: vi.fn(),
        staticCheckSjs: vi.fn(),
      },
    };
    registerEvalTools(server as never, clients as never, true);

    const result = await tools.get("ml_eval_xquery")!({ xquery: "1+1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ML_ALLOW_EVAL");
  });

  it("ml_eval_javascript returns isError when EvalDisabledError is thrown", async () => {
    const { server, tools } = createMockServer();
    const clients = {
      eval: {
        evalXQuery: vi.fn(),
        evalJavaScript: vi.fn().mockRejectedValue(new EvalDisabledError()),
        invokeModule: vi.fn(),
        staticCheckSjs: vi.fn(),
      },
    };
    registerEvalTools(server as never, clients as never, true);

    const result = await tools.get("ml_eval_javascript")!({ javascript: "1+1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ML_ALLOW_EVAL");
  });
});

// ── Extension readonly enforcement ────────────────────────────────────────────

describe("extension readonly enforcement – tool registration", () => {
  it("does not register put/delete when readonly=true", () => {
    const { server, tools } = createMockServer();
    const clients = {
      extensions: {
        listExtensions: vi.fn(),
        getExtension: vi.fn(),
        callExtension: vi.fn(),
        putExtension: vi.fn(),
        deleteExtension: vi.fn(),
      },
    };
    registerExtensionTools(server as never, clients as never, true);

    expect(tools.has("ml_extension_put")).toBe(false);
    expect(tools.has("ml_extension_delete")).toBe(false);
    expect(tools.has("ml_extension_list")).toBe(true);
  });
});
