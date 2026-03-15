import type { MarkLogicBaseClient } from "./base.js";

export interface OpticResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export class OpticClient {
  constructor(private readonly base: MarkLogicBaseClient) {}

  async query(plan: Record<string, unknown>, database?: string): Promise<OpticResult> {
    const params: Record<string, string> = { output: "json" };
    if (database) params.database = database;

    const raw = await this.base.post<Record<string, unknown>>(
      this.base.http,
      "/v1/rows",
      plan,
      { params, headers: { "Content-Type": "application/json", Accept: "application/json" } }
    );

    return normalizeOpticResponse(raw);
  }
}

function normalizeOpticResponse(raw: Record<string, unknown>): OpticResult {
  // MarkLogic returns { columns: [{name, type}...], rows: [{col: {type, value}}...] }
  const rawColumns = (raw?.columns as Array<{ name: string; type?: string }>) ?? [];
  const columns = rawColumns.map((c) => c.name ?? String(c));

  const rawRows = (raw?.rows as Array<Record<string, { type?: string; value?: unknown } | unknown>>) ?? [];
  const rows = rawRows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => {
        const val = v && typeof v === "object" && "value" in (v as object) ? (v as { value: unknown }).value : v;
        return [k, val];
      })
    )
  );

  return { columns, rows };
}
