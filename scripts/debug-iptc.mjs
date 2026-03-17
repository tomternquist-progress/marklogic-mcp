/**
 * Debug: Inspect raw CLS XML and publisher workspace ZIP contents.
 */
import { initLogger } from "../dist/utils/logger.js";
import { SemaphoreClient } from "../dist/client/semaphore.js";
import JSZip from "jszip";

initLogger({ level: "warn", format: "pretty" });

const config = {
  host: "semaphore.ternquist.com",
  scsPort: 5058,
  kmmPort: 5080,
  username: "admin",
  password: "admin",
  ssl: false,
};

const semaphore = new SemaphoreClient(config);

async function main() {
  // 1. Raw classification XML
  console.log("=== Raw CLS classification XML ===");
  const text = "Olympic athletes competed in swimming at the Paris games.";
  const result = await semaphore.classify(text, 0);
  console.log("Categories count:", result.categories?.length);
  console.log("Raw XML (first 2000 chars):\n", result.rawXml?.slice(0, 2000));

  // 2. Download current publisher workspace ZIP and list contents
  console.log("\n=== Publisher workspace ZIP contents ===");
  const zipBuf = await semaphore.kmmDownloadPublishConfigZip("model:IPTCMediaTopics");
  if (!zipBuf) {
    console.log("No workspace ZIP found!");
    return;
  }
  const zip = await JSZip.loadAsync(zipBuf);
  const files = Object.keys(zip.files);
  console.log("Files in ZIP:", files);

  // 3. Show the actual publisher XML in the ZIP
  const xmlFile = zip.files["Semaphore-Publisher-CS-only.xml"];
  if (xmlFile) {
    const xml = await xmlFile.async("string");
    console.log("\n=== Semaphore-Publisher-CS-only.xml ===\n" + xml);
  }

  // 4. Show ContextualCitation.kid if present
  const kidFile = zip.files["templates/ContextualCitation.kid"];
  if (kidFile) {
    const kid = await kidFile.async("string");
    console.log("\n=== templates/ContextualCitation.kid (first 500 chars) ===\n" + kid.slice(0, 500));
  } else {
    console.log("\nWARNING: templates/ContextualCitation.kid NOT FOUND in ZIP!");
    // List what's in templates/
    files.filter(f => f.startsWith("templates")).forEach(f => console.log("  template file:", f));
  }

  // 5. Check sem:guid on concepts via SPARQL
  console.log("\n=== sem:guid check ===");
  const r1 = await semaphore.kmmSparqlQuery("model:IPTCMediaTopics",
    `PREFIX sem: <http://www.smartlogic.com/2014/08/semaphore-core#>
     PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
     SELECT (COUNT(?c) AS ?n) WHERE { ?c a skos:Concept . ?c sem:guid ?g }`);
  console.log("Concepts with sem:guid:", r1.rows[0]?.n);

  // 6. Check skos:prefLabel@en count
  console.log("\n=== skos:prefLabel@en check ===");
  const r2 = await semaphore.kmmSparqlQuery("model:IPTCMediaTopics",
    `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
     SELECT (COUNT(?c) AS ?n) WHERE {
       ?c skos:prefLabel ?l .
       FILTER(LANGMATCHES(LANG(?l), "en"))
     }`);
  console.log("Concepts with @en prefLabel:", r2.rows[0]?.n);

  // 7. Run the exact getPrefLabelsSparql query
  console.log("\n=== getPrefLabelsSparql test (first 5 rows) ===");
  const r3 = await semaphore.kmmSparqlQuery("model:IPTCMediaTopics",
    `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
     SELECT ?termUri ?prefLabelUri ?prefLabel ?prefLabelRelationship
     WHERE {
       BIND(skos:prefLabel AS ?prefLabelRelationship) .
       ?termUri skos:prefLabel ?prefLabel .
       FILTER(LANGMATCHES(LANG(?prefLabel), "en"))
       BIND(?termUri AS ?prefLabelUri) .
     } LIMIT 5`);
  console.log("Rows:", r3.rows.length);
  r3.rows.forEach(row => console.log(" ", JSON.stringify(row)));
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
