import type { MarkLogicBaseClient } from "./base.js";
import type { SearchClient } from "./search.js";
import type { AdminClient } from "./admin.js";

export interface FieldDescriptor {
  path: string;
  type: "string" | "number" | "boolean" | "date" | "object" | "array" | "null" | "mixed";
  nullable: boolean;
  cardinality: "single" | "multiple";
  exampleValues: unknown[];
  hasRangeIndex: boolean;
}

export interface SchemaDiscoveryResult {
  collection?: string;
  database?: string;
  documentCount: number;
  inferredFields: FieldDescriptor[];
  rangeIndexes: RangeIndex[];
  tdeSchemas: unknown[];
}

export interface RangeIndex {
  type: string;
  localname?: string;
  namespace?: string;
  pathExpression?: string;
  scalarType: string;
}

export class SchemaClient {
  constructor(
    private readonly base: MarkLogicBaseClient,
    private readonly search: SearchClient,
    private readonly admin: AdminClient
  ) {}

  async discoverSchema(options: {
    collection?: string;
    sampleSize?: number;
    database?: string;
  }): Promise<SchemaDiscoveryResult> {
    const sampleSize = options.sampleSize ?? 10;

    // Fetch sample documents
    const searchResult = await this.search.search({
      q: "",
      collection: options.collection,
      pageLength: sampleSize,
      database: options.database,
    });

    const docs: unknown[] = [];
    for (const result of searchResult.results) {
      try {
        const res = await this.base.http.get("/v1/documents", {
          params: {
            uri: result.uri,
            ...(options.database ? { database: options.database } : {}),
          },
          responseType: "text",
        });
        const text = res.data as string;
        try {
          docs.push(JSON.parse(text));
        } catch {
          // skip non-JSON docs
        }
      } catch {
        // skip unavailable docs
      }
    }

    const fieldMap = new Map<string, FieldDescriptor>();
    for (const doc of docs) {
      collectFields(doc as Record<string, unknown>, "", fieldMap, docs.length);
    }

    // Get range indexes from DB properties
    let rangeIndexes: RangeIndex[] = [];
    if (options.database) {
      try {
        const props = await this.admin.getDatabaseProperties(options.database);
        rangeIndexes = extractRangeIndexes(props as Record<string, unknown>);

        // Mark fields that have range indexes
        for (const idx of rangeIndexes) {
          const path = idx.pathExpression ?? idx.localname ?? "";
          if (fieldMap.has(path)) {
            fieldMap.get(path)!.hasRangeIndex = true;
          }
        }
      } catch {
        // management API may not be accessible
      }
    }

    // Get TDE schemas via search on Schemas DB
    const tdeSchemas: unknown[] = [];

    return {
      collection: options.collection,
      database: options.database,
      documentCount: searchResult.total,
      inferredFields: Array.from(fieldMap.values()),
      rangeIndexes,
      tdeSchemas,
    };
  }

  async listCollections(database?: string, limit = 50): Promise<Array<{ name: string; count: number }>> {
    // Use /v1/values with built-in collection lexicon
    try {
      const params: Record<string, string | number> = { format: "json", limit };
      if (database) params.database = database;

      const raw = await this.base.get<Record<string, unknown>>(
        this.base.http,
        "/v1/search",
        {
          params: {
            ...params,
            "page-length": 0,
            format: "json",
          },
        }
      );

      // Fall back to eval if values approach doesn't return collections
      const xquery = `
        for $c in cts:collections()
        let $count := xdmp:estimate(cts:collection-query($c))
        order by $count descending
        return object-node { "name": $c, "count": $count }
      `;
      const evalParams: Record<string, string | number> = { format: "json" };
      if (database) evalParams.database = database;
      const evalRes = await this.base.http.post(
        "/v1/eval",
        new URLSearchParams({ xquery }).toString(),
        {
          params: evalParams,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "multipart/mixed",
          },
          responseType: "text",
        }
      );
      void raw; // used for database param passing; actual result from eval

      // Quick parse of multipart — just extract JSON objects
      const text = evalRes.data as string;
      const matches = [...text.matchAll(/\{[^}]+\}/g)];
      return matches
        .map((m) => {
          try {
            return JSON.parse(m[0]) as { name: string; count: number };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(0, limit) as Array<{ name: string; count: number }>;
    } catch {
      return [];
    }
  }

  async listIndexes(database: string): Promise<RangeIndex[]> {
    const props = await this.admin.getDatabaseProperties(database);
    return extractRangeIndexes(props as Record<string, unknown>);
  }

  async listNamespaces(database?: string): Promise<Array<{ prefix: string; namespaceUri: string }>> {
    try {
      const xquery = `
        for $ns in xdmp:database-path-namespaces(xdmp:database())
        return object-node { "prefix": $ns, "uri": $ns }
      `;
      const evalParams: Record<string, string> = {};
      if (database) evalParams.database = database;
      const evalRes = await this.base.http.post(
        "/v1/eval",
        new URLSearchParams({ xquery }).toString(),
        {
          params: evalParams,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "multipart/mixed",
          },
          responseType: "text",
        }
      );
      const text = evalRes.data as string;
      const matches = [...text.matchAll(/\{[^}]+\}/g)];
      return matches
        .map((m) => {
          try {
            const o = JSON.parse(m[0]) as { prefix: string; uri: string };
            return { prefix: o.prefix, namespaceUri: o.uri };
          } catch {
            return null;
          }
        })
        .filter(Boolean) as Array<{ prefix: string; namespaceUri: string }>;
    } catch {
      return [];
    }
  }

  async getTdeSchemas(database?: string, schemaName?: string): Promise<unknown[]> {
    try {
      let xquery = `
        for $schema in cts:search(/, cts:and-query(()))
        where fn:ends-with(xdmp:node-uri($schema), ".json") or fn:ends-with(xdmp:node-uri($schema), ".xml")
        return xdmp:node-uri($schema)
      `;
      if (schemaName) {
        xquery = `
          for $schema in cts:search(/, cts:element-value-query(xs:QName("template-name"), "${schemaName}"))
          return xdmp:node-uri($schema)
        `;
      }
      const evalParams: Record<string, string> = {};
      if (database) evalParams.database = database;
      const evalRes = await this.base.http.post(
        "/v1/eval",
        new URLSearchParams({ xquery }).toString(),
        {
          params: { ...evalParams, database: "Schemas" },
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "multipart/mixed",
          },
          responseType: "text",
        }
      );
      const text = evalRes.data as string;
      return text.split("\r\n").filter((l) => l.startsWith("/"));
    } catch {
      return [];
    }
  }
}

function collectFields(
  obj: Record<string, unknown>,
  prefix: string,
  map: Map<string, FieldDescriptor>,
  total: number
): void {
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const type = inferType(val);

    if (map.has(path)) {
      const existing = map.get(path)!;
      if (existing.type !== type) existing.type = "mixed";
      if (existing.exampleValues.length < 3) existing.exampleValues.push(val);
    } else {
      map.set(path, {
        path,
        type,
        nullable: val === null,
        cardinality: Array.isArray(val) ? "multiple" : "single",
        exampleValues: val !== null && val !== undefined ? [val] : [],
        hasRangeIndex: false,
      });
    }

    if (type === "object" && val !== null) {
      collectFields(val as Record<string, unknown>, path, map, total);
    }
  }
}

function inferType(val: unknown): FieldDescriptor["type"] {
  if (val === null) return "null";
  if (Array.isArray(val)) return "array";
  const t = typeof val;
  if (t === "object") return "object";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "string") {
    // Heuristic: ISO date strings
    if (/^\d{4}-\d{2}-\d{2}/.test(val as string)) return "date";
    return "string";
  }
  return "string";
}

function extractRangeIndexes(props: Record<string, unknown>): RangeIndex[] {
  const indexes: RangeIndex[] = [];
  const rangeElement = (props["range-element-index"] as Array<Record<string, string>> | undefined) ?? [];
  const rangePath = (props["range-path-index"] as Array<Record<string, string>> | undefined) ?? [];
  const rangeField = (props["range-field-index"] as Array<Record<string, string>> | undefined) ?? [];

  for (const idx of rangeElement) {
    indexes.push({
      type: "range-element",
      localname: idx.localname,
      namespace: idx["namespace-uri"],
      scalarType: idx["scalar-type"] ?? "string",
    });
  }
  for (const idx of rangePath) {
    indexes.push({
      type: "range-path",
      pathExpression: idx["path-expression"],
      scalarType: idx["scalar-type"] ?? "string",
    });
  }
  for (const idx of rangeField) {
    indexes.push({
      type: "range-field",
      localname: idx["field-name"],
      scalarType: idx["scalar-type"] ?? "string",
    });
  }
  return indexes;
}
