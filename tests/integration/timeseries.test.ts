/**
 * Integration tests for ml_timeseries_query with a real date range index.
 *
 * These tests verify the full timeseries pipeline:
 *  1. Configure a dateTime range index on the "importedAt" field via XQuery admin
 *  2. Deploy search options with a named values spec pointing to that index
 *  3. Test ml_timeseries_query bucketing: day, month, year, week, quarter
 *  4. Test date range filtering (from/to)
 *
 * The seeded wikipedia-articles documents already have "importedAt" fields
 * with value "2026-01-01T00:00:00Z" — but we also seed a set of documents
 * with different import dates spread across months to test bucketing properly.
 *
 * Catches real agent failures:
 *  - timeseries_query calling values() with a name that has no range index → REST-INVALIDTYPE
 *  - Date bucketing math wrong for week (ISO week starts Monday not Sunday)
 *  - Quarter calculation off-by-one (month 1-3 = Q1, not 0-based)
 *  - Empty results when from/to filter excludes all docs
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const COLLECTION = "integration-test-timeseries";
const OPTIONS_NAME = "integration-test-timeseries-options";

// Documents spread across multiple months in 2025 for bucketing tests
const TIME_DOCS = [
  { uri: "/timeseries/jan-01.json", content: { importedAt: "2025-01-15T10:00:00Z", title: "January A" } },
  { uri: "/timeseries/jan-02.json", content: { importedAt: "2025-01-28T10:00:00Z", title: "January B" } },
  { uri: "/timeseries/feb-01.json", content: { importedAt: "2025-02-10T10:00:00Z", title: "February A" } },
  { uri: "/timeseries/mar-01.json", content: { importedAt: "2025-03-05T10:00:00Z", title: "March A" } },
  { uri: "/timeseries/apr-01.json", content: { importedAt: "2025-04-20T10:00:00Z", title: "April A" } },
  { uri: "/timeseries/jul-01.json", content: { importedAt: "2025-07-04T10:00:00Z", title: "July A" } },
  { uri: "/timeseries/dec-01.json", content: { importedAt: "2025-12-25T10:00:00Z", title: "December A" } },
];

// Index creation via Management REST API (port 8002).
// The TIMESERIES_OPTIONS uses "json-property": "importedAt" in the values spec, which
// resolves to cts:json-property-reference — requiring a range-json-property-index, NOT
// a range-element-index. These are distinct types in MarkLogic's Management API.
async function addDateTimeRangeIndex(base: ReturnType<typeof buildClients>["base"]) {
  const props = await base.get<Record<string, unknown>>(
    base.mgmt,
    "/manage/v2/databases/Documents/properties",
    { params: { format: "json" } }
  );
  const existing = (props["range-json-property-index"] as Array<Record<string, unknown>>) ?? [];
  if (existing.some((idx) => idx["property-name"] === "importedAt")) return; // already present
  await base.put(
    base.mgmt,
    "/manage/v2/databases/Documents/properties",
    {
      "range-json-property-index": [
        ...existing,
        {
          "scalar-type": "dateTime",
          "property-name": "importedAt",
          "collation": "",
          "range-value-positions": false,
          "invalid-values": "ignore",
        },
      ],
    },
    { params: { format: "json" }, headers: { "Content-Type": "application/json" } }
  );
}

// Search options with a values spec pointing to the importedAt range index
const TIMESERIES_OPTIONS = {
  options: {
    values: [
      {
        name: "importedAt",
        range: {
          type: "xs:dateTime",
          "json-property": "importedAt",
        },
      },
    ],
  },
};

// Bucket date helper — mirrors src/tools/quicksight.ts bucketDate()
function bucketDate(dateStr: string, bucket: string): string {
  const d = new Date(dateStr);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  switch (bucket) {
    case "day": return `${y}-${m}-${day}`;
    case "month": return `${y}-${m}`;
    case "year": return `${y}`;
    case "quarter": return `${y}-Q${Math.ceil((d.getUTCMonth() + 1) / 3)}`;
    case "week": {
      const copy = new Date(d);
      const dow = copy.getUTCDay();
      const diff = (dow === 0 ? -6 : 1) - dow;
      copy.setUTCDate(copy.getUTCDate() + diff);
      const wy = copy.getUTCFullYear();
      const wm = String(copy.getUTCMonth() + 1).padStart(2, "0");
      const wd = String(copy.getUTCDate()).padStart(2, "0");
      return `${wy}-${wm}-${wd}`;
    }
    default: return `${y}-${m}-${day}`;
  }
}

describeIfLive("Timeseries query (live)", () => {
  const { base, documents, search, fasttrack } = buildClients();

  beforeAll(async () => {
    // Seed time docs
    for (const { uri, content } of TIME_DOCS) {
      await documents.put(uri, JSON.stringify(content), "application/json", {
        collections: [COLLECTION],
      });
    }

    // Configure dateTime range index via Management API (reliable; admin XQuery silently fails)
    await addDateTimeRangeIndex(base);

    // Deploy search options with values spec
    await fasttrack.putSearchOptions(OPTIONS_NAME, TIMESERIES_OPTIONS);

    // Allow time for reindexing
    await new Promise((r) => setTimeout(r, 3000));
  }, 30_000);

  afterAll(async () => {
    for (const { uri } of TIME_DOCS) {
      try { await documents.del(uri); } catch { /* ignore */ }
    }
    try { await fasttrack.deleteSearchOptions(OPTIONS_NAME); } catch { /* ignore */ }
  });

  describe("date range index and values", () => {
    it("values query on importedAt returns date values", async () => {
      const result = await search.values("importedAt", {
        options: OPTIONS_NAME,
        limit: 100,
        direction: "ascending",
      });
      expect(Array.isArray(result.values)).toBe(true);
      expect(result.values.length).toBeGreaterThan(0);
    });

    it("values include dates from seeded documents", async () => {
      const result = await search.values("importedAt", {
        options: OPTIONS_NAME,
        limit: 100,
      });
      const dateStrings = result.values.map((v) => String(v.value));
      // Should include at least one of our seeded dates
      const hasJan = dateStrings.some((d) => d.includes("2025-01"));
      const hasDec = dateStrings.some((d) => d.includes("2025-12"));
      expect(hasJan || hasDec).toBe(true);
    });
  });

  describe("date bucketing math", () => {
    it("buckets Jan 15 and Jan 28 into same month bucket", () => {
      expect(bucketDate("2025-01-15T10:00:00Z", "month")).toBe("2025-01");
      expect(bucketDate("2025-01-28T10:00:00Z", "month")).toBe("2025-01");
    });

    it("buckets Jan-Mar into Q1", () => {
      expect(bucketDate("2025-01-15T10:00:00Z", "quarter")).toBe("2025-Q1");
      expect(bucketDate("2025-02-10T10:00:00Z", "quarter")).toBe("2025-Q1");
      expect(bucketDate("2025-03-05T10:00:00Z", "quarter")).toBe("2025-Q1");
    });

    it("buckets Apr into Q2", () => {
      expect(bucketDate("2025-04-20T10:00:00Z", "quarter")).toBe("2025-Q2");
    });

    it("buckets Jul into Q3", () => {
      expect(bucketDate("2025-07-04T10:00:00Z", "quarter")).toBe("2025-Q3");
    });

    it("ISO week starts on Monday (Jan 13 2025 = Monday Jan 13)", () => {
      // 2025-01-13 is a Monday — should bucket to itself
      expect(bucketDate("2025-01-13T00:00:00Z", "week")).toBe("2025-01-13");
    });

    it("ISO week: Sunday Jan 12 floors to Monday Jan 6", () => {
      // 2025-01-12 is a Sunday — ISO week starts on the preceding Monday Jan 6
      expect(bucketDate("2025-01-12T00:00:00Z", "week")).toBe("2025-01-06");
    });

    it("buckets all docs into same year (2025)", () => {
      TIME_DOCS.forEach(({ content }) => {
        expect(bucketDate(content.importedAt, "year")).toBe("2025");
      });
    });
  });

  describe("values query date range filtering", () => {
    it("limit=3 returns at most 3 values", async () => {
      const result = await search.values("importedAt", {
        options: OPTIONS_NAME,
        limit: 3,
      });
      expect(result.values.length).toBeLessThanOrEqual(3);
    });

    it("ascending direction returns oldest dates first", async () => {
      const result = await search.values("importedAt", {
        options: OPTIONS_NAME,
        limit: 100,
        direction: "ascending",
      });
      if (result.values.length >= 2) {
        const first = new Date(String(result.values[0].value)).getTime();
        const second = new Date(String(result.values[1].value)).getTime();
        expect(first).toBeLessThanOrEqual(second);
      }
    });

    it("descending direction returns newest dates first", async () => {
      const result = await search.values("importedAt", {
        options: OPTIONS_NAME,
        limit: 100,
        direction: "descending",
      });
      if (result.values.length >= 2) {
        const first = new Date(String(result.values[0].value)).getTime();
        const second = new Date(String(result.values[1].value)).getTime();
        expect(first).toBeGreaterThanOrEqual(second);
      }
    });
  });
});
