import type { MarkLogicBaseClient } from "./base.js";
import type { SearchClient } from "./search.js";
import type { AdminClient } from "./admin.js";
import { parseMultipartMixed } from "../utils/multipart.js";

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
  // Geospatial-specific fields (present when type starts with "geospatial-")
  parentLocalname?: string;
  parentNamespace?: string;
  latLocalname?: string;
  lonLocalname?: string;
  coordinateSystem?: string;
  // JSON property pair geospatial index fields
  parentProperty?: string;
  latProperty?: string;
  lonProperty?: string;
}

export interface TdeValidationResult {
  tdeUri: string;
  collection: string;
  /** Number of documents in the collection (via xdmp:estimate) */
  documentCount: number;
  /** Number of rows returned by the view for up to sampleSize rows */
  sampledRows: number;
  /** Schema and view names extracted from the TDE */
  views: Array<{ schema: string; view: string }>;
  /** A few sample rows from the view */
  sampleRows: unknown[];
  /** Error if the view could not be queried (e.g. SQL-TABLENOTFOUND, reindexing) */
  viewError?: string;
  summary: string;
  // Legacy fields kept for backward compatibility
  sampledDocuments: number;
  validDocuments: number;
  invalidDocuments: number;
  errors: Array<{ uri: string; messages: string[] }>;
  suggestedNullableColumns: string[];
}

export interface TdeColumn {
  name: string;
  scalarType: string;
  val: string;
  nullable?: boolean;
}

export interface GeneratedTdeTemplate {
  uri: string;
  template: Record<string, unknown>;
  /** Column names that were sanitized (spaces/special chars replaced with underscores) */
  sanitizedColumns: string[];
  /** Column names skipped because every sampled value was null (would contribute nothing to the view) */
  skippedNullColumns: string[];
  /**
   * Column names skipped because their sanitized path produces an invalid TDE val expression.
   * For example, Socrata `:@computed_region_*` keys sanitize to `:_computed_region_*`, which
   * starts with `:` — an invalid XPath step that MarkLogic rejects, causing SQL-TABLENOTFOUND.
   */
  skippedInvalidColumns: string[];
}

export interface ViewDescriptor {
  schema: string;
  view: string;
  tde_uri: string;
  collections: string[];
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

    let rangeIndexes: RangeIndex[] = [];
    if (options.database) {
      try {
        const props = await this.admin.getDatabaseProperties(options.database);
        rangeIndexes = extractRangeIndexes(props as Record<string, unknown>);
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

    return {
      collection: options.collection,
      database: options.database,
      documentCount: searchResult.total,
      inferredFields: Array.from(fieldMap.values()),
      rangeIndexes,
      tdeSchemas: [],
    };
  }

  async listCollections(database?: string, limit = 50): Promise<Array<{ name: string; count: number }>> {
    // Use xdmp:to-json(map:new(...)) instead of the object-node {} constructor.
    // cts:estimate() takes a cts:query directly and returns a count estimate.
    const xquery = `
      for $c in cts:collections()
      let $count := cts:estimate(cts:collection-query($c))
      order by $count descending
      return xdmp:to-json(map:new((map:entry("name", $c), map:entry("count", $count))))
    `;
    const evalParams: Record<string, string | number> = {};
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
    const parts = parseMultipartMixed(evalRes.data as string, evalRes.headers["content-type"] as string);
    return parts
      .map((p) => {
        const v = p.value;
        if (v && typeof v === "object" && "name" in (v as object)) {
          return v as { name: string; count: number };
        }
        if (typeof v === "string") {
          try { return JSON.parse(v) as { name: string; count: number }; } catch { /* skip */ }
        }
        return null;
      })
      .filter(Boolean)
      .slice(0, limit) as Array<{ name: string; count: number }>;
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

  /**
   * List TDE template URIs from the Schemas database.
   * When schemaName (a URI like /tde/gdelt/events.json) is provided, returns the
   * full template content rather than just the URI.
   */
  async getTdeSchemas(database?: string, schemaName?: string): Promise<unknown[]> {
    if (schemaName) {
      // Fetch the specific template document directly by URI from Schemas DB.
      // This is reliable regardless of what element/property names are inside.
      const res = await this.base.http.get("/v1/documents", {
        params: { uri: schemaName, database: "Schemas" },
        responseType: "text",
      });
      const text = res.data as string;
      let content: unknown;
      try { content = JSON.parse(text); } catch { content = text; }
      return [{ uri: schemaName, content }];
    }

    // List all TDE template URIs via the TDE collection in Schemas DB.
    const xquery = `
      for $uri in cts:uris((), (), cts:collection-query("http://marklogic.com/xdmp/tde"))
      return $uri
    `;
    const evalRes = await this.base.http.post(
      "/v1/eval",
      new URLSearchParams({ xquery }).toString(),
      {
        params: { database: "Schemas" },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "multipart/mixed",
        },
        responseType: "text",
      }
    );
    const text = evalRes.data as string;
    return text.split("\r\n").filter((l) => l.startsWith("/"));
  }

  /**
   * Find TDE template URIs (in Schemas DB) whose collection scope overlaps with
   * the given collection list. Used for pre-flight conflict detection before import.
   */
  async findTdesByCollection(collections: string[]): Promise<string[]> {
    if (!collections.length) return [];
    const javascript = `
      const cols = collections;
      const uris = [];
      for (const uri of cts.uris(null, null, cts.collectionQuery('http://marklogic.com/xdmp/tde'))) {
        const obj = cts.doc(uri).toObject();
        const tcols = obj && obj.template && obj.template.collections;
        if (tcols && tcols.some(c => cols.includes(c))) uris.push(uri);
      }
      uris;
    `;
    const body = new URLSearchParams();
    body.append("javascript", javascript);
    body.append("vars", JSON.stringify({ collections }));
    const res = await this.base.http.post("/v1/eval", body.toString(), {
      params: { database: "Schemas" },
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "multipart/mixed" },
      responseType: "text",
    });
    const results = parseMultipartMixed(res.data as string, res.headers["content-type"] as string);
    // Results may be individual strings (one per URI) or a single array
    const flat: string[] = [];
    for (const r of results) {
      if (Array.isArray(r.value)) flat.push(...(r.value as string[]));
      else if (typeof r.value === "string" && r.value.startsWith("/")) flat.push(r.value);
    }
    return flat;
  }

  /**
   * Validate a TDE template against sample documents from a collection.
   * Returns structured results including which columns fail and suggestions for nullable:true.
   */
  async validateTde(options: {
    tdeUri: string;
    collection: string;
    sampleSize?: number;
  }): Promise<TdeValidationResult> {
    const { tdeUri, collection, sampleSize = 5 } = options;

    // Read the TDE template from the Schemas database first, then pass its JSON
    // content as a variable so the eval (which runs against the Documents DB) can
    // reconstruct a document node with xdmp.unquote() without needing cross-DB access.
    const tdeResult = await this.getTdeSchemas(undefined, tdeUri);
    if (!tdeResult.length) {
      throw new Error(`TDE template not found at: ${tdeUri}`);
    }
    const tdeContent = (tdeResult[0] as { content: unknown }).content;
    const tplObj = (typeof tdeContent === "string" ? JSON.parse(tdeContent) : tdeContent) as Record<string, unknown>;
    const tpl = (tplObj.template ?? tplObj) as Record<string, unknown>;
    const tplRows = (tpl.rows as Array<Record<string, unknown>>) ?? [];

    // Extract schema/view pairs from the TDE template
    const viewPairs = tplRows
      .filter((r) => r.schemaName && r.viewName)
      .map((r) => ({ schema: r.schemaName as string, view: r.viewName as string }));

    if (viewPairs.length === 0) {
      throw new Error(`No rows definitions found in TDE template at: ${tdeUri}`);
    }

    // NOTE: tde.validate() is broken in MarkLogic 12.0.1 (XDMP-INTERNAL: basic_string::_S_construct null not valid).
    // We use Optic row queries instead, which is more useful anyway: it confirms the view is queryable,
    // returns actual row counts, and surfaces SQL-TABLENOTFOUND / TABLEREINDEXING errors directly.
    const javascript = `
      const op = require('/MarkLogic/optic');
      // xdmp.estimate() was removed in MarkLogic 12 SJS; cts.estimate() is the replacement
      const docCount = cts.estimate(cts.collectionQuery(collection));
      const results = [];
      for (const {schema, view} of viewPairs) {
        try {
          const rows = op.fromView(schema, view).limit(sampleSize).result().toArray();
          results.push({ schema, view, rowCount: rows.length, docCount, sampleRows: rows.slice(0, 3) });
        } catch(e) {
          results.push({ schema, view, error: e.message, docCount });
        }
      }
      results;
    `;

    const body = new URLSearchParams();
    body.append("javascript", javascript);
    body.append("vars", JSON.stringify({ collection, sampleSize, viewPairs }));

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2500;

    type ViewResult = { schema: string; view: string; rowCount?: number; docCount: number; sampleRows?: unknown[]; error?: string };
    let viewResults: ViewResult[] = [];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await this.base.http.post("/v1/eval", body.toString(), {
        params: {},
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "multipart/mixed" },
        responseType: "text",
      });
      const parsed = parseMultipartMixed(res.data as string, res.headers["content-type"] as string);

      viewResults = [];
      for (const r of parsed) {
        if (Array.isArray(r.value)) {
          viewResults.push(...(r.value as ViewResult[]));
        } else if (r.value && typeof r.value === "object" && "schema" in (r.value as object)) {
          viewResults.push(r.value as ViewResult);
        }
      }

      const err = viewResults[0]?.error ?? "";
      const isReindexing = err.includes("TABLEREINDEXING") || err.includes("not available until");
      if (isReindexing && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      break;
    }

    const firstResult = viewResults[0];
    const docCount = firstResult?.docCount ?? 0;
    const rowCount = firstResult?.rowCount ?? 0;
    const viewError = firstResult?.error;
    const sampleRows = firstResult?.sampleRows ?? [];

    let summary: string;
    if (viewError) {
      summary = `View query failed: ${viewError}`;
    } else if (rowCount === 0 && docCount > 0) {
      summary = `View returned 0 rows despite ${docCount} documents in collection "${collection}". ` +
        `Likely causes: (1) columns missing nullable:true — if documents are sparse or were imported with ` +
        `--ignore-null-fields, any document missing a non-nullable column produces no row; ` +
        `(2) TDE context path or collection scope does not match document structure.`;
    } else if (rowCount > 0) {
      summary = `View is healthy: returned ${rowCount} of up to ${sampleSize} rows (collection has ~${docCount} documents).`;
    } else {
      summary = `No documents in collection "${collection}" and no rows in view.`;
    }

    return {
      tdeUri,
      collection,
      documentCount: docCount,
      sampledRows: rowCount,
      views: viewPairs,
      sampleRows,
      viewError,
      summary,
      // Legacy fields
      sampledDocuments: rowCount,
      validDocuments: viewError ? 0 : rowCount,
      invalidDocuments: viewError ? rowCount : 0,
      errors: viewError ? [{ uri: tdeUri, messages: [viewError] }] : [],
      suggestedNullableColumns: [],
    };
  }

  /**
   * List all schema.view pairs available for Optic queries by reading TDE templates
   * from the Schemas database and extracting their row definitions.
   */
  async listViews(database?: string): Promise<ViewDescriptor[]> {
    const uris = await this.getTdeSchemas(database) as string[];
    const views: ViewDescriptor[] = [];

    for (const uri of uris) {
      try {
        const res = await this.base.http.get("/v1/documents", {
          params: { uri, database: "Schemas" },
          responseType: "text",
        });
        const text = res.data as string;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          continue; // skip non-JSON TDEs
        }
        const tpl = (parsed.template ?? parsed) as Record<string, unknown>;
        const rows = (tpl.rows as Array<Record<string, unknown>>) ?? [];
        const collections = (tpl.collections as string[]) ?? [];
        for (const row of rows) {
          if (row.schemaName && row.viewName) {
            views.push({
              schema: row.schemaName as string,
              view: row.viewName as string,
              tde_uri: uri,
              collections,
            });
          }
        }
      } catch {
        // skip unavailable or malformed TDE documents
      }
    }

    return views;
  }

  /**
   * Generate a TDE template JSON by sampling documents from a collection and
   * inferring column types. All string columns that appear nullable get nullable:true.
   * Returns both the template object and the suggested Schemas DB URI.
   */
  async generateTdeTemplate(options: {
    collection: string;
    schemaName: string;
    viewName: string;
    sampleSize?: number;
    database?: string;
  }): Promise<GeneratedTdeTemplate> {
    const discovery = await this.discoverSchema({
      collection: options.collection,
      sampleSize: options.sampleSize ?? 15,
      database: options.database,
    });

    const sanitizedColumns: string[] = [];
    const skippedNullColumns: string[] = [];
    const skippedInvalidColumns: string[] = [];
    const columns: TdeColumn[] = discovery.inferredFields
      .filter((f) => !f.path.includes(".")) // top-level fields only
      .filter((f) => {
        // Skip columns where every sampled value was null — they contribute nothing
        // to the TDE view and create noise (e.g. Socrata @computed_region_* columns).
        if (f.exampleValues.length === 0 && f.nullable) {
          skippedNullColumns.push(f.path);
          return false;
        }
        return true;
      })
      .filter((f) => {
        // Skip columns whose sanitized path starts with ':' or any non-[a-zA-Z_] character.
        // Example: Socrata ':@computed_region_*' keys sanitize to ':_computed_region_*', which
        // starts with ':' — an invalid XPath leading character that MarkLogic rejects, causing
        // the entire TDE view to return SQL-TABLENOTFOUND even though all other columns are valid.
        const sanitized = f.path.replace(/[ \t]/g, "_").replace(/[^a-zA-Z0-9_.:-]/g, "_");
        if (/^[^a-zA-Z_]/.test(sanitized)) {
          skippedInvalidColumns.push(f.path);
          return false;
        }
        return true;
      })
      .map((f) => {
        const scalarType = inferTdeScalarType(f);
        // MarkLogic's JSON-to-XML model maps property names to XML element names.
        // Spaces and characters invalid in XML names are converted to underscores.
        // TDE val paths must use the sanitized form, not the raw JSON key.
        const sanitizedPath = f.path.replace(/[ \t]/g, "_").replace(/[^a-zA-Z0-9_.:-]/g, "_");
        if (sanitizedPath !== f.path) sanitizedColumns.push(f.path);
        const col: TdeColumn = { name: sanitizedPath, scalarType, val: sanitizedPath };
        // Always mark nullable:true. When documents are imported with --ignore-null-fields
        // (e.g. GDELT, most open-data CSV imports), absent fields are simply omitted rather
        // than stored as null — so sampling never sees a null value and f.nullable stays false.
        // A column with nullable:false will silently produce no row for any document missing
        // that field, which can result in 0 rows for a sparse collection.
        col.nullable = true;
        return col;
      });

    const template = {
      template: {
        context: "/",
        collections: [options.collection],
        rows: [{
          schemaName: options.schemaName,
          viewName: options.viewName,
          columns,
        }],
      },
    };

    const uri = `/tde/${options.schemaName}/${options.viewName}.json`;
    return { uri, template, sanitizedColumns, skippedNullColumns, skippedInvalidColumns };
  }
}

// ── Type helpers ──────────────────────────────────────────────────────────────

function inferTdeScalarType(field: FieldDescriptor): string {
  switch (field.type) {
    case "number": {
      const examples = field.exampleValues.filter((v) => v !== null && v !== undefined);
      if (examples.length > 0 && examples.every((v) => Number.isInteger(v as number))) return "long";
      return "double";
    }
    case "boolean": return "int";
    case "date":    return "string"; // keep as string; TDE dateTime requires strict ISO format
    case "string": {
      // If every non-null example value looks like a decimal number (e.g. "0.84", "1.0"),
      // infer float rather than string. This catches Semaphore classifier score fields and
      // any other numeric-string columns where string type would silently break comparisons.
      const examples = field.exampleValues.filter((v) => v !== null && v !== undefined && v !== "");
      // Only infer float when the string contains a decimal point (e.g. "0.84", "3.14").
      // Integer-like strings ("20955", "42") are almost always IDs/codes — keep them as string
      // to avoid silent sort-order and join-correctness bugs (e.g. GDELT ADM2 geo codes).
      if (examples.length > 0 && examples.every((v) => /^-?[0-9]+\.[0-9]+$/.test(String(v)))) return "float";
      return "string";
    }
    default:        return "string";
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
      if (val === null) existing.nullable = true;
      if (existing.exampleValues.length < 3 && val !== null) existing.exampleValues.push(val);
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
    indexes.push({ type: "range-element", localname: idx.localname, namespace: idx["namespace-uri"], scalarType: idx["scalar-type"] ?? "string" });
  }
  for (const idx of rangePath) {
    indexes.push({ type: "range-path", pathExpression: idx["path-expression"], scalarType: idx["scalar-type"] ?? "string" });
  }
  for (const idx of rangeField) {
    indexes.push({ type: "range-field", localname: idx["field-name"], scalarType: idx["scalar-type"] ?? "string" });
  }

  // Geospatial indexes
  const geoPair = (props["geospatial-element-pair-index"] as Array<Record<string, string>> | undefined) ?? [];
  const geoElem = (props["geospatial-element-index"] as Array<Record<string, string>> | undefined) ?? [];
  const geoPath = (props["geospatial-path-index"] as Array<Record<string, string>> | undefined) ?? [];
  const geoAttrPair = (props["geospatial-element-attribute-pair-index"] as Array<Record<string, string>> | undefined) ?? [];
  const geoChild = (props["geospatial-element-child-index"] as Array<Record<string, string>> | undefined) ?? [];
  const geoJsonPropPair = (props["geospatial-json-property-pair-index"] as Array<Record<string, string>> | undefined) ?? [];

  for (const idx of geoPair) {
    indexes.push({
      type: "geospatial-element-pair",
      scalarType: "geospatial",
      parentLocalname: idx["parent-localname"],
      parentNamespace: idx["parent-namespace-uri"],
      latLocalname: idx["latitude-localname"],
      lonLocalname: idx["longitude-localname"],
      coordinateSystem: idx["coordinate-system"],
    });
  }
  for (const idx of geoElem) {
    indexes.push({
      type: "geospatial-element",
      scalarType: "geospatial",
      localname: idx.localname,
      namespace: idx["namespace-uri"],
      coordinateSystem: idx["coordinate-system"],
    });
  }
  for (const idx of geoPath) {
    indexes.push({
      type: "geospatial-path",
      scalarType: "geospatial",
      pathExpression: idx["path-expression"],
      coordinateSystem: idx["coordinate-system"],
    });
  }
  for (const idx of geoAttrPair) {
    indexes.push({
      type: "geospatial-element-attribute-pair",
      scalarType: "geospatial",
      parentLocalname: idx["parent-localname"],
      latLocalname: idx["latitude-attribute-localname"],
      lonLocalname: idx["longitude-attribute-localname"],
      coordinateSystem: idx["coordinate-system"],
    });
  }
  for (const idx of geoChild) {
    indexes.push({
      type: "geospatial-element-child",
      scalarType: "geospatial",
      parentLocalname: idx["parent-localname"],
      localname: idx.localname,
      coordinateSystem: idx["coordinate-system"],
    });
  }
  for (const idx of geoJsonPropPair) {
    indexes.push({
      type: "geospatial-json-property-pair",
      scalarType: "geospatial",
      parentProperty: idx["parent-property"],
      latProperty: idx["lat-property"],
      lonProperty: idx["lon-property"],
      coordinateSystem: idx["coordinate-system"],
    });
  }

  return indexes;
}
