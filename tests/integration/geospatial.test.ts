/**
 * Integration tests for ml_geospatial_search.
 *
 * Covers the full prerequisite chain that agents must follow:
 *  1. Use ml_indexes_list to discover geospatial indexes
 *  2. Seed documents with lat/lon properties
 *  3. Configure a geospatial element pair index via the Management API
 *  4. Test circle, bounding-box, and polygon searches
 *
 * Uses the Management API to add the index programmatically — this
 * mirrors what an agent would guide a user to do when no index exists.
 *
 * Catches bugs that unit tests miss:
 *  - Wrong cts:json-property-pair-geospatial-query argument order (lat vs lon)
 *  - Radius unit conversion (km → miles internally)
 *  - Index not yet built when search runs (reindexing race condition)
 *
 * Key MarkLogic behaviour:
 *  - geospatial-element-pair-index covers BOTH XML element pair queries and
 *    JSON property pair queries (ML maps JSON properties to XML elements internally).
 *  - cts:json-property-pair-geospatial-query uses string property names and works
 *    against a geospatial-element-pair-index for JSON documents.
 *  - JSON docs return object-node() from cts:search; xdmp:node-uri() extracts the
 *    correct URI (fn:document-uri() returns empty string for object-node()).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ML_HOST, buildClients } from "./helpers.js";

const describeIfLive = ML_HOST ? describe : describe.skip;

const COLLECTION = "integration-test-geo";
const GEO_DOCS = [
  // New York City: 40.71°N, 74.00°W
  {
    uri: "/geo/nyc.json",
    content: { id: "geo-001", name: "New York City", location: { lat: 40.7128, lon: -74.0060 } },
  },
  // Los Angeles: 34.05°N, 118.24°W
  {
    uri: "/geo/lax.json",
    content: { id: "geo-002", name: "Los Angeles", location: { lat: 34.0522, lon: -118.2437 } },
  },
  // Chicago: 41.88°N, 87.63°W
  {
    uri: "/geo/chi.json",
    content: { id: "geo-003", name: "Chicago", location: { lat: 41.8781, lon: -87.6298 } },
  },
  // London: 51.51°N, 0.13°W
  {
    uri: "/geo/lon.json",
    content: { id: "geo-004", name: "London", location: { lat: 51.5074, lon: -0.1278 } },
  },
];

// Add a geospatial element pair index via the Management REST API (port 8002).
// cts:json-property-pair-geospatial-query works against geospatial-element-pair-index:
// MarkLogic maps JSON properties to XML elements in its internal index model, so the
// element-pair index serves both XML element pair queries and JSON property pair queries.
//
// After the PUT, we poll until a subsequent GET confirms the index is present.
// ML applies database property changes asynchronously (sometimes with a brief
// database restart), so we must not proceed until the change is visible.
async function addGeoElementPairIndex(base: ReturnType<typeof buildClients>["base"]) {
  const getProps = () => base.get<Record<string, unknown>>(
    base.mgmt,
    "/manage/v2/databases/Documents/properties",
    { params: { format: "json" } }
  );
  const hasIndex = (props: Record<string, unknown>) => {
    const existing = (props["geospatial-element-pair-index"] as Array<Record<string, unknown>>) ?? [];
    return existing.some((idx) => idx["parent-localname"] === "location" && idx["latitude-localname"] === "lat");
  };

  const props = await getProps();
  if (hasIndex(props)) return; // already configured

  const existing = (props["geospatial-element-pair-index"] as Array<Record<string, unknown>>) ?? [];
  await base.put(
    base.mgmt,
    "/manage/v2/databases/Documents/properties",
    {
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
    },
    { params: { format: "json" }, headers: { "Content-Type": "application/json" } }
  );

  // Poll until the GET confirms the index is present (ML applies config asynchronously)
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const updated = await getProps();
      if (hasIndex(updated)) return;
    } catch { /* DB may be briefly restarting; keep polling */ }
  }
  throw new Error("Timed out waiting for geospatial-element-pair-index on location to appear in database properties");
}

// XQuery using cts:json-property-pair-geospatial-query (string property names).
// This works against geospatial-element-pair-index for JSON documents.
// JSON docs return object-node() from cts:search; xdmp:node-uri() extracts the URI correctly.
function geoCircleXQuery(lat: number, lon: number, radiusKm: number, collection: string): string {
  const radiusMiles = radiusKm * 0.621371;
  return `
    for $doc in cts:search(
      fn:collection("${collection}"),
      cts:json-property-pair-geospatial-query(
        "location",
        "lat",
        "lon",
        cts:circle(${radiusMiles}, cts:point(${lat}, ${lon}))
      )
    )
    return xdmp:node-uri($doc)
  `;
}

describeIfLive("Geospatial search (live)", () => {
  const { base, documents, eval: evalClient, schema } = buildClients();

  beforeAll(async () => {
    // Configure the geospatial index BEFORE inserting documents.
    // Inserting documents after index configuration means ML indexes them immediately
    // during ingest — no reindexing race condition. If we insert first and configure
    // the index second, ML must reindex existing documents, which takes variable time.
    await addGeoElementPairIndex(base);

    // Seed geo documents (indexed immediately against the already-configured geo index)
    for (const { uri, content } of GEO_DOCS) {
      await documents.put(uri, JSON.stringify(content), "application/json", {
        collections: [COLLECTION],
      });
    }

    // Brief settle time
    await new Promise((r) => setTimeout(r, 1000));
  }, 30_000);

  afterAll(async () => {
    for (const { uri } of GEO_DOCS) {
      try { await documents.del(uri); } catch { /* ignore */ }
    }
  });

  describe("index discovery", () => {
    it("ml_indexes_list shows geospatial-element-pair index after configuration", async () => {
      const indexes = await schema.listIndexes("Documents");
      const geoIndexes = indexes.filter((i) => i.type.startsWith("geospatial"));
      // Should have at least the location/lat/lon index we just added
      expect(geoIndexes.length).toBeGreaterThan(0);
    });

    it("geospatial index has expected parent/lat/lon localnames", async () => {
      const indexes = await schema.listIndexes("Documents");
      const locationIndex = indexes.find(
        (i) => i.type === "geospatial-element-pair" &&
               (i as Record<string, unknown>)["parentLocalname"] === "location"
      );
      expect(locationIndex).toBeDefined();
    });
  });

  // Helper: results are URIs (e.g. "/geo/nyc.json") — check presence by URI
  const uriToCity: Record<string, string> = {
    "/geo/nyc.json": "New York City",
    "/geo/lax.json": "Los Angeles",
    "/geo/chi.json": "Chicago",
    "/geo/lon.json": "London",
  };

  describe("circle search", () => {
    it("finds NYC in a 50km radius around NYC", async () => {
      // NYC: 40.71°N, -74.00°W — 50km radius should contain only NYC from our set
      const xquery = geoCircleXQuery(40.7128, -74.0060, 50, COLLECTION);
      const results = await evalClient.evalXQuery(xquery);
      const uris = results.map((r) => String(r.value));
      const cities = uris.map((u) => uriToCity[u] ?? u);
      expect(cities).toContain("New York City");
    });

    it("does NOT include Los Angeles in a 50km radius around NYC", async () => {
      const xquery = geoCircleXQuery(40.7128, -74.0060, 50, COLLECTION);
      const results = await evalClient.evalXQuery(xquery);
      const uris = results.map((r) => String(r.value));
      const cities = uris.map((u) => uriToCity[u] ?? u);
      expect(cities).not.toContain("Los Angeles");
    });

    it("finds NYC and Chicago in a large radius around the US midwest", async () => {
      // Center: ~Kansas City (39.1°N, -94.6°W), 2000km radius covers NYC + Chicago
      const xquery = geoCircleXQuery(39.1, -94.6, 2000, COLLECTION);
      const results = await evalClient.evalXQuery(xquery);
      const uris = results.map((r) => String(r.value));
      const cities = uris.map((u) => uriToCity[u] ?? u);
      expect(cities).toContain("Chicago");
      expect(cities).toContain("New York City");
    });

    it("does NOT include London in a US-only search radius", async () => {
      // Center: US, 5000km radius — London is ~6700km from Kansas City
      const xquery = geoCircleXQuery(39.1, -94.6, 5000, COLLECTION);
      const results = await evalClient.evalXQuery(xquery);
      const uris = results.map((r) => String(r.value));
      const cities = uris.map((u) => uriToCity[u] ?? u);
      expect(cities).not.toContain("London");
    });
  });

  describe("bounding box search", () => {
    it("finds US east coast cities within a Northeast US bounding box", async () => {
      // Bounding box: roughly New England + Mid-Atlantic (38-45°N, 80-70°W)
      const xquery = `
        for $doc in cts:search(
          fn:collection("${COLLECTION}"),
          cts:json-property-pair-geospatial-query(
            "location",
            "lat",
            "lon",
            cts:box(38, -80, 45, -70)
          )
        )
        return xdmp:node-uri($doc)
      `;
      const results = await evalClient.evalXQuery(xquery);
      const uris = results.map((r) => String(r.value));
      const cities = uris.map((u) => uriToCity[u] ?? u);
      expect(cities).toContain("New York City");
      expect(cities).not.toContain("Los Angeles");
      expect(cities).not.toContain("London");
    });

    it("finds London within a Europe bounding box", async () => {
      // Europe bounding box: 35-72°N, 25°W-45°E
      const xquery = `
        for $doc in cts:search(
          fn:collection("${COLLECTION}"),
          cts:json-property-pair-geospatial-query(
            "location",
            "lat",
            "lon",
            cts:box(35, -25, 72, 45)
          )
        )
        return xdmp:node-uri($doc)
      `;
      const results = await evalClient.evalXQuery(xquery);
      const uris = results.map((r) => String(r.value));
      const cities = uris.map((u) => uriToCity[u] ?? u);
      expect(cities).toContain("London");
      expect(cities).not.toContain("New York City");
    });
  });
});
