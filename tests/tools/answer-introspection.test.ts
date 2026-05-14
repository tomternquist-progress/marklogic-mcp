/**
 * Tests for the introspection tools: ml_capabilities + ml_query_recipe.
 * Focuses on the structured-error path (UNKNOWN_NAME with closest match,
 * MISSING_PARAMETER with corrected example).
 */

import { describe, it, expect, vi } from "vitest";
import { registerAnswerTools } from "../../src/tools/answer.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function setup() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: any, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  const clients = {
    schema: { discoverSchema: vi.fn(), listCollections: vi.fn() },
    search: { search: vi.fn(), fetchDocs: vi.fn() },
    fasttrack: { listSearchOptions: vi.fn() },
  };
  registerAnswerTools(server as never, clients as never);
  return { tools, clients };
}

describe("ml_capabilities", () => {
  it("returns the manifest for a known tool", async () => {
    const { tools } = setup();
    const result = await tools.get("ml_capabilities")!({ tool: "ml_search" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.name).toBe("ml_search");
    expect(Array.isArray(parsed.params)).toBe(true);
  });

  it("suggests the closest match for an unknown tool name", async () => {
    const { tools } = setup();
    const result = await tools.get("ml_capabilities")!({ tool: "ml_caplabilities" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("UNKNOWN_NAME");
    expect(parsed.error.details.closest).toBe("ml_capabilities");
    expect(parsed.error.exampleValid).toEqual({ tool: "ml_capabilities" });
  });

  it("lists everything when no name is given", async () => {
    const { tools } = setup();
    const result = await tools.get("ml_capabilities")!({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.tools)).toBe(true);
    expect(parsed.tools.length).toBeGreaterThan(0);
  });

  it("payload-check mode strips unknown keys and reports the closest accepted name", async () => {
    const { tools } = setup();
    const result = await tools.get("ml_capabilities")!({
      tool: "ml_answer_query",
      payload: {
        question: "which records involved X",
        collection: "c1",
        // Unknown keys: a near-miss typo + a clearly-wrong key:
        modee: "balanced",
        unrelated_key: 7,
      },
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.mode).toBe("payload_check");
    expect(parsed.ready).toBe(false);
    expect(parsed.cleaned_payload).toEqual({
      question: "which records involved X",
      collection: "c1",
    });
    const dropped = parsed.dropped_keys.map((d: any) => d.key);
    expect(dropped).toContain("modee");
    expect(dropped).toContain("unrelated_key");
    const modeeDrop = parsed.dropped_keys.find((d: any) => d.key === "modee");
    expect(modeeDrop?.closest).toBe("mode");
  });

  it("payload-check mode returns ready=true when every key is accepted", async () => {
    const { tools } = setup();
    const result = await tools.get("ml_capabilities")!({
      tool: "ml_answer_query",
      payload: { question: "ok", collection: "c1", answer_mode: "rows" },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ready).toBe(true);
    expect(parsed.dropped_keys).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });
});

describe("ml_query_recipe", () => {
  it("lists recipes for 'list'", async () => {
    const { tools } = setup();
    const result = await tools.get("ml_query_recipe")!({ recipe: "list" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.recipes)).toBe(true);
  });

  it("returns structured UNKNOWN_NAME with closest match on typo", async () => {
    const { tools } = setup();
    const result = await tools.get("ml_query_recipe")!({ recipe: "find_entities_by_typ" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("UNKNOWN_NAME");
    expect(parsed.error.details.closest).toBe("find_entities_by_type");
    expect(parsed.error.exampleValid?.recipe).toBe("find_entities_by_type");
  });

  it("returns structured MISSING_PARAMETER with a corrected example", async () => {
    const { tools } = setup();
    const result = await tools.get("ml_query_recipe")!({
      recipe: "find_entities_by_type",
      params: { collection: "X" },
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("MISSING_PARAMETER");
    expect(parsed.error.details.required).toEqual([
      "collection",
      "type_field",
      "type_value",
    ]);
    expect(parsed.error.exampleValid?.params).toBeTruthy();
  });
});
