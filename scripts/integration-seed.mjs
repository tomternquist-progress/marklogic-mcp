#!/usr/bin/env node
/**
 * Seeds the bare minimum test data needed for integration tests on a fresh
 * MarkLogic instance (e.g. the Docker container spun up by the CI workflow).
 *
 * Run manually:
 *   ML_HOST=localhost ML_USER=admin ML_PASSWORD=admin node scripts/integration-seed.mjs
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const axios = require("axios");

const HOST = process.env.ML_HOST ?? "localhost";
const PORT = process.env.ML_PORT ?? "8000";
const USER = process.env.ML_USER ?? "admin";
const PASS = process.env.ML_PASSWORD ?? "admin";
const BASE = `http://${HOST}:${PORT}`;

// Simple Digest auth using a two-step challenge-response
async function digestPut(uri, body, collection) {
  const url = `${BASE}/v1/documents?uri=${encodeURIComponent(uri)}&collection=${encodeURIComponent(collection)}`;
  const content = JSON.stringify(body);

  // Step 1: get the challenge
  let challenge;
  try {
    await axios.put(url, content, { headers: { "Content-Type": "application/json" } });
    console.log(`  ✓ ${uri} (no auth needed)`);
    return;
  } catch (err) {
    if (err.response?.status !== 401) throw new Error(`PUT ${uri}: ${err.message}`);
    challenge = err.response.headers["www-authenticate"];
  }

  // Parse Digest challenge
  const realm = challenge.match(/realm="([^"]+)"/)?.[1] ?? "";
  const nonce = challenge.match(/nonce="([^"]+)"/)?.[1] ?? "";
  const qop   = challenge.match(/qop="([^"]+)"/)?.[1] ?? "";
  const opaque = challenge.match(/opaque="([^"]+)"/)?.[1];

  const { createHash } = await import("crypto");
  const md5 = (s) => createHash("md5").update(s).digest("hex");

  const ha1 = md5(`${USER}:${realm}:${PASS}`);
  const ha2 = md5(`PUT:${new URL(url).pathname + new URL(url).search}`);
  const nc = "00000001";
  const cnonce = Math.random().toString(36).slice(2, 10);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  const authHeader = [
    `Digest username="${USER}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${new URL(url).pathname + new URL(url).search}"`,
    `qop=${qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
    `response="${response}"`,
    opaque ? `opaque="${opaque}"` : "",
  ].filter(Boolean).join(", ");

  // Step 2: authenticated request
  try {
    await axios.put(url, content, {
      headers: { "Content-Type": "application/json", Authorization: authHeader },
    });
    console.log(`  ✓ ${uri}`);
  } catch (err) {
    throw new Error(`PUT ${uri} failed ${err.response?.status}: ${JSON.stringify(err.response?.data)}`);
  }
}

async function main() {
  console.log(`Seeding test data on ${BASE} as ${USER}...`);

  await digestPut(
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

  await digestPut(
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
