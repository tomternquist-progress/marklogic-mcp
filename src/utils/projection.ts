// Field projection, aggregation, and NL parsing helpers used by ml_search,
// ml_answer_query, and the recipe library. Kept dependency-free so tool files
// stay focused on MCP wiring.

/**
 * Walk a dotted/bracketed field path through a JSON object and return the
 * first non-null match. Supports:
 *   "title"                 → obj.title
 *   "envelope.instance.id"  → obj.envelope.instance.id
 *   "tags[]"                → first element of obj.tags (array)
 *   "*.declarationTitle"    → first declarationTitle found at any nested depth
 *
 * Designed to be forgiving: returns undefined if any step is missing rather
 * than throwing. Strings are normalized (text-node coercion) by the caller.
 */
export function projectField(doc: unknown, path: string): unknown {
  if (doc == null || !path) return undefined;
  const segments = path.split(".");
  return walk(doc, segments, 0);
}

function walk(node: unknown, segments: string[], idx: number): unknown {
  if (idx >= segments.length) return node;
  if (node == null) return undefined;

  const seg = segments[idx];

  // Wildcard step: search recursively for the next segment name.
  if (seg === "*") {
    const remainder = segments.slice(idx + 1);
    if (!remainder.length) return node;
    return findRecursive(node, remainder);
  }

  // Strip optional [] suffix that signals "take first array element".
  const arrayHint = seg.endsWith("[]");
  const key = arrayHint ? seg.slice(0, -2) : seg;

  if (Array.isArray(node)) {
    // For arrays we descend into each element and keep the first non-empty result.
    for (const el of node) {
      const got = walk(el, segments, idx);
      if (got !== undefined) return got;
    }
    return undefined;
  }

  if (typeof node !== "object") return undefined;

  const obj = node as Record<string, unknown>;
  const next = obj[key];
  if (next === undefined) return undefined;

  if (arrayHint && Array.isArray(next)) {
    return next.length ? walk(next[0], segments, idx + 1) : undefined;
  }
  return walk(next, segments, idx + 1);
}

function findRecursive(node: unknown, remainder: string[]): unknown {
  if (node == null) return undefined;
  if (Array.isArray(node)) {
    for (const el of node) {
      const got = findRecursive(el, remainder);
      if (got !== undefined) return got;
    }
    return undefined;
  }
  if (typeof node !== "object") return undefined;
  const obj = node as Record<string, unknown>;
  // Try direct match at this level first.
  const direct = walk(obj, remainder, 0);
  if (direct !== undefined) return direct;
  // Otherwise descend into each value.
  for (const v of Object.values(obj)) {
    const got = findRecursive(v, remainder);
    if (got !== undefined) return got;
  }
  return undefined;
}

/**
 * Coerce a value that may be a MarkLogic text node, primitive, or array into a
 * clean string suitable for tabular display. Optionally collapse runs of
 * whitespace so values lifted from XML mixed content render cleanly.
 */
export function coerceCell(value: unknown, normalizeWhitespace = false): unknown {
  if (value == null) return null;
  if (typeof value === "string") {
    return normalizeWhitespace ? value.replace(/\s+/g, " ").trim() : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    // Flatten one level — primitives become a comma list; objects pass through.
    if (value.every((v) => v == null || typeof v !== "object")) {
      return value
        .map((v) => coerceCell(v, normalizeWhitespace))
        .filter((v) => v != null && v !== "")
        .join(", ");
    }
    return value;
  }
  // Fall back to string coercion for unknown shapes (covers text nodes).
  const s = String(value);
  return normalizeWhitespace ? s.replace(/\s+/g, " ").trim() : s;
}

export interface ProjectedRow {
  uri: string;
  score?: number;
  [field: string]: unknown;
}

/**
 * Project a set of fields out of a document into a flat row. Field paths are
 * applied in order; missing fields become `null`. The URI is always included
 * so callers can drill into the source document if needed.
 */
export function projectRow(
  uri: string,
  doc: unknown,
  fields: string[],
  options: { normalizeWhitespace?: boolean; score?: number; aliases?: Record<string, string> } = {}
): ProjectedRow {
  const row: ProjectedRow = { uri };
  if (options.score !== undefined) row.score = options.score;
  for (const field of fields) {
    const path = options.aliases?.[field] ?? field;
    const value = projectField(doc, path);
    row[field] = coerceCell(value, options.normalizeWhitespace);
  }
  return row;
}

// ─── Aggregation primitives ──────────────────────────────────────────────────

export type AggregateMode = "distinct" | "group_by";

/**
 * Group rows by a single field and return value/count pairs sorted by count
 * descending. Null/empty values are dropped so output stays useful.
 */
export function aggregateByField(
  rows: ProjectedRow[],
  field: string,
  options: { normalizeWhitespace?: boolean; limit?: number } = {}
): Array<{ value: unknown; count: number }> {
  const counts = new Map<string, { value: unknown; count: number }>();
  for (const row of rows) {
    const raw = row[field];
    if (raw == null || raw === "") continue;
    const normalized = coerceCell(raw, options.normalizeWhitespace);
    if (normalized == null || normalized === "") continue;
    const key = typeof normalized === "object" ? JSON.stringify(normalized) : String(normalized);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { value: normalized, count: 1 });
  }
  const sorted = Array.from(counts.values()).sort((a, b) => b.count - a.count);
  return options.limit ? sorted.slice(0, options.limit) : sorted;
}

// ─── Alias dictionary (schema-aware NL parsing) ──────────────────────────────

/**
 * Per-collection alias dictionary. Maps natural-language phrases (lowercased,
 * whitespace-normalized) to the field path agents should actually query. Used
 * by ml_answer_query when constructing a CTS query from a user question.
 *
 * Built from observed dataset shapes. Add new entries here when a new dataset
 * is being supported; existing entries are intentionally generic enough to
 * cover most disaster/event/incident-style collections.
 */
export const FIELD_ALIASES: Record<string, Record<string, string[]>> = {
  // FEMA disaster declarations and similar event/incident datasets.
  "*": {
    declarationTitle: ["title", "disaster", "disaster name", "event", "event name", "incident name"],
    incidentType: [
      "type",
      "incident type",
      "event type",
      "disaster type",
      "category",
      "kind",
      "involved",
      "involving",
      "related to",
      "about",
    ],
    state: ["state", "us state", "where", "location", "region"],
    designatedArea: ["county", "area", "designated area", "place"],
    declarationDate: ["date", "declared", "declaration date", "when"],
    incidentBeginDate: ["start", "began", "started", "from", "incident begin"],
    incidentEndDate: ["end", "ended", "until", "through", "incident end"],
    fipsStateCode: ["fips", "state code", "fips code"],
    declarationType: ["declaration type", "designation"],
  },
};

export interface ParsedAliasResult {
  /** Field path → search phrase that should match values of that field. */
  fieldFilters: Array<{ field: string; phrase: string; matchedAlias: string }>;
  /** Words from the question that were not consumed by any alias match. */
  residual: string;
}

/**
 * Lightweight NL parser: look at the question text for phrases registered in
 * the alias dictionary and turn them into field-scoped filters. Anything not
 * consumed by an alias becomes the residual free-text query.
 *
 * Example:
 *   "which disasters involved hurricanes"
 *   → fieldFilters: [{ field: "incidentType", phrase: "hurricanes", matchedAlias: "involved" }]
 *   → residual: "disasters"
 *
 * Heuristic — does not aim to fully parse English. The goal is "natural
 * phrasing doesn't fail just because wording differs from indexed terms."
 */
export function parseQuestionWithAliases(
  question: string,
  collection?: string
): ParsedAliasResult {
  const aliasSet = collectAliases(collection);
  const lower = question.toLowerCase();

  const filters: Array<{ field: string; phrase: string; matchedAlias: string }> = [];
  const consumed: Array<[number, number]> = [];

  // Sort alias terms by length descending so multi-word phrases match before
  // single-word substrings of those phrases.
  const aliasEntries = aliasSet.flatMap(([field, aliases]) =>
    aliases.map((a) => ({ field, alias: a }))
  );
  aliasEntries.sort((a, b) => b.alias.length - a.alias.length);

  for (const { field, alias } of aliasEntries) {
    const aliasLower = alias.toLowerCase();
    // Look for the alias as a whole-word phrase; capture the noun that follows
    // it. "involved hurricanes" → field=incidentType, phrase="hurricanes".
    const pattern = new RegExp(
      String.raw`\b${escapeRegex(aliasLower)}\b\s+([a-z][a-z0-9\- ]{1,40}?)(?=\s+(?:in|on|at|by|with|and|or|of|for|from|to|during)\b|[?.!,]|$)`,
      "i"
    );
    const m = pattern.exec(lower);
    if (!m) continue;
    if (m.index === undefined) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (overlaps(consumed, start, end)) continue;
    const phrase = m[1].trim();
    if (!phrase) continue;
    filters.push({ field, phrase, matchedAlias: alias });
    consumed.push([start, end]);
  }

  // Build residual by removing the consumed spans.
  let residual = "";
  let cursor = 0;
  consumed.sort((a, b) => a[0] - b[0]);
  for (const [s, e] of consumed) {
    residual += question.slice(cursor, s);
    cursor = e;
  }
  residual += question.slice(cursor);
  residual = residual.replace(/\s+/g, " ").trim();

  return { fieldFilters: filters, residual };
}

function collectAliases(collection?: string): Array<[string, string[]]> {
  // Merge global aliases with collection-specific ones if the collection has
  // its own entry. Collection-specific entries win on key conflict.
  const out = new Map<string, string[]>();
  const globalEntry = FIELD_ALIASES["*"] ?? {};
  for (const [field, aliases] of Object.entries(globalEntry)) {
    out.set(field, [...aliases]);
  }
  if (collection && FIELD_ALIASES[collection]) {
    for (const [field, aliases] of Object.entries(FIELD_ALIASES[collection])) {
      const existing = out.get(field) ?? [];
      out.set(field, Array.from(new Set([...aliases, ...existing])));
    }
  }
  return Array.from(out.entries());
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function overlaps(spans: Array<[number, number]>, start: number, end: number): boolean {
  return spans.some(([s, e]) => start < e && end > s);
}
