#!/usr/bin/env node
/**
 * Seeds the bare minimum test data needed for integration tests on a fresh
 * MarkLogic instance (e.g. the Docker container spun up by the CI workflow).
 *
 * Run manually:
 *   ML_HOST=localhost ML_USER=admin ML_PASSWORD=admin node scripts/integration-seed.mjs
 */

const HOST = process.env.ML_HOST ?? "localhost";
const PORT = process.env.ML_PORT ?? "8000";
const USER = process.env.ML_USER ?? "admin";
const PASS = process.env.ML_PASSWORD ?? "admin";
const BASE = `http://${HOST}:${PORT}`;

async function put(uri, body, collection, contentType = "application/json") {
  const params = new URLSearchParams({ uri });
  if (collection) params.set("collection", collection);

  const url = `${BASE}/v1/documents?${params}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${uri} failed ${res.status}: ${text}`);
  }
  console.log(`  ✓ ${uri}`);
}

async function main() {
  console.log(`Seeding test data on ${BASE} as ${USER}...`);

  // A minimal document to test get/permissions
  await put(
    "/wikipedia/climate-change.json",
    {
      id: "wiki-001",
      title: "Climate change",
      source: "wikipedia",
      url: "https://en.wikipedia.org/wiki/Climate_change",
      importedAt: "2026-01-01T00:00:00Z",
      summary: "Climate change is a long-term shift in global temperatures and weather patterns.",
      classification: {
        classifiedAt: "2026-01-01T00:05:00Z",
        topCategory: { label: "climate change", score: 0.9, class: "IPTCMediaTopics" },
        categories: [{ class: "IPTCMediaTopics", label: "climate change", score: 0.9 }],
      },
    },
    "wikipedia-articles"
  );

  await put(
    "/wikipedia/artificial-intelligence.json",
    {
      id: "wiki-002",
      title: "Artificial intelligence",
      source: "wikipedia",
      url: "https://en.wikipedia.org/wiki/Artificial_intelligence",
      importedAt: "2026-01-01T00:00:00Z",
      summary: "Artificial intelligence is the simulation of human intelligence by machines.",
      classification: {
        classifiedAt: "2026-01-01T00:05:00Z",
        topCategory: { label: "technology", score: 0.8, class: "IPTCMediaTopics" },
        categories: [{ class: "IPTCMediaTopics", label: "technology", score: 0.8 }],
      },
    },
    "wikipedia-articles"
  );

  console.log("Seed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
