import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerQuickSightTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_aggregate_query",
    "Run a high-level aggregation query on MarkLogic and return tabular results suitable for AWS QuickSight dashboards. Groups documents and computes metrics using range indexes.",
    {
      collection: z.string().optional().describe("Collection to aggregate over"),
      filter_query: z.string().optional().describe("Constraining search query to filter documents before aggregating"),
      group_by: z.array(z.string()).optional().describe(
        "Field paths to group by. NOTE: arbitrary field-path grouping is not supported by this tool — " +
        "supplying this parameter returns an error with guidance. " +
        "Use ml_optic_query with a group-by operator (requires TDE view) or ml_values_query with a named values definition backed by a range index instead."
      ),
      metrics: z.array(z.object({
        values_name: z.string().describe("Named values definition in search options"),
        aggregate: z.enum(["count", "sum", "avg", "min", "max", "stddev"]).describe("Aggregate function"),
        alias: z.string().optional().describe("Column alias for the result"),
      })).optional().describe("Aggregate metrics to compute"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ collection, filter_query, group_by, metrics, database }) => {
      // group_by is not supported — reject early with actionable guidance
      if (group_by?.length) {
        return {
          content: [{
            type: "text",
            text:
              "group_by is not supported by ml_aggregate_query.\n\n" +
              "To group documents by a field, use one of:\n" +
              "  • ml_optic_query — use a group-by operator in an Optic plan (requires a TDE view with the field as a column). " +
              "Example: add {\"ns\":\"op\",\"fn\":\"group-by\",\"args\":[[col],[{\"ns\":\"op\",\"fn\":\"count\",\"args\":[\"count\",null]}]]} to your plan.\n" +
              "  • ml_values_query — pass a named values definition backed by a range index to get value frequencies.\n\n" +
              "Use ml_schema_discover to find available range indexes, or ml_views_list to see TDE views.",
          }],
          isError: true,
        };
      }

      try {
        const results: Record<string, unknown> = {
          query: { collection, filter: filter_query },
          metrics: [],
        };

        // Fetch document count matching the filter
        const countResult = await clients.search.search({
          q: filter_query ?? "",
          collection,
          pageLength: 0,
          database,
        });
        results.documentCount = countResult.total;

        // Compute each metric via values/aggregation
        if (metrics?.length) {
          const metricResults = await Promise.allSettled(
            metrics.map(async (m) => {
              const res = await clients.search.values(m.values_name, {
                query: filter_query,
                aggregate: m.aggregate,
                database,
              });
              return { alias: m.alias ?? m.values_name, aggregate: m.aggregate, ...res };
            })
          );
          results.metrics = metricResults
            .filter((r) => r.status === "fulfilled")
            .map((r) => (r as PromiseFulfilledResult<unknown>).value);
        }

        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_timeseries_query",
    "Time-bucketed aggregation query for MarkLogic — returns data suitable for QuickSight time-series charts. Requires a range index on the time field.",
    {
      collection: z.string().optional().describe("Collection to query"),
      time_values_name: z.string().describe("Named values definition pointing to the date/time range index"),
      bucket: z.enum(["hour", "day", "week", "month", "quarter", "year"]).optional().describe("Time bucket size (default: day)"),
      filter_query: z.string().optional().describe("Constraining search query"),
      from: z.string().optional().describe("Start datetime (ISO 8601)"),
      to: z.string().optional().describe("End datetime (ISO 8601)"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ collection, time_values_name, bucket, filter_query, from, to, database }) => {
      try {
        const values = await clients.search.values(time_values_name, {
          query: filter_query,
          limit: 10000,
          direction: "ascending",
          database,
        });

        // Filter by date range if from/to specified
        let filtered = values.values;
        if (from || to) {
          const fromDate = from ? new Date(from).getTime() : -Infinity;
          const toDate = to ? new Date(to).getTime() : Infinity;
          filtered = filtered.filter((v) => {
            const t = new Date(String(v.value)).getTime();
            return !isNaN(t) && t >= fromDate && t <= toDate;
          });
        }

        // Bucket values if requested
        let points: Array<{ bucket: string; count: number; frequency_sum: number }> | typeof filtered;
        if (bucket) {
          const bucketMap = new Map<string, { count: number; frequency_sum: number }>();
          for (const v of filtered) {
            const d = new Date(String(v.value));
            if (isNaN(d.getTime())) continue;
            const key = bucketDate(d, bucket);
            const existing = bucketMap.get(key);
            if (existing) {
              existing.count += 1;
              existing.frequency_sum += v.frequency;
            } else {
              bucketMap.set(key, { count: 1, frequency_sum: v.frequency });
            }
          }
          points = Array.from(bucketMap.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, val]) => ({ bucket: key, count: val.count, frequency_sum: val.frequency_sum }));
        } else {
          points = filtered;
        }

        const result = {
          collection,
          timeField: time_values_name,
          bucket: bucket ?? "none",
          dateRange: { from: from ?? null, to: to ?? null },
          points,
          total: Array.isArray(points) ? points.length : 0,
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_export_tabular",
    "Export MarkLogic search results as tabular data (JSON rows or CSV) for direct ingestion into AWS QuickSight SPICE datasets.",
    {
      query: z.string().optional().describe("Full-text or structured query string"),
      collection: z.string().optional().describe("Collection to export from"),
      fields: z.array(z.string()).describe("JSON field paths to extract from each document (e.g. ['customer.name', 'order.total'])"),
      max_rows: z.number().int().positive().max(10000).optional().describe("Maximum rows to export (default: 1000)"),
      format: z.enum(["json-rows", "csv"]).optional().describe("Output format (default: json-rows)"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ query, collection, fields, max_rows, format, database }) => {
      try {
        const pageLength = Math.min(max_rows ?? 1000, 100);
        const rows: Record<string, unknown>[] = [];
        let start = 1;
        const maxRows = max_rows ?? 1000;

        while (rows.length < maxRows) {
          const searchRes = await clients.search.search({
            q: query ?? "",
            collection,
            start,
            pageLength,
            database,
          });
          if (!searchRes.results.length) break;

          for (const result of searchRes.results) {
            if (rows.length >= maxRows) break;
            try {
              const doc = await clients.documents.get(result.uri, database);
              const docObj = doc.content as Record<string, unknown>;
              const row: Record<string, unknown> = { _uri: result.uri };
              for (const field of fields) {
                row[field] = getNestedValue(docObj, field);
              }
              rows.push(row);
            } catch {
              // skip inaccessible docs
            }
          }

          if (searchRes.results.length < pageLength) break;
          start += pageLength;
        }

        let output: string;
        if (format === "csv") {
          const headers = ["_uri", ...fields];
          const csvLines = [
            headers.join(","),
            ...rows.map((row) =>
              headers.map((h) => csvEscape(row[h])).join(",")
            ),
          ];
          output = csvLines.join("\n");
        } else {
          output = JSON.stringify({ rows, count: rows.length }, null, 2);
        }

        return { content: [{ type: "text", text: output }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_facets_query",
    "Return facet breakdowns from MarkLogic search results — suitable for populating QuickSight filter controls and pie/bar charts.",
    {
      query: z.string().optional().describe("Constraining search query"),
      collection: z.string().optional().describe("Collection to facet"),
      options: z.string().optional().describe("Named search options that define the facets"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ query, collection, options, database }) => {
      try {
        const result = await clients.search.search({
          q: query ?? "",
          collection,
          pageLength: 0,
          options,
          database,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              total: result.total,
              facets: result.facets ?? {},
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}

function bucketDate(d: Date, bucket: string): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  switch (bucket) {
    case "hour":
      return `${y}-${m}-${day}T${h}:00:00Z`;
    case "day":
      return `${y}-${m}-${day}`;
    case "week": {
      // ISO week: floor to Monday
      const copy = new Date(d);
      const dayOfWeek = copy.getUTCDay();
      const diff = (dayOfWeek === 0 ? -6 : 1) - dayOfWeek;
      copy.setUTCDate(copy.getUTCDate() + diff);
      const wy = copy.getUTCFullYear();
      const wm = String(copy.getUTCMonth() + 1).padStart(2, "0");
      const wd = String(copy.getUTCDate()).padStart(2, "0");
      return `${wy}-${wm}-${wd}`;
    }
    case "month":
      return `${y}-${m}`;
    case "quarter":
      return `${y}-Q${Math.ceil((d.getUTCMonth() + 1) / 3)}`;
    case "year":
      return `${y}`;
    default:
      return `${y}-${m}-${day}`;
  }
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = typeof val === "object" ? JSON.stringify(val) : String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
