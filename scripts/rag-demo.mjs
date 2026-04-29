#!/usr/bin/env node
/**
 * MarkLogic RAG Pipeline — end-to-end demo
 *
 * Demonstrates:
 *   1. EMBED  — generate embeddings for news article chunks (OpenAI or mock)
 *   2. INGEST — store docs with embedding arrays in MarkLogic
 *   3. QUERY  — embed the user question, retrieve top-k by cosine similarity
 *   4. ANSWER — pass retrieved chunks to Claude as context and stream the answer
 *
 * Usage:
 *   node scripts/rag-demo.mjs
 *   OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... node scripts/rag-demo.mjs
 *
 * Without API keys the script uses deterministic mock embeddings and prints the
 * assembled LLM prompt instead of calling Claude — useful for understanding the
 * pipeline mechanics without spending tokens.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ── Config ───────────────────────────────────────────────────────────────────

function loadDotEnv() {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env — rely on real env vars */ }
}
loadDotEnv();

const ML_HOST     = process.env.ML_HOST     ?? "localhost";
const ML_PORT     = parseInt(process.env.ML_PORT ?? "8000");
const ML_USER     = process.env.ML_USER     ?? "admin";
const ML_PASSWORD = process.env.ML_PASSWORD ?? "admin";
const COLLECTION  = "bbc-news";
const EMBEDDING_DIM = process.env.OPENAI_API_KEY ? 1536 : 4; // 1536 for text-embedding-3-small, 4 for mock

// ── Step 1: EMBED ─────────────────────────────────────────────────────────────
//
// In production: call OpenAI (or Cohere, local sentence-transformer, etc.)
// Here we support both real OpenAI and a deterministic mock for offline demos.

async function embed(text) {
  if (process.env.OPENAI_API_KEY) {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.data[0].embedding; // float[]
  }

  // Mock: deterministic 4-d vector derived from the text content
  // Sports-heavy text → high dim 0, politics → high dim 1, science → high dim 2
  const lower = text.toLowerCase();
  const sports  = (lower.match(/\b(sport|olympic|swim|gold|relay|race|athlete)\b/g) ?? []).length;
  const politics = (lower.match(/\b(tax|budget|chancellor|government|policy|minister)\b/g) ?? []).length;
  const science = (lower.match(/\b(drug|trial|brain|disease|research|scientist|clinical)\b/g) ?? []).length;
  const other   = Math.max(1, text.length / 200);
  const raw = [sports + 0.1, politics + 0.1, science + 0.1, other];
  const mag = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map(v => v / mag); // unit vector
}

// ── Step 2: INGEST ────────────────────────────────────────────────────────────
//
// PUT each document to MarkLogic with its embedding as a sibling field.
// Real pipelines use flux_import for bulk loads; ml_document_put for small batches.

async function putDocument(uri, doc, collections = [COLLECTION]) {
  const url = `http://${ML_HOST}:${ML_PORT}/v1/documents?uri=${encodeURIComponent(uri)}&${collections.map(c => `collection=${encodeURIComponent(c)}`).join("&")}`;
  const credentials = Buffer.from(`${ML_USER}:${ML_PASSWORD}`).toString("base64");
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Authorization": `Basic ${credentials}`, "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  if (!res.ok && res.status !== 204) throw new Error(`PUT ${uri} failed: ${res.status}`);
}

// ── Step 3: RETRIEVE ──────────────────────────────────────────────────────────
//
// Embed the user query, then run a server-side eval to:
//   - cts.search for bbc-news docs that have an embedding field
//   - compute vec.cosine(stored, query) for each
//   - return top-k sorted by score
//
// vec.cosine is a MarkLogic 12 global built-in (no require() needed).
// For large collections use cts.andQuery with field filters BEFORE scoring.

async function retrieveTopK(queryVector, k = 3, sectionFilter = null) {
  const script = `
    const queryVec = vec.vector(externalQueryVec);
    const filter = externalSection
      ? cts.andQuery([
          cts.collectionQuery('${COLLECTION}'),
          cts.jsonPropertyScopeQuery('embedding', cts.trueQuery()),
          cts.jsonPropertyValueQuery('section', externalSection)
        ])
      : cts.andQuery([
          cts.collectionQuery('${COLLECTION}'),
          cts.jsonPropertyScopeQuery('embedding', cts.trueQuery())
        ]);

    const docs = Array.from(fn.subsequence(cts.search(filter), 1, 200));
    const scored = docs.map(doc => {
      const d = doc.toObject();
      const score = vec.cosine(vec.vector(d.embedding), queryVec);
      return { score, title: d.title, section: d.section,
               chunkText: d.description, uri: xdmp.nodeUri(doc) };
    });

    scored.sort((a, b) => b.score - a.score).slice(0, ${k});
  `;

  const credentials = Buffer.from(`${ML_USER}:${ML_PASSWORD}`).toString("base64");
  const res = await fetch(`http://${ML_HOST}:${ML_PORT}/v1/eval`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "multipart/mixed",
    },
    body: new URLSearchParams({
      javascript: script,
      vars: JSON.stringify({ externalQueryVec: queryVector, externalSection: sectionFilter }),
    }),
  });

  if (!res.ok) throw new Error(`Eval failed: ${res.status} ${await res.text()}`);

  // Parse multipart/mixed response — each part is one result value
  const body = await res.text();
  const boundary = res.headers.get("content-type").match(/boundary=(.+)/)[1];
  const parts = body.split(`--${boundary}`).slice(1, -1);
  const rows = [];
  for (const part of parts) {
    const [, payload] = part.split("\r\n\r\n");
    if (payload?.trim()) {
      try { rows.push(...JSON.parse(payload.trim())); } catch { /* skip malformed */ }
    }
  }
  return rows;
}

// ── Step 4: ANSWER ────────────────────────────────────────────────────────────
//
// Assemble retrieved chunks into a context block and call Claude.
// Swap in any LLM — the retrieval step is model-agnostic.

async function answer(question, retrievedDocs) {
  const contextBlock = retrievedDocs
    .map((d, i) => `[${i + 1}] ${d.title} (${d.section}, score=${d.score.toFixed(4)})\n${d.chunkText}`)
    .join("\n\n");

  const prompt = `You are a news assistant. Answer the user's question using ONLY the retrieved passages below. Cite the passage number in your answer. If the passages don't contain enough information, say so.

Retrieved passages:
${contextBlock}

Question: ${question}`;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("\n── Assembled LLM prompt (set ANTHROPIC_API_KEY to get a real answer) ──\n");
    console.log(prompt);
    return;
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log("\n── Claude answer ──\n");
  console.log(data.content[0].text);
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

const ARTICLES = [
  {
    uri: "/bbc/sport/paris-olympics-swimming.json",
    doc: {
      id: "bbc-sport-001",
      title: "Paris Olympics: British swimmers claim gold in relay final",
      description: "Great Britain's relay team delivered a stunning performance in the 4x100m freestyle relay, breaking the European record and claiming gold at the Paris Olympics.",
      section: "Sport", source: "BBC News",
      link: "https://bbc.co.uk/sport/olympics/paris-2024/swimming",
      pubDate: "2024-07-30",
    },
  },
  {
    uri: "/bbc/politics/uk-budget-2024.json",
    doc: {
      id: "bbc-politics-001",
      title: "Chancellor announces £40bn tax rise in autumn budget",
      description: "The Chancellor has announced the largest tax increase in a generation, raising employer National Insurance and capital gains tax to plug a gap in public finances.",
      section: "Politics", source: "BBC News",
      link: "https://bbc.co.uk/news/politics/uk-budget-2024",
      pubDate: "2024-10-30",
    },
  },
  {
    uri: "/bbc/science/alzheimers-drug-trial.json",
    doc: {
      id: "bbc-science-001",
      title: "Alzheimer's drug lecanemab slows cognitive decline in landmark trial",
      description: "Scientists report that lecanemab, a drug that targets amyloid plaques in the brain, significantly slows cognitive decline in early-stage Alzheimer's patients in a phase-3 clinical trial.",
      section: "Science", source: "BBC News",
      link: "https://bbc.co.uk/news/health/alzheimers-lecanemab-trial",
      pubDate: "2024-09-12",
    },
  },
];

async function main() {
  console.log(`\n=== MarkLogic RAG Pipeline Demo ===`);
  console.log(`Embedding: ${process.env.OPENAI_API_KEY ? "OpenAI text-embedding-3-small (1536d)" : "mock (4d)"}`);
  console.log(`LLM:       ${process.env.ANTHROPIC_API_KEY ? "Claude Haiku" : "prompt-only (no ANTHROPIC_API_KEY)"}\n`);

  // ── STEP 1+2: Embed and ingest ─────────────────────────────────────────────
  console.log("── Step 1+2: Embedding and ingesting articles ──");
  for (const { uri, doc } of ARTICLES) {
    const textToEmbed = `${doc.title}. ${doc.description}`;
    const embedding = await embed(textToEmbed);
    const docWithEmbedding = {
      ...doc,
      embedding,                              // float[] stored as JSON array
      embeddingModel: process.env.OPENAI_API_KEY ? "text-embedding-3-small" : "mock-4d",
      embeddingDim: embedding.length,
    };
    await putDocument(uri, docWithEmbedding);
    console.log(`  ✓ ${doc.section}: "${doc.title.slice(0, 50)}..." [${embedding.length}d]`);
  }

  // ── STEP 3: Embed the query and retrieve ───────────────────────────────────
  const question = "What happened at the Paris Olympics swimming events?";
  console.log(`\n── Step 3: Retrieving for query ──\n  "${question}"`);

  const queryVec = await embed(question);
  const topDocs = await retrieveTopK(queryVec, 3);

  if (topDocs.length === 0) {
    console.log("  No results — check that ML_ALLOW_EVAL=true and documents have an 'embedding' field.");
    return;
  }

  console.log(`\n  Top-${topDocs.length} results:`);
  for (const d of topDocs) {
    console.log(`  [${d.score.toFixed(4)}] (${d.section}) ${d.title}`);
  }

  // ── STEP 4: Generate the answer ────────────────────────────────────────────
  console.log("\n── Step 4: Generating answer ──");
  await answer(question, topDocs);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
