/**
 * Semaphore Classification Server (CLS) + KMM MCP tools.
 *
 * The CLS API is XML-based over HTTP. Key configuration:
 *   SEMAPHORE_URL = http://<host>:<port>   (default CLS port: 5058)
 *
 * Architecture:
 *   Port 5058 — Classification Server (CLS): classifies text via XML API.
 *   Port 5080 — Semaphore Studio (KMM): taxonomy authoring web UI + REST API.
 *
 * For bulk classification, use Flux's built-in Semaphore support:
 *   flux_import extra_args: ["--classifier-host", "<host>", "--classifier-port", "5058",
 *                            "--classifier-path", "/", "--classifier-http"]
 *   Note: --classifier-http is required when the CLS endpoint is plain HTTP (not HTTPS).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerSemaphoreTools(server: McpServer, clients: MarkLogicClients): void {
  const { semaphore } = clients;

  // ── semaphore_status ──────────────────────────────────────────────────────────
  server.tool(
    "semaphore_status",
    "Check whether the Semaphore Classification Server (SCS) is configured and reachable, and return its version. " +
    "Run this first before any other semaphore_* tool to confirm connectivity.\n\n" +
    "CONFIGURATION: Set SEMAPHORE_URL in the MCP server .env to the SCS base URL, e.g. http://semaphore:5058",
    {},
    async () => {
      if (!semaphore.configured) {
        return {
          content: [{
            type: "text",
            text:
              "Semaphore is not configured.\n\n" +
              "Set SEMAPHORE_URL in the MCP server .env to the base URL of the Semaphore Classification Server.\n" +
              "Example: SEMAPHORE_URL=http://semaphore.example.com:5058\n\n" +
              "Note: port 5058 is the default SCS port. Your deployment may use a different port.",
          }],
          isError: true,
        };
      }
      const { healthy, version } = await semaphore.healthCheck();
      if (!healthy) {
        return {
          content: [{
            type: "text",
            text:
              `Semaphore Classification Server at ${semaphore.baseUrl} is not reachable.\n\n` +
              "Check that the SCS service is running and SEMAPHORE_URL is correct.",
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text",
          text: `Semaphore Classification Server is healthy.\n\nURL: ${semaphore.baseUrl}\nVersion: ${version ?? "(unknown)"}`,
        }],
      };
    }
  );

  // ── semaphore_studio_status ───────────────────────────────────────────────────
  server.tool(
    "semaphore_studio_status",
    "Check whether Semaphore Studio (KMM — Knowledge Model Manager) is configured and reachable. " +
    "Studio runs on a separate port from the Classification Server (default: 5080 vs 5058). " +
    "Use this to verify connectivity before building or inspecting taxonomy models via the KMM API.\n\n" +
    "CONFIGURATION: Set SEMAPHORE_HOST (shared with SCS), SEMAPHORE_KMM_PORT (default 5080), " +
    "SEMAPHORE_USERNAME, and SEMAPHORE_PASSWORD in the MCP server .env.",
    {},
    async () => {
      if (!semaphore.configured) {
        return {
          content: [{
            type: "text",
            text:
              "Semaphore is not configured.\n\n" +
              "Set SEMAPHORE_HOST in the MCP server .env to enable both SCS and KMM connectivity.\n" +
              "Example:\n" +
              "  SEMAPHORE_HOST=semaphore.example.com\n" +
              "  SEMAPHORE_KMM_PORT=5080          # default\n" +
              "  SEMAPHORE_USERNAME=admin\n" +
              "  SEMAPHORE_PASSWORD=admin",
          }],
          isError: true,
        };
      }
      if (!semaphore.kmmBaseUrl) {
        return {
          content: [{
            type: "text",
            text:
              "KMM URL could not be constructed — SEMAPHORE_HOST is not set.\n" +
              "Set SEMAPHORE_HOST (and optionally SEMAPHORE_KMM_PORT) to enable Studio connectivity.",
          }],
          isError: true,
        };
      }
      const { healthy, statusCode } = await semaphore.kmmHealthCheck();
      if (!healthy) {
        return {
          content: [{
            type: "text",
            text:
              `Semaphore Studio (KMM) at ${semaphore.kmmBaseUrl} is not reachable.\n\n` +
              "Check that the Studio service is running and SEMAPHORE_KMM_PORT is correct (default: 5080).",
          }],
          isError: true,
        };
      }
      const authNote = semaphore.kmmConfigured
        ? "Credentials configured (SEMAPHORE_USERNAME / SEMAPHORE_PASSWORD)."
        : "No credentials configured — set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD for authenticated KMM API access.";
      const statusNote = statusCode === 401 || statusCode === 403
        ? `\nServer responded with HTTP ${statusCode} — authentication required. Check credentials.`
        : statusCode === 200
          ? "\nServer responded with HTTP 200."
          : `\nServer responded with HTTP ${statusCode ?? "(unknown)"}.`;
      return {
        content: [{
          type: "text",
          text:
            `Semaphore Studio (KMM) is reachable.\n\n` +
            `URL: ${semaphore.kmmBaseUrl}` +
            statusNote +
            `\n${authNote}`,
        }],
      };
    }
  );

  // ── semaphore_publish_sets ────────────────────────────────────────────────────
  server.tool(
    "semaphore_publish_sets",
    "List published rule sets (equivalent to models/taxonomies) loaded in the Semaphore Classification Server. " +
    "Each publish set is a named set of classification rules derived from a Semaphore taxonomy. " +
    "The active sets are combined into the current rulenet used for all classification requests. " +
    "Use the class names returned here (and from semaphore_classes) to understand what taxonomy domains are available.",
    {},
    async () => {
      if (!semaphore.configured) {
        return {
          content: [{ type: "text", text: "Semaphore is not configured. Set SEMAPHORE_URL in the MCP server .env." }],
          isError: true,
        };
      }
      try {
        const sets = await semaphore.listPublishSets();
        if (sets.length === 0) {
          return {
            content: [{ type: "text", text: "No publish sets found. The Classification Server may have no rules loaded." }],
          };
        }
        const lines = [
          "SEMAPHORE PUBLISH SETS (loaded taxonomies/models)",
          "─".repeat(50),
          "",
          ...sets.map(s =>
            `  ${s.active ? "✓ ACTIVE" : "  inactive"} | ${s.name} | type: ${s.type}`
          ),
          "",
          `Total: ${sets.length} publish set(s). Active sets are combined into the current rulenet.`,
          "",
          "Use semaphore_classes to see the classification class names (e.g. 'Bluey-Episodes').",
          "Pass a publish set name as the multiarticle param to scope classification to one set.",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_classes ─────────────────────────────────────────────────────────
  server.tool(
    "semaphore_classes",
    "List classification classes from the active Semaphore rulenet. " +
    "Each class corresponds to a top-level taxonomy domain (e.g. 'Bluey-Episodes', 'IPTC-NewsML'). " +
    "Classification results are grouped by class name in the META elements of the XML response. " +
    "Use the class names here to understand what taxonomy domains will appear in classification output.",
    {},
    async () => {
      if (!semaphore.configured) {
        return {
          content: [{ type: "text", text: "Semaphore is not configured. Set SEMAPHORE_URL in the MCP server .env." }],
          isError: true,
        };
      }
      try {
        const classes = await semaphore.listClasses();
        if (classes.length === 0) {
          return {
            content: [{ type: "text", text: "No classification classes found. The rulenet may be empty." }],
          };
        }
        const lines = [
          "SEMAPHORE CLASSIFICATION CLASSES",
          "─".repeat(50),
          "",
          ...classes.map(c => `  ${c.name}  (${c.ruleCount} rules)`),
          "",
          `Total: ${classes.length} class(es)`,
          "",
          "These class names appear as the 'className' field in semaphore_classify results.",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_cls_languages ───────────────────────────────────────────────────
  server.tool(
    "semaphore_cls_languages",
    "List available language packs in the Semaphore Classification Server.\n\n" +
    "CLS language codes use an INDEXED format (e.g. 'en1', 'fr1') not standard ISO codes. " +
    "You must use these indexed codes in classify() language parameters, not 'en' or 'en-US'.\n\n" +
    "Use this tool to discover which language codes are installed and have rules defined. " +
    "The default language is used automatically when no language is specified in classification requests.",
    {},
    async () => {
      if (!semaphore.configured) {
        return {
          content: [{ type: "text", text: "Semaphore is not configured. Set SEMAPHORE_URL in the MCP server .env." }],
          isError: true,
        };
      }
      try {
        const languages = await semaphore.listClsLanguages();
        if (languages.length === 0) {
          return {
            content: [{ type: "text", text: "No languages found. The Classification Server may have no language packs installed." }],
          };
        }
        const lines = [
          "CLS LANGUAGE PACKS",
          "─".repeat(50),
          "",
          ...languages.map(l =>
            `  ${l.default ? "★ DEFAULT" : "         "}  ${l.id.padEnd(8)}  ${l.name}${l.hasRules ? "  [rules loaded]" : "  [no rules]"}`
          ),
          "",
          `Total: ${languages.length} language(s)`,
          "",
          "Use the 'id' value (e.g. 'en1') — not ISO codes like 'en' or 'en-US' — when specifying",
          "a language in classification requests. The default language is used automatically.",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_kmm_models_list ─────────────────────────────────────────────────
  server.tool(
    "semaphore_kmm_models_list",
    "List all taxonomy models (ontologies) registered in Semaphore Studio / KMM (Knowledge Model Manager). " +
    "Each model corresponds to a taxonomy that can be published to the Classification Server (CLS) as a rule set. " +
    "Use this to discover existing models before creating a new one or loading SKOS content.\n\n" +
    "CONFIGURATION: Requires SEMAPHORE_HOST, SEMAPHORE_USERNAME, and SEMAPHORE_PASSWORD in the MCP server .env. " +
    "KMM runs on a separate port from CLS (default: SEMAPHORE_KMM_PORT=5080). " +
    "Authentication uses a two-step Java EE form login — Basic auth is NOT supported by KMM.",
    {},
    async () => {
      if (!semaphore.kmmBaseUrl) {
        return {
          content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }],
          isError: true,
        };
      }
      if (!semaphore.kmmConfigured) {
        return {
          content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD in the MCP server .env." }],
          isError: true,
        };
      }
      try {
        const models = await semaphore.listKmmModels();
        if (models.length === 0) {
          return {
            content: [{ type: "text", text: "No models found in KMM. Use semaphore_kmm_model_create to create a new taxonomy model." }],
          };
        }
        const lines = [
          "KMM TAXONOMY MODELS",
          "─".repeat(50),
          "",
          ...models.map((m, i) => `  ${i + 1}. ${m.id}`),
          "",
          `Total: ${models.length} model(s)`,
          "",
          "Use semaphore_kmm_skos_load to load a SKOS vocabulary into an existing model.",
          "Use semaphore_kmm_sparql to query model content.",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_kmm_model_create ────────────────────────────────────────────────
  server.tool(
    "semaphore_kmm_model_create",
    "Create a new taxonomy model in Semaphore Studio / KMM. " +
    "A model is the container for a taxonomy or ontology — it must exist before loading any SKOS content. " +
    "After creation, use semaphore_kmm_skos_load to populate it with concepts from a public RDF/SKOS URL.\n\n" +
    "Returns the new model URI (e.g. 'model:IPTCMediaTopics') which is required for semaphore_kmm_skos_load and semaphore_kmm_sparql.\n\n" +
    "NEXT STEP: After creating a model, load taxonomy content with semaphore_kmm_skos_load, " +
    "then use semaphore_publish_config_fix_plain_skos (for plain skos:prefLabel vocabularies) and " +
    "semaphore_publish to build the CLS rule set. Use semaphore_classify to test results.",
    {
      name: z.string().describe(
        "Short identifier used as the model name and URI suffix. " +
        "Must be a single word or CamelCase with no spaces (e.g. 'IPTCMediaTopics', 'EuroVoc')."
      ),
      default_namespace: z.string().describe(
        "Base namespace URI for concepts in this model " +
        "(e.g. 'http://cv.iptc.org/newscodes/mediatopic/', 'http://eurovoc.europa.eu/')."
      ),
      description: z.string().optional().describe("Human-readable description of this taxonomy model."),
    },
    async ({ name, default_namespace, description }) => {
      if (!semaphore.kmmBaseUrl) {
        return {
          content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }],
          isError: true,
        };
      }
      if (!semaphore.kmmConfigured) {
        return {
          content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }],
          isError: true,
        };
      }
      try {
        const modelUri = await semaphore.createKmmModel(name, default_namespace, description);
        const lines = [
          "KMM MODEL CREATED",
          "─".repeat(50),
          "",
          `  Name:              ${name}`,
          `  Model URI:         ${modelUri}`,
          `  Default namespace: ${default_namespace}`,
          description ? `  Description:       ${description}` : "",
          "",
          "NEXT STEPS:",
          `  1. Load SKOS:       semaphore_kmm_skos_load  model_uri="${modelUri}"  skos_url="<rdf-url>"`,
          `  2. Verify concepts: semaphore_kmm_sparql     model_uri="${modelUri}"`,
          `                      query: SELECT (COUNT(?s) AS ?n) WHERE { ?s a <http://www.w3.org/2004/02/skos/core#Concept> }`,
          "  3. Add sem:guid:    semaphore_kmm_sparql_update — add sem:guid to each concept (required for",
          "                      ContextualCitation.kid template). Use a SPARQL INSERT with UUID generation.",
          "  4. Fix plain SKOS:  semaphore_publish_config_fix_plain_skos  model_uri=\"" + modelUri + "\"",
          "                      (Skip if vocabulary uses SKOS-XL reification; required for plain skos:prefLabel)",
          `  5. Publish to CLS:  semaphore_publish  model_uri="${modelUri}"  async=true`,
          "  6. Verify in CLS:   semaphore_publish_sets → confirm new rule set is active",
          "  7. Test:            semaphore_classify  threshold=0  content=\"<sample text>\"",
        ].filter(Boolean);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_kmm_skos_load ───────────────────────────────────────────────────
  server.tool(
    "semaphore_kmm_skos_load",
    "Import a SKOS taxonomy into an existing KMM model using the Studio backup/import API. " +
    "This mirrors exactly how Semaphore Studio UI imports a vocabulary file — the MCP server " +
    "fetches the RDF file from the given URL and POSTs it to KMM as multipart/form-data. " +
    "This is the recommended approach for all external SKOS vocabularies (IPTC, EuroVoc, AGROVOC, etc.) " +
    "as it creates the correct model structure that the Semaphore Publisher can query for rule generation.\n\n" +
    "IMPORTANT — ASYNC:\n" +
    "  The import is asynchronous and may take 1-3 minutes for large vocabularies.\n" +
    "  The tool polls until complete (up to 5 minutes) and returns when done.\n\n" +
    "SKOS URL EXAMPLES:\n" +
    "  IPTC Media Topics (RDF/XML): https://cv.iptc.org/newscodes/mediatopic/?lang=x-all&format=rdfxml\n" +
    "  Note: check the vocabulary's download API for the correct RDF URL — HTML endpoints return HTML.\n\n" +
    "AFTER LOADING:\n" +
    "  1. Run semaphore_publish_config_fix_plain_skos (for plain skos:prefLabel vocabularies)\n" +
    "  2. Run semaphore_publish to build the CLS rule set\n" +
    "  3. Run semaphore_classify to test classification",
    {
      model_uri: z.string().describe(
        "KMM model URI to import into, e.g. 'model:IPTCMediaTopics'. " +
        "Get from semaphore_kmm_models_list or use the URI returned by semaphore_kmm_model_create."
      ),
      skos_url: z.string().url().describe(
        "Public HTTP/HTTPS URL of the SKOS RDF file to fetch and import. " +
        "The MCP server downloads this file and posts it to KMM. " +
        "Supports RDF/XML, Turtle (.ttl), N-Triples (.nt), and JSON-LD (.jsonld)."
      ),
      format: z.string().optional().describe(
        "Override the RDF format MIME type (e.g. 'application/rdf+xml', 'text/turtle'). " +
        "Auto-detected from Content-Type or URL extension if omitted."
      ),
      overwrite: z.boolean().optional().describe(
        "If true, replaces existing triples in the model. Default: false (adds to existing)."
      ),
    },
    async ({ model_uri, skos_url, format, overwrite }) => {
      if (!semaphore.kmmBaseUrl) {
        return {
          content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }],
          isError: true,
        };
      }
      if (!semaphore.kmmConfigured) {
        return {
          content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }],
          isError: true,
        };
      }
      try {
        // Step 1: start the async import job
        const jobId = await semaphore.kmmImportSkos(model_uri, skos_url, { format, overwrite });

        const lines = [
          "SKOS IMPORT STARTED",
          "─".repeat(50),
          "",
          `  Model:   ${model_uri}`,
          `  Source:  ${skos_url}`,
          `  Job ID:  ${jobId}`,
          "",
          "Polling for completion (up to 5 minutes)...",
        ];

        // Step 2: poll until complete
        const pollResult = await semaphore.kmmWaitForAsyncJob(jobId, 300_000);

        lines.push("");
        if (pollResult.status === "COMPLETE") {
          lines.push("✓ Import COMPLETE");
          lines.push("");
          lines.push("NEXT STEPS:");
          lines.push(`  1. Fix plain SKOS config (for plain skos:prefLabel vocabularies):`);
          lines.push(`     semaphore_publish_config_fix_plain_skos  model_uri="${model_uri}"`);
          lines.push(`  2. Publish to CLS:  semaphore_publish  model_uri="${model_uri}"  wait_for_completion=true`);
          lines.push(`  3. Verify classes:  semaphore_classes`);
          lines.push(`  4. Test:            semaphore_classify  threshold=0  content="<news text>"`);
        } else if (pollResult.status === "FAILED") {
          lines.push(`✗ Import FAILED: ${pollResult.error ?? "unknown error"}`);
          lines.push("Check Semaphore Studio for details.");
          return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
        } else {
          lines.push("⚠ Import timed out (5 min). Check Semaphore Studio for job status.");
          lines.push(`  Job ID: ${jobId}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_kmm_sparql ──────────────────────────────────────────────────────
  server.tool(
    "semaphore_kmm_sparql",
    "Run a SPARQL SELECT query against a KMM model graph to inspect taxonomy content. " +
    "Use this to verify concept counts after loading SKOS, browse hierarchy, or extract concept URIs and labels " +
    "for use in classification workflows.\n\n" +
    "COMMON QUERIES:\n" +
    "  Count concepts:    SELECT (COUNT(?s) AS ?n) WHERE { ?s a skos:Concept }\n" +
    "  Top concepts:      SELECT ?s ?label WHERE { ?s a skos:Concept ; skos:topConceptOf ?scheme ; skos:prefLabel ?label } LIMIT 20\n" +
    "  Narrow concepts:   SELECT ?parent ?child ?label WHERE { ?parent skos:narrower ?child . ?child skos:prefLabel ?label } LIMIT 30\n" +
    "  By keyword:        SELECT ?s ?label WHERE { ?s skos:prefLabel ?label FILTER(CONTAINS(LCASE(STR(?label)), 'sport')) }\n\n" +
    "NOTE: SPARQL prefixes are NOT pre-declared — use full URIs or declare prefixes inline:\n" +
    "  PREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n" +
    "  PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>",
    {
      model_uri: z.string().describe(
        "KMM model URI to query, e.g. 'model:IPTCMediaTopics'. " +
        "Get from semaphore_kmm_models_list."
      ),
      query: z.string().describe(
        "SPARQL SELECT query. Always declare prefixes inline (PREFIX skos: ...). " +
        "Use LIMIT to avoid large result sets."
      ),
    },
    async ({ model_uri, query }) => {
      if (!semaphore.kmmBaseUrl) {
        return {
          content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }],
          isError: true,
        };
      }
      if (!semaphore.kmmConfigured) {
        return {
          content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }],
          isError: true,
        };
      }
      try {
        const result = await semaphore.kmmSparqlQuery(model_uri, query);
        const { rows } = result;

        if (rows.length === 0) {
          return {
            content: [{
              type: "text",
              text:
                "SPARQL query returned 0 results.\n\n" +
                "Possible causes:\n" +
                "  • The model may be empty — run semaphore_kmm_skos_load first\n" +
                "  • Prefixes may not be declared — add PREFIX skos: <http://www.w3.org/2004/02/skos/core#> etc.\n" +
                "  • The model URI may be wrong — check semaphore_kmm_models_list\n\n" +
                `Model: ${model_uri}\nQuery: ${query}`,
            }],
          };
        }

        const headers = Object.keys(rows[0]);
        const lines = [
          `SPARQL RESULTS — ${model_uri}`,
          "─".repeat(50),
          `Columns: ${headers.join(", ")}  |  Rows: ${rows.length}`,
          "",
        ];

        // Table output
        const colWidths = headers.map(h =>
          Math.min(50, Math.max(h.length, ...rows.slice(0, 100).map(r => (r[h] ?? "").length)))
        );
        const header = headers.map((h, i) => h.padEnd(colWidths[i])).join("  ");
        const divider = colWidths.map(w => "─".repeat(w)).join("  ");
        lines.push(header);
        lines.push(divider);
        for (const row of rows.slice(0, 100)) {
          lines.push(headers.map((h, i) => (row[h] ?? "").slice(0, colWidths[i]).padEnd(colWidths[i])).join("  "));
        }
        if (rows.length > 100) {
          lines.push(`… ${rows.length - 100} more rows omitted`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_kmm_sparql_update ───────────────────────────────────────────────
  server.tool(
    "semaphore_kmm_sparql_update",
    "Run a SPARQL UPDATE (INSERT DATA / DELETE DATA / DELETE+INSERT / LOAD) against a KMM model graph.\n\n" +
    "Unlike semaphore_kmm_sparql (SELECT only), this tool modifies model triples. " +
    "It always passes checkConstraints=false&runEditRules=false to bypass Semaphore SHACL validation — " +
    "required for bulk updates like adding sem:guid to concepts.\n\n" +
    "COMMON USE CASES:\n\n" +
    "1. Add sem:guid to every concept (REQUIRED before publishing with ContextualCitation.kid template):\n" +
    "   PREFIX sem: <http://www.smartlogic.com/2014/08/semaphore-core#>\n" +
    "   PREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n" +
    "   INSERT { ?c sem:guid ?g }\n" +
    "   WHERE { ?c a skos:Concept . FILTER NOT EXISTS { ?c sem:guid ?x } . BIND(STRUUID() AS ?g) }\n\n" +
    "2. Delete unwanted triples:\n" +
    "   DELETE { ?s <http://purl.org/dc/terms/created> ?o } WHERE { ?s <http://purl.org/dc/terms/created> ?o }\n\n" +
    "3. Load additional RDF from a URL:\n" +
    "   LOAD <https://example.com/extra-labels.ttl>\n\n" +
    "NOTE: Very large updates (100k+ triples) may time out. Use LIMIT in WHERE clauses to batch.\n" +
    "After updating labels, re-publish with semaphore_publish to rebuild the CLS rule set.",
    {
      model_uri: z.string().describe(
        "KMM model URI to update, e.g. 'model:UNESCO'. " +
        "Get from semaphore_kmm_models_list."
      ),
      sparql: z.string().describe(
        "SPARQL UPDATE string. Supported: INSERT DATA, DELETE DATA, DELETE/INSERT, LOAD, CLEAR. " +
        "Always declare prefixes inline (PREFIX skos: ...). " +
        "Always passes checkConstraints=false — no need to add that."
      ),
    },
    async ({ model_uri, sparql }) => {
      if (!semaphore.kmmBaseUrl) {
        return {
          content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }],
          isError: true,
        };
      }
      if (!semaphore.kmmConfigured) {
        return {
          content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }],
          isError: true,
        };
      }
      try {
        await semaphore.kmmSparqlUpdate(model_uri, sparql);
        return {
          content: [{
            type: "text",
            text:
              "SPARQL UPDATE COMPLETE\n" +
              "─".repeat(50) + "\n\n" +
              `  Model: ${model_uri}\n\n` +
              "The update was applied successfully (HTTP 204).\n\n" +
              "NEXT STEPS:\n" +
              `  • Verify the change: semaphore_kmm_sparql  model_uri="${model_uri}"  query="SELECT ..."  \n` +
              `  • Re-publish if labels changed: semaphore_publish  model_uri="${model_uri}"`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_publish ─────────────────────────────────────────────────────────
  server.tool(
    "semaphore_publish",
    "Trigger a Semaphore KMM publish — compile the taxonomy model into CLS classification rules.\n\n" +
    "Publishing converts the RDF taxonomy in KMM into a .rules file that the Classification Server (CLS) " +
    "uses to classify text. You must re-publish after any change to model content or publisher config.\n\n" +
    "PREREQUISITES:\n" +
    "  1. PUBLISHER WORKSPACE: Created automatically the first time a publish is triggered.\n" +
    "     No Studio interaction required — workspace init happens as a side effect of publish.\n\n" +
    "  2. PUBLISHER ENVIRONMENT: Must be configured once in Studio Admin (one-time, global).\n" +
    "     Studio: Administration → Publisher → Classification Server Environments → Add\n" +
    "     (Name: any label, Host: <cls-host>, Port: <cls-port>)\n" +
    "     After that, all future model publishes auto-discover this environment.\n\n" +
    "ASYNC vs SYNC:\n" +
    "  Large models (500+ concepts) will time out on synchronous publish. " +
    "  Use async=true (the default) — the tool returns a job ID immediately. " +
    "  Poll the job status by calling this tool again with job_id to check completion.\n\n" +
    "PLAIN SKOS MODELS:\n" +
    "  If the model uses plain skos:prefLabel (not SKOS-XL), run " +
    "semaphore_publish_config_fix_plain_skos BEFORE publishing. " +
    "  Without the fix, the publisher will only generate 1 rule (for the ConceptScheme) " +
    "instead of one rule per concept.\n\n" +
    "AFTER PUBLISH:\n" +
    "  • Check semaphore_publish_sets to confirm the new rule set is loaded\n" +
    "  • Run semaphore_classify with threshold=0 to test classification\n" +
    "  • If all scores are 0, the rulenet index is still building — wait a minute and retry",
    {
      model_uri: z.string().describe(
        "KMM model URI to publish, e.g. 'model:UNESCO'. " +
        "Get from semaphore_kmm_models_list."
      ),
      config: z.string().optional().describe(
        "Publisher config name to use (optional). Leave blank to use the model's default config. " +
        "Config names are the names of publisher config files in the workspace ZIP."
      ),
      environment: z.string().optional().describe(
        "Target publisher environment name (required if multiple environments configured, " +
        "or if the server requires an explicit environment). " +
        "Environments are configured in Semaphore Studio: " +
        "Administration → Publisher → Classification Server Environments. " +
        "If omitted and no default is set, publish fails with 'Environment doesn't exist'."
      ),
      language: z.string().optional().describe(
        "Language code to publish (default: 'en'). " +
        "Must match the language codes configured in the publisher config."
      ),
      async: z.boolean().optional().describe(
        "Use async publish (default: true). Recommended for all models — sync publish times out " +
        "for models with more than a few hundred concepts."
      ),
      wait_for_completion: z.boolean().optional().describe(
        "If true, poll for publish completion by querying the model's publish event log (up to 5 minutes). " +
        "Returns COMPLETE/FAILED/TIMEOUT. Use this to confirm the publish finished before classifying."
      ),
    },
    async ({ model_uri, config, environment, language, async: useAsync, wait_for_completion }) => {
      if (!semaphore.kmmBaseUrl) {
        return {
          content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }],
          isError: true,
        };
      }
      if (!semaphore.kmmConfigured) {
        return {
          content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }],
          isError: true,
        };
      }
      try {
        const sinceTimestamp = new Date().toISOString();
        const result = await semaphore.kmmPublish(model_uri, {
          config,
          environment,
          language: language ?? "en",
          async: useAsync !== false,
        });

        const lines = [
          "SEMAPHORE PUBLISH TRIGGERED",
          "─".repeat(50),
          "",
          `  Model:       ${model_uri}`,
          `  Language:    ${language ?? "en"}`,
          config       ? `  Config:      ${config}` : "",
          environment  ? `  Environment: ${environment}` : "",
          result.jobId ? `  Job ID:      ${result.jobId}` : "",
          "",
        ].filter(s => s !== undefined);

        if (result.accepted && (wait_for_completion === true)) {
          // Prefer async job polling when we have a real job ID (more reliable than SPARQL graph polling)
          const rawPoll = result.jobId
            ? await semaphore.kmmWaitForAsyncJob(result.jobId, 300_000)
            : await semaphore.waitForPublish(model_uri, sinceTimestamp);
          const pollMessage = (rawPoll as { message?: string }).message
            ?? (rawPoll as { error?: string }).error;
          lines.push(`  Status: ${rawPoll.status}`);
          if (pollMessage) lines.push(`  Message: ${pollMessage}`);
          lines.push("");
          if (rawPoll.status === "COMPLETE") {
            // Auto-check loaded rule count — a well-formed publish of 100+ concepts should
            // produce many rules. ≤1 rule is the unmistakeable "plain SKOS without GRAPH
            // clause" symptom: only the auto-generated ConceptScheme root rule was produced.
            const modelName = model_uri.replace(/^model:/, "").toLowerCase();
            const ruleCount = await semaphore.clsRuleCount(modelName);
            lines.push(`  Rules loaded in CLS: ${ruleCount >= 0 ? ruleCount : "(unknown)"}`);
            lines.push("");
            if (ruleCount >= 0 && ruleCount <= 1) {
              lines.push("⚠  WARNING: Only 1 rule loaded — this strongly suggests a publisher config problem.");
              lines.push("   Root cause: the default publisher config uses SKOS-XL label queries that hit");
              lines.push("   the empty default graph of the global SPARQL endpoint. Each model's data lives");
              lines.push(`   in the named graph urn:x-evn-master:${model_uri.replace(/^model:/, "")}.`);
              lines.push("   Fix: run  semaphore_publish_config_fix_plain_skos  then re-publish.");
            } else if (ruleCount > 1) {
              lines.push("✓ Publish completed successfully.");
              lines.push("  • semaphore_classify  threshold=0  content='<test text>'  — test classification");
            } else {
              lines.push("Publish completed. Verify the rule set:");
              lines.push("  • semaphore_publish_sets  — confirm new rule set is active");
              lines.push("  • semaphore_classify  threshold=0  content='<test text>'");
            }
          } else if (rawPoll.status === "FAILED") {
            lines.push("Publish FAILED. Check Semaphore Studio Publisher tab for error details.");
          } else {
            lines.push("Publish timed out (5 min). Check Semaphore Studio Publisher tab for status.");
          }
        } else if (result.accepted) {
          lines.push(`  Status: ${result.status ?? "ACCEPTED"}`);
          lines.push("");
          lines.push("The publish job is running asynchronously.");
          lines.push("After a minute or two, verify completion:");
          lines.push("  • semaphore_publish_sets  — confirm new rule set appears as active");
          lines.push("  • semaphore_classes       — confirm class names are present");
          lines.push("  • semaphore_classify  threshold=0  content='<test text>'");
          lines.push("");
          lines.push("If classification scores are all 0, the rulenet index is still building.");
          lines.push("Wait 1-2 minutes and retry semaphore_classify.");
        } else {
          lines.push("  Status: COMPLETE (synchronous publish)");
          lines.push("");
          lines.push("Publish complete. Run semaphore_publish_sets to confirm the rule set is active.");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_publish_config_fix_plain_skos ────────────────────────────────────
  server.tool(
    "semaphore_publish_config_fix_plain_skos",
    "Fix the Semaphore publisher workspace config for a plain-SKOS model (one that uses skos:prefLabel literals, not SKOS-XL).\n\n" +
    "ROOT CAUSE THIS FIXES:\n" +
    "  The Semaphore publisher's SparqlEndpoint connects to a GLOBAL SPARQL endpoint shared across all\n" +
    "  models. Each model's data lives in a named graph (urn:x-evn-master:{ModelName}), not in the\n" +
    "  default graph. The stock publisher config has no GRAPH clause, so all label queries hit the\n" +
    "  empty default graph — returning 0 rows. Result: only 1 rule is published (the auto-generated\n" +
    "  ConceptScheme root rule) instead of one rule per concept.\n\n" +
    "  Additionally, the default config uses SKOS-XL reification for label lookups, which doesn't\n" +
    "  work for vocabularies that store labels as plain skos:prefLabel literals.\n\n" +
    "WHAT THIS TOOL DOES:\n" +
    "  1. Downloads the current publisher workspace config ZIP from KMM (or creates a fresh one)\n" +
    "  2. Replaces the default config with AllConcepts + PlainSkosModel — generates one rule per skos:Concept\n" +
    "  3. Injects GRAPH <urn:x-evn-master:{ModelName}> clauses into all label SPARQL queries\n" +
    "     so the publisher finds data in the correct named graph\n" +
    "  4. Uses plain skos:prefLabel / skos:altLabel instead of SKOS-XL reification\n" +
    "  5. Ensures the ContextualCitation.kid rule template is present\n" +
    "  6. Re-uploads the patched ZIP to the KMM workspace\n\n" +
    "WHEN TO USE THIS:\n" +
    "  Use for ANY model you've loaded via semaphore_kmm_skos_load — both plain SKOS vocabularies\n" +
    "  (UNESCO, EuroVoc, AGROVOC, IPTC) and SKOS-XL ones benefit from the GRAPH clause fix.\n" +
    "  Symptom: semaphore_publish completes successfully but only 1 rule loads in CLS.\n\n" +
    "BEFORE RUNNING:\n" +
    "  1. WORKSPACE: Initialized automatically — this tool bootstraps the workspace by triggering\n" +
    "     an initial publish if no workspace exists yet. No Studio interaction required.\n\n" +
    "  2. Ensure concepts have sem:guid triples — use semaphore_kmm_sparql_update:\n" +
    "     PREFIX sem: <http://www.smartlogic.com/2014/08/semaphore-core#>\n" +
    "     PREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n" +
    "     INSERT { ?c sem:guid ?g }\n" +
    "     WHERE { ?c a skos:Concept . FILTER NOT EXISTS { ?c sem:guid ?x } . BIND(STRUUID() AS ?g) }\n\n" +
    "AFTER RUNNING:\n" +
    "  Run semaphore_publish (with wait_for_completion=true) to rebuild the CLS rule set.\n" +
    "  The tool will automatically check the loaded rule count and warn if it's still only 1.",
    {
      model_uri: z.string().describe(
        "KMM model URI to patch, e.g. 'model:UNESCO'. " +
        "Get from semaphore_kmm_models_list."
      ),
    },
    async ({ model_uri }) => {
      if (!semaphore.kmmBaseUrl) {
        return {
          content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }],
          isError: true,
        };
      }
      if (!semaphore.kmmConfigured) {
        return {
          content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }],
          isError: true,
        };
      }
      try {
        const summary = await semaphore.kmmPatchPublishConfigForPlainSkos(model_uri);
        const lines = [
          "PUBLISHER CONFIG FIX — PLAIN SKOS",
          "─".repeat(50),
          "",
          summary,
          "",
          "NEXT STEPS:",
          `  1. Publish to CLS:  semaphore_publish  model_uri="${model_uri}"  async=true`,
          "  2. Verify rules:    semaphore_publish_sets → confirm the rule set is active",
          "  3. Test:            semaphore_classify  threshold=0  content=\"<test text>\"",
          "",
          "TIP: If classification results are empty after publish, check that sem:guid was",
          "added to all concepts before publishing (required by ContextualCitation.kid):",
          `  semaphore_kmm_sparql  model_uri="${model_uri}"`,
          "  query: PREFIX sem: <http://www.smartlogic.com/2014/08/semaphore-core#>",
          "         SELECT (COUNT(?c) AS ?n) WHERE { ?c sem:guid ?g }",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_classify ────────────────────────────────────────────────────────
  server.tool(
    "semaphore_classify",
    "Classify text content using the Semaphore Classification Server (CLS). Returns scored taxonomy categories.\n\n" +
    "HOW IT WORKS:\n" +
    "  The CLS parses your text, matches it against the loaded classification rules (publish sets),\n" +
    "  and returns categories above the threshold score. Each category has a class name (taxonomy domain),\n" +
    "  a label (concept name), a stable UUID, and a score (0–100).\n\n" +
    "USE THIS TOOL WHEN:\n" +
    "  - Testing classification output on sample text before building a pipeline\n" +
    "  - Classifying a small number of documents individually (for bulk, use Flux)\n" +
    "  - Verifying that a publish set produces the expected categories\n" +
    "  - Designing the MarkLogic document model for storing classification results\n\n" +
    "FOR BULK CLASSIFICATION (preferred for production):\n" +
    "  Use flux_import with extra_args to classify every document at ingest time:\n" +
    "    extra_args: [\"--classifier-host\", \"<host>\", \"--classifier-port\", \"<port>\",\n" +
    "                 \"--classifier-path\", \"/\", \"--classifier-http\"]\n" +
    "  Add --classifier-http when the CLS endpoint is plain HTTP (not HTTPS).\n" +
    "  Or use flux_reprocess with an SJS transform — but note that xdmp.httpPost() from MarkLogic\n" +
    "  pods may be blocked by Kubernetes network policy from reaching the CLS. Prefer Flux or\n" +
    "  pre-classify from the application tier.\n\n" +
    "THRESHOLD GUIDANCE:\n" +
    "  Default threshold is 48. Score range is 0–100.\n" +
    "  Use threshold=0 to see all candidate categories regardless of confidence.\n" +
    "  Production pipelines typically use 48–70 depending on precision requirements.\n\n" +
    "SCORE=0 NOTE:\n" +
    "  A freshly published rule set may return score=0 for all categories while the\n" +
    "  Semaphore Publisher service finishes building the rulenet index. If every category\n" +
    "  scores 0, use threshold=0 to see them, then re-run classification after the Publisher\n" +
    "  service has completed indexing (check Semaphore Studio → Publish tab for status).",
    {
      content: z.string().describe("Plain text or HTML content to classify"),
      threshold: z.number().int().min(0).max(100).optional().describe(
        "Minimum score (0–100) for a category to be included. Default: 0 (return all candidates). " +
        "The SCS default threshold is 48 — use 0 here to see all results for exploration."
      ),
    },
    async ({ content, threshold }) => {
      if (!semaphore.configured) {
        return {
          content: [{ type: "text", text: "Semaphore is not configured. Set SEMAPHORE_URL in the MCP server .env." }],
          isError: true,
        };
      }
      try {
        const result = await semaphore.classify(content, threshold ?? 0);
        const cats = result.categories;

        if (cats.length === 0) {
          return {
            content: [{
              type: "text",
              text:
                "SEMAPHORE CLASSIFICATION: No categories returned.\n\n" +
                "Possible causes:\n" +
                "  • Threshold is too high — all category scores are below the threshold value.\n" +
                "    Retry with threshold=0 to see every candidate regardless of score.\n" +
                "  • Score=0 for all matches — a freshly published rule set may score 0 while\n" +
                "    the Semaphore Publisher service is still building the rulenet index.\n" +
                "    Check Semaphore Studio → Publish tab for Publisher status, then retry.\n" +
                "  • No publish sets are loaded — run semaphore_publish_sets to check.\n" +
                "    If no sets are active, publish a model from Semaphore Studio first.\n" +
                "  • The content does not match any classification rules in the active rulenet.\n\n" +
                "Debug: run semaphore_classes to confirm classification classes are active.",
            }],
          };
        }

        // Group by className
        const byClass = new Map<string, typeof cats>();
        for (const cat of cats) {
          if (!byClass.has(cat.className)) byClass.set(cat.className, []);
          byClass.get(cat.className)!.push(cat);
        }

        const lines: string[] = [
          "SEMAPHORE CLASSIFICATION RESULTS",
          "─".repeat(50),
          `Content length: ${content.length} chars | Categories found: ${cats.length}`,
          "",
        ];

        for (const [className, items] of byClass) {
          // Sort by score descending
          const sorted = [...items].sort((a, b) => b.score - a.score);
          lines.push(`  CLASS: ${className} (${items.length} categories)`);
          for (const cat of sorted.slice(0, 20)) {
            const score = cat.score > 0
              ? ` [score: ${cat.score.toFixed(1)}]`
              : ` [score: 0]`;
            lines.push(`    • ${cat.label}${score}`);
            lines.push(`      id: ${cat.id}`);
          }
          if (sorted.length > 20) {
            lines.push(`    … and ${sorted.length - 20} more`);
          }
          lines.push("");
        }

        lines.push("─".repeat(50));
        lines.push("Store in MarkLogic as:");
        lines.push('  "classification": { "categories": [...], "topCategory": {...} }');
        lines.push("Then add a path range index on classification/categories/label for search facets.");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_publish_diagnose ────────────────────────────────────────────────
  server.tool(
    "semaphore_publish_diagnose",
    "Diagnose why a Semaphore taxonomy publish produced too few classification rules.\n\n" +
    "Compares three counts and flags any mismatch:\n" +
    "  • KMM concept count  — how many skos:Concept instances exist in the model (OE API)\n" +
    "  • Labeled concept count — how many concepts have an English skos:prefLabel (SPARQL)\n" +
    "  • CLS rule count     — how many rules are currently loaded in the Classification Server\n\n" +
    "A healthy publish of N concepts should load ~N rules. The classic failure mode is:\n" +
    "  KMM: 1392 concepts, Labels: 1391, CLS rules: 1\n" +
    "This means the publisher ran successfully but its SPARQL label queries hit the empty\n" +
    "default graph (not the model's named graph) and returned zero rows, so no concept rules\n" +
    "were written — only the auto-generated ConceptScheme root rule.\n\n" +
    "FIX: Run semaphore_publish_config_fix_plain_skos then re-publish.",
    {
      model_uri: z.string().describe(
        "KMM model URI to diagnose, e.g. 'model:IPTCMediaTopics'. " +
        "Get from semaphore_kmm_models_list."
      ),
    },
    async ({ model_uri }) => {
      if (!semaphore.kmmBaseUrl) {
        return {
          content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }],
          isError: true,
        };
      }
      const lines = [
        "PUBLISH DIAGNOSTICS",
        "─".repeat(50),
        `  Model: ${model_uri}`,
        "",
      ];

      // 1. KMM concept count via OE API
      const kmmCount = await semaphore.kmmConceptCount(model_uri);
      lines.push(`  KMM concept count (OE API):     ${kmmCount >= 0 ? kmmCount : "ERROR — could not query"}`);

      // 2. Labeled concept count via SPARQL
      let labelCount = -1;
      try {
        const modelName = model_uri.replace(/^model:/, "");
        const r = await semaphore.kmmSparqlQuery(model_uri,
          `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
           SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE {
             GRAPH <urn:x-evn-master:${modelName}> {
               ?c a skos:Concept ; skos:prefLabel ?l .
               FILTER(LANG(?l) = "en")
             }
           }`
        );
        const n = r.rows[0]?.["n"];
        labelCount = n !== undefined ? parseInt(String(n), 10) : -1;
      } catch { /* ignore */ }
      lines.push(`  English prefLabels (SPARQL):     ${labelCount >= 0 ? labelCount : "ERROR — could not query"}`);

      // 3. CLS rule count
      const publishSetName = model_uri.replace(/^model:/, "").toLowerCase();
      const ruleCount = await semaphore.clsRuleCount(publishSetName);
      lines.push(`  CLS rules loaded:               ${ruleCount >= 0 ? ruleCount : "unknown (CLS not reachable or publish set not found)"}`);

      lines.push("");

      // Diagnosis
      const healthy = kmmCount > 0 && ruleCount > 1 && (ruleCount >= kmmCount * 0.5);
      if (healthy) {
        lines.push("✓ HEALTHY — rule count looks proportionate to concept count.");
        lines.push("  Run semaphore_classify to verify classification quality.");
      } else if (ruleCount >= 0 && ruleCount <= 1 && kmmCount > 0) {
        lines.push("✗ PROBLEM DETECTED: Only 1 rule loaded despite " + kmmCount + " concepts in KMM.");
        lines.push("");
        lines.push("  Root cause: the publisher's SPARQL label queries hit the empty default graph.");
        lines.push("  Each model's data lives in the named graph:");
        lines.push(`    urn:x-evn-master:${model_uri.replace(/^model:/, "")}`);
        lines.push("  Without an explicit GRAPH clause, 0 labels are found → 0 concept rules.");
        lines.push("");
        lines.push("  FIX (two steps):");
        lines.push(`    1. semaphore_publish_config_fix_plain_skos  model_uri="${model_uri}"`);
        lines.push(`    2. semaphore_publish  model_uri="${model_uri}"  wait_for_completion=true`);
      } else if (labelCount >= 0 && labelCount === 0 && kmmCount > 0) {
        lines.push("✗ PROBLEM DETECTED: " + kmmCount + " concepts exist but none have English prefLabels.");
        lines.push("  Check the language tags on your skos:prefLabel triples.");
        lines.push("  Run: semaphore_kmm_sparql to inspect what LANG() values are present:");
        lines.push(`    model_uri="${model_uri}"`);
        lines.push('    query: SELECT DISTINCT (LANG(?l) AS ?lang) (COUNT(?l) AS ?n) WHERE { ?c skos:prefLabel ?l } GROUP BY ?lang');
      } else if (kmmCount <= 0) {
        lines.push("✗ PROBLEM DETECTED: No concepts found in KMM.");
        lines.push(`  Run semaphore_kmm_skos_load to import a SKOS vocabulary into ${model_uri}.`);
      } else {
        lines.push("⚠  Results inconclusive — could not determine CLS rule count.");
        lines.push("  If classification returns nothing, run semaphore_publish_config_fix_plain_skos");
        lines.push("  and re-publish.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── semaphore_kmm_model_delete ────────────────────────────────────────────────
  server.tool(
    "semaphore_kmm_model_delete",
    "Permanently delete a KMM taxonomy model and ALL its concepts from Semaphore Studio.\n\n" +
    "⚠️  THIS ACTION IS IRREVERSIBLE. The model and all its triples are permanently removed.\n\n" +
    "IMPORTANT NOTES:\n" +
    "  • This does NOT remove published rule sets from the Classification Server (CLS).\n" +
    "    Published rule sets remain active in the CLS until manually deactivated via the CLS API.\n" +
    "  • You must set confirm=true to proceed — the tool will refuse without explicit confirmation.\n" +
    "  • Use semaphore_kmm_models_list to verify the model URI before deleting.",
    {
      model_uri: z.string().describe(
        "KMM model URI to delete, e.g. 'model:MyModel'. " +
        "Get from semaphore_kmm_models_list."
      ),
      confirm: z.boolean().describe(
        "Must be explicitly set to true to confirm deletion. " +
        "The tool will refuse to delete without this confirmation."
      ),
    },
    async ({ model_uri, confirm }) => {
      if (!semaphore.kmmBaseUrl) {
        return {
          content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }],
          isError: true,
        };
      }
      if (!semaphore.kmmConfigured) {
        return {
          content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }],
          isError: true,
        };
      }
      if (!confirm) {
        return {
          content: [{
            type: "text",
            text:
              `Deletion of ${model_uri} was NOT executed.\n\n` +
              "Set confirm=true to proceed. This action is irreversible.",
          }],
        };
      }
      try {
        await semaphore.kmmDeleteModel(model_uri);
        return {
          content: [{
            type: "text",
            text:
              `KMM MODEL DELETED\n` +
              "─".repeat(50) + "\n\n" +
              `  Model URI: ${model_uri}\n\n` +
              "The model and all its concepts have been permanently removed from KMM.\n\n" +
              "NOTE: Any published CLS rule sets derived from this model remain active in the\n" +
              "Classification Server until manually deactivated.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
