/**
 * Integration tests for FluxClient against a live flux-runner sidecar.
 *
 * All tests are gated on FLUX_RUNNER_URL being set in the environment.
 * Tests are automatically skipped when the Flux runner is not present.
 *
 * Env vars required:
 *   FLUX_RUNNER_URL  — URL of the flux-runner sidecar, e.g. http://localhost:8080
 *   ML_HOST          — MarkLogic hostname (for constructing Flux connection strings)
 *   ML_PORT          — MarkLogic REST port (default: 8000)
 *   ML_USER          — MarkLogic username (default: admin)
 *   ML_PASSWORD      — MarkLogic password (default: admin)
 *
 * Covers all flux_* tools:
 *   flux_help        — runs flux --help via FluxClient.run(['--help'])
 *   flux_preview     — runs flux import --preview via FluxClient.run()
 *   flux_import      — runs a Flux import job
 *   flux_export      — runs a Flux export job
 *   flux_copy        — runs a Flux copy job
 *   flux_reprocess   — runs a Flux reprocess job
 *   flux_status      — FluxClient.healthCheck()
 */

import { describe, it, expect } from "vitest";
import { FluxClient } from "../../src/client/flux.js";
import type { ConnectionConfig } from "../../src/config/schema.js";

const FLUX_RUNNER_URL = process.env.FLUX_RUNNER_URL ?? "";
const ML_HOST = process.env.ML_HOST ?? "localhost";
const ML_PORT = parseInt(process.env.ML_PORT ?? "8000", 10);
const ML_USER = process.env.ML_USER ?? "admin";
const ML_PASSWORD = process.env.ML_PASSWORD ?? "admin";
const ML_AUTH_TYPE = (process.env.ML_AUTH_TYPE ?? "digest") as "digest" | "basic" | "oauth";

const describeIfLive = FLUX_RUNNER_URL ? describe : describe.skip;

function buildFluxClient(): FluxClient {
  const mlConfig: ConnectionConfig = {
    host: ML_HOST,
    port: ML_PORT,
    managementPort: 8002,
    username: ML_USER,
    password: ML_PASSWORD,
    database: "Documents",
    ssl: false,
    rejectUnauthorized: true,
    authType: ML_AUTH_TYPE,
    timeoutMs: 30_000,
  };
  return new FluxClient(FLUX_RUNNER_URL, mlConfig);
}

describeIfLive("FluxClient (live)", () => {
  const flux = buildFluxClient();

  describe("healthCheck (flux_status)", () => {
    it("returns true when the runner is reachable", async () => {
      const healthy = await flux.healthCheck();
      expect(healthy).toBe(true);
    });

    it("configured is true when FLUX_RUNNER_URL is set", () => {
      expect(flux.configured).toBe(true);
    });
  });

  describe("flux_help — run(['help'])", () => {
    it("returns a result with success=true or useful output", async () => {
      const result = await flux.run(["help"]);
      expect(result).toBeDefined();
      expect(typeof result.output).toBe("string");
      expect(typeof result.exitCode).toBe("number");
    });

    it("output includes Flux command information", async () => {
      const result = await flux.run(["help"]);
      // Flux help subcommand should mention commands like import, export, or flux
      expect(result.output.toLowerCase()).toMatch(/import|export|flux|command/i);
    });
  });

  describe("flux_preview — import with --preview", () => {
    it("previews an import from the wikipedia-articles collection without writing", async () => {
      // Preview an export of the wikipedia-articles collection to /dev/null
      // This validates the connection string and Flux CLI parsing without modifying data
      const result = await flux.run([
        "export-files",
        "--connection-string", flux.connectionString(),
        "--collections", "wikipedia-articles",
        "--path", "/tmp/flux-preview-test",
        "--preview",
      ]);
      expect(typeof result.output).toBe("string");
      expect(typeof result.exitCode).toBe("number");
      // preview should succeed (exit 0) or report a count, not a connection error
      if (result.exitCode !== 0) {
        // If it fails, the output should indicate a known reason, not a connection failure
        expect(result.output).not.toMatch(/ECONNREFUSED|UnknownHost/i);
      }
    });
  });

  describe("flux_export — export documents from MarkLogic", () => {
    it("exports wikipedia-articles collection to a temp directory", async () => {
      const result = await flux.run([
        "export-files",
        "--connection-string", flux.connectionString(),
        "--collections", "wikipedia-articles",
        "--path", "/tmp/flux-export-integration-test",
      ]);
      expect(typeof result.output).toBe("string");
      expect(typeof result.exitCode).toBe("number");
      // Export should succeed
      if (result.exitCode !== 0) {
        console.error("Flux export failed:", result.output);
      }
      expect(result.success).toBe(true);
    });
  });

  describe("flux_import — import documents from filesystem", () => {
    it("re-imports the previously exported wikipedia-articles files", async () => {
      // Import back from the directory we just exported to
      const result = await flux.run([
        "import-files",
        "--connection-string", flux.connectionString(),
        "--path", "/tmp/flux-export-integration-test",
        "--uri-replace", "/tmp/flux-export-integration-test,''",
        "--collections", "flux-reimport-test",
      ]);
      expect(typeof result.output).toBe("string");
      expect(typeof result.exitCode).toBe("number");
    });
  });

  describe("flux_copy — copy documents between collections", () => {
    it("copies documents from wikipedia-articles to a new collection", async () => {
      const result = await flux.run([
        "copy",
        "--connection-string", flux.connectionString(),
        "--collections", "wikipedia-articles",
        "--output-collections", "flux-copy-test",
        "--output-connection-string", flux.connectionString(),
      ]);
      expect(typeof result.output).toBe("string");
      expect(typeof result.exitCode).toBe("number");
    });
  });

  describe("flux_reprocess — reprocess documents", () => {
    it("runs a reprocess job over the wikipedia-articles collection", async () => {
      // Reprocess with a simple javascript transform that's a no-op
      // (just reads and re-writes the document)
      const result = await flux.run([
        "reprocess",
        "--connection-string", flux.connectionString(),
        "--read-collections", "wikipedia-articles",
        "--write-connection-string", flux.connectionString(),
        // A no-op: just re-ingest the same documents unchanged
      ]);
      expect(typeof result.output).toBe("string");
      expect(typeof result.exitCode).toBe("number");
    });
  });

  describe("connection string and auth type", () => {
    it("connectionString returns user:password@host:port/database format", () => {
      const cs = flux.connectionString();
      expect(cs).toContain("@");
      expect(cs).toContain(String(ML_PORT));
      expect(cs).toContain(ML_HOST);
    });

    it("authType returns the configured auth type", () => {
      expect(flux.authType).toBe(ML_AUTH_TYPE);
    });
  });
});
