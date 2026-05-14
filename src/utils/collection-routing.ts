// Collection-routing heuristic for ml_answer_query. When the caller doesn't
// specify a collection, we score candidate collections by:
//   1. Name overlap with question/parsed-filter tokens (cheap, no I/O).
//   2. Field overlap with the parsed filter fields (one schema-discovery per
//      top-scoring candidate).
// Returns top candidates ranked by combined score, with explicit confidence.

import type { MarkLogicClients } from "../client/index.js";

export interface CandidateCollection {
  name: string;
  documentCount: number;
  nameScore: number;
  fieldScore: number;
  totalScore: number;
  observedFields: string[];
}

export interface RoutingResult {
  picked: CandidateCollection | undefined;
  candidates: CandidateCollection[];
  /** "high": top score is large and dominates #2. "medium": top is best but
      others are close. "low": no signal found. */
  confidence: "high" | "medium" | "low";
  reason: string;
}

interface RouteOptions {
  question: string;
  parsedFields: string[];
  database?: string;
  /** Cap candidate collections to enumerate. Top-N by document count. */
  candidatePoolSize?: number;
  /** Of those, how many to sample for field-overlap scoring. */
  sampleTop?: number;
}

/**
 * Build a token bag from a string: lowercased words ≥3 chars, with both
 * the original and singularized form, so "disasters" and "disaster" both
 * match a collection called "fema-disasters".
 */
function tokens(text: string): string[] {
  const lower = text.toLowerCase();
  const raw = lower
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  const out = new Set<string>();
  for (const w of raw) {
    out.add(w);
    if (w.length > 3 && w.endsWith("s")) out.add(w.slice(0, -1));
  }
  return Array.from(out);
}

function scoreNameOverlap(collectionName: string, questionTokens: string[]): number {
  const colTokens = tokens(collectionName);
  if (!colTokens.length || !questionTokens.length) return 0;
  let hits = 0;
  for (const t of questionTokens) {
    if (colTokens.includes(t)) hits++;
  }
  return hits;
}

export async function routeToCollection(
  clients: MarkLogicClients,
  options: RouteOptions
): Promise<RoutingResult> {
  const poolSize = options.candidatePoolSize ?? 30;
  const sampleTop = options.sampleTop ?? 5;

  let candidates: Array<{ name: string; count: number }>;
  try {
    candidates = await clients.schema.listCollections(options.database, poolSize);
  } catch {
    return {
      picked: undefined,
      candidates: [],
      confidence: "low",
      reason: "Could not enumerate collections — pass `collection` explicitly.",
    };
  }
  if (!candidates.length) {
    return {
      picked: undefined,
      candidates: [],
      confidence: "low",
      reason: "No collections found at this scope.",
    };
  }

  const qTokens = tokens(options.question);

  // Pass 1: cheap name-overlap scoring across all candidates.
  const ranked = candidates
    .map((c) => ({
      name: c.name,
      documentCount: c.count,
      nameScore: scoreNameOverlap(c.name, qTokens),
      fieldScore: 0,
      totalScore: 0,
      observedFields: [] as string[],
    }))
    .sort((a, b) => b.nameScore - a.nameScore || b.documentCount - a.documentCount);

  // Pass 2: for the top candidates, sample fields and score by overlap with
  // the parsed filter fields. This is the expensive step — keep it bounded.
  const seedPool = ranked.slice(0, sampleTop);
  for (const cand of seedPool) {
    try {
      const schema = await clients.schema.discoverSchema({
        collection: cand.name,
        sampleSize: 5,
        database: options.database,
      });
      cand.observedFields = (schema.inferredFields ?? [])
        .filter((f) => !f.path.includes("/"))
        .map((f) => f.path);
      let overlap = 0;
      for (const pf of options.parsedFields) {
        if (cand.observedFields.includes(pf)) overlap++;
      }
      cand.fieldScore = overlap;
    } catch {
      // skip — keep nameScore signal
    }
  }

  // Combine scores: field overlap is the strong signal (×3), name overlap is
  // the weak tiebreaker (×1).
  for (const c of ranked) {
    c.totalScore = c.fieldScore * 3 + c.nameScore;
  }
  ranked.sort((a, b) => b.totalScore - a.totalScore || b.documentCount - a.documentCount);

  const best = ranked[0];
  const second = ranked[1];

  let confidence: "high" | "medium" | "low";
  let reason: string;
  if (!best || best.totalScore === 0) {
    confidence = "low";
    reason = "No collection scored above zero for name- or field-overlap. " +
      "Pass `collection` explicitly or invoke ml_collections_list to browse.";
  } else if (!second || best.totalScore >= second.totalScore * 2) {
    confidence = "high";
    reason = `"${best.name}" dominates other candidates by ≥2× score.`;
  } else {
    confidence = "medium";
    reason = `Top candidate "${best.name}" only narrowly beats other options; consider passing the collection explicitly.`;
  }

  return {
    picked: confidence === "low" ? undefined : best,
    candidates: ranked.slice(0, Math.min(5, ranked.length)),
    confidence,
    reason,
  };
}
