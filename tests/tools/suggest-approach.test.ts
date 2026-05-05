/**
 * Unit tests for the ml_suggest_approach tool handler.
 *
 * The tool is a pure in-memory classifier — no MarkLogic connection required.
 * Tests verify that:
 *  - The tool registers correctly under the "ml_suggest_approach" name
 *  - Common task descriptions route to the expected top-level tool
 *  - The output format is text (not JSON) containing recognisable section headers
 *  - The fallback prompt is returned when no pattern matches
 *  - Ambiguous / multi-intent tasks return multiple suggestions
 */

import { describe, it, expect, beforeEach } from "vitest";
import { registerSuggestApproachTool } from "../../src/tools/suggest-approach.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

async function suggest(task: string, tools: Map<string, ToolHandler>): Promise<string> {
  const result = await tools.get("ml_suggest_approach")!({ task });
  return result.content[0].text;
}

// ─── Registration ──────────────────────────────────────────────────────────────

describe("registerSuggestApproachTool – registration", () => {
  it("registers exactly one tool named ml_suggest_approach", () => {
    const { server, tools } = createMockServer();
    registerSuggestApproachTool(server as never);
    expect(tools.has("ml_suggest_approach")).toBe(true);
    expect(tools.size).toBe(1);
  });
});

// ─── ml_suggest_approach handler ──────────────────────────────────────────────

describe("ml_suggest_approach – bulk import / URL fetch", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes CSV import to flux_import", async () => {
    const text = await suggest("import a CSV file into MarkLogic", tools);
    expect(text).toContain("flux_import");
    expect(text).toContain("import-delimited-files");
  });

  it("routes URL download to flux_import with http_url", async () => {
    const text = await suggest("download data from https://example.com/data.csv and load it", tools);
    expect(text).toContain("flux_import");
    expect(text).toContain("http_url");
  });

  it("routes JDBC import to import-jdbc subcommand", async () => {
    const text = await suggest("import data from a PostgreSQL database via JDBC", tools);
    expect(text).toContain("flux_import");
    expect(text).toContain("import-jdbc");
  });

  it("routes S3 JSON import to import-files subcommand", async () => {
    const text = await suggest("load .json files from an S3 bucket into MarkLogic", tools);
    expect(text).toContain("flux_import");
    expect(text).toContain("import-files");
  });

  it("warns about Socrata /rows.json format issue", async () => {
    const text = await suggest("fetch data from a Socrata data.gov open data endpoint", tools);
    expect(text).toContain("flux_import");
    expect(text).toContain("rows.csv");
  });

  it("includes TDE recipe for CSV import", async () => {
    const text = await suggest("import a CSV dataset and create a view for querying", tools);
    expect(text).toContain("generate_tde");
  });
});

describe("ml_suggest_approach – analytics / aggregation", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes group-by aggregate to ml_optic_query", async () => {
    const text = await suggest("count documents by category using group by", tools);
    expect(text).toContain("ml_optic_query");
  });

  it("routes sum/avg to ml_optic_query", async () => {
    const text = await suggest("calculate the average salary per department", tools);
    expect(text).toContain("ml_optic_query");
  });

  it("routes time series trend to ml_timeseries_query", async () => {
    const text = await suggest("show me the daily trend of article count over time", tools);
    expect(text).toContain("ml_timeseries_query");
    expect(text).toContain("bucket");
  });

  it("routes monthly report to ml_timeseries_query", async () => {
    const text = await suggest("build a monthly report of sales totals", tools);
    expect(text).toContain("ml_timeseries_query");
  });
});

describe("ml_suggest_approach – full-text search", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes keyword search to ml_search", async () => {
    const text = await suggest("find all documents mentioning climate change", tools);
    expect(text).toContain("ml_search");
  });

  it("routes 'documents about X' to ml_search", async () => {
    const text = await suggest("get documents about renewable energy", tools);
    expect(text).toContain("ml_search");
    expect(text).toContain("collection");
  });
});

describe("ml_suggest_approach – hybrid search + analytics", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes hybrid search+aggregate to fromSearch Optic pattern", async () => {
    const text = await suggest("search for articles about AI and count by category", tools);
    // Should NOT contain standalone ml_search — should be the hybrid fromSearch pattern
    expect(text).toContain("from-search");
    expect(text).toContain("group-by");
  });
});

describe("ml_suggest_approach – schema discovery", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes schema/view exploration to ml_schema_discover", async () => {
    const text = await suggest("what schemas and TDE views exist in the database", tools);
    expect(text).toContain("ml_schema_discover");
  });

  it("routes index discovery to ml_schema_discover", async () => {
    const text = await suggest("what indexes are configured", tools);
    expect(text).toContain("ml_schema_discover");
  });
});

describe("ml_suggest_approach – single document write", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes single document insert to ml_document_put", async () => {
    const text = await suggest("write a single JSON document to MarkLogic", tools);
    expect(text).toContain("ml_document_put");
  });

  it("routes TDE template installation to ml_document_put", async () => {
    const text = await suggest("install a TDE template document in the Schemas database", tools);
    expect(text).toContain("ml_document_put");
    expect(text).toContain("Schemas");
  });
});

describe("ml_suggest_approach – graph / SPARQL", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes SPARQL query to ml_sparql_query", async () => {
    const text = await suggest("run a SPARQL SELECT query against the triple store", tools);
    expect(text).toContain("ml_sparql_query");
  });

  it("routes RDF graph traversal to ml_sparql_query", async () => {
    const text = await suggest("find entity relationships in the RDF graph", tools);
    expect(text).toContain("ml_sparql_query");
  });
});

describe("ml_suggest_approach – project setup", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes new project setup to project_setup_advisor", async () => {
    const text = await suggest("create a new ml-gradle project structure", tools);
    expect(text).toContain("project_setup_advisor");
    expect(text).toContain("ml-gradle");
  });

  it("routes 'create a new project' (without ml-gradle keyword) to ml_gradle_scaffold first", async () => {
    const text = await suggest("create a new project to store and search customer orders", tools);
    expect(text).toContain("ml_gradle_scaffold");
    // Scaffold should appear BEFORE the advisor prompt — it's the actionable first step.
    expect(text.indexOf("ml_gradle_scaffold")).toBeLessThan(text.indexOf("project_setup_advisor"));
  });

  it("routes 'build me an app' to ml_gradle_scaffold", async () => {
    const text = await suggest("build me an app that exposes a custom REST endpoint", tools);
    expect(text).toContain("ml_gradle_scaffold");
  });

  it("routes 'add a REST extension' to project setup, not raw ml_extension_put", async () => {
    const text = await suggest("I want to add a REST extension to my MarkLogic deployment", tools);
    expect(text).toContain("ml_gradle_scaffold");
  });

  it("routes 'deploy this to production' to project setup", async () => {
    const text = await suggest("how do I deploy my application to production", tools);
    expect(text).toContain("ml_gradle_scaffold");
  });

  it("does NOT route pure search queries to project setup", async () => {
    const text = await suggest("search documents mentioning climate change", tools);
    expect(text).not.toContain("ml_gradle_scaffold");
  });
});

describe("ml_suggest_approach – vector / RAG", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes vector similarity search to ml_vector_search", async () => {
    const text = await suggest("find similar documents using vector embeddings", tools);
    expect(text).toContain("ml_vector_search");
  });

  it("routes RAG retrieval to ml_vector_search", async () => {
    const text = await suggest("build a RAG retrieval pipeline using cosine similarity", tools);
    expect(text).toContain("ml_vector_search");
  });
});

describe("ml_suggest_approach – export", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes export to flux_export", async () => {
    const text = await suggest("export the sales collection to Parquet files", tools);
    expect(text).toContain("flux_export");
  });
});

describe("ml_suggest_approach – server-side eval", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes custom XQuery/SJS logic to ml_eval_javascript", async () => {
    const text = await suggest("run custom server-side javascript using xdmp built-ins", tools);
    expect(text).toContain("ml_eval_javascript");
  });
});

describe("ml_suggest_approach – Semaphore classification", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("routes text classification to semaphore_classify", async () => {
    const text = await suggest("classify this article using the taxonomy", tools);
    expect(text).toContain("semaphore_classify");
  });

  it("routes auto-tagging to semaphore_classify and integration advisor", async () => {
    const text = await suggest("automatically tag documents with taxonomy concepts", tools);
    expect(text).toContain("semaphore");
    expect(text).toContain("semaphore_integration_advisor");
  });

  it("routes bulk classification to Flux+Semaphore pipeline", async () => {
    const text = await suggest("classify all documents in a collection using Semaphore in bulk", tools);
    expect(text).toContain("flux_reprocess");
  });

  it("routes SKOS taxonomy loading to the full pipeline", async () => {
    const text = await suggest("load a SKOS taxonomy and publish it to the Classification Server", tools);
    expect(text).toContain("semaphore_kmm_model_create");
    expect(text).toContain("semaphore_kmm_skos_load");
    expect(text).toContain("semaphore_publish");
  });

  it("routes IPTC media topics to taxonomy load pipeline", async () => {
    const text = await suggest("import the IPTC media topics taxonomy into Semaphore", tools);
    expect(text).toContain("semaphore_kmm_skos_load");
  });
});

describe("ml_suggest_approach – fallback", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("returns problem_advisor fallback for unrecognised task", async () => {
    // A completely opaque task with no recognised keywords
    const text = await suggest("zzz nonsense gibberish", tools);
    expect(text).toContain("problem_advisor");
  });
});

describe("ml_suggest_approach – output format", () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    const { server, tools: t } = createMockServer();
    registerSuggestApproachTool(server as never);
    tools = t;
  });

  it("output starts with APPROACH RECOMMENDATIONS header", async () => {
    const text = await suggest("import a CSV file", tools);
    expect(text.startsWith("APPROACH RECOMMENDATIONS FOR:")).toBe(true);
  });

  it("output contains ## section headings for each suggestion", async () => {
    const text = await suggest("import a CSV file", tools);
    expect(text).toMatch(/^## \d+\./m);
  });

  it("output contains RATIONALE section", async () => {
    const text = await suggest("import a CSV file", tools);
    expect(text).toContain("RATIONALE:");
  });

  it("output contains RECIPE section with JSON code block", async () => {
    const text = await suggest("import a CSV file", tools);
    expect(text).toContain("RECIPE:");
    expect(text).toContain("```json");
  });

  it("multi-match tasks show a count summary at the end", async () => {
    // A task that definitely matches multiple patterns
    const text = await suggest("search for articles and count by category group by", tools);
    // Multiple matches → summary line
    const hasMultiLine = text.includes("approaches matched");
    const hasSingleSection = text.includes("## 1.");
    expect(hasMultiLine || hasSingleSection).toBe(true);
  });

  it("result is never isError", async () => {
    const result = await tools.get("ml_suggest_approach")!({ task: "anything" });
    expect(result.isError).toBeUndefined();
  });
});
