#!/usr/bin/env node
/**
 * Seeds the bare minimum test data needed for integration tests on a fresh
 * MarkLogic instance (e.g. the Docker container spun up by the CI workflow).
 *
 * Also pre-configures the range and geospatial indexes that the timeseries
 * and geospatial integration tests require. Doing this here (before tests run)
 * gives MarkLogic time to apply the configuration before any test worker
 * touches the database, eliminating the async-propagation race condition.
 *
 * Run manually:
 *   ML_HOST=localhost ML_USER=admin ML_PASSWORD=admin node scripts/integration-seed.mjs
 */

import { createRequire } from "module";
import { createHash } from "crypto";

const require = createRequire(import.meta.url);
const axios = require("axios");

const HOST = process.env.ML_HOST ?? "localhost";
const PORT = process.env.ML_PORT ?? "8000";
const MGMT_PORT = process.env.ML_MGMT_PORT ?? "8002";
const USER = process.env.ML_USER ?? "admin";
const PASS = process.env.ML_PASSWORD ?? "admin";
const BASE = `http://${HOST}:${PORT}`;
const MGMT = `http://${HOST}:${MGMT_PORT}`;

const md5 = (s) => createHash("md5").update(s).digest("hex");

/**
 * Retry a transient-failure-prone operation with exponential backoff.
 *
 * A fresh MarkLogic container reports healthy on /admin/v1/timestamp and
 * /v1/search BEFORE it has finished applying admin-config-reload restarts —
 * those produce a brief 503 "Service Unavailable -- Restarting to reload
 * server config" window in which any write hits a hard error. Likewise, the
 * Management API port can briefly drop the TCP connection (ECONNRESET) while
 * the security forest re-attaches.
 *
 * We retry up to 8 times with delays of 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s
 * (~2 minutes of total tolerance) for these transient signals only. Other
 * errors (400, 401, 403, 404, 5xx that are not 503) fail fast.
 */
async function withRetry(operation, label) {
  const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const body = err.response?.data ? JSON.stringify(err.response.data) : "";
      const transient =
        status === 503 ||
        status === 502 ||
        status === 504 ||
        err.code === "ECONNRESET" ||
        err.code === "ECONNREFUSED" ||
        err.code === "ETIMEDOUT" ||
        body.includes("Restarting") ||
        body.includes("not available") ||
        body.includes("Service Unavailable");
      if (!transient || attempt === delays.length) throw err;
      const delay = delays[attempt];
      console.log(`  ↻ ${label}: transient ${status ?? err.code} — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${delays.length})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Build a Digest Authorization header from a WWW-Authenticate challenge. */
function buildDigestAuth(method, urlStr, wwwAuthenticate) {
  const realm  = wwwAuthenticate.match(/realm="([^"]+)"/)?.[1] ?? "";
  const nonce  = wwwAuthenticate.match(/nonce="([^"]+)"/)?.[1] ?? "";
  const qop    = wwwAuthenticate.match(/qop="([^"]+)"/)?.[1] ?? "";
  const opaque = wwwAuthenticate.match(/opaque="([^"]+)"/)?.[1];

  const u = new URL(urlStr);
  const uri = u.pathname + u.search;
  const ha1 = md5(`${USER}:${realm}:${PASS}`);
  const ha2 = md5(`${method}:${uri}`);
  const nc = "00000001";
  const cnonce = Math.random().toString(36).slice(2, 10);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  return [
    `Digest username="${USER}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `qop=${qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
    `response="${response}"`,
    opaque ? `opaque="${opaque}"` : "",
  ].filter(Boolean).join(", ");
}

/** Perform a Digest-authenticated PUT to the REST API (port 8000). */
async function digestPut(uri, body, collection) {
  const url = `${BASE}/v1/documents?uri=${encodeURIComponent(uri)}&collection=${encodeURIComponent(collection)}`;
  const content = JSON.stringify(body);

  await withRetry(async () => {
    let challenge;
    try {
      await axios.put(url, content, { headers: { "Content-Type": "application/json" } });
      console.log(`  ✓ ${uri} (no auth needed)`);
      return;
    } catch (err) {
      // 401 is the expected initial response — challenge follows. Any other
      // non-success bubbles to withRetry, which retries on transient signals.
      if (err.response?.status !== 401) throw err;
      challenge = err.response.headers["www-authenticate"];
    }
    const authHeader = buildDigestAuth("PUT", url, challenge);
    await axios.put(url, content, {
      headers: { "Content-Type": "application/json", Authorization: authHeader },
    });
    console.log(`  ✓ ${uri}`);
  }, `PUT ${uri}`);
}

/** GET database properties from the Management API. */
async function mgmtGet(path) {
  const url = `${MGMT}${path}?format=json`;
  return withRetry(async () => {
    let challenge;
    try {
      const res = await axios.get(url, { headers: { Accept: "application/json" } });
      return res.data;
    } catch (err) {
      if (err.response?.status !== 401) throw err;
      challenge = err.response.headers["www-authenticate"];
    }
    const auth = buildDigestAuth("GET", url, challenge);
    const res = await axios.get(url, { headers: { Accept: "application/json", Authorization: auth } });
    return res.data;
  }, `GET ${path}`);
}

/** PUT to the Management API with Digest auth. */
async function mgmtPut(path, body) {
  const url = `${MGMT}${path}?format=json`;
  const content = JSON.stringify(body);
  await withRetry(async () => {
    let challenge;
    try {
      await axios.put(url, content, { headers: { "Content-Type": "application/json" } });
      return;
    } catch (err) {
      if (err.response?.status !== 401) throw err;
      challenge = err.response.headers["www-authenticate"];
    }
    const auth = buildDigestAuth("PUT", url, challenge);
    await axios.put(url, content, {
      headers: { "Content-Type": "application/json", Authorization: auth },
    });
  }, `PUT ${path}`);
}

/** Wait until fn() returns true, polling every intervalMs up to maxMs. */
async function pollUntil(fn, maxMs = 30_000, intervalMs = 1_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      if (await fn()) return;
    } catch { /* DB may be briefly restarting */ }
  }
  throw new Error("pollUntil timed out");
}

async function configureIndexes() {
  const DB_PATH = "/manage/v2/databases/Documents/properties";

  const props = await mgmtGet(DB_PATH);
  const rangeIdxs = props["range-element-index"] ?? [];
  const geoIdxs = props["geospatial-element-pair-index"] ?? [];

  const hasImportedAt = Array.isArray(rangeIdxs) &&
    rangeIdxs.some((i) => i.localname === "importedAt" && i["scalar-type"] === "dateTime");
  const hasGeoLocation = Array.isArray(geoIdxs) &&
    geoIdxs.some((i) => i["parent-localname"] === "location" && i["latitude-localname"] === "lat");

  if (hasImportedAt && hasGeoLocation) {
    console.log("  ✓ Indexes already configured");
    return;
  }

  if (!hasImportedAt) {
    const existing = Array.isArray(rangeIdxs) ? rangeIdxs : [];
    await mgmtPut(DB_PATH, {
      "range-element-index": [
        ...existing,
        {
          "scalar-type": "dateTime",
          "namespace-uri": "",
          "localname": "importedAt",
          "collation": "",
          "range-value-positions": false,
          "invalid-values": "ignore",
        },
      ],
    });
    console.log("  ✓ Added range-element-index for importedAt");
  }

  if (!hasGeoLocation) {
    const existing = Array.isArray(geoIdxs) ? geoIdxs : [];
    await mgmtPut(DB_PATH, {
      "geospatial-element-pair-index": [
        ...existing,
        {
          "parent-namespace-uri": "",
          "parent-localname": "location",
          "latitude-namespace-uri": "",
          "latitude-localname": "lat",
          "longitude-namespace-uri": "",
          "longitude-localname": "lon",
          "coordinate-system": "wgs84",
          "range-value-positions": false,
          "invalid-values": "ignore",
        },
      ],
    });
    console.log("  ✓ Added geospatial-element-pair-index for location");
  }

  // Wait until both indexes appear in a fresh GET (ML applies config asynchronously)
  console.log("  Waiting for index configuration to take effect...");
  await pollUntil(async () => {
    const updated = await mgmtGet(DB_PATH);
    const ri = updated["range-element-index"] ?? [];
    const gi = updated["geospatial-element-pair-index"] ?? [];
    const okRange = !hasImportedAt
      ? Array.isArray(ri) && ri.some((i) => i.localname === "importedAt")
      : true;
    const okGeo = !hasGeoLocation
      ? Array.isArray(gi) && gi.some((i) => i["parent-localname"] === "location")
      : true;
    return okRange && okGeo;
  });
  console.log("  ✓ Indexes confirmed active");
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

  console.log("Configuring indexes...");
  await configureIndexes();

  console.log("Seed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
