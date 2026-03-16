/**
 * Semaphore client — Classification Server (SCS) + Studio/KMM connectivity.
 *
 * Progress Data Platform: MarkLogic (storage/search) + Semaphore (taxonomy/classification).
 *
 * Connection model (mirrors MarkLogic pattern):
 *   SEMAPHORE_HOST      — hostname for both SCS and KMM
 *   SEMAPHORE_SCS_PORT  — Classification Server port (default 5058)
 *   SEMAPHORE_KMM_PORT  — Studio / KMM port (default 5080)
 *   SEMAPHORE_USERNAME  — for KMM REST API authentication
 *   SEMAPHORE_PASSWORD  — for KMM REST API authentication
 *   SEMAPHORE_SSL       — use https (default false)
 *   SEMAPHORE_URL       — explicit SCS URL override (backward compat, takes precedence)
 *
 * SCS API summary (XML-based HTTP, port 5058 by default):
 *   GET  /?op=version                  → XML version string
 *   POST / (URL-encoded XML_INPUT)     → XML responses for admin ops
 *   POST / (URL-encoded body+threshold) → XML classification result
 *
 * Classification result format:
 *   <META name="<ClassName>" value="<CategoryLabel>" id="<uuid>" score="<float>"/>
 *
 * KMM / Studio API (port 5080 by default):
 *   Session-based authentication; Bearer token supported.
 *   Connectivity check via GET / (expects a non-connection-error response).
 *
 * Flux classifier flags (for bulk classification at ingest time):
 *   --classifier-host <host>  --classifier-port <scsPort>  --classifier-path /
 */

import axios, { type AxiosInstance } from "axios";
import { logger } from "../utils/logger.js";
import type { SemaphoreConfig } from "../config/schema.js";

// ── XML parsing helpers ──────────────────────────────────────────────────────

/** Extract text content of a named XML element (first match). */
function xmlText(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m?.[1]?.trim();
}

/** Extract all occurrences of an XML element as raw strings. */
function xmlAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^/]*?/>|<${tag}[^>]*>[\\s\\S]*?</${tag}>`, "gi");
  return xml.match(re) ?? [];
}

/** Parse attributes of a self-closing or opening XML element into a record. */
function xmlAttrs(element: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(element)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface SemaphoreCategory {
  /** Taxonomy class name (e.g. "Bluey-Episodes", "IPTC-NewsML") */
  className: string;
  /** Category label (e.g. "Season 1 Episode 1 - Magic Xylophone") */
  label: string;
  /** Stable concept UUID from the taxonomy */
  id: string;
  /** Classification confidence score (0–100 scale) */
  score: number;
}

export interface SemaphoreClassificationResult {
  categories: SemaphoreCategory[];
  /** Raw XML response from the server — useful for debugging */
  rawXml: string;
}

export interface SemaphorePublishSet {
  name: string;
  type: string;
  active: boolean;
  rulesCount?: number;
}

export interface SemaphoreClass {
  name: string;
  ruleCount: number;
}

// ── Client ───────────────────────────────────────────────────────────────────

export class SemaphoreClient {
  private readonly scsHttp: AxiosInstance;
  private readonly kmmHttp: AxiosInstance;

  /** True when a host or explicit URL is configured (SCS reachable). */
  readonly configured: boolean;
  /** SCS base URL (e.g. http://semaphore.example.com:5058) */
  readonly baseUrl: string;
  /** KMM / Studio base URL (e.g. http://semaphore.example.com:5080) */
  readonly kmmBaseUrl: string;
  /** The raw hostname (for passing to Flux --classifier-host). */
  readonly scsHost: string | undefined;
  /** SCS port number (for passing to Flux --classifier-port). */
  readonly scsPort: number;
  /** True when KMM credentials are configured. */
  readonly kmmConfigured: boolean;

  constructor(config: SemaphoreConfig) {
    const { host, scsPort, kmmPort, username, password, ssl, timeoutMs, url } = config;

    this.scsHost = host;
    this.scsPort = scsPort;
    this.configured = !!(host ?? url);

    const scheme = ssl ? "https" : "http";

    // Explicit URL override takes precedence over host:scsPort
    this.baseUrl = url ?? (host ? `${scheme}://${host}:${scsPort}` : "");
    this.kmmBaseUrl = host ? `${scheme}://${host}:${kmmPort}` : "";

    this.kmmConfigured = !!(host && (username ?? password));

    this.scsHttp = axios.create({
      baseURL: this.baseUrl || "http://localhost:5058",
      timeout: timeoutMs,
    });

    this.kmmHttp = axios.create({
      baseURL: this.kmmBaseUrl || "http://localhost:5080",
      timeout: timeoutMs,
      ...(username && password
        ? { auth: { username, password } }
        : {}),
    });

    this.scsHttp.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = (err as { response?: { status?: number } }).response?.status;
        logger.debug("Semaphore SCS HTTP error", { status, message: String(err) });
        throw err;
      }
    );
  }

  // ── SCS methods ─────────────────────────────────────────────────────────────

  /** Returns true if the Classification Server is reachable. */
  async healthCheck(): Promise<{ healthy: boolean; version?: string }> {
    if (!this.configured) return { healthy: false };
    try {
      const res = await this.scsHttp.get<string>("/?op=version", {
        timeout: 5_000,
        responseType: "text",
      });
      const version = xmlText(String(res.data), "version");
      return { healthy: true, version };
    } catch {
      return { healthy: false };
    }
  }

  /** Returns true if the KMM / Studio server is reachable. */
  async kmmHealthCheck(): Promise<{ healthy: boolean; statusCode?: number }> {
    if (!this.kmmBaseUrl) return { healthy: false };
    try {
      const res = await this.kmmHttp.get<string>("/", {
        timeout: 5_000,
        responseType: "text",
        // 401/403 still mean the server is up — only network errors mean it's down
        validateStatus: () => true,
      });
      return { healthy: true, statusCode: res.status };
    } catch {
      return { healthy: false };
    }
  }

  /** List published rule sets (equivalent to "models" or "taxonomies"). */
  async listPublishSets(): Promise<SemaphorePublishSet[]> {
    const xml = await this.postXmlOp("listPublishSets");
    const sets: SemaphorePublishSet[] = [];
    for (const el of xmlAll(xml, "publishset")) {
      const a = xmlAttrs(el);
      if (a.name) {
        sets.push({
          name: a.name,
          type: a.type ?? "unknown",
          active: a.active === "true",
        });
      }
    }
    return sets;
  }

  /** List classification classes (taxonomy roots) from the active rulenet. */
  async listClasses(): Promise<SemaphoreClass[]> {
    const xml = await this.postXmlOp("listRulenetClasses");
    const classes: SemaphoreClass[] = [];
    for (const el of xmlAll(xml, "Class")) {
      const a = xmlAttrs(el);
      if (a.Name) {
        classes.push({
          name: a.Name,
          ruleCount: parseInt(a.count_rules ?? "0", 10),
        });
      }
    }
    return classes;
  }

  /**
   * Classify text content.
   *
   * @param content    Plain text or HTML to classify.
   * @param threshold  Minimum score (0–100, default: 48). Lower = more results.
   *                   Use 0 to return all candidates regardless of score.
   */
  async classify(
    content: string,
    threshold = 48
  ): Promise<SemaphoreClassificationResult> {
    const body = new URLSearchParams({
      body: content,
      threshold: String(threshold),
      singlearticle: "1",
    }).toString();

    const res = await this.scsHttp.post<string>("/", body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      responseType: "text",
    });

    const xml = String(res.data);
    const categories: SemaphoreCategory[] = [];

    for (const el of xmlAll(xml, "META")) {
      const a = xmlAttrs(el);
      // Skip non-classification META elements (Type, Template, etc.)
      if (!a.name || !a.value || !a.id || a.score === undefined) continue;
      // Filter out internal system META
      if (a.name === "Type" || a.name === "Template") continue;
      const score = parseFloat(a.score);
      categories.push({
        className: a.name,
        label: a.value,
        id: a.id,
        score,
      });
    }

    return { categories, rawXml: xml };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async postXmlOp(op: string): Promise<string> {
    const xmlInput = `<?xml version="1.0" ?><request op="${op}"></request>`;
    const res = await this.scsHttp.post<string>(
      "/",
      new URLSearchParams({ XML_INPUT: xmlInput }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        responseType: "text",
      }
    );
    return String(res.data);
  }
}
