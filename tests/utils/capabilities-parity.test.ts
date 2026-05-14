/**
 * Schema-vs-docs parity test. Registers every tool that has a manifest entry
 * in src/utils/capabilities.ts against a mock server, captures each tool's
 * Zod schema, and asserts the param keys in the manifest exactly match the
 * keys in the registered schema. Catches drift in either direction:
 *   - manifest lists a param the tool doesn't accept any more
 *   - tool added a param without updating the manifest
 */

import { describe, it, expect, vi } from "vitest";
import { registerSearchTools } from "../../src/tools/search.js";
import { registerAnswerTools } from "../../src/tools/answer.js";
import { registerSchemaTools } from "../../src/tools/schema.js";
import { registerPerformanceTools } from "../../src/tools/performance.js";
import { TOOL_CAPABILITIES } from "../../src/utils/capabilities.js";

type CapturedTool = {
  name: string;
  schemaKeys: string[];
};

function createCapturingServer(): { server: { tool: ReturnType<typeof vi.fn> }; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const server = {
    tool: vi.fn((name: string, _desc: string, schema: Record<string, unknown>) => {
      tools.push({ name, schemaKeys: Object.keys(schema ?? {}) });
    }),
  };
  return { server, tools };
}

function makeEmptyClients() {
  // Minimal stub — the test only inspects schemas, never calls handlers.
  return {
    schema: {
      discoverSchema: vi.fn(),
      listCollections: vi.fn(),
      listIndexes: vi.fn(),
      listNamespaces: vi.fn(),
      getTdeSchemas: vi.fn(),
      validateTde: vi.fn(),
      validateTemplateSyntax: vi.fn(),
    },
    search: { search: vi.fn(), qbe: vi.fn(), values: vi.fn(), suggest: vi.fn(), fetchDocs: vi.fn() },
    documents: { get: vi.fn(), put: vi.fn() },
    eval: { evalJavaScript: vi.fn(), parseCtsQuery: vi.fn() },
    performance: {
      explainOptic: vi.fn(),
      searchDebug: vi.fn(),
      getForestStatus: vi.fn(),
      getForestCounts: vi.fn(),
      forceMerge: vi.fn(),
      profileXQuery: vi.fn(),
      profileJavaScript: vi.fn(),
      profileSparql: vi.fn(),
    },
    fasttrack: { listSearchOptions: vi.fn() },
    admin: { getDatabaseProperties: vi.fn() },
  };
}

describe("capabilities manifest ↔ registered schema parity", () => {
  // Register every tool group whose tools appear in the manifest.
  const { server, tools } = createCapturingServer();
  const clients = makeEmptyClients();

  registerSearchTools(server as never, clients as never);
  registerSchemaTools(server as never, clients as never);
  registerAnswerTools(server as never, clients as never);
  // Performance tools — non-eval set; ml_search_query_plan is always registered.
  registerPerformanceTools(server as never, clients as never, false);

  const registered = new Map(tools.map((t) => [t.name, t.schemaKeys]));

  for (const cap of TOOL_CAPABILITIES) {
    it(`${cap.name}: every manifest param is in the runtime schema`, () => {
      const schemaKeys = registered.get(cap.name);
      expect(schemaKeys, `tool "${cap.name}" was not registered in this build`).toBeDefined();
      const manifestKeys = cap.params.map((p) => p.name);
      const missingInSchema = manifestKeys.filter((k) => !schemaKeys!.includes(k));
      expect(
        missingInSchema,
        `manifest lists params not in the runtime schema for ${cap.name}: ${missingInSchema.join(", ")}`
      ).toEqual([]);
    });

    it(`${cap.name}: every runtime schema param is in the manifest`, () => {
      const schemaKeys = registered.get(cap.name)!;
      const manifestKeys = new Set(cap.params.map((p) => p.name));
      const missingInManifest = schemaKeys.filter((k) => !manifestKeys.has(k));
      expect(
        missingInManifest,
        `runtime schema has params missing from manifest for ${cap.name}: ${missingInManifest.join(", ")}`
      ).toEqual([]);
    });
  }
});
