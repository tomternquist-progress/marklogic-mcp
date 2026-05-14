// Value normalization helpers for NL → CTS translation. The point: when a
// user asks about "hurricanes" but the indexed values are {"Hurricane",
// "Tornado", "Flood"}, a strict value-query returns zero. Normalize the
// phrase (case, plural) and, when we have observed values to compare
// against, pick the closest known value before executing.

/** Drop a trailing 's' or 'es' to approximate singular form. Crude, on purpose. */
export function singularize(s: string): string {
  if (s.length > 3 && /(ches|shes|sses|xes)$/i.test(s)) return s.slice(0, -2);
  if (s.length > 2 && /[^aeiou]ies$/i.test(s)) return s.slice(0, -3) + "y";
  if (s.length > 2 && /[^s]s$/i.test(s)) return s.slice(0, -1);
  return s;
}

/** Title Case each whitespace-separated word. */
export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Produce the most useful candidates to try for a value-query given a raw
 * NL phrase. Output is deduplicated, ordered most-likely-to-match first.
 *
 *   "hurricanes"  → ["Hurricane", "hurricane", "Hurricanes", "hurricanes"]
 *   "fire damage" → ["Fire Damage", "fire damage"]
 */
export function valueCandidates(phrase: string): string[] {
  const trimmed = phrase.trim();
  if (!trimmed) return [];
  const singular = singularize(trimmed);
  const out = [
    titleCase(singular),
    singular,
    titleCase(trimmed),
    trimmed,
    singular.toLowerCase(),
    trimmed.toLowerCase(),
  ];
  return Array.from(new Set(out.filter(Boolean)));
}

/**
 * Pick the closest known value to a candidate from a set of observed
 * (sampled) values. Strategy:
 *  1. Exact case-insensitive match wins.
 *  2. Singularized case-insensitive match.
 *  3. Substring containment (either direction, lowercased).
 *  4. Levenshtein-1 (single character edit) — catches typos like "hurricaen".
 *
 * Returns the original known value (preserving its case) if any rule
 * matches, otherwise undefined.
 */
export function closestKnownValue(
  candidate: string,
  knownValues: string[]
): { value: string; via: "exact" | "singular" | "substring" | "edit" } | undefined {
  const target = candidate.toLowerCase();
  const singular = singularize(target);

  for (const v of knownValues) {
    if (v.toLowerCase() === target) return { value: v, via: "exact" };
  }
  for (const v of knownValues) {
    if (v.toLowerCase() === singular) return { value: v, via: "singular" };
  }
  for (const v of knownValues) {
    const vl = v.toLowerCase();
    if (vl.includes(target) || target.includes(vl)) return { value: v, via: "substring" };
    if (vl.includes(singular) || singular.includes(vl)) return { value: v, via: "substring" };
  }
  for (const v of knownValues) {
    if (editDistanceAtMost1(v.toLowerCase(), target)) return { value: v, via: "edit" };
    if (editDistanceAtMost1(v.toLowerCase(), singular)) return { value: v, via: "edit" };
  }
  return undefined;
}

/**
 * True iff `a` and `b` are within one single-character edit
 * (substitution, insertion, deletion) OR a single adjacent transposition.
 * Damerau-style; common typos like "hurricaen" ↔ "hurricane" qualify.
 */
function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  // Same length → at most one substitution OR one adjacent transposition.
  if (la === lb) {
    let diffs: number[] = [];
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diffs.push(i);
        if (diffs.length > 2) return false;
      }
    }
    if (diffs.length === 0) return true;
    if (diffs.length === 1) return true; // single substitution
    if (diffs.length === 2) {
      // adjacent transposition: a[i] = b[i+1] and a[i+1] = b[i]
      const [i, j] = diffs;
      return j === i + 1 && a[i] === b[j] && a[j] === b[i];
    }
    return false;
  }
  // One char insertion or deletion.
  const [shorter, longer] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let used = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] !== longer[j]) {
      if (used) return false;
      used = true;
      j++;
    } else {
      i++;
      j++;
    }
  }
  return true;
}

/**
 * Strip common NL filler so a residual chunk like "which disasters" doesn't
 * accidentally over-constrain the query when it gets passed as a free-text
 * q. Returns the cleaned residual (may be empty).
 */
const FILLER_TOKENS = new Set([
  "which",
  "what",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "the",
  "a",
  "an",
  "of",
  "do",
  "does",
  "did",
  "show",
  "list",
  "find",
  "give",
  "tell",
  "me",
  "us",
  "all",
  "any",
  "some",
  "please",
  "can",
  "could",
  "would",
  "should",
  "have",
  "has",
  "had",
]);

export function stripFiller(text: string): string {
  return text
    .replace(/[?!.,;:]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER_TOKENS.has(w.toLowerCase()))
    .join(" ")
    .trim();
}
