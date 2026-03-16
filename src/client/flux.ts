import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import axios, { type AxiosInstance } from "axios";
import type { ConnectionConfig } from "../config/schema.js";

export interface FluxRunResult {
  exitCode: number;
  output: string;
  timedOut?: boolean;
  success: boolean;
}

/**
 * Client for the flux-runner sidecar service.
 *
 * The sidecar exposes POST /run accepting { args: string[] } and returns
 * { exitCode: number, output: string, timedOut?: boolean }.
 *
 * Connection args are built from the MCP server's own MarkLogic config so
 * callers don't have to repeat credentials.
 */
export class FluxClient {
  private readonly http: AxiosInstance;
  readonly configured: boolean;

  constructor(
    runnerUrl: string | undefined,
    private readonly mlConfig: ConnectionConfig
  ) {
    this.configured = !!runnerUrl;
    this.http = axios.create({
      baseURL: runnerUrl ?? "http://flux-runner:8080",
      // Flux jobs can be long — use a generous timeout; the runner also enforces its own
      timeout: 35 * 60 * 1000,
    });
  }

  /**
   * Build the MarkLogic connection string from the configured ML connection.
   * Format: user:password@host:port[/database]
   */
  connectionString(database?: string): string {
    const { username, password, host, port } = this.mlConfig;
    const db = database ?? this.mlConfig.database;
    return `${username}:${password}@${host}:${port}/${db}`;
  }

  /** Auth type configured for this MarkLogic connection ("digest" or "basic"). */
  get authType(): string {
    return this.mlConfig.authType;
  }

  /**
   * Run a Flux command via the /run-stream SSE endpoint.
   *
   * The runner streams each line of Flux stdout/stderr as:
   *   data: <line>\n\n
   * and terminates with:
   *   data: __exit__:<exitCode>\n\n
   *
   * Consuming the stream as it arrives prevents the pipe-buffer deadlock that
   * occurs when buffering all output until process exit.  Falls back to the
   * synchronous /run endpoint if the runner doesn't support /run-stream.
   */
  async run(args: string[]): Promise<FluxRunResult> {
    if (!this.configured) {
      return {
        exitCode: -1,
        output: "Flux runner is not configured. Set FLUX_RUNNER_URL (e.g. http://flux-runner:8080) and ensure the flux-runner service is running.",
        success: false,
      };
    }

    try {
      return await this.runStream(args);
    } catch (err: unknown) {
      // If the runner is an older build without /run-stream, fall back to /run.
      const isConnErr = err instanceof Error && ("code" in err) &&
        ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET"].includes((err as NodeJS.ErrnoException).code ?? "");
      if (isConnErr) {
        return {
          exitCode: -1,
          output: `Flux runner is not reachable at ${this.http.defaults.baseURL}. Ensure the flux-runner service is running (use --profile flux with docker compose).`,
          success: false,
        };
      }
      // Unknown error — surface it directly.
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: -1, output: msg, success: false };
    }
  }

  /**
   * Internal: POST to /run-stream and consume the SSE response, accumulating
   * all lines into a single output string.
   */
  private runStream(args: string[]): Promise<FluxRunResult> {
    return new Promise((resolve, reject) => {
      const baseUrl = new URL(this.http.defaults.baseURL ?? "http://flux-runner:8080");
      const isHttps = baseUrl.protocol === "https:";
      const requestOptions = {
        hostname: baseUrl.hostname,
        port: baseUrl.port || (isHttps ? 443 : 80),
        path: "/run-stream",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      };

      const body = JSON.stringify({ args });
      const transport = isHttps ? https : http;

      const req = transport.request(requestOptions, (res) => {
        // Older runner without /run-stream falls through to /run-fallback below.
        if (res.statusCode === 404) {
          res.resume(); // drain
          this.runLegacy(args).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          // Read the body before rejecting — the runner puts error details there
          const chunks: string[] = [];
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => chunks.push(chunk));
          res.on("end", () => {
            const body = chunks.join("").trim();
            const detail = body ? `: ${body.slice(0, 500)}` : "";
            reject(new Error(`Flux runner returned HTTP ${res.statusCode} from /run-stream${detail}`));
          });
          res.on("error", reject);
          return;
        }

        const lines: string[] = [];
        let exitCode = 0;
        let buf = "";

        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          // SSE events are separated by double newline
          const events = buf.split("\n\n");
          buf = events.pop() ?? "";
          for (const event of events) {
            // Each event is "data: <value>"
            const match = /^data: (.*)$/m.exec(event);
            if (!match) continue;
            const data = match[1];
            if (data.startsWith("__exit__:")) {
              exitCode = parseInt(data.slice("__exit__:".length), 10);
            } else {
              lines.push(data);
            }
          }
        });

        res.on("end", () => {
          const output = lines.join("\n");
          resolve({ exitCode, output, success: exitCode === 0 });
        });

        res.on("error", reject);
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /** Legacy synchronous /run endpoint — used as fallback for older runner builds. */
  private async runLegacy(args: string[]): Promise<FluxRunResult> {
    try {
      const res = await this.http.post<{ exitCode: number; output: string; timedOut?: boolean }>(
        "/run",
        { args },
        { headers: { "Content-Type": "application/json" } }
      );
      const { exitCode, output, timedOut } = res.data;
      return { exitCode, output, timedOut, success: exitCode === 0 };
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response) {
        const body = typeof err.response.data === "string"
          ? err.response.data
          : JSON.stringify(err.response.data);
        throw new Error(`Flux runner returned HTTP ${err.response.status}: ${body}`);
      }
      throw err;
    }
  }

  /**
   * Upload a local file (on the MCP server) to the flux runner's /tmp directory.
   * Returns the absolute path of the file on the runner, suitable for use as --path.
   */
  async upload(localPath: string): Promise<string> {
    if (!this.configured) {
      throw new Error("Flux runner is not configured. Set FLUX_RUNNER_URL.");
    }
    try {
      statSync(localPath);
    } catch {
      throw new Error(`File not found on MCP server: ${localPath}`);
    }
    const fileBytes = readFileSync(localPath);
    const filename = basename(localPath);
    const res = await this.http.post<{ path: string }>(
      `/upload?filename=${encodeURIComponent(filename)}`,
      fileBytes,
      {
        headers: { "Content-Type": "application/octet-stream" },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
    return res.data.path;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.http.get("/health", { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}
