// Structured error envelope for MCP tools. Returns a machine-readable code +
// classification + actionable hint + a corrected example payload — so clients
// don't need to grep prose for "what to change". Use makeToolError() from any
// tool handler; the result is the same shape the MCP SDK expects.

export type ToolErrorCode =
  | "INVALID_PARAMETER"
  | "MISSING_PARAMETER"
  | "UNKNOWN_NAME"
  | "UNSUPPORTED_IN_BUILD"
  | "NOT_FOUND"
  | "UPSTREAM_FAILURE"
  | "INTERNAL";

/**
 * High-level classification used by clients to decide whether the user needs
 * to fix their input, whether the call should fall back to a different code
 * path, or whether it's a transient upstream issue.
 */
export type ToolErrorClass = "user_input" | "runtime_capability" | "upstream" | "internal";

export interface ToolErrorBody {
  /** Machine-readable code. Stable across releases. */
  code: ToolErrorCode;
  /** Coarse classification — see ToolErrorClass docs. */
  class: ToolErrorClass;
  /** What failed, in one sentence. */
  message: string;
  /** What the caller should change. Always actionable. */
  hint: string;
  /** A minimal valid example payload for this tool. */
  exampleValid?: Record<string, unknown>;
  /** Free-form supplementary info: closest valid names, supported keys, etc. */
  details?: Record<string, unknown>;
  /** Correlation ID for cross-referencing with server logs / traces. */
  correlationId?: string;
}

export interface ToolErrorResult {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  // The MCP SDK's tool-handler return type carries an index signature for
  // forwards-compatible custom fields; mirror it so this shape is assignable
  // without a cast.
  [key: string]: unknown;
}

export function makeToolError(body: ToolErrorBody): ToolErrorResult {
  // The MCP SDK expects content as a plain text array. We emit a JSON-encoded
  // payload so clients that want structured handling can parse it; the JSON
  // also reads acceptably in raw chat output.
  return {
    content: [{ type: "text", text: JSON.stringify({ error: body }, null, 2) }],
    isError: true,
  };
}

/**
 * Damerau-style edit distance between two strings (substitution, insertion,
 * deletion, adjacent transposition). Used by closestMatch() for "did you
 * mean…" suggestions.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  const prev = new Array<number>(lb + 1);
  const curr = new Array<number>(lb + 1);
  const prevPrev = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
      // Transposition
      if (
        i > 1 && j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        curr[j] = Math.min(curr[j], prevPrev[j - 2] + 1);
      }
    }
    for (let j = 0; j <= lb; j++) prevPrev[j] = prev[j];
    for (let j = 0; j <= lb; j++) prev[j] = curr[j];
  }
  return prev[lb];
}

/**
 * Find the closest match to `target` in `candidates` by edit distance.
 * Returns undefined when no candidate is within `maxDistance` (default: 1/3
 * of the target's length, rounded up — i.e. tolerates short typos but not
 * arbitrary string differences).
 */
export function closestMatch(
  target: string,
  candidates: string[],
  maxDistance?: number
): string | undefined {
  if (!candidates.length) return undefined;
  const max = maxDistance ?? Math.max(2, Math.ceil(target.length / 3));
  let best: { value: string; distance: number } | undefined;
  for (const c of candidates) {
    const d = editDistance(target.toLowerCase(), c.toLowerCase());
    if (d > max) continue;
    if (!best || d < best.distance) best = { value: c, distance: d };
  }
  return best?.value;
}

/** Generate a short correlation ID — not cryptographically random but
 *  collision-resistant enough for short-lived MCP request tracing. */
export function newCorrelationId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `mlq_${ts}_${rnd}`;
}
