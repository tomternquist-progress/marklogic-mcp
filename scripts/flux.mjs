#!/usr/bin/env node
/**
 * Helper: forwards arguments to the Flux runner HTTP API.
 *
 * Usage:
 *   npm run flux -- import-delimited-files --path /data/crimes.csv --collections crimes
 *
 * Reads FLUX_RUNNER_URL from the environment (or .env file).
 * Defaults to http://localhost:8080.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Minimal .env loader (avoids needing to import dotenv as ESM)
function loadDotEnv() {
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // no .env — that's fine
  }
}

loadDotEnv();

const runnerUrl = (process.env.FLUX_RUNNER_URL || "http://localhost:8080").replace(/\/$/, "");
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: npm run flux -- <flux-subcommand> [args...]");
  console.error("Example: npm run flux -- import-delimited-files --path /data/file.csv");
  process.exit(1);
}

let res;
try {
  res = await fetch(`${runnerUrl}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args }),
  });
} catch (err) {
  console.error(`Cannot reach Flux runner at ${runnerUrl}: ${err.message}`);
  console.error("Is the flux-runner container running? Check FLUX_RUNNER_URL in .env.");
  process.exit(1);
}

const body = await res.json();
process.stdout.write(body.output || "");
if (body.output && !body.output.endsWith("\n")) process.stdout.write("\n");
process.exit(body.exitCode ?? (res.ok ? 0 : 1));
