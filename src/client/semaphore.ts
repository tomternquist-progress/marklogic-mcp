/**
 * Semaphore client — Classification Server (CLS) + Studio/KMM connectivity.
 *
 * Progress Data Platform: MarkLogic (storage/search) + Semaphore (taxonomy/classification).
 *
 * Connection model (mirrors MarkLogic pattern):
 *   SEMAPHORE_HOST      — hostname for both CLS and KMM
 *   SEMAPHORE_SCS_PORT  — Classification Server (CLS) port (default 5058)
 *   SEMAPHORE_KMM_PORT  — Studio / KMM port (default 5080)
 *   SEMAPHORE_USERNAME  — for KMM REST API authentication
 *   SEMAPHORE_PASSWORD  — for KMM REST API authentication
 *   SEMAPHORE_SSL       — use https (default false)
 *   SEMAPHORE_URL       — explicit CLS URL override (backward compat, takes precedence)
 *
 * CLS API summary (XML-based HTTP, port 5058 by default):
 *   GET  /?op=version                  → XML version string
 *   POST / (URL-encoded XML_INPUT)     → XML responses for admin ops
 *   POST / (URL-encoded body+threshold) → XML classification result
 *
 * Classification result format:
 *   <META name="<ClassName>" value="<CategoryLabel>" id="<uuid>" score="<float>"/>
 *
 * KMM / Studio API (port 5080 by default):
 *   Two-step Java EE form authentication:
 *     1. POST /j_security_check  (form: j_username, j_password) → JSESSIONID cookie
 *     2. GET  /api/token?lifeTime=86400   (with cookie)         → { tokenId: "<token>" }
 *   Use header  x-api-key: <token>  for all KMM REST calls.
 *
 *   Key KMM endpoints (all prefixed /kmm/api/):
 *     GET  specialgraph:system/teamwork:Tag/rdf:instance          → list models (JSON-LD)
 *     POST sys/sys:Model/rdf:instance  (Content-Type: application/ld+json)  → create model
 *     POST model:<Name>/sparql?checkConstraints=false&runEditRules=false
 *          (Content-Type: application/sparql-update)              → SPARQL UPDATE / LOAD
 *     GET  model:<Name>/sparql?query=<encoded-SELECT>             → SPARQL SELECT (XML)
 *     POST /kmm/api?path=publisher/model:<Name>/publish&async=true → trigger publish
 *     GET  /kmm/api/publisher/workspace/<encoded-uri>/config → ZIP config download
 *     POST /kmm/api/publisher/workspace/<encoded-uri>/config → ZIP config upload (multipart/form-data)
 *
 *   Model URIs use the prefix  urn:x-evn-master:  (shorthand: model:<Name>).
 *   To load third-party SKOS (IPTC, EuroVoc, AGROVOC etc.) always pass
 *     checkConstraints=false&runEditRules=false  — external vocabularies routinely
 *     use properties (e.g. ikos:hasFacet) that fail Semaphore's SHACL shapes.
 *
 *   PLAIN SKOS (no SKOS-XL): The default publisher config uses SKOS-XL reification
 *   for label lookups. Vocabularies that use plain skos:prefLabel (UNESCO, EuroVoc,
 *   AGROVOC, IPTC) need a patched publisher config. Use kmmPatchPublishConfigForPlainSkos()
 *   or the semaphore_publish_config_fix_plain_skos tool to apply the patch.
 *
 *   PUBLISHER WORKSPACE LIFECYCLE (important — read before calling workspace methods):
 *     The publisher workspace is a ZIP stored on the Semaphore server filesystem.
 *     It is created by the Semaphore Studio UI when you first open a model's
 *     Publisher tab. The REST API can read (GET) and update (POST) an existing
 *     workspace, but CANNOT create a new one via the API alone.
 *
 *     Workspace GET/POST endpoint (correct URL — no double-slash prefix):
 *       GET  /kmm/api/publisher/workspace/{encodedUri}/config → ZIP download
 *       POST /kmm/api/publisher/workspace/{encodedUri}/config → ZIP upload (multipart/form-data)
 *     where {encodedUri} = encodeURIComponent("urn:x-evn-master:{ModelName}")
 *
 *     If workspace does not exist: GET returns 404, POST returns 403.
 *     Solution: open Semaphore Studio → model → Publisher tab → initialize workspace.
 *     After initialization, kmmPatchPublishConfigForPlainSkos() will succeed.
 *
 *   PUBLISHER ENVIRONMENTS (important — read before calling kmmPublish):
 *     Semaphore publisher "environments" map named targets to sets of CLS/SES servers.
 *     They are configured in Semaphore Studio: Admin → Publisher → Environments → Add.
 *     The publish API requires a named environment; if none is configured,
 *     publish fails with HTTP 404 "Environment doesn't exist: null".
 *     The kmmPublish() method passes the environment name if provided, or omits it.
 *
 *     To configure an environment pointing to the CLS:
 *       Studio → Administration → Publisher → Classification Server Environments → Add
 *       Name: <any name>, Host: <cls-host>, Port: <cls-port>
 *     Then pass that name as options.environment to kmmPublish().
 *
 * Flux classifier flags (for bulk classification at ingest time):
 *   --classifier-host <host>  --classifier-port <clsPort>  --classifier-path /
 *   Add --classifier-http when the CLS endpoint is plain HTTP (not HTTPS).
 *
 * NETWORK NOTE (Kubernetes):
 *   xdmp.httpPost() from MarkLogic pods may be blocked by network policy from
 *   reaching the CLS. Prefer Flux (which runs outside MarkLogic) for server-side
 *   classification, or pre-classify from the application tier before insertion.
 *
 * CLS language codes use an indexed format ("en1", "fr1" etc.) not ISO codes.
 * Use listClsLanguages() to discover available codes. The default is usually "en1".
 *
 * Publisher workspace notes (from KMM API reference):
 *   - The workspace config endpoint uses a DOUBLE-SLASH: /kmm/api//{encodedUri}/...
 *   - New models have no workspace until the Studio Publisher tab is accessed once
 *     (or a publish is triggered that initialises it). The workspace config upload
 *     (POST multipart) returns HTTP 415 until the workspace exists.
 *   - The publish trigger endpoint encodes model URI colons (%3A) but NOT slashes
 *     in the path parameter value: /kmm/api?path=publisher/model%3AName/publish
 */

import axios, { type AxiosInstance } from "axios";
import JSZip from "jszip";
import { logger } from "../utils/logger.js";
import type { SemaphoreConfig } from "../config/schema.js";

// ── Publisher config constants ────────────────────────────────────────────────

/**
 * Canonical publisher config XML for plain-SKOS models (skos:prefLabel, no SKOS-XL).
 *
 * Key differences from the Semaphore default:
 *   • AllConcepts (not AllResources) — generates one CLS rule per skos:Concept
 *   • PlainSkosModel bean overrides getPrefLabelsSparql / getAltLabelsForwardSparql
 *     to use plain skos:prefLabel / skos:altLabel instead of SKOS-XL reification
 *
 * Required for: UNESCO Thesaurus, EuroVoc, AGROVOC, and any vocabulary that uses
 * plain skos:prefLabel literals rather than skosxl:prefLabel + skosxl:Label nodes.
 */
const PLAIN_SKOS_PUBLISHER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       xmlns="http://www.springframework.org/schema/beans"
       xsi:schemaLocation="http://www.springframework.org/schema/beans
       http://www.springframework.org/schema/beans/spring-beans.xsd" default-lazy-init="true">

  <bean class="com.smartlogic.workbench.publisher.Configuration">
    <property name="description" value="Publish to CS services only (plain SKOS labels)"/>
    <property name="environments">
      <list/>
    </property>
  </bean>

  <!-- Override SparqlEndpoint to use plain skos:prefLabel (no SKOS-XL reification).
       Required for vocabularies that use skos:prefLabel literals directly, e.g.
       UNESCO Thesaurus, EuroVoc, AGROVOC. -->
  <bean id="PlainSkosModel" parent="SparqlEndpoint">
    <property name="getPrefLabelsSparql">
      <value><![CDATA[
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT ?termUri ?prefLabelUri ?prefLabel ?prefLabelRelationship
        WHERE {
          BIND(skos:prefLabel AS ?prefLabelRelationship) .
          ?termUri skos:prefLabel ?prefLabel .
          FILTER(LANGMATCHES(LANG(?prefLabel), "en"))
          BIND(?termUri AS ?prefLabelUri) .
        }
      ]]></value>
    </property>
    <property name="getAltLabelsForwardSparql">
      <value><![CDATA[
        PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
        SELECT DISTINCT ?termUri ?labelUri ?labelLiteral
        WHERE {
          ?termUri skos:altLabel ?labelLiteral .
          FILTER(LANGMATCHES(LANG(?labelLiteral), "en"))
          BIND(?termUri AS ?labelUri) .
        }
      ]]></value>
    </property>
  </bean>

  <bean class="com.smartlogic.publisher.Publisher">
    <property name="model" ref="PlainSkosModel"/>
    <property name="configurationSets">
      <list>
        <!-- AllConcepts: generates one CLS rule per skos:Concept.
             AllResources (the default) only generates rules at the ConceptScheme level. -->
        <bean parent="AllConcepts">
          <property name="languageCodes">
            <list><value>en-US</value></list>
          </property>
          <property name="outputProcessors">
            <list>
              <bean id="NamedEntityRules" parent="RulebaseWriterTemplate">
                <property name="templateFileName" value="ContextualCitation.kid"/>
              </bean>
              <ref bean="environmentCSWriter"/>
            </list>
          </property>
        </bean>
      </list>
    </property>
    <property name="modelUpdater" ref="OEUpdater"/>
  </bean>

  <!-- The following import lines import many default configuration settings
         that will not usually be altered.
         Therefore be careful editing anything below here -->
  <import resource="file:\${resources.directory}/import/ModelInterface.xml"/>
  <import resource="file:\${resources.directory}/import/ModelDefinition.xml"/>
  <import resource="file:\${resources.directory}/import/RulebaseStructure.xml"/>
  <import resource="file:\${resources.directory}/import/SESConfiguration.xml"/>
  <import resource="file:\${resources.directory}/import/ConfigurationSets.xml"/>

</beans>
`;

/**
 * ContextualCitation.kid — default Semaphore publisher template.
 * Generates CLS rules that fire on exact phrase matches and near-word matches of
 * preferred and alternative labels, with weighted contributions from related concepts.
 */
const CONTEXTUAL_CITATION_TEMPLATE = `<!-- Template: ContextualCitation.kid -->
<rulebase language="\${language.iso_code}">

\t<!--~~
\t\tThis rulebase is designed to look for citations of preferred and alternative labels
\t\tas well as contextual information from hierarchical and associative relationships.

\t\tMentions of all the words near each other have a weight of 50. If the mention is
\t\tand exact phrase mentions it has an additional weight of 20.
\t\tDirect descendants each contribute 60% of their weight if they are firing. All associative
\t\trelationships together contribute 50% of their weight, up to a total weight contribution of 30.

\t\tA single mention, exact or near group, is sufficient for the rulebase to fire.
\t\tIf the rulebase does not find direct evidence, the contribution of one highly scoring descendant
\t\tor 2 moderately scoring descendants is sufficient for the rulebase to fire.
\t\tContributions from associative relationships alone are never enough for the rulebase to fire.
\t-->\

\t<content>

\t\t<!-- Firing category -->
\t\t<category class="\${rulebaseClass}" name="\${resource.label}" id="\${resource.guid}">
\t\t\t<link label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_FINAL"/>
\t\t</category>

\t\t<!-- Combine score from evidence and relationships -->
\t\t<combine label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_FINAL" weight="100">
\t\t\t<!-- Direct evidence contribution -->
\t\t\t<link label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE"/>
\t\t\t<!-- Contributions of associative relationships -->
\t\t\t<combine weight="30">
\t\t\t\t<linklist label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE" weight="50" relationshiptypes="Associative"/>
\t\t\t</combine>
\t\t\t<!-- Contributions of direct descendants -->
\t\t\t<combine weight="100">
\t\t\t\t<linklist label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE" weight="60" relationshiptypes="LowerInHierarchy"/>
\t\t\t</combine>
\t\t</combine>

\t\t<!-- Evidence lookup -->
\t\t<combine label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE" weight="100">
\t\t\t<!-- All labels, as phrases, anywhere in the document-->
\t\t\t<phraselist pos="0" stem="1" weight="20" foreach="1" />
\t\t\t<!-- Constituent words of the labels, appearing near each other, anywhere in the document. -->
\t\t\t<nearlist pos="0" stem="1" weight="50" foreach="1" />
\t\t</combine>

\t</content>

</rulebase>
`;

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

// ── Multipart body builder ────────────────────────────────────────────────────

interface MultipartField {
  name: string;
  value: Buffer | string;
  filename?: string;
  contentType?: string;
}

/**
 * Build a multipart/form-data body from an array of fields.
 * Returns the raw Buffer and the Content-Type header (including boundary).
 *
 * Using manual construction instead of the Node.js built-in FormData to guarantee
 * the Content-Type includes a boundary — required for Semaphore's JAX-RS/RESTEasy
 * endpoints which return HTTP 415 when the boundary is absent.
 */
function buildMultipart(fields: MultipartField[]): { body: Buffer; contentType: string } {
  const boundary = `----SemaphoreMCPBoundary${Date.now().toString(16)}`;
  const CRLF = "\r\n";
  const parts: Buffer[] = [];

  for (const field of fields) {
    let header = `--${boundary}${CRLF}`;
    header += `Content-Disposition: form-data; name="${field.name}"`;
    if (field.filename) header += `; filename="${field.filename}"`;
    header += CRLF;
    if (field.contentType) header += `Content-Type: ${field.contentType}${CRLF}`;
    header += CRLF;

    const value = Buffer.isBuffer(field.value) ? field.value : Buffer.from(field.value, "utf8");
    parts.push(Buffer.from(header), value, Buffer.from(CRLF));
  }
  parts.push(Buffer.from(`--${boundary}--${CRLF}`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface SemaphoreCategory {
  /** Taxonomy class name (e.g. "Bluey-Episodes", "IPTC-NewsML") */
  className: string;
  /** Category label (e.g. "Season 1 Episode 1 - Magic Xylophone") */
  label: string;
  /** Stable concept UUID from the taxonomy */
  id: string;
  /** Classification confidence score as a float returned by the CLS (0.0–1.0).
   *  Note: the `threshold` parameter uses a 0–100 integer scale (default 48),
   *  but the XML response contains scores as 0.0–1.0 floats. */
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

export interface SemaphoreLanguage {
  /** CLS language code, e.g. "en1", "fr1" — use this in classify() language param */
  id: string;
  /** Human-readable language name, e.g. "English" */
  name: string;
  /** True if this is the CLS default language */
  default: boolean;
  /** True if rules have been published for this language */
  hasRules: boolean;
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface KmmModel {
  id: string;
}

export interface KmmSparqlResult {
  /** Raw SPARQL XML result string */
  xml: string;
  /** Parsed bindings — each row is a map of variable name → value string */
  rows: Array<Record<string, string>>;
}

export class SemaphoreClient {
  private readonly clsHttp: AxiosInstance;
  private readonly kmmHttp: AxiosInstance;

  /** True when a host or explicit URL is configured (CLS reachable). */
  readonly configured: boolean;
  /** CLS base URL (e.g. http://semaphore.example.com:5058) */
  readonly baseUrl: string;
  /** KMM / Studio base URL (e.g. http://semaphore.example.com:5080) */
  readonly kmmBaseUrl: string;
  /** The raw hostname (for passing to Flux --classifier-host). */
  readonly clsHost: string | undefined;
  /** CLS port number (for passing to Flux --classifier-port). */
  readonly clsPort: number;
  /** True when KMM credentials are configured. */
  readonly kmmConfigured: boolean;

  /** @deprecated Use clsHost */
  get scsHost(): string | undefined { return this.clsHost; }
  /** @deprecated Use clsPort */
  get scsPort(): number { return this.clsPort; }

  /** Cached KMM API token (x-api-key) and its expiry epoch ms. */
  private kmmToken: string | null = null;
  private kmmTokenExpiry = 0;
  private readonly kmmUsername: string | undefined;
  private readonly kmmPassword: string | undefined;

  constructor(config: SemaphoreConfig) {
    const { host, scsPort, kmmPort, username, password, ssl, timeoutMs, url } = config;

    this.clsHost = host;
    this.clsPort = scsPort;
    this.configured = !!(host ?? url);
    this.kmmUsername = username;
    this.kmmPassword = password;

    const scheme = ssl ? "https" : "http";

    // Explicit URL override takes precedence over host:clsPort
    this.baseUrl = url ?? (host ? `${scheme}://${host}:${scsPort}` : "");
    this.kmmBaseUrl = host ? `${scheme}://${host}:${kmmPort}` : "";

    this.kmmConfigured = !!(host && (username ?? password));

    this.clsHttp = axios.create({
      baseURL: this.baseUrl || "http://localhost:5058",
      timeout: timeoutMs,
    });

    // KMM HTTP client — auth is handled dynamically via kmmApiKey()
    this.kmmHttp = axios.create({
      baseURL: this.kmmBaseUrl || "http://localhost:5080",
      timeout: timeoutMs,
    });

    this.clsHttp.interceptors.response.use(
      (res) => res,
      (err) => {
        const status = (err as { response?: { status?: number } }).response?.status;
        logger.debug("Semaphore CLS HTTP error", { status, message: String(err) });
        throw err;
      }
    );
  }

  // ── KMM authentication ───────────────────────────────────────────────────────

  /**
   * Return a valid KMM API token, performing the two-step Java EE form auth if
   * necessary or if the cached token has expired.
   *
   * Step 1: POST /j_security_check  (j_username + j_password form fields)
   *         → sets JSESSIONID cookie in the cookie jar string we hold in memory.
   * Step 2: GET  /api/token?lifeTime=86400  (with JSESSIONID cookie)
   *         → { tokenId: "<token>" }
   * Use result as  x-api-key: <token>  header on subsequent KMM requests.
   */
  private async kmmApiKey(): Promise<string> {
    const now = Date.now();
    // Re-use cached token if still valid (with a 60-second safety margin)
    if (this.kmmToken && now < this.kmmTokenExpiry - 60_000) {
      return this.kmmToken;
    }

    if (!this.kmmUsername || !this.kmmPassword) {
      throw new Error(
        "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD."
      );
    }

    // Step 1 — form login; capture Set-Cookie header manually (no cookie jar in axios)
    const loginBody = new URLSearchParams({
      j_username: this.kmmUsername,
      j_password: this.kmmPassword,
    }).toString();

    const loginRes = await this.kmmHttp.post("/j_security_check", loginBody, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      maxRedirects: 0,
      validateStatus: (s) => s < 400,
    });

    const setCookieHeader = loginRes.headers["set-cookie"];
    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
    const jsessionid = cookies
      .flatMap((c) => c.split(";"))
      .find((part) => part.trim().toUpperCase().startsWith("JSESSIONID="));

    if (!jsessionid) {
      throw new Error(
        "KMM login did not return a JSESSIONID cookie. Check SEMAPHORE_USERNAME / SEMAPHORE_PASSWORD."
      );
    }

    // Step 2 — exchange session for a long-lived API token
    const TOKEN_TTL_S = 86_400; // 24 hours
    const tokenRes = await this.kmmHttp.get<{ tokenId: string }>(
      `/api/token?lifeTime=${TOKEN_TTL_S}`,
      { headers: { Cookie: jsessionid.trim() } }
    );

    const token = tokenRes.data?.tokenId;
    if (!token) {
      throw new Error("KMM token endpoint did not return a tokenId.");
    }

    this.kmmToken = token;
    this.kmmTokenExpiry = now + TOKEN_TTL_S * 1_000;
    logger.debug("KMM API token acquired", { expiresIn: `${TOKEN_TTL_S}s` });
    return token;
  }

  /** Perform an authenticated GET against the KMM REST API. */
  private async kmmGet<T = unknown>(path: string): Promise<T> {
    const token = await this.kmmApiKey();
    const res = await this.kmmHttp.get<T>(path, {
      headers: { "x-api-key": token },
      validateStatus: (s) => s < 500,
    });
    if (res.status === 404) throw new Error(`KMM resource not found: ${path}`);
    if (res.status === 401 || res.status === 403) {
      // Token may have been invalidated on a server restart — clear and let caller retry
      this.kmmToken = null;
      throw new Error(`KMM authentication failed (HTTP ${res.status}) — credentials may have changed.`);
    }
    return res.data;
  }

  /** Perform an authenticated POST against the KMM REST API. */
  private async kmmPost<T = unknown>(
    path: string,
    body: unknown,
    contentType: string
  ): Promise<{ status: number; location?: string; data: T }> {
    const token = await this.kmmApiKey();
    const res = await this.kmmHttp.post<T>(path, body, {
      headers: { "x-api-key": token, "Content-Type": contentType },
      validateStatus: (s) => s < 500,
    });
    if (res.status === 401 || res.status === 403) {
      this.kmmToken = null;
      throw new Error(`KMM authentication failed (HTTP ${res.status}).`);
    }
    return {
      status: res.status,
      location: res.headers["location"] as string | undefined,
      data: res.data,
    };
  }

  // ── KMM model management ─────────────────────────────────────────────────────

  /**
   * List all models (taxonomies/ontologies) registered in KMM.
   * Calls GET /kmm/api/specialgraph:system/teamwork:Tag/rdf:instance
   * and returns the @graph array of model tag objects.
   */
  async listKmmModels(): Promise<KmmModel[]> {
    const data = await this.kmmGet<{ "@graph"?: Array<{ "@id": string }> }>(
      "/kmm/api/specialgraph:system/teamwork:Tag/rdf:instance"
    );
    return (data["@graph"] ?? []).map((item) => ({ id: item["@id"] }));
  }

  /**
   * Create a new taxonomy model in KMM.
   * Calls POST /kmm/api/sys/sys:Model/rdf:instance with application/ld+json.
   * Returns the new model's URI from the Location header (e.g. "model:MyModel").
   *
   * @param name              Short identifier used as the model name and URI suffix.
   * @param defaultNamespace  Base namespace for concepts in the model.
   * @param description       Optional human-readable description.
   */
  async createKmmModel(
    name: string,
    defaultNamespace: string,
    description?: string
  ): Promise<string> {
    const body: Record<string, unknown> = {
      "@type": ["sys:Model"],
      "rdfs:label": [{ "@value": name }],
      "swa:defaultNamespace": [{ "@value": defaultNamespace }],
    };
    if (description) {
      body["rdfs:comment"] = { "@value": description };
    }

    const { status, location } = await this.kmmPost(
      "/kmm/api/sys/sys:Model/rdf:instance",
      JSON.stringify(body),
      "application/ld+json"
    );

    if (status !== 201) {
      throw new Error(`KMM model creation returned HTTP ${status} (expected 201).`);
    }
    // Location is e.g. "../model:MyModel" — extract the model: part
    const modelUri = location?.replace(/^.*?(model:[^/\s]+).*$/, "$1") ?? `model:${name}`;
    return modelUri;
  }

  /**
   * Load a SKOS taxonomy into an existing KMM model via SPARQL LOAD.
   * Uses POST /kmm/api/{graphUri}/sparql with Content-Type application/sparql-update.
   * Always passes checkConstraints=false&runEditRules=false so that third-party
   * SKOS vocabularies (IPTC, EuroVoc, AGROVOC …) load without SHACL failures.
   *
   * @param modelUri  KMM model URI, e.g. "model:IPTCMediaTopics"
   * @param skosUrl   Public HTTP/HTTPS URL of the SKOS RDF file to load.
   */
  async kmmLoadSkos(modelUri: string, skosUrl: string): Promise<void> {
    const sparql = `LOAD <${skosUrl}>`;
    const { status } = await this.kmmPost(
      `/kmm/api/${modelUri}/sparql?checkConstraints=false&runEditRules=false`,
      sparql,
      "application/sparql-update"
    );
    if (status !== 200 && status !== 204) {
      throw new Error(`SPARQL LOAD returned HTTP ${status}. The SKOS URL may be unreachable from the KMM server.`);
    }
  }

  /**
   * Delete a KMM model and all its triples permanently.
   * THIS IS IRREVERSIBLE. Does not remove published CLS rule sets — deactivate
   * those separately via the CLS publish-set API.
   *
   * @param modelUri  KMM model URI, e.g. "model:MyModel"
   */
  async kmmDeleteModel(modelUri: string): Promise<void> {
    const token = await this.kmmApiKey();
    const res = await this.kmmHttp.delete(
      `/kmm/api/sys/${modelUri}`,
      {
        headers: { "x-api-key": token },
        validateStatus: (s) => s < 500,
      }
    );
    if (res.status !== 200 && res.status !== 204) {
      throw new Error(`Failed to delete KMM model ${modelUri} (HTTP ${res.status}).`);
    }
  }

  /**
   * Run a SPARQL SELECT query against a KMM model graph.
   * Calls GET /kmm/api/{graphUri}/sparql?query=<encoded>.
   *
   * @param modelUri  KMM model URI, e.g. "model:IPTCMediaTopics"
   * @param query     SPARQL SELECT query string.
   */
  async kmmSparqlQuery(modelUri: string, query: string): Promise<KmmSparqlResult> {
    const encoded = encodeURIComponent(query);
    const xml = await this.kmmGet<string>(
      `/kmm/api/${modelUri}/sparql?query=${encoded}`
    );
    const xmlStr = typeof xml === "string" ? xml : JSON.stringify(xml);

    // Parse SPARQL XML results into row objects
    const rows: Array<Record<string, string>> = [];
    const resultRe = /<result>([\s\S]*?)<\/result>/g;
    const bindingRe = /<binding\s+name="([^"]+)"[^>]*>[\s\S]*?<(?:uri|literal)[^>]*>([^<]*)<\/(?:uri|literal)>/g;
    let resultMatch: RegExpExecArray | null;
    while ((resultMatch = resultRe.exec(xmlStr)) !== null) {
      const row: Record<string, string> = {};
      let bm: RegExpExecArray | null;
      while ((bm = bindingRe.exec(resultMatch[1])) !== null) {
        row[bm[1]] = bm[2];
      }
      rows.push(row);
    }

    return { xml: xmlStr, rows };
  }

  /**
   * Run a SPARQL UPDATE (INSERT DATA / DELETE DATA / DELETE+INSERT / LOAD) against a KMM model.
   * Unlike kmmSparqlQuery (SELECT only), this modifies model triples.
   *
   * Always passes checkConstraints=false&runEditRules=false so that standard SPARQL
   * UPDATE operations work without triggering Semaphore's SHACL validation.
   *
   * Common use cases:
   *   • Add sem:guid to concepts (required by ContextualCitation.kid template)
   *   • Fix or backfill labels
   *   • Remove unwanted triples before publishing
   *
   * @param modelUri  KMM model URI, e.g. "model:UNESCO"
   * @param sparql    SPARQL UPDATE string (INSERT DATA / DELETE DATA / etc.)
   */
  async kmmSparqlUpdate(modelUri: string, sparql: string): Promise<void> {
    const { status } = await this.kmmPost(
      `/kmm/api/${modelUri}/sparql?checkConstraints=false&runEditRules=false`,
      sparql,
      "application/sparql-update"
    );
    if (status !== 200 && status !== 204) {
      throw new Error(`SPARQL UPDATE returned HTTP ${status}. Check the query syntax and model URI.`);
    }
  }

  /**
   * Trigger a KMM publisher run for a model, pushing rules to the Classification Server.
   *
   * Always uses async=true by default because large models (1000+ concepts) time out
   * on synchronous publish calls. The job ID can be polled with kmmPublishJobStatus().
   *
   * @param modelUri    KMM model URI, e.g. "model:UNESCO"
   * @param options     Optional publish parameters:
   *   config       — publisher config name (default: use the model's active config)
   *   environment  — target environment name (default: the model's configured environment)
   *   language     — language code (default: "en")
   *   async        — use async publish (default: true; set false only for tiny test models)
   */
  async kmmPublish(
    modelUri: string,
    options: {
      config?: string;
      environment?: string;
      language?: string;
      async?: boolean;
    } = {}
  ): Promise<{ accepted: boolean; jobId?: string; status?: string }> {
    // Build query string manually — URLSearchParams encodes slashes (%2F) inside
    // the path parameter value, which prevents JAX-RS from routing the request.
    // Colons in the model URI are encoded (%3A) but path separators are left as-is.
    const encModelUri = modelUri.replace(/:/g, "%3A");
    const pathValue = `publisher/${encModelUri}/publish`;
    const qsParts = [`path=${pathValue}`];
    if (options.language) qsParts.push(`language=${encodeURIComponent(options.language)}`);
    if (options.config) qsParts.push(`config=${encodeURIComponent(options.config)}`);
    if (options.environment) qsParts.push(`environment=${encodeURIComponent(options.environment)}`);
    if (options.async !== false) qsParts.push("async=true");

    const { status, data } = await this.kmmPost<{ status?: string; jobId?: string; message?: string }>(
      `/kmm/api?${qsParts.join("&")}`,
      "",
      "application/json"
    );

    if (status === 202 || status === 200 || status === 204) {
      const d = data ?? {};
      return { accepted: true, jobId: d.jobId, status: d.status };
    }

    // Detect "Environment doesn't exist" — this means no publisher environment is configured
    // in Semaphore Studio. The environment must be set up via:
    //   Studio → Administration → Publisher → Classification Server Environments → Add
    //   (Name: any label, Host: cls-host, Port: cls-port)
    // Then pass options.environment = "<that name>" to retry.
    const msg = (data as Record<string, unknown>)?.message as string | undefined;
    if (status === 404 && msg?.includes("Environment doesn't exist")) {
      const envName = options.environment ?? "null (not specified)";
      throw new Error(
        `Publish failed: publisher environment "${envName}" not found.\n` +
        `Publisher environments must be configured in Semaphore Studio:\n` +
        `  Studio → Administration → Publisher → Classification Server Environments → Add\n` +
        `  (Name: <any label>, Host: ${this.clsHost ?? "cls-host"}, Port: ${this.clsPort})\n` +
        `Then retry: semaphore_publish model_uri="${modelUri}" environment="<name>"`
      );
    }

    throw new Error(
      `Publish request returned HTTP ${status}${msg ? `: ${msg}` : ""}. ` +
      `Check the model URI, publisher config, and that a workspace exists (Studio → Publisher tab).`
    );
  }

  /**
   * Check the status of an async publish job.
   * Poll this after kmmPublish() to wait for completion.
   *
   * Typical status values: ACCEPTED, RUNNING, COMPLETE, FAILED.
   *
   * @param modelUri  KMM model URI used in the original kmmPublish() call
   * @param jobId     Job ID returned by kmmPublish()
   */
  async kmmPublishJobStatus(
    modelUri: string,
    jobId: string
  ): Promise<{ status: string; message?: string }> {
    try {
      const data = await this.kmmGet<{ status?: string; message?: string }>(
        `/kmm/api?path=publisher/${modelUri}/job/${jobId}`
      );
      return { status: data.status ?? "UNKNOWN", message: data.message };
    } catch {
      return { status: "UNKNOWN" };
    }
  }

  /**
   * Poll a KMM publish job until it completes, fails, or times out.
   *
   * @param modelUri   KMM model URI used in kmmPublish()
   * @param jobId      Job ID returned by kmmPublish()
   * @param timeoutMs  Max wait time in ms (default: 300 000 = 5 min)
   * @param pollMs     Polling interval in ms (default: 5 000 = 5 s)
   */
  async waitForPublish(
    modelUri: string,
    jobId: string,
    timeoutMs = 300_000,
    pollMs = 5_000
  ): Promise<{ status: "COMPLETE" | "FAILED" | "TIMEOUT"; message?: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const result = await this.kmmPublishJobStatus(modelUri, jobId);
      if (result.status === "COMPLETE") return { status: "COMPLETE", message: result.message };
      if (result.status === "FAILED") return { status: "FAILED", message: result.message };
    }
    return { status: "TIMEOUT" };
  }

  /**
   * Download the publisher workspace config ZIP for a model.
   *
   * The ZIP typically contains:
   *   • Publisher XML config file(s) (e.g. Semaphore-Publisher-CS-only.xml)
   *   • templates/ directory with .kid rule template files
   *
   * Correct workspace endpoint (verified against Semaphore 5.10.1):
   *   GET /kmm/api/publisher/workspace/{encodedUri}/config
   * where encodedUri = encodeURIComponent("urn:x-evn-master:{ModelName}")
   *
   * NOTE: A previous (incorrect) pattern used a double-slash prefix:
   *   /kmm/api//{encodedUri}/publisher/workspace/{encodedUri}/config  ← WRONG
   * That URL returns HTTP 400 "invalid uris: publisher" on current Semaphore builds.
   *
   * @returns ZIP buffer, or null if no workspace exists yet for this model.
   */
  async kmmDownloadPublishConfigZip(modelUri: string): Promise<Buffer | null> {
    const modelName = modelUri.replace(/^model:/, "");
    const encodedUri = encodeURIComponent(`urn:x-evn-master:${modelName}`);
    const token = await this.kmmApiKey();
    const res = await this.kmmHttp.get(
      `/kmm/api/publisher/workspace/${encodedUri}/config`,
      {
        headers: { "x-api-key": token },
        responseType: "arraybuffer",
        validateStatus: (s) => s < 500,
      }
    );
    // 404 = workspace does not exist (never initialized via Studio UI)
    // 400 = legacy double-slash URL used; no config either way — return null so caller creates fresh
    if (res.status === 404 || res.status === 400) return null;
    if (res.status !== 200) {
      throw new Error(`Failed to download publish config (HTTP ${res.status}).`);
    }
    return Buffer.from(res.data as ArrayBuffer);
  }

  /**
   * Upload a publisher workspace config ZIP for a model.
   *
   * Uses multipart/form-data POST (field name "file") to the workspace config endpoint.
   * Returns on HTTP 204 (success) or throws on failure.
   *
   * PREREQUISITE: The workspace must already exist (i.e. the model's Publisher tab must
   * have been opened in Semaphore Studio at least once). If not, POST returns HTTP 403
   * with "permission: sempubpermissions:UploadModelConfiguration" — that message is
   * misleading; the real issue is the workspace file doesn't exist on the server.
   * Fix: open Studio → model → Publisher tab to initialize the workspace, then retry.
   */
  /**
   * Grant the publisher workspace upload permission on a KMM model via JSON-Patch.
   *
   * The Semaphore publisher workspace requires the `sempubpermissions:UploadModelConfiguration`
   * permission before a config ZIP can be uploaded. By default this is only granted when a
   * user opens the model's Publisher tab in Semaphore Studio.
   *
   * This method grants it programmatically via the PATCH /sys/{graphUri} endpoint
   * (RFC 6902 JSON-Patch, Content-Type: application/json-patch+json) — confirmed working in
   * Semaphore 5.10.1. It appends the given principal (default: "user:admin") to the
   * sempubpermissions:UploadModelConfiguration array on the model's sys graph node.
   *
   * NOTE: This grants the API-level permission but does NOT create the workspace ZIP file
   * on the server filesystem. If the workspace file has never been initialised (model was
   * created via API and the Publisher tab was never opened), the upload will still fail
   * with 403 even after granting the permission. In that case the Studio Publisher tab must
   * be opened once to initialise the workspace directory.
   *
   * @param modelUri   KMM model URI, e.g. "model:IPTCMediaTopics"
   * @param principal  JSON-LD @id of the user/group to grant, default "user:admin"
   */
  async kmmGrantPublisherPermission(
    modelUri: string,
    principal = "user:admin"
  ): Promise<void> {
    const modelName = modelUri.replace(/^model:/, "");
    const graphUri = `model:${modelName}`;
    const encodedGraph = encodeURIComponent(graphUri);
    const token = await this.kmmApiKey();

    const patch = [
      {
        op: "add",
        path: "@graph/0/sempubpermissions:UploadModelConfiguration/-",
        value: { "@id": principal },
      },
    ];

    const res = await this.kmmHttp.patch(
      `/kmm/api/sys/${encodedGraph}`,
      patch,
      {
        headers: {
          "x-api-key": token,
          "Content-Type": "application/json-patch+json",
        },
        validateStatus: (s) => s < 500,
      }
    );

    if (res.status !== 200 && res.status !== 204) {
      logger.warn("kmmGrantPublisherPermission returned non-success", {
        status: res.status,
        modelUri,
        principal,
      });
    } else {
      logger.info("Granted sempubpermissions:UploadModelConfiguration", {
        modelUri,
        principal,
      });
    }
  }

  async kmmUploadPublishConfigZip(modelUri: string, zipBuffer: Buffer): Promise<void> {
    const modelName = modelUri.replace(/^model:/, "");
    const encodedUri = encodeURIComponent(`urn:x-evn-master:${modelName}`);
    const token = await this.kmmApiKey();

    const { body, contentType } = buildMultipart([
      { name: "file", value: zipBuffer, filename: "config.zip", contentType: "application/zip" },
    ]);

    const doUpload = async () =>
      this.kmmHttp.post(
        `/kmm/api/publisher/workspace/${encodedUri}/config`,
        body,
        {
          headers: { "x-api-key": token, "Content-Type": contentType },
          validateStatus: (s) => s < 500,
        }
      );

    let res = await doUpload();

    // On 403 try granting the permission via JSON-Patch and retry once.
    // This handles models created via API that have never had the Publisher tab opened.
    // Note: the grant alone is sufficient when the workspace file already exists on the
    // server (i.e. the model was created in Studio or the Publisher tab was opened once).
    if (res.status === 403) {
      logger.info("kmmUploadPublishConfigZip got 403 — attempting auto-grant of UploadModelConfiguration", { modelUri });
      try {
        await this.kmmGrantPublisherPermission(modelUri);
        res = await doUpload();
      } catch {
        // Permission grant failed — fall through to the informative error below
      }
    }

    if (res.status === 403) {
      throw new Error(
        `Publisher workspace for ${modelUri} has not been initialized. ` +
        `Open Semaphore Studio, navigate to the model's Publisher tab to initialize the workspace, then retry. ` +
        `(HTTP 403 "UploadModelConfiguration" — the workspace file simply does not exist yet.)`
      );
    }

    if (res.status !== 204 && res.status !== 200) {
      throw new Error(`Failed to upload publish config (HTTP ${res.status}).`);
    }
  }

  /**
   * Patch the publisher workspace config ZIP for a plain-SKOS model.
   *
   * Standard Semaphore publisher configs use SKOS-XL reification (skosxl:prefLabel
   * + skosxl:Label nodes) for label lookups. Plain-SKOS vocabularies that use
   * skos:prefLabel literals directly (UNESCO, EuroVoc, AGROVOC) will generate only
   * a single rule (for the ConceptScheme) with the default config.
   *
   * This method fixes that by:
   *   1. Downloading the current workspace config ZIP (or creating a fresh one)
   *   2. Replacing AllResources → AllConcepts in the publisher XML
   *      (AllConcepts generates one CLS rule per skos:Concept; AllResources only
   *      generates rules at the ConceptScheme level)
   *   3. Adding a PlainSkosModel bean that overrides the SPARQL queries to use
   *      plain skos:prefLabel and skos:altLabel instead of SKOS-XL reification
   *   4. Ensuring the ContextualCitation.kid rule template is present
   *   5. Re-uploading the patched ZIP
   *
   * @returns Human-readable summary of what was changed (or a no-op message if already patched).
   */
  async kmmPatchPublishConfigForPlainSkos(modelUri: string): Promise<string> {
    // Try to download the existing workspace config ZIP
    let zip: JSZip;
    const existing = await this.kmmDownloadPublishConfigZip(modelUri);
    if (existing) {
      zip = await JSZip.loadAsync(existing);
      logger.debug("Downloaded existing publisher config ZIP", { modelUri, size: existing.length });
    } else {
      zip = new JSZip();
      logger.debug("No existing publisher config — creating fresh ZIP", { modelUri });
    }

    // Find the main publisher XML config file (skip sub-directory imports)
    const xmlFilename = Object.keys(zip.files).find(
      (f) =>
        f.endsWith(".xml") &&
        !f.includes("/import/") &&
        !zip.files[f].dir
    );

    const currentXml = xmlFilename
      ? await zip.files[xmlFilename].async("string")
      : "";

    // Check what needs to change
    const alreadyHasAllConcepts = currentXml.includes('parent="AllConcepts"');
    const alreadyHasPlainSkos = currentXml.includes("PlainSkosModel");

    if (alreadyHasAllConcepts && alreadyHasPlainSkos) {
      return (
        `Publisher config for ${modelUri} is already patched for plain SKOS.\n` +
        "No changes needed — proceed with semaphore_publish to rebuild the rule set."
      );
    }

    const changes: string[] = [];
    if (!alreadyHasAllConcepts) {
      changes.push("AllResources → AllConcepts (one rule per skos:Concept)");
    }
    if (!alreadyHasPlainSkos) {
      changes.push(
        "Added PlainSkosModel bean — overrides label SPARQL to use skos:prefLabel / skos:altLabel"
      );
    }

    // Write the canonical patched XML (replaces any existing XML config entirely)
    const targetFilename = xmlFilename ?? "Semaphore-Publisher-CS-only.xml";
    zip.file(targetFilename, PLAIN_SKOS_PUBLISHER_XML);

    // Ensure the ContextualCitation.kid template is present
    if (!zip.files["templates/ContextualCitation.kid"]) {
      zip.file("templates/ContextualCitation.kid", CONTEXTUAL_CITATION_TEMPLATE);
      changes.push("Added templates/ContextualCitation.kid");
    }

    // Generate and upload patched ZIP
    const zipBuffer = Buffer.from(
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
    );
    await this.kmmUploadPublishConfigZip(modelUri, zipBuffer);

    logger.debug("Uploaded patched publisher config ZIP", { modelUri, changes });
    return (
      `Publisher config for ${modelUri} patched and uploaded successfully.\n` +
      `Changes applied:\n${changes.map((c) => `  • ${c}`).join("\n")}\n\n` +
      "Next step: run semaphore_publish to rebuild the CLS rule set with the new config."
    );
  }

  // ── CLS methods ─────────────────────────────────────────────────────────────

  /** Returns true if the Classification Server (CLS) is reachable. */
  async healthCheck(): Promise<{ healthy: boolean; version?: string }> {
    if (!this.configured) return { healthy: false };
    try {
      const res = await this.clsHttp.get<string>("/?op=version", {
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
   * List available language packs in the Classification Server.
   *
   * CLS language codes use an indexed format (e.g. "en1", "fr1") not ISO codes.
   * Use the returned `id` values for the `language` parameter in classify() calls.
   * The default language (usually "en1") is used when no language is specified.
   */
  async listClsLanguages(): Promise<SemaphoreLanguage[]> {
    const xml = await this.postXmlOp("listlanguages");
    const languages: SemaphoreLanguage[] = [];
    for (const el of xmlAll(xml, "language")) {
      const a = xmlAttrs(el);
      if (a.id) {
        languages.push({
          id: a.id,
          name: a.name ?? a.id,
          default: a.default === "true",
          hasRules: a.has_rules_defined === "true",
        });
      }
    }
    return languages;
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
    const { body, contentType } = buildMultipart([
      { name: "body", value: content },
      { name: "threshold", value: String(threshold) },
      { name: "singlearticle", value: "true" },
    ]);

    const res = await this.clsHttp.post<string>("/", body, {
      headers: { "Content-Type": contentType },
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

  private async postXmlOp(op: string, publishSet?: string): Promise<string> {
    let xmlInput = `<?xml version="1.0" ?><request op="${op}">`;
    if (publishSet) xmlInput += `<publish_set>${publishSet}</publish_set>`;
    xmlInput += "</request>";

    const { body, contentType } = buildMultipart([
      { name: "XML_INPUT", value: xmlInput },
    ]);

    const res = await this.clsHttp.post<string>("/", body, {
      headers: { "Content-Type": contentType },
      responseType: "text",
    });
    return String(res.data);
  }
}

