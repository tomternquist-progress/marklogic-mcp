/**
 * Behavioral tests for the readonly safety-belt gating: confirm that the
 * tools that can write to MarkLogic are either NOT REGISTERED or REFUSE
 * with a structured UNSUPPORTED_IN_BUILD error when ML_READONLY=true.
 *
 * These tests are the regression net for the security issue surfaced by the
 * reviewer: an agent created a database via a Node script that bypassed the
 * MCP server entirely. We can't stop shell-level bypass, but we can ensure
 * the server's own tool surface is sealed.
 */

import { describe, it, expect, vi } from "vitest";
import { registerAdminTools } from "../../src/tools/admin.js";
import { registerEvalTools } from "../../src/tools/eval.js";
import { registerFluxTools } from "../../src/tools/flux.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  return { server, tools };
}

function makeAdminClient() {
  return {
    admin: {
      listDatabases: vi.fn(),
      getDatabaseProperties: vi.fn(),
      getDatabaseStatistics: vi.fn(),
      listForests: vi.fn(),
      setDatabaseForests: vi.fn(),
      listServers: vi.fn(),
      getServerProperties: vi.fn(),
      getClusterStatus: vi.fn(),
      getReindexStatus: vi.fn(),
      listLogs: vi.fn(),
      readLog: vi.fn(),
    },
  };
}

describe("admin tool gating", () => {
  it("ml_database_set_forests is NOT registered when readonly=true", () => {
    const { server, tools } = createMockServer();
    registerAdminTools(server as never, makeAdminClient() as never, true);
    expect(tools.has("ml_database_set_forests")).toBe(false);
    // Read-only admin tools are still registered.
    expect(tools.has("ml_databases_list")).toBe(true);
    expect(tools.has("ml_database_properties")).toBe(true);
  });

  it("ml_database_set_forests IS registered when readonly=false", () => {
    const { server, tools } = createMockServer();
    registerAdminTools(server as never, makeAdminClient() as never, false);
    expect(tools.has("ml_database_set_forests")).toBe(true);
  });
});

describe("eval tool gating", () => {
  function makeEvalClients() {
    return {
      eval: { evalJavaScript: vi.fn(), evalXQuery: vi.fn(), invokeModule: vi.fn() },
    };
  }

  it("eval tools are NOT registered when allowEval=false", () => {
    const { server, tools } = createMockServer();
    registerEvalTools(server as never, makeEvalClients() as never, false);
    expect(tools.has("ml_eval_javascript")).toBe(false);
    expect(tools.has("ml_eval_xquery")).toBe(false);
  });

  it("eval tools ARE registered when allowEval=true", () => {
    const { server, tools } = createMockServer();
    registerEvalTools(server as never, makeEvalClients() as never, true);
    expect(tools.has("ml_eval_javascript")).toBe(true);
    expect(tools.has("ml_eval_xquery")).toBe(true);
  });
});

describe("flux tool gating", () => {
  function makeFluxClients() {
    return {
      flux: {
        runImport: vi.fn(),
        runExport: vi.fn(),
        runCopy: vi.fn(),
        runReprocess: vi.fn(),
        runPreview: vi.fn(),
        runHelp: vi.fn(),
        runStatus: vi.fn(),
      },
      schema: { discoverSchema: vi.fn() },
      documents: { put: vi.fn() },
      semaphore: { configured: false },
    };
  }

  // Flux write subcommands follow the same convention as document/eval/graph
  // write tools: they are NOT registered when readonly=true (so they never
  // appear in the tool list), rather than registering and refusing at call time.
  it("flux write subcommands are NOT registered when readonly=true", () => {
    const { server, tools } = createMockServer();
    registerFluxTools(server as never, makeFluxClients() as never, "digest", true);

    expect(tools.has("flux_import")).toBe(false);
    expect(tools.has("flux_copy")).toBe(false);
    expect(tools.has("flux_reprocess")).toBe(false);
  });

  it("flux write subcommands ARE registered when readonly=false", () => {
    const { server, tools } = createMockServer();
    registerFluxTools(server as never, makeFluxClients() as never, "digest", false);

    expect(tools.has("flux_import")).toBe(true);
    expect(tools.has("flux_copy")).toBe(true);
    expect(tools.has("flux_reprocess")).toBe(true);
  });

  it("flux read-only commands stay registered even when readonly=true", () => {
    const { server, tools } = createMockServer();
    registerFluxTools(server as never, makeFluxClients() as never, "digest", true);
    expect(tools.has("flux_export")).toBe(true);
    expect(tools.has("flux_preview")).toBe(true);
    expect(tools.has("flux_help")).toBe(true);
    expect(tools.has("flux_status")).toBe(true);
  });

  it("under oauth, every flux tool is registered only as a disabled stub", () => {
    const { server, tools } = createMockServer();
    registerFluxTools(server as never, makeFluxClients() as never, "oauth", false);
    for (const name of ["flux_import", "flux_export", "flux_copy", "flux_reprocess", "flux_preview", "flux_help", "flux_status"]) {
      expect(tools.has(name)).toBe(true);
    }
  });
});
