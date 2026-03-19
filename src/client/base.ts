import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import https from "https";
import type { ConnectionConfig } from "../config/schema.js";
import { AuthenticationError, MarkLogicError } from "../utils/errors.js";
import { buildDigestHeader } from "../utils/digest.js";
import { logger } from "../utils/logger.js";

/**
 * Extract a readable error message from MarkLogic's HTML 500 error body.
 * MarkLogic returns errors as HTML with <dl><dt>label</dt><dd>value</dd></dl> pairs.
 * Falls back to stripping all tags if the <dl> structure isn't found.
 */
function extractHtmlError(raw: string): string {
  // Try to pull <dt>/<dd> pairs out of the <dl> block
  const dlMatch = raw.match(/<dl[^>]*>([\s\S]*?)<\/dl>/i);
  if (dlMatch) {
    const dl = dlMatch[1];
    const dtMatches = [...dl.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/gi)];
    const ddMatches = [...dl.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/gi)];
    const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").trim();
    const parts: string[] = [];
    for (let i = 0; i < dtMatches.length; i++) {
      const key = stripTags(dtMatches[i][1]);
      const val = ddMatches[i] ? stripTags(ddMatches[i][1]) : "";
      if (key && val) parts.push(`${key}: ${val}`);
    }
    if (parts.length > 0) return parts.join(" | ");
  }
  // Fallback: strip HTML tags and collapse whitespace
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);
}

export class MarkLogicBaseClient {
  readonly config: ConnectionConfig;
  readonly http: AxiosInstance;   // Main REST port (8000, etc.)
  readonly mgmt: AxiosInstance;   // Management API port (8002)

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.http = this.createAxiosInstance(config.port);
    this.mgmt = this.createAxiosInstance(config.managementPort);
  }

  private createAxiosInstance(port: number): AxiosInstance {
    const baseURL = `${this.config.ssl ? "https" : "http"}://${this.config.host}:${port}`;
    const instance = axios.create({
      baseURL,
      timeout: this.config.timeoutMs,
      httpsAgent:
        this.config.ssl && !this.config.rejectUnauthorized
          ? new https.Agent({ rejectUnauthorized: false })
          : undefined,
    });

    if (this.config.authType === "basic") {
      instance.defaults.auth = {
        username: this.config.username,
        password: this.config.password,
      };
      instance.interceptors.response.use(
        (res) => res,
        (error) => { throw this.mapError(error); }
      );
    } else {
      this.attachDigestInterceptor(instance, port);
    }

    return instance;
  }

  private attachDigestInterceptor(instance: AxiosInstance, port: number): void {
    instance.interceptors.response.use(
      (res) => res,
      async (error) => {
        const originalRequest = error.config as InternalAxiosRequestConfig & { _digestRetry?: boolean };
        if (
          error.response?.status === 401 &&
          !originalRequest._digestRetry
        ) {
          originalRequest._digestRetry = true;
          const wwwAuth = error.response.headers["www-authenticate"] as string | undefined;
          if (!wwwAuth?.toLowerCase().startsWith("digest")) {
            throw new AuthenticationError(`${this.config.host}:${port}`);
          }
          const method = (originalRequest.method ?? "GET").toUpperCase();
          // Build the path+query for the digest URI (must match the actual request URL).
          // Serialize params manually to avoid casting non-string values and to ensure
          // the digest URI matches exactly what Axios will send.
          const basePath = originalRequest.url ?? "/";
          const params = originalRequest.params as Record<string, unknown> | undefined;
          const qs = params && Object.keys(params).length
            ? "?" + new URLSearchParams(
                Object.entries(params)
                  .filter(([, v]) => v != null)
                  .map(([k, v]) => [k, String(v)])
              ).toString()
            : "";
          const digestUri = basePath + qs;
          const authHeader = buildDigestHeader(
            method,
            digestUri,
            this.config.username,
            this.config.password,
            wwwAuth
          );
          originalRequest.headers["Authorization"] = authHeader;
          return instance(originalRequest);
        }
        throw this.mapError(error);
      }
    );
  }

  private mapError(error: unknown): Error {
    if (!axios.isAxiosError(error)) return error as Error;
    const status = error.response?.status;
    const body = error.response?.data as Record<string, unknown> | undefined;
    const rawBodyStr = typeof body === "string" ? body : body ? JSON.stringify(body) : undefined;
    const errObj =
      (body?.["error-response"] as Record<string, string> | undefined) ??
      (body?.["errorResponse"] as Record<string, string> | undefined);
    const mlMessage =
      errObj?.["message"] ??
      (body?.message as string | undefined) ??
      (rawBodyStr ? `${error.message} — body: ${extractHtmlError(rawBodyStr)}` : error.message);
    const mlCode = (errObj?.["status-code"] ?? errObj?.["messageCode"]) as string | undefined;

    if (status === 401) return new AuthenticationError(`${this.config.host}`);
    logger.debug("MarkLogic HTTP error", { status, mlMessage, mlCode, rawBody: body });
    return new MarkLogicError(mlMessage, status, mlCode);
  }

  async get<T = unknown>(
    instance: AxiosInstance,
    url: string,
    config?: AxiosRequestConfig
  ): Promise<T> {
    const res: AxiosResponse<T> = await instance.get(url, config);
    return res.data;
  }

  async post<T = unknown>(
    instance: AxiosInstance,
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig
  ): Promise<T> {
    const res: AxiosResponse<T> = await instance.post(url, data, config);
    return res.data;
  }

  async put(
    instance: AxiosInstance,
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig
  ): Promise<void> {
    await instance.put(url, data, config);
  }

  async delete(instance: AxiosInstance, url: string, config?: AxiosRequestConfig): Promise<void> {
    await instance.delete(url, config);
  }

  async patch<T = unknown>(
    instance: AxiosInstance,
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig
  ): Promise<T> {
    const res: AxiosResponse<T> = await instance.patch(url, data, config);
    return res.data;
  }
}
