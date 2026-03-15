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

  async run(args: string[]): Promise<FluxRunResult> {
    if (!this.configured) {
      return {
        exitCode: -1,
        output: "Flux runner is not configured. Set FLUX_RUNNER_URL (e.g. http://flux-runner:8080) and ensure the flux-runner service is running.",
        success: false,
      };
    }

    try {
      const res = await this.http.post<{ exitCode: number; output: string; timedOut?: boolean }>(
        "/run",
        { args },
        { headers: { "Content-Type": "application/json" } }
      );
      const { exitCode, output, timedOut } = res.data;
      return { exitCode, output, timedOut, success: exitCode === 0 };
    } catch (err: unknown) {
      const isConnErr = err instanceof Error && ("code" in err) &&
        ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET"].includes((err as NodeJS.ErrnoException).code ?? "");
      const msg = isConnErr
        ? `Flux runner is not reachable at ${this.http.defaults.baseURL}. Ensure the flux-runner service is running (use --profile flux with docker compose).`
        : (err instanceof Error ? err.message : String(err));
      return { exitCode: -1, output: msg, success: false };
    }
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
