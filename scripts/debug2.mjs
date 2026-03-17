/**
 * Debug 2: Count OE API concepts, check default publisher XMLs, inspect Semaphore-Publisher.xml
 */
import { initLogger } from "../dist/utils/logger.js";
import { SemaphoreClient } from "../dist/client/semaphore.js";
import JSZip from "jszip";

initLogger({ level: "warn", format: "pretty" });

const config = { host: "semaphore.ternquist.com", scsPort: 5058, kmmPort: 5080, username: "admin", password: "admin", ssl: false };
const semaphore = new SemaphoreClient(config);

async function kmmGet(path) {
  const token = await semaphore.kmmApiKey();
  const res = await semaphore.kmmHttp.get(path, { headers: { "x-api-key": token }, validateStatus: (s) => s < 500 });
  return { status: res.status, data: res.data };
}

async function main() {
  // 1. Count OE API concept instances
  console.log("=== OE API concept count ===");
  const { data: oeData } = await kmmGet("/kmm/api/model:IPTCMediaTopics/skos:Concept/rdf:instance");
  const graph = oeData["@graph"] ?? [];
  console.log(`OE API returned ${graph.length} skos:Concept instances`);
  if (graph.length > 0) {
    console.log("First 3:", graph.slice(0, 3).map(g => g["@id"]));
  }

  // 2. Look at the default Semaphore-Publisher.xml to understand AllConcepts
  console.log("\n=== Default publisher ZIP ===");
  const zipBuf = await semaphore.kmmDownloadPublishConfigZip("model:IPTCMediaTopics");
  const zip = await JSZip.loadAsync(zipBuf);

  // Show Semaphore-Publisher.xml (default config, not CS-only)
  const defaultXml = zip.files["Semaphore-Publisher.xml"];
  if (defaultXml) {
    const xml = await defaultXml.async("string");
    // Just show AllConcepts/AllResources section
    const allConceptsIdx = xml.indexOf("AllConcepts");
    const allResourcesIdx = xml.indexOf("AllResources");
    console.log("AllConcepts at index:", allConceptsIdx);
    console.log("AllResources at index:", allResourcesIdx);
    console.log("\nFirst 3000 chars of Semaphore-Publisher.xml:\n" + xml.slice(0, 3000));
  }

  // 3. Check the server-side import files (can we GET them?)
  console.log("\n=== Checking ModelDefinition.xml ===");
  const modelDefPaths = [
    "/kmm/api?path=publisher/model:IPTCMediaTopics/import/ModelDefinition.xml",
    "/kmm/import/ModelDefinition.xml",
  ];
  for (const path of modelDefPaths) {
    try {
      const { status, data } = await kmmGet(path);
      console.log(`GET ${path} → ${status}: ${String(data).slice(0, 200)}`);
    } catch (err) {
      console.log(`GET ${path} → ERROR: ${err.message}`);
    }
  }

  // 4. Try getting the publish log for the last job
  console.log("\n=== Last publish event log ===");
  try {
    const { status, data } = await kmmGet(
      "/kmm/api?path=sys/model:IPTCMediaTopics/sempubpermissions:eventLog&language=en"
    );
    console.log(`Status: ${status}`);
    console.log(`Data: ${JSON.stringify(data).slice(0, 1000)}`);
  } catch (err) {
    console.log(`Error: ${err.message}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
