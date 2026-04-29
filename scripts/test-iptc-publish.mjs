/**
 * Quick local test script: apply plain-SKOS config fix to IPTC model and republish.
 * Run with: node scripts/test-iptc-publish.mjs
 */

import { initLogger } from "../dist/utils/logger.js";
import { SemaphoreClient } from "../dist/client/semaphore.js";

// Initialize logger before anything else
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
const MODEL_URI = "model:IPTCMediaTopics";

async function main() {
  console.log("=== IPTC Media Topics — plain SKOS config fix + republish ===\n");

  // 1. List models (verify new endpoint works)
  console.log("1. Listing KMM models...");
  try {
    const models = await semaphore.listKmmModels();
    if (models.length === 0) {
      console.log("   (No models returned — endpoint may still need tuning)");
    } else {
      console.log(`   Found ${models.length} model(s):`);
      models.forEach((m) => console.log(`   - ${m.id}`));
    }
  } catch (err) {
    console.log(`   Error: ${err.message}`);
  }

  // 2. Apply plain SKOS config fix
  console.log("\n2. Applying plain SKOS publisher config fix...");
  try {
    const result = await semaphore.kmmPatchPublishConfigForPlainSkos(MODEL_URI);
    console.log(result);
  } catch (err) {
    console.error(`   FAILED: ${err.message}`);
    process.exit(1);
  }

  // 3. Republish
  console.log("\n3. Publishing to CLS (async, waiting for completion)...");
  try {
    const publishResult = await semaphore.kmmPublish(MODEL_URI, { async: true, waitForCompletion: true });
    console.log(`   Accepted: ${publishResult.accepted}`);
    console.log(`   Job ID:   ${publishResult.jobId ?? "N/A"}`);
    console.log(`   Status:   ${publishResult.status ?? "N/A"}`);
  } catch (err) {
    console.error(`   FAILED: ${err.message}`);
    process.exit(1);
  }

  // 4. Quick classification test
  console.log("\n4. Test classification (threshold=0)...");
  try {
    const text = "Athletes competed in the Olympic Games, with gold medals awarded in swimming, cycling and football.";
    const results = await semaphore.classify(text, 0);
    if (results.length === 0) {
      console.log("   No classifications returned (rules may still indexing — retry in ~1 min)");
    } else {
      console.log(`   ${results.length} result(s):`);
      results.slice(0, 5).forEach((r) => console.log(`   - [${r.score}] ${r.className}: ${r.value}`));
    }
  } catch (err) {
    console.log(`   Classification error: ${err.message}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
