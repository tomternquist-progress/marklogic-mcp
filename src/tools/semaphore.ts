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
    "Load a SKOS taxonomy into an existing KMM model via SPARQL LOAD. " +
    "This is the standard way to import a public vocabulary (IPTC Media Topics, EuroVoc, AGROVOC, etc.) " +
    "into Semaphore — the KMM server fetches the RDF file directly from the given URL.\n\n" +
    "IMPORTANT — CONSTRAINT BYPASS:\n" +
    "  Third-party SKOS vocabularies routinely use properties (e.g. ikos:hasFacet) that fail " +
    "  Semaphore's built-in SHACL validation, returning HTTP 409 Conflict. This tool always passes " +
    "  checkConstraints=false&runEditRules=false to bypass this — required for all external SKOS.\n\n" +
    "AFTER LOADING:\n" +
    "  Use semaphore_kmm_sparql to verify concept count and spot-check labels.\n" +
    "  Then open Semaphore Studio UI to publish the model as a CLS rule set.\n\n" +
    "SKOS URL EXAMPLES:\n" +
    "  IPTC Media Topics: https://cv.iptc.org/newscodes/mediatopic/?lang=x-all&format=rdfxml\n" +
    "  Note: always check the vocabulary's API for the correct RDF/XML URL — HTML endpoints return HTML.",
    {
      model_uri: z.string().describe(
        "KMM model URI to load into, e.g. 'model:IPTCMediaTopics'. " +
        "Get from semaphore_kmm_models_list or use the URI returned by semaphore_kmm_model_create."
      ),
      skos_url: z.string().url().describe(
        "Public HTTP/HTTPS URL of the SKOS RDF file. " +
        "Must be accessible from the KMM server — the server fetches this URL directly. " +
        "Use RDF/XML format (not HTML or Turtle) for best compatibility."
      ),
    },
    async ({ model_uri, skos_url }) => {
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
        await semaphore.kmmLoadSkos(model_uri, skos_url);
        const lines = [
          "SKOS LOAD COMPLETE",
          "─".repeat(50),
          "",
          `  Model:    ${model_uri}`,
          `  Source:   ${skos_url}`,
          "",
          "NEXT STEPS:",
          `  1. Verify concept count:`,
          `     semaphore_kmm_sparql  model_uri="${model_uri}"`,
          `     query: SELECT (COUNT(?s) AS ?n) WHERE { ?s a <http://www.w3.org/2004/02/skos/core#Concept> }`,
          "  2. Spot-check labels:    semaphore_kmm_sparql with LIMIT 20 SELECT ?s ?label",
          "  3. Add sem:guid (required by ContextualCitation.kid template):",
          `     semaphore_kmm_sparql_update  model_uri="${model_uri}"`,
          "     sparql: PREFIX sem: <http://www.smartlogic.com/2014/08/semaphore-core#>",
          "             PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
          "             INSERT { ?c sem:guid ?g } WHERE {",
          "               ?c a skos:Concept . FILTER NOT EXISTS { ?c sem:guid ?x }",
          "               BIND(STRUUID() AS ?g) }",
          "  4. Fix plain SKOS config (if vocabulary uses plain skos:prefLabel, not SKOS-XL):",
          `     semaphore_publish_config_fix_plain_skos  model_uri="${model_uri}"`,
          `  5. Publish to CLS:  semaphore_publish  model_uri="${model_uri}"  async=true`,
          "  6. Verify in CLS:   semaphore_publish_sets → confirm new rule set is active",
          "  7. Test:            semaphore_classify  threshold=0  content=\"<sample text>\"",
          "",
          "NOTE: After publishing, classification scores may be 0 while the Publisher service",
          "finishes building the rulenet index. Re-run semaphore_classify after publish completes.",
        ];
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
        "Target environment name (optional). Leave blank to publish to all configured environments."
      ),
      language: z.string().optional().describe(
        "Language code to publish (default: 'en'). " +
        "Must match the language codes configured in the publisher config."
      ),
      async: z.boolean().optional().describe(
        "Use async publish (default: true). Recommended for all models — sync publish times out " +
        "for models with more than a few hundred concepts. Returns a job_id for status polling."
      ),
    },
    async ({ model_uri, config, environment, language, async: useAsync }) => {
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
          "",
        ].filter(s => s !== undefined);

        if (result.jobId) {
          lines.push(`  Status: ${result.status ?? "ACCEPTED"}`);
          lines.push(`  Job ID: ${result.jobId}`);
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
    "PROBLEM THIS SOLVES:\n" +
    "  The default Semaphore publisher config uses AllResources + SKOS-XL reification for label lookups. " +
    "  When publishing a vocabulary with plain skos:prefLabel (e.g. UNESCO Thesaurus, EuroVoc, AGROVOC), " +
    "  this produces only 1 CLS rule (for the ConceptScheme root) instead of one rule per concept. " +
    "  Classification then returns no results because no concept-level rules exist.\n\n" +
    "WHAT THIS TOOL DOES:\n" +
    "  1. Downloads the current publisher workspace config ZIP from KMM (or creates a fresh one)\n" +
    "  2. Replaces AllResources with AllConcepts — generates one rule per skos:Concept\n" +
    "  3. Adds a PlainSkosModel bean that overrides the label SPARQL queries to use\n" +
    "     plain skos:prefLabel / skos:altLabel instead of SKOS-XL reification\n" +
    "  4. Ensures the ContextualCitation.kid rule template is present\n" +
    "  5. Re-uploads the patched ZIP to the KMM workspace\n\n" +
    "WHEN TO USE THIS:\n" +
    "  Use for: UNESCO Thesaurus, EuroVoc, AGROVOC, IPTC rdfxml format, and any SKOS vocabulary\n" +
    "  that stores labels as skos:prefLabel literals on the concept node directly.\n" +
    "  Skip for: Vocabularies already using SKOS-XL (skosxl:prefLabel + skosxl:Label nodes).\n\n" +
    "BEFORE RUNNING:\n" +
    "  Ensure concepts have sem:guid triples — use semaphore_kmm_sparql_update to add them:\n" +
    "    PREFIX sem: <http://www.smartlogic.com/2014/08/semaphore-core#>\n" +
    "    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n" +
    "    INSERT { ?c sem:guid ?g }\n" +
    "    WHERE { ?c a skos:Concept . FILTER NOT EXISTS { ?c sem:guid ?x } . BIND(STRUUID() AS ?g) }\n\n" +
    "AFTER RUNNING:\n" +
    "  Run semaphore_publish to rebuild the CLS rule set with the patched config.",
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
}
