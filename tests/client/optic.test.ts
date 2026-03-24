import { describe, it, expect, vi } from "vitest";
import { OpticClient } from "../../src/client/optic.js";

function createMockBase() {
  return {
    http: {},
    post: vi.fn(),
  };
}

// ── query ─────────────────────────────────────────────────────────────────────

describe("OpticClient.query", () => {
  it("posts plan to /v1/rows and normalizes response", async () => {
    const base = createMockBase();
    const client = new OpticClient(base as never);

    base.post.mockResolvedValue({
      columns: [{ name: "myschema.myview.id" }, { name: "myschema.myview.name" }],
      rows: [
        { "myschema.myview.id": { type: "xs:integer", value: 1 }, "myschema.myview.name": { type: "xs:string", value: "Alice" } },
      ],
    });

    const plan = { $optic: { ns: "op", fn: "from-view", args: ["myschema", "myview"] } };
    const result = await client.query(plan);

    expect(result.columns).toEqual(["myschema.myview.id", "myschema.myview.name"]);
    expect(result.rows[0]["myschema.myview.id"]).toBe(1);
    expect(result.rows[0]["myschema.myview.name"]).toBe("Alice");
  });

  it("strips schema.view prefix when stripSchemaPrefix=true", async () => {
    const base = createMockBase();
    const client = new OpticClient(base as never);

    base.post.mockResolvedValue({
      columns: [{ name: "schema.view.id" }, { name: "schema.view.name" }],
      rows: [
        { "schema.view.id": { value: 1 }, "schema.view.name": { value: "Bob" } },
      ],
    });

    const result = await client.query({}, undefined, true);

    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows[0]["id"]).toBe(1);
    expect(result.rows[0]["name"]).toBe("Bob");
  });

  it("does not strip prefix when stripSchemaPrefix=false", async () => {
    const base = createMockBase();
    const client = new OpticClient(base as never);

    base.post.mockResolvedValue({
      columns: [{ name: "s.v.col" }],
      rows: [{ "s.v.col": { value: 42 } }],
    });

    const result = await client.query({}, undefined, false);

    expect(result.columns).toEqual(["s.v.col"]);
  });

  it("handles rows with direct values (no nested {type,value})", async () => {
    const base = createMockBase();
    const client = new OpticClient(base as never);

    base.post.mockResolvedValue({
      columns: [{ name: "count" }],
      rows: [{ count: 99 }],
    });

    const result = await client.query({});
    expect(result.rows[0]["count"]).toBe(99);
  });

  it("passes database as query param", async () => {
    const base = createMockBase();
    const client = new OpticClient(base as never);
    base.post.mockResolvedValue({ columns: [], rows: [] });

    await client.query({}, "my-db");

    const [, , , opts] = base.post.mock.calls[0];
    expect(opts.params.database).toBe("my-db");
  });

  it("returns empty columns/rows for empty response", async () => {
    const base = createMockBase();
    const client = new OpticClient(base as never);
    base.post.mockResolvedValue({});

    const result = await client.query({});
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });
});
