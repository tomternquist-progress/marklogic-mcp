/**
 * Wait for publish job and test classification.
 * Run with: node scripts/test-iptc-classify.mjs [jobId]
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
const JOB_ID = process.argv[2] ?? "408e65ad-8876-46cf-901f-837be2253c9e-173";

async function main() {
  // Poll job status
  console.log(`Polling publish job ${JOB_ID}...`);
  const result = await semaphore.kmmWaitForAsyncJob(JOB_ID, 300_000, 5_000);
  console.log(`Job status: ${result.status}`);
  if (result.error) console.log(`Error: ${result.error}`);
  if (result.result) console.log(`Result: ${JSON.stringify(result.result).slice(0, 300)}`);

  // Check publish sets in CLS
  console.log("\nChecking CLS publish sets...");
  const sets = await semaphore.listPublishSets();
  console.log(`${sets.length} publish set(s) in CLS:`);
  sets.forEach((s) => console.log(`  - ${s.name}: ${s.ruleCount} rules, active=${s.active}`));

  // Test classification
  console.log("\nClassifying sample text (threshold=0)...");
  const texts = [
    "Olympic athletes competed in swimming and cycling events at the Paris games.",
    "The prime minister announced new economic policies to address inflation.",
    "Scientists discovered a new treatment for cancer using immunotherapy.",
  ];

  for (const text of texts) {
    console.log(`\nText: "${text.slice(0, 60)}..."`);
    try {
      const result = await semaphore.classify(text, 0);
      const { categories, rawXml } = result;
      if (!categories || categories.length === 0) {
        console.log("  (no matches — rules may still indexing)");
        // Show META tags from raw XML to debug
        const metaMatches = [...rawXml.matchAll(/<META[^>]*/g)].slice(0, 3);
        if (metaMatches.length > 0) metaMatches.forEach(([m]) => console.log("  " + m.slice(0, 120)));
      } else {
        categories.slice(0, 5).forEach((c) =>
          console.log(`  [${c.score}] ${c.className}: ${c.value}`)
        );
      }
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
