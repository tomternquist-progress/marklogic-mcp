/**
 * Probe the KMM OE API to check if IPTC concepts are indexed.
 * AllConcepts in the publisher uses the OE API to enumerate concepts.
 */
import { initLogger } from "../dist/utils/logger.js";
import { SemaphoreClient } from "../dist/client/semaphore.js";

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

async function kmmGet(path) {
  const token = await semaphore.kmmApiKey();
  const res = await semaphore.kmmHttp.get(path, {
    headers: { "x-api-key": token },
    validateStatus: (s) => s < 500,
  });
  return { status: res.status, data: res.data };
}

async function main() {
  console.log("=== Probing KMM OE API for IPTC concepts ===\n");

  // 1. Try OE API concept listing
  const paths = [
    "/kmm/api/model:IPTCMediaTopics/skos:Concept/rdf:instance",
    "/kmm/api/model:IPTCMediaTopics/skos%3AConcept/rdf:instance",
    "/kmm/api?path=model:IPTCMediaTopics/skos:Concept/rdf:instance",
    "/kmm/api/sys/sys:Model/rdf:instance",
    "/kmm/api?path=sys/sys:Model/rdf:instance",
  ];

  for (const path of paths) {
    try {
      const { status, data } = await kmmGet(path);
      const dataStr = JSON.stringify(data).slice(0, 300);
      console.log(`GET ${path}`);
      console.log(`  Status: ${status}`);
      console.log(`  Data: ${dataStr}\n`);
    } catch (err) {
      console.log(`GET ${path} → ERROR: ${err.message}\n`);
    }
  }

  // 2. Try getting the model's properties via OE API
  console.log("=== Model properties via OE API ===");
  try {
    const { status, data } = await kmmGet(
      "/kmm/api?path=model:IPTCMediaTopics/model:IPTCMediaTopics&properties=owl:imports&language=en"
    );
    console.log(`Status: ${status}`);
    console.log(`Data: ${JSON.stringify(data).slice(0, 500)}`);
  } catch (err) {
    console.log(`Error: ${err.message}`);
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
