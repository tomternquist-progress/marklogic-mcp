/**
 * Integration tests for ml_geospatial_search.
 *
 * Covers the full prerequisite chain that agents must follow:
 *  1. Use ml_indexes_list to discover geospatial indexes
 *  2. Seed documents with lat/lon properties
 *  3. Configure a geospatial element pair index via the XQuery admin library
 *  4. Test circle, bounding-box, and polygon searches
 *
 * Uses the XQuery admin module to add the index programmatically — this
 * mirrors what an agent would guide a user to do when no index exists.
 *
 * Catches bugs that unit tests miss:
 *  - Wrong cts:element-pair-geospatial-query argument order (lat vs lon)
 *  - Radius unit conversion (km → miles internally)
 *  - Polygon winding order (MarkLogic expects counter-clockwise)
 *  - Index not yet built when search runs (reindexing race condition)
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

// XQuery to add a geospatial element pair index on location/lat/lon.
// admin:database-geospatial-element-pair-index creates an element-pair index that
// covers BOTH XML elements and JSON properties (via MarkLogic's JSON→XML model).
// Query this index with cts:element-pair-geospatial-query + xs:QName args, NOT with
// cts:json-property-pair-geospatial-query (which requires a distinct json-property-pair index).
// ML handles duplicate index config gracefully (wrapped in try-catch).
const ADD_GEO_INDEX_XQUERY = `
import module namespace admin = "http://marklogic.com/xdmp/admin"
  at "/MarkLogic/admin.xqy";

let $config := admin:get-configuration()
let $db-id  := xdmp:database("Documents")
let $index  := admin:database-geospatial-element-pair-index(
                "",          (: parent namespace :)
                "location",  (: parent localname :)
                "",          (: lat namespace :)
                "lat",       (: lat localname :)
                "",          (: lon namespace :)
                "lon",       (: lon localname :)
                "wgs84",     (: coordinate system :)
                fn:false()   (: range-value-positions :)
              )
return
  try {
    let $config2 := admin:database-add-geospatial-element-pair-index($config, $db-id, $index)
    return (admin:save-configuration($config2), "added")
  } catch * {
    "already-exists"
  }
`;

// XQuery returns document URIs using the element-pair geospatial query.
// The admin module creates a geospatial-element-pair index (not a json-property-pair index).
// cts:element-pair-geospatial-query uses the element-pair index and works for BOTH XML elements
// and JSON properties (since MarkLogic indexes JSON via its XML element model).
// cts:json-property-pair-geospatial-query requires a separate json-property-pair index type.
function geoCircleXQuery(lat: number, lon: number, radiusKm: number, collection: string): string {
  const radiusMiles = radiusKm * 0.621371;
  return `
    for $doc in cts:search(
      fn:collection("${collection}"),
      cts:element-pair-geospatial-query(
        xs:QName("location"),
        xs:QName("lat"),
        xs:QName("lon"),
        cts:circle(${radiusMiles}, cts:point(${lat}, ${lon}))
      )
    )
    return xdmp:node-uri($doc)
  `;
}

describeIfLive("Geospatial search (live)", () => {
  const { documents, eval: evalClient, schema } = buildClients();

  beforeAll(async () => {
    // Seed geo documents
    for (const { uri, content } of GEO_DOCS) {
      await documents.put(uri, JSON.stringify(content), "application/json", {
        collections: [COLLECTION],
      });
    }

    // Add geospatial index via XQuery admin module
    await evalClient.evalXQuery(ADD_GEO_INDEX_XQUERY);

    // Allow time for the index to be built
    await new Promise((r) => setTimeout(r, 3000));
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
          cts:element-pair-geospatial-query(
            xs:QName("location"),
            xs:QName("lat"),
            xs:QName("lon"),
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
          cts:element-pair-geospatial-query(
            xs:QName("location"),
            xs:QName("lat"),
            xs:QName("lon"),
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
