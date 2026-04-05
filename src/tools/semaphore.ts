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
    "USE THIS TOOL WHEN: the user wants to auto-tag documents with taxonomy concepts, classify content by topic or subject, " +
    "add controlled-vocabulary categories to documents, build faceted navigation from a thesaurus, or extract named concepts " +
    "from text. Semaphore is the Progress Data Platform's AI-powered taxonomy and auto-classification engine.\n\n" +
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

  // ── semaphore_task_list ───────────────────────────────────────────────────────
  server.tool(
    "semaphore_task_list",
    "List open working copies (tasks) in Semaphore KMM.\n\n" +
    "In Semaphore KMM, a 'task' is a working copy / branch of a taxonomy model — the governance mechanism\n" +
    "for proposing and reviewing changes before they are merged into master.\n\n" +
    "TASK LIFECYCLE:\n" +
    "  1. Create task in Studio (Model → Working Copies → New) — status: Uncommitted\n" +
    "  2. Edit taxonomy concepts in the task (isolated from master)\n" +
    "  3. Publish task to staging CLS via semaphore_publish task_name=... to test classification\n" +
    "  4. Validate with semaphore_classify against the staging rule set\n" +
    "  5. Commit task (Studio) → status: Committed\n" +
    "  6. Merge/implement task into master (Studio) → status: Implemented\n" +
    "  7. Publish master to production CLS via semaphore_publish (no task_name)\n\n" +
    "NAMED GRAPHS:\n" +
    "  Master graph:  urn:x-evn-master:{ModelName}\n" +
    "  Task graph:    urn:x-evn-tag:{ModelName}:{TaskName}\n\n" +
    "  The task graph contains only the delta (added/changed concepts) relative to master.\n" +
    "  When publishing a task, the publisher merges master + task delta to generate rules.\n\n" +
    "NOTE: Task creation and merging require Semaphore Studio UI.\n" +
    "      Use semaphore_publish with task_name to publish a task for classification testing.",
    {
      model_uri: z.string().optional().describe(
        "Filter tasks to a specific model, e.g. 'model:IPTCMediaTopics'. " +
        "Omit to list all tasks across all models (only shows Studio-created tasks with full metadata)."
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
        const tasks = await semaphore.listKmmTasks(model_uri);
        if (tasks.length === 0) {
          const scope = model_uri ? ` for ${model_uri}` : "";
          return {
            content: [{
              type: "text",
              text: `No open tasks found${scope}.\n\nTo create a task: Semaphore Studio → open model → Working Copies → New Working Copy.`,
            }],
          };
        }
        const lines = [
          "SEMAPHORE KMM TASKS (WORKING COPIES)",
          "─".repeat(50),
          "",
          ...tasks.map((t, i) => {
            const status = t.status ?? "unknown";
            const created = t.created ? ` | created: ${t.created.slice(0, 10)}` : "";
            return `  ${i + 1}. ${t.id}\n     Model: ${t.modelId} | Status: ${status}${created}`;
          }),
          "",
          `Total: ${tasks.length} task(s)`,
          "",
          "To publish a task for testing: semaphore_publish  model_uri=<model>  task_name=<taskName>",
          "To publish master to CLS:       semaphore_publish  model_uri=<model>",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_task_create ──────────────────────────────────────────────────────
  server.tool(
    "semaphore_task_create",
    "Create a new task (working copy) for a taxonomy model in Semaphore KMM.\n\n" +
    "A task isolates changes from the master graph so they can be tested and reviewed\n" +
    "before being merged. The task gets its own named graph (urn:x-evn-tag:{Model}:{Task}).\n\n" +
    "WORKFLOW AFTER CREATION:\n" +
    "  1. Edit concepts in the task (via Studio, or API tools that support task_name param)\n" +
    "  2. semaphore_publish model_uri=... task_name=... — publish task to CLS for testing\n" +
    "  3. semaphore_classify — validate classification results\n" +
    "  4. semaphore_task_commit — merge task into master (or via Studio UI)\n" +
    "  5. semaphore_publish model_uri=... — publish master to production CLS\n\n" +
    "COMPATIBILITY:\n" +
    "  The KMM API reference documents POST /{model}/semsys:hasTask/rdf:instance for task creation,\n" +
    "  but this endpoint is not yet implemented in Semaphore 5.10.x (the current latest release).\n" +
    "  The tool falls back to the legacy teamwork:Tag endpoint. Tasks created via the legacy endpoint\n" +
    "  may not appear in semaphore_task_list — use Studio UI for full task lifecycle support.",
    {
      model_uri: z.string().describe(
        "KMM model URI to create the task for, e.g. 'model:IPTCMediaTopics'. " +
        "Get from semaphore_kmm_models_list."
      ),
      label: z.string().describe(
        "Short name for the task / working copy, e.g. 'AddSynonyms' or 'Q1-2026-Updates'. " +
        "Used as the task identifier — avoid spaces and special characters."
      ),
      description: z.string().optional().describe(
        "Optional description of what changes this task will contain."
      ),
    },
    async ({ model_uri, label, description }) => {
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
        const result = await semaphore.createKmmTask(model_uri, label, description);
        const lines = [
          "SEMAPHORE TASK CREATED",
          "─".repeat(50),
          "",
          `  Task ID:    ${result.id}`,
          `  Model:      ${model_uri}`,
          `  Label:      ${label}`,
          description ? `  Description: ${description}` : "",
          "",
        ].filter(s => s !== "");

        if (!result.fullSupport) {
          lines.push(
            "⚠  Created via legacy API (teamwork:Tag) — Semaphore 5.10.x does not support",
            "   the semsys:hasTask endpoint. This task may not appear in semaphore_task_list.",
            "   For full task lifecycle support, create tasks via Semaphore Studio:",
            `   Studio → open ${model_uri} → Working Copies → New Working Copy`,
            "",
          );
        }

        lines.push(
          "Next steps:",
          `  1. Edit taxonomy in the task (via Studio or API)`,
          `  2. semaphore_publish  model_uri="${model_uri}"  task_name="${label}"`,
          `  3. semaphore_classify  — validate results`,
          `  4. semaphore_task_commit  model_uri="${model_uri}"  task_name="${label}"`,
        );

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_task_commit ────────────────────────────────────────────────────
  server.tool(
    "semaphore_task_commit",
    "Commit (merge) a task's changes into the master graph.\n\n" +
    "This merges the task's delta graph (urn:x-evn-tag:{Model}:{Task}) into the model's\n" +
    "master graph (urn:x-evn-master:{Model}). After committing, publish master to CLS.\n\n" +
    "COMPATIBILITY:\n" +
    "  The KMM API reference documents POST /sys/{taskGraphUri} for task commit,\n" +
    "  but this endpoint is not yet implemented in Semaphore 5.10.x (current latest release).\n" +
    "  The tool attempts the API call and provides Studio instructions as fallback.\n\n" +
    "AFTER COMMIT:\n" +
    "  semaphore_publish  model_uri=<model>  — publish master to production CLS",
    {
      model_uri: z.string().describe(
        "KMM model URI, e.g. 'model:IPTCMediaTopics'."
      ),
      task_name: z.string().describe(
        "Task name to commit, e.g. 'Test' from task:ATCDrugClassification:Test. " +
        "Use semaphore_task_list to discover open tasks."
      ),
    },
    async ({ model_uri, task_name }) => {
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
        const result = await semaphore.commitKmmTask(model_uri, task_name);
        const lines = [
          result.committed ? "SEMAPHORE TASK COMMITTED" : "SEMAPHORE TASK COMMIT — MANUAL ACTION REQUIRED",
          "─".repeat(50),
          "",
          result.message,
        ];

        if (result.committed) {
          lines.push(
            "",
            "Next step: publish master to production CLS:",
            `  semaphore_publish  model_uri="${model_uri}"`,
          );
        }

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
    "SKOS HIERARCHY DESIGN — BEST PRACTICES:\n" +
    "  When building a taxonomy from scratch, follow proper SKOS modeling:\n" +
    "  ✓ USE skos:narrower / skos:broader for hierarchy — child concepts must be proper narrower concepts,\n" +
    "    not synonyms. Each named service, product, or entity deserves its own skos:Concept node.\n" +
    "  ✓ USE skos:altLabel for genuine synonyms and abbreviations of THAT concept only\n" +
    "    (e.g. aws:EC2 skos:altLabel 'Elastic Compute Cloud', 'virtual machine', 'instance')\n" +
    "  ✗ DO NOT list child concept names as altLabels on a parent concept — this is a flat anti-pattern\n" +
    "    (e.g. putting 'EC2', 'Lambda', 'S3' as altLabels on an 'AWS' top concept is WRONG)\n" +
    "  ✓ USE skos:related for cross-cutting relationships between sibling branches\n" +
    "  ✓ Tag ALL labels with @en (or relevant language tag) — required for Semaphore CLS publishing\n" +
    "  ✗ Do NOT add dcterms:created, dcterms:description or other Dublin Core properties to the\n" +
    "    ConceptScheme — KMM rejects these with domain/range warnings. Use skos:definition instead.\n\n" +
    "  RECOMMENDED STRUCTURE per concept:\n" +
    "    <ns:EC2> a skos:Concept ;\n" +
    "        skos:inScheme <ns:MyScheme> ;\n" +
    "        skos:broader <ns:Compute> ;\n" +
    "        skos:prefLabel \"Amazon EC2\"@en ;\n" +
    "        skos:altLabel \"EC2\"@en, \"Elastic Compute Cloud\"@en, \"virtual machine\"@en .\n\n" +
    "  After loading, run semaphore_kmm_sparql_update with the SKOS-XL backfill query to make\n" +
    "  labels appear in Studio's 'Preferred Labels' managed section (not just raw Metadata).\n\n" +
    "  Use semaphore_taxonomy_scaffold to generate a properly structured SKOS skeleton,\n" +
    "  and semaphore_taxonomy_validate to check an existing model for structural issues.\n\n" +
    "CRITICAL — CONCEPTSCHEME URI CONVENTION:\n" +
    "  The Semaphore Publisher expects the ConceptScheme URI to follow a strict pattern:\n" +
    "    {default_namespace}{name}Taxonomy\n" +
    "  Example: model name='MoviesModel', namespace='http://example.org/ontology/movies/'\n" +
    "    → ConceptScheme URI must be: http://example.org/ontology/movies/MoviesModelTaxonomy\n\n" +
    "  If you use any other URI (e.g. ex:MoviesScheme), the publisher's concept-enumeration\n" +
    "  query will find no concepts and publish only 1 rule.\n\n" +
    "  The semaphore_taxonomy_scaffold tool generates the correct URI automatically — it is the\n" +
    "  recommended starting point for new taxonomies.\n\n" +
    "  For hand-crafted SKOS, use this pattern at the top of your Turtle:\n" +
    "    @prefix ns: <{default_namespace}> .\n" +
    "    ns:{name}Taxonomy a skos:ConceptScheme ;\n" +
    "        skos:prefLabel \"{name} Taxonomy\"@en ;\n" +
    "        skos:hasTopConcept ns:TopConcept1, ns:TopConcept2 .\n\n" +
    "NEXT STEP: After creating a model, load taxonomy content with semaphore_kmm_skos_load " +
    "(pass skos_content with the Turtle text for locally created taxonomies, or skos_url for public vocabulary endpoints). " +
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
        const ns = default_namespace.endsWith("/") || default_namespace.endsWith("#")
          ? default_namespace : default_namespace + "/";
        const expectedSchemeUri = `${ns}${name}Taxonomy`;
        const lines = [
          "KMM MODEL CREATED",
          "─".repeat(50),
          "",
          `  Name:              ${name}`,
          `  Model URI:         ${modelUri}`,
          `  Default namespace: ${default_namespace}`,
          description ? `  Description:       ${description}` : "",
          "",
          "REQUIRED — CONCEPTSCHEME URI CONVENTION:",
          "  The Semaphore Publisher finds concepts by querying for a ConceptScheme at a specific URI.",
          "  Your ConceptScheme MUST use this exact URI:",
          `    ${expectedSchemeUri}`,
          "",
          "  Turtle snippet to include at the top of your SKOS vocabulary:",
          `    @prefix ns: <${ns}> .`,
          `    ns:${name}Taxonomy a <http://www.w3.org/2004/02/skos/core#ConceptScheme> ;`,
          `        <http://www.w3.org/2004/02/skos/core#prefLabel> "${name} Taxonomy"@en ;`,
          `        <http://www.w3.org/2004/02/skos/core#hasTopConcept> ns:TopConcept1 .`,
          "",
          "  TIP: Use semaphore_taxonomy_scaffold — it generates this URI automatically.",
          "",
          "NEXT STEPS:",
          `  1. Load SKOS:       semaphore_kmm_skos_load  model_uri="${modelUri}"`,
          `                      skos_content="<turtle-or-rdf-text>"  (for locally created taxonomies — read file with Read tool)`,
          `                      skos_url="<public-https-url>"        (for publicly reachable vocabulary endpoints only)`,
          `  2. Verify concepts: semaphore_kmm_sparql     model_uri="${modelUri}"`,
          `                      query: PREFIX skos: <http://www.w3.org/2004/02/skos/core#>`,
          `                             SELECT (COUNT(?s) AS ?n) WHERE { GRAPH <urn:x-evn-master:${name}> { ?s a skos:Concept } }`,
          "  3. Validate:        semaphore_taxonomy_validate  model_uri=\"" + modelUri + "\"",
          "                      (checks hierarchy, orphans, ConceptScheme URI, missing labels)",
          "  4. Fix plain SKOS:  semaphore_publish_config_fix_plain_skos  model_uri=\"" + modelUri + "\"",
          "                      (Skip if vocabulary uses SKOS-XL reification; required for plain skos:prefLabel)",
          `  5. Publish to CLS:  semaphore_publish  model_uri="${modelUri}"  wait_for_completion=true`,
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
    "fetches the RDF file from the given URL (or uses inline content) and POSTs it to KMM as multipart/form-data. " +
    "This is the recommended approach for all external SKOS vocabularies (IPTC, EuroVoc, AGROVOC, etc.) " +
    "as it creates the correct model structure that the Semaphore Publisher can query for rule generation.\n\n" +
    "IMPORTANT — USE skos_content FOR LOCALLY CREATED TAXONOMIES:\n" +
    "  The MCP server is a remote process (not running on the same machine as the user).\n" +
    "  When a taxonomy is written to a local file (e.g. /tmp/my_taxonomy.ttl), the MCP server\n" +
    "  cannot reach it via localhost:PORT — use skos_content to pass the RDF text directly instead.\n" +
    "  Read the file with the Read tool and pass its content as the skos_content parameter.\n" +
    "  Use skos_url only for publicly reachable HTTP/HTTPS URLs (GitHub Gist, official vocabulary\n" +
    "  endpoints like https://cv.iptc.org/..., etc.).\n\n" +
    "WHY THIS TOOL (not semaphore_kmm_sparql_update) FOR LOADING VOCABULARIES:\n" +
    "  semaphore_kmm_sparql_update can insert raw triples, but the publisher generates only 1 rule\n" +
    "  because it bypasses Semaphore's OE (Ontology Engine) indexing. This tool uses\n" +
    "  content=automatic which triggers full OE indexing — required for AllConcepts to enumerate\n" +
    "  concepts at publish time. Always use this tool to load the initial vocabulary.\n\n" +
    "IMPORTANT — ASYNC:\n" +
    "  The import is asynchronous and may take 1-3 minutes for large vocabularies.\n" +
    "  The tool polls until complete (up to 5 minutes) and returns when done.\n\n" +
    "SKOS URL EXAMPLES:\n" +
    "  IPTC Media Topics (RDF/XML): https://cv.iptc.org/newscodes/mediatopic/?lang=x-all&format=rdfxml\n" +
    "  Note: check the vocabulary's download API for the correct RDF URL — HTML endpoints return HTML.\n\n" +
    "SKOS HIERARCHY BEST PRACTICES:\n" +
    "  Before loading, ensure the taxonomy uses proper hierarchy (skos:narrower/skos:broader) rather\n" +
    "  than a flat structure. The flat anti-pattern stuffs all child names as skos:altLabel on a parent —\n" +
    "  instead, give each named concept its own skos:Concept node with skos:broader pointing to the parent.\n" +
    "  Use semaphore_taxonomy_validate after loading to check for structural issues.\n" +
    "  Use semaphore_taxonomy_scaffold to generate a properly structured SKOS skeleton before loading.\n\n" +
    "AFTER LOADING:\n" +
    "  1. Run semaphore_taxonomy_validate to check hierarchy quality\n" +
    "  2. Run semaphore_publish_config_fix_plain_skos (for plain skos:prefLabel vocabularies)\n" +
    "  3. Run semaphore_publish to build the CLS rule set\n" +
    "  4. Run semaphore_classify to test classification",
    {
      model_uri: z.string().describe(
        "KMM model URI to import into, e.g. 'model:IPTCMediaTopics'. " +
        "Get from semaphore_kmm_models_list or use the URI returned by semaphore_kmm_model_create."
      ),
      skos_url: z.string().url().optional().describe(
        "Public HTTP/HTTPS URL of the SKOS RDF file to fetch and import. " +
        "The MCP server downloads this from its own process — localhost URLs will NOT work because " +
        "the MCP server is remote. Use only for publicly reachable URLs (GitHub Gist, official " +
        "vocabulary endpoints, etc.). Mutually exclusive with skos_content. " +
        "Supports RDF/XML, Turtle (.ttl), N-Triples (.nt), and JSON-LD (.jsonld)."
      ),
      skos_content: z.string().optional().describe(
        "Inline RDF/SKOS content as a string (Turtle, RDF/XML, or JSON-LD). " +
        "Use this instead of skos_url when the taxonomy is in a local file or was just created. " +
        "Read the file with the Read tool and pass its text here — the MCP server will upload it " +
        "directly to KMM without any network fetch. Auto-detects format from content prefix " +
        "(@prefix/@base → Turtle, { → JSON-LD, otherwise RDF/XML). " +
        "Mutually exclusive with skos_url."
      ),
      format: z.string().optional().describe(
        "Override the RDF format MIME type (e.g. 'application/rdf+xml', 'text/turtle'). " +
        "Auto-detected from Content-Type, URL extension, or content prefix if omitted."
      ),
      overwrite: z.boolean().optional().describe(
        "If true, replaces existing triples in the model. Default: false (adds to existing)."
      ),
    },
    async ({ model_uri, skos_url, skos_content, format, overwrite }) => {
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
      if (!skos_url && !skos_content) {
        return {
          content: [{ type: "text", text: "Either skos_url or skos_content must be provided." }],
          isError: true,
        };
      }
      if (skos_url && skos_content) {
        return {
          content: [{ type: "text", text: "Provide either skos_url or skos_content, not both." }],
          isError: true,
        };
      }
      try {
        // Step 1: start the async import job
        const sourceLabel = skos_content
          ? `inline content (${skos_content.length} chars)`
          : skos_url!;
        const jobId = await semaphore.kmmImportSkos(
          model_uri,
          skos_url ?? null,
          { format, overwrite, skosContent: skos_content }
        );

        const lines = [
          "SKOS IMPORT STARTED",
          "─".repeat(50),
          "",
          `  Model:   ${model_uri}`,
          `  Source:  ${sourceLabel}`,
          `  Job ID:  ${jobId}`,
          "",
          "Polling for completion (up to 5 minutes)...",
        ];

        // Step 2: poll until complete
        const pollResult = await semaphore.kmmWaitForAsyncJob(jobId, 300_000);

        lines.push("");
        if (pollResult.status === "COMPLETE") {
          lines.push("✓ Import COMPLETE");

          // ── Language tag check ──────────────────────────────────────────────
          // Detect which language the vocabulary uses, then verify all concepts
          // have a prefLabel in that language. Bare (untagged) literals will
          // produce 0 rules when the publisher SPARQL filters by language.
          // IMPORTANT: Query the model's named graph (urn:x-evn-master:{ModelId}),
          // not the default graph — data lives in the named graph after import.
          try {
            const PREFIX = "PREFIX skos: <http://www.w3.org/2004/02/skos/core#> ";
            const modelName = model_uri.replace(/^model:/, "");
            const graphClause = `GRAPH <urn:x-evn-master:${modelName}>`;
            // Find the dominant prefLabel language in the imported data
            const langRes = await semaphore.kmmSparqlQuery(model_uri,
              PREFIX + `SELECT (LANG(?l) AS ?lang) (COUNT(?l) AS ?n) WHERE { ${graphClause} { ?s a skos:Concept ; skos:prefLabel ?l } } GROUP BY LANG(?l) ORDER BY DESC(COUNT(?l)) LIMIT 5`
            );
            const langRows = langRes?.rows ?? [];
            const dominantLang = langRows.find(r => r.lang && r.lang !== "")?.lang ?? null;
            const untaggedCount = parseInt(langRows.find(r => !r.lang || r.lang === "")?.n ?? "0", 10);

            const [totalRes, taggedRes] = await Promise.all([
              semaphore.kmmSparqlQuery(model_uri,
                PREFIX + `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ${graphClause} { ?s a skos:Concept } }`),
              dominantLang
                ? semaphore.kmmSparqlQuery(model_uri,
                    PREFIX + `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ${graphClause} { ?s a skos:Concept ; skos:prefLabel ?l FILTER(LANG(?l) = "${dominantLang}") } }`)
                : Promise.resolve({ rows: [{ n: "0" }] }),
            ]);
            const totalConcepts  = parseInt(totalRes?.rows?.[0]?.n ?? "0", 10);
            const taggedConcepts = parseInt(taggedRes?.rows?.[0]?.n ?? "0", 10);

            lines.push("");
            if (dominantLang) {
              lines.push(`LABEL LANGUAGE CHECK: ${taggedConcepts}/${totalConcepts} concepts have @${dominantLang} prefLabel`);
              if (totalConcepts > 0 && taggedConcepts < totalConcepts) {
                lines.push(`⚠  ${totalConcepts - taggedConcepts} concept(s) lack a @${dominantLang} prefLabel — those will not produce CLS rules.`);
              } else if (taggedConcepts > 0) {
                lines.push(`✓ All concepts have @${dominantLang} prefLabel — ready for publish.`);
              }
            } else if (untaggedCount > 0) {
              lines.push(`LABEL LANGUAGE CHECK: ${totalConcepts} concept(s) have UNTAGGED prefLabels (no language tag)`);
              lines.push("⚠ WARNING: Bare string literals found — no language tags on prefLabels!");
              lines.push("  The Semaphore Publisher SPARQL filters by language, so bare literals will produce only 1 rule.");
              lines.push("  Run this SPARQL UPDATE via semaphore_kmm_sparql_update to tag labels (replace 'en' with your language):");
              lines.push("");
              lines.push("  -- Fix prefLabels:");
              lines.push("  DELETE { ?c skos:prefLabel ?l }");
              lines.push("  INSERT { ?c skos:prefLabel ?lTagged }");
              lines.push("  WHERE  { ?c skos:prefLabel ?l . FILTER(LANG(?l) = \"\") . BIND(STRLANG(?l,\"en\") AS ?lTagged) }");
              lines.push("");
              lines.push("  -- Fix altLabels:");
              lines.push("  DELETE { ?c skos:altLabel ?l }");
              lines.push("  INSERT { ?c skos:altLabel ?lTagged }");
              lines.push("  WHERE  { ?c skos:altLabel ?l . FILTER(LANG(?l) = \"\") . BIND(STRLANG(?l,\"en\") AS ?lTagged) }");
              lines.push("");
              lines.push("  After running the updates, re-run semaphore_publish.");
            } else if (totalConcepts === 0) {
              lines.push("LABEL LANGUAGE CHECK: 0 concepts found in the model's named graph.");
              lines.push(`  Queried: GRAPH <urn:x-evn-master:${modelName}>`);
              // Check for OWL constructs — a common mistake when loading OWL instead of SKOS
              const contentToCheck = skos_content ?? "";
              const hasOwlClass = contentToCheck.includes("owl:Class") || contentToCheck.includes("owl/2002/07/owl#Class");
              const hasOwlOntology = contentToCheck.includes("owl:Ontology") || contentToCheck.includes("owl/2002/07/owl#Ontology");
              if (hasOwlClass || hasOwlOntology) {
                lines.push("⚠  WARNING: OWL constructs detected in the loaded content!");
                lines.push("   Semaphore KMM only supports SKOS — OWL ontologies import silently but produce 0 concepts.");
                lines.push("   Convert your ontology to SKOS before loading:");
                lines.push("     owl:Class        → skos:Concept");
                lines.push("     rdfs:subClassOf  → skos:broader / skos:narrower");
                lines.push("     owl:inverseOf    → skos:related");
                lines.push("     owl:Ontology     → skos:ConceptScheme");
                lines.push("   Use semaphore_taxonomy_scaffold to generate a correct SKOS skeleton.");
              } else {
                lines.push("  This may be a timing issue — the named graph may not yet be committed.");
                lines.push("  Run semaphore_kmm_sparql to verify:");
                lines.push(`    model_uri="${model_uri}"`);
                lines.push('    query: PREFIX skos: <http://www.w3.org/2004/02/skos/core#>');
                lines.push(`           SELECT (COUNT(?c) AS ?n) WHERE { GRAPH <urn:x-evn-master:${modelName}> { ?c a skos:Concept } }`);
              }
            }
          } catch {
            // Non-fatal: SPARQL check failure should not block the success response
            lines.push("  (Could not perform label language check — verify manually with semaphore_kmm_sparql)");
          }

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
    "required for bulk triple modifications.\n\n" +
    "NOTE: sem:guid is auto-generated by KMM when loading via semaphore_kmm_skos_load — no manual\n" +
    "INSERT is needed for the normal workflow. Only add sem:guid manually if you built the model\n" +
    "entirely via raw SPARQL INSERT (bypassing the Studio import API).\n\n" +
    "COMMON USE CASES:\n\n" +
    "1. Fix or backfill labels:\n" +
    "   PREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n" +
    "   INSERT { ?c skos:altLabel \"extra label\"@en } WHERE { ?c a skos:Concept ; skos:prefLabel \"...\"@en }\n\n" +
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
    "Trigger a Semaphore KMM publish — compile the taxonomy model (or task working copy) into CLS classification rules.\n\n" +
    "Publishing converts the RDF taxonomy in KMM into a .rules file that the Classification Server (CLS) " +
    "uses to classify text. You must re-publish after any change to model content or publisher config.\n\n" +
    "TASK vs MASTER PUBLISHING:\n" +
    "  • task_name omitted → publishes the MASTER graph (urn:x-evn-master:{Model}) to production CLS.\n" +
    "  • task_name=<name> → publishes the TASK working copy (urn:x-evn-tag:{Model}:{Task}) to CLS.\n\n" +
    "  RECOMMENDED GOVERNANCE WORKFLOW for production taxonomy changes:\n" +
    "    1. Create task in Studio: Model → Working Copies → New Working Copy\n" +
    "    2. Edit taxonomy in the task (concepts are isolated from master)\n" +
    "    3. semaphore_publish  model_uri=...  task_name=...  — publish task to test CLS\n" +
    "    4. semaphore_classify — validate classification quality against the task rule set\n" +
    "    5. Commit + merge task in Studio (Working Copies → Submit → Merge to Master)\n" +
    "    6. semaphore_publish  model_uri=...  — publish master to production CLS\n\n" +
    "  For sandbox/development (single-user, rapid iteration): publishing master directly is fine.\n" +
    "  Use semaphore_task_list to see open tasks before publishing.\n\n" +
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
      task_name: z.string().optional().describe(
        "Task (working copy) name to publish instead of master, e.g. 'Test' from task:ATCDrugClassification:Test. " +
        "Use semaphore_task_list to discover open tasks. When set, publishes the task's delta graph " +
        "to CLS for classification testing — without merging into master. " +
        "Omit to publish the master graph (production publish)."
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
    async ({ model_uri, config, environment, language, task_name, async: useAsync, wait_for_completion }) => {
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
          taskName: task_name,
        });

        const modelName = model_uri.replace(/^model:/, "");
        const publishTarget = task_name ? `${model_uri} (task: ${task_name})` : model_uri;
        const lines = [
          "SEMAPHORE PUBLISH TRIGGERED",
          "─".repeat(50),
          "",
          `  Target:      ${publishTarget}`,
          task_name ? `  Source:      task working copy (urn:x-evn-tag:${modelName}:${task_name})` : `  Source:      master graph (urn:x-evn-master:${modelName})`,
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
            // Auto-check loaded rule count by comparing pak-size estimate against KMM concept count.
            // The pak-size heuristic is unreliable for small taxonomies (≤ ~25 concepts) — their
            // paks are legitimately small. Use KMM concept count to distinguish a true 1-rule
            // failure from a correctly published small taxonomy.
            const [ruleCount, kmmCount] = await Promise.all([
              semaphore.clsRuleCount(modelName.toLowerCase()),
              semaphore.kmmConceptCount(model_uri),
            ]);
            lines.push(`  Rules loaded in CLS: ${ruleCount >= 0 ? ruleCount : "(unknown)"}`);
            lines.push("");
            // Only warn if the estimated rule count looks disproportionately low relative to
            // the number of concepts. For small taxonomies (kmmCount ≤ 10) the heuristic is
            // unreliable — just suggest semaphore_classify to verify.
            const likelyBroken = ruleCount >= 0 && ruleCount <= 1 && kmmCount > 10;
            if (likelyBroken) {
              lines.push("⚠  WARNING: Only 1 rule loaded — this strongly suggests a publisher config problem.");
              lines.push("   Root cause: the default publisher config uses SKOS-XL label queries that hit");
              lines.push("   the empty default graph of the global SPARQL endpoint. Each model's data lives");
              lines.push(`   in the named graph urn:x-evn-master:${modelName}.`);
              lines.push("   Fix: run  semaphore_publish_config_fix_plain_skos  then re-publish.");
            } else if (ruleCount > 1) {
              lines.push("✓ Publish completed successfully.");
              lines.push("  • semaphore_classify  threshold=0  content='<test text>'  — test classification");
            } else {
              lines.push("✓ Publish completed.");
              lines.push("  • semaphore_classify  threshold=0  content='<test text>'  — verify classification works");
              lines.push("  (Rule count estimate is low but taxonomy is small — this is expected.)");
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
          if (task_name) {
            lines.push("");
            lines.push("TASK WORKFLOW — next steps after validating classification quality:");
            lines.push(`  1. Studio: open ${model_uri} → Working Copies → ${task_name} → Submit`);
            lines.push(`  2. Studio: merge the task into master`);
            lines.push(`  3. semaphore_publish  model_uri="${model_uri}"  — publish master to production CLS`);
          }
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
    "  WORKSPACE: Initialized automatically — this tool bootstraps the workspace by triggering\n" +
    "  an initial publish if no workspace exists yet. No Studio interaction required.\n\n" +
    "  NOTE: sem:guid is automatically added by KMM when loading via semaphore_kmm_skos_load.\n" +
    "  No manual SPARQL INSERT is needed.\n\n" +
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
        // ── Pre-check: verify ConceptScheme URI follows the expected pattern ──
        // The publisher's concept-enumeration query looks for a ConceptScheme at
        // {namespace}{ModelId}Taxonomy. Any other URI will result in 0 concepts found.
        const modelName = model_uri.replace(/^model:/, "");
        const expectedSuffix = `${modelName}Taxonomy`;
        try {
          const schemeRes = await semaphore.kmmSparqlQuery(model_uri,
            `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
             SELECT ?scheme WHERE { ?scheme a skos:ConceptScheme } LIMIT 20`
          );
          const schemes = schemeRes.rows.map(r => r.scheme ?? "");
          const matchingScheme = schemes.find(s => s.endsWith(expectedSuffix));
          if (schemes.length > 0 && !matchingScheme) {
            const schemeList = schemes.slice(0, 5).join("\n    ");
            return {
              content: [{
                type: "text",
                text:
                  "CONCEPTSCHEME URI MISMATCH — Config fix skipped\n" +
                  "─".repeat(50) + "\n\n" +
                  `  Model: ${model_uri}\n\n` +
                  `  Expected ConceptScheme URI ending with: .../${expectedSuffix}\n` +
                  `  Found scheme(s):\n    ${schemeList}\n\n` +
                  "  The publisher's concept-enumeration query finds concepts by querying for a\n" +
                  `  ConceptScheme whose URI ends with '${expectedSuffix}' (convention: {namespace}{ModelId}Taxonomy).\n` +
                  "  None of the existing ConceptSchemes match this pattern — the publish will produce only 1 rule.\n\n" +
                  "  FIX: Add a correctly named ConceptScheme via semaphore_kmm_sparql_update:\n" +
                  `    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>\n` +
                  `    INSERT DATA {\n` +
                  `      <{your-namespace}${expectedSuffix}> a skos:ConceptScheme ;\n` +
                  `          skos:prefLabel "${modelName} Taxonomy"@en ;\n` +
                  `          skos:hasTopConcept <{your-top-concept-uri}> .\n` +
                  `    }\n` +
                  "  Replace {your-namespace} with your model's base namespace.\n" +
                  "  Then re-run semaphore_publish_config_fix_plain_skos.",
              }],
              isError: true,
            };
          }
        } catch {
          // Non-fatal: if SPARQL check fails, proceed with the patch anyway
        }

        const summary = await semaphore.kmmPatchPublishConfigForPlainSkos(model_uri);
        const lines = [
          "PUBLISHER CONFIG FIX — PLAIN SKOS",
          "─".repeat(50),
          "",
          summary,
          "",
          "NEXT STEPS:",
          `  1. Publish to CLS:  semaphore_publish  model_uri="${model_uri}"  wait_for_completion=true`,
          "  2. Verify rules:    semaphore_publish_sets → confirm the rule set is active",
          "  3. Test:            semaphore_classify  threshold=0  content=\"<test text>\"",
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
    "AUTO-TAG / CLASSIFY text against a controlled-vocabulary taxonomy. Returns scored taxonomy categories " +
    "drawn from the active Semaphore rule set (SKOS thesaurus, subject classification scheme, or custom ontology).\n\n" +
    "USE THIS TOOL WHEN:\n" +
    "  - The user asks to classify, tag, categorize, label, or annotate documents by topic or subject\n" +
    "  - The user wants to extract concepts, themes, or entities using a taxonomy or controlled vocabulary\n" +
    "  - Testing classification output on sample text before building a bulk pipeline\n" +
    "  - Classifying a small number of documents individually (for bulk, use flux_import or flux_reprocess)\n" +
    "  - Verifying that a publish set produces the expected categories after semaphore_publish\n" +
    "  - Designing the MarkLogic document model for storing classification results\n\n" +
    "HOW IT WORKS:\n" +
    "  The CLS parses your text, matches it against the loaded classification rules (publish sets),\n" +
    "  and returns categories above the threshold score. Each category has a class name (taxonomy domain),\n" +
    "  a label (concept name), a stable UUID, and a score (0.0–1.0 float).\n\n" +
    "FOR BULK CLASSIFICATION (preferred for production):\n" +
    "  Use flux_import or flux_reprocess with classify_with_semaphore=true. To scope results to\n" +
    "  specific taxonomies, pass classifier_publish_sets=[\"name1\",\"name2\"] — Flux injects\n" +
    "  --classifier-prop publish_set_name_list=name1|name2 so the CLS only returns those sets.\n" +
    "  Publish set names are lowercase model names — use semaphore_publish_sets to list them.\n\n" +
    "THRESHOLD GUIDANCE:\n" +
    "  Default threshold is 48. The threshold parameter uses an integer 0–100 scale.\n" +
    "  Returned scores are 0.0–1.0 floats (threshold=48 filters out results below score 0.48).\n" +
    "  Use threshold=0 to see all candidate categories regardless of confidence.\n" +
    "  Production pipelines typically use threshold 48–70 depending on precision requirements.\n\n" +
    "SCORE=0 NOTE:\n" +
    "  A freshly published rule set may return score=0 for all categories while the\n" +
    "  Semaphore Publisher service finishes building the rulenet index. If every category\n" +
    "  scores 0, use threshold=0 to see them, then re-run classification after the Publisher\n" +
    "  service has completed indexing (check Semaphore Studio → Publish tab for status).",
    {
      content: z.string().describe("Plain text or HTML content to classify"),
      threshold: z.number().int().min(0).max(100).optional().describe(
        "Minimum confidence threshold, integer 0–100 (e.g. 48 = filter out results below score 0.48). " +
        "Default: 0 (return all candidates). The SCS default is 48 — use 0 here to see all results for exploration. " +
        "Note: the threshold is 0–100 integer but returned scores are 0.0–1.0 floats — different scales."
      ),
      publish_set: z.string().optional().describe(
        "Restrict classification to a single publish set (e.g. 'iptcmediatopics'). " +
        "Passed as the 'publish_set' CLS form field. Use publish_sets instead when you want " +
        "results from several (but not all) taxonomies. " +
        "ALWAYS run semaphore_publish_sets first to discover exact names — names vary by deployment. " +
        "Common names in the standard Semaphore distribution: 'iptcmediatopics', 'unescothesaurus', " +
        "'unsdg', 'marklogic', 'biologicaltaxonomy', 'meddraadversereactions', 'awsservices', 'azureservices', " +
        "'softwareengineering', 'moviesmodel'. Names are typically the lowercase model prefix before the first dash."
      ),
      publish_sets: z.array(z.string()).optional().describe(
        "Restrict classification to a specific list of publish sets (e.g. ['iptcmediatopics', 'unescothesaurus']). " +
        "Passed as the 'publish_set_name_list' CLS form field (pipe-separated). " +
        "Takes precedence over publish_set when both are provided. " +
        "When omitted (and publish_set is also omitted), all active publish sets are used. " +
        "ALWAYS run semaphore_publish_sets first to discover exact names — names vary by deployment. " +
        "Common names in the standard Semaphore distribution: 'iptcmediatopics', 'unescothesaurus', " +
        "'unsdg', 'marklogic', 'biologicaltaxonomy', 'meddraadversereactions', 'awsservices', 'azureservices', " +
        "'softwareengineering', 'moviesmodel'. Names are typically the lowercase model prefix before the first dash."
      ),
    },
    async ({ content, threshold, publish_set, publish_sets }) => {
      if (!semaphore.configured) {
        return {
          content: [{ type: "text", text: "Semaphore is not configured. Set SEMAPHORE_URL in the MCP server .env." }],
          isError: true,
        };
      }
      try {
        const result = await semaphore.classify(content, threshold ?? 0, publish_set, publish_sets);
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
                "Debug:\n" +
                "  • semaphore_classes to confirm classification classes are active.\n" +
                "  • semaphore_publish_diagnose to check rule count vs concept count.\n" +
                "  • semaphore_kid_template_diagnose  symptom=missing_matches for a guided fix plan.",
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

        // ── Quality signal analysis ─────────────────────────────────────────
        // Detect anomalous score patterns and surface the right next step.
        const scores = cats.map(c => c.score);
        const nonZeroScores = scores.filter(s => s > 0);
        const uniqueScores = new Set(nonZeroScores.map(s => s.toFixed(2)));
        const allZero = nonZeroScores.length === 0;
        const allIdentical = uniqueScores.size === 1 && nonZeroScores.length > 2;
        const suspiciouslyMany = nonZeroScores.length > 15;
        const hasQualitySignal = allZero || allIdentical || suspiciouslyMany;

        if (hasQualitySignal) {
          lines.push("─".repeat(50));
          lines.push("⚠ QUALITY SIGNALS DETECTED:");
          lines.push("");

          if (allZero) {
            lines.push("  ALL SCORES = 0");
            lines.push("    Most likely cause: the CLS rulenet index is still building after a recent publish.");
            lines.push("    Wait 30–60 seconds and re-run this classification.");
            lines.push("    If it persists: run semaphore_publish_diagnose to check rule count vs concept count.");
          }

          if (allIdentical) {
            const uniformScore = nonZeroScores[0].toFixed(2);
            lines.push(`  ALL SCORES IDENTICAL (${uniformScore})`);
            lines.push("    Cause: all firing concepts contribute the same weight — likely single-word labels");
            lines.push("    matched only via phraselist (nearlist needs multi-word labels to differentiate).");
            lines.push("    This makes threshold-based separation impossible.");
            lines.push("");
            lines.push("    FIX OPTIONS (try in order):");
            lines.push("      1. Add multi-word altLabels to key concepts → semaphore_concept_labels_update");
            lines.push("      2. Use a precision-focused velocity template → semaphore_kid_template_set preset=exact_only");
            lines.push("      3. Add zone-biasing if docs have title/body → semaphore_kid_template_set title_weight=80 body_weight=20");
            lines.push("    Diagnose: semaphore_kid_template_diagnose  symptom=score_too_uniform");
          }

          if (suspiciouslyMany && !allIdentical) {
            lines.push(`  HIGH CATEGORY COUNT (${cats.length} categories)`);
            lines.push("    This may indicate over-matching, OR you are classifying against all available taxonomies");
            lines.push("    when you only need results from a specific subset.");
            lines.push("");
            lines.push("    SCOPE RESULTS TO SPECIFIC TAXONOMIES (most effective first step):");
            lines.push("      Re-run with publish_sets=[\"name1\",\"name2\"] to restrict classification to the");
            lines.push("      taxonomies you actually need. Use semaphore_publish_sets to list available names.");
            lines.push("      Example: publish_sets=[\"iptcmediatopics\",\"unescothesaurus\",\"unsdg\"]");
            lines.push("");
            lines.push("    IF STILL TOO MANY AFTER SCOPING (over-matching within a taxonomy):");
            lines.push("      1. Inspect unexpected concepts → semaphore_concept_get on the low-scoring categories");
            lines.push("      2. Remove over-broad labels → semaphore_concept_labels_update  action=remove");
            lines.push("      3. Reduce nearlist contribution → semaphore_kid_template_set  preset=precision");
            lines.push("      4. Disable associative propagation → semaphore_kid_template_set  associative_cap=0");
            lines.push("    Diagnose: semaphore_kid_template_diagnose  symptom=false_positives");
          }

          lines.push("");
        }

        lines.push("─".repeat(50));
        if (!hasQualitySignal) {
          lines.push("Store in MarkLogic as:");
          lines.push('  "classification": { "categories": [...], "topCategory": {...} }');
          lines.push("Then add a path range index on classification/categories/label for search facets.");
        }
        lines.push("");
        lines.push("CLASSIFICATION TUNING DECISION HIERARCHY:");
        lines.push("  If results look wrong, try fixes in this order:");
        lines.push("    1. Label edit (semaphore_concept_labels_update)  — fix one concept's labels");
        lines.push("    2. Threshold adjust (re-run this tool with different threshold)  — zero model changes");
        lines.push("    3. Velocity template tuning (semaphore_kid_template_set preset=...)  — global weight change");
        lines.push("    4. Custom template (semaphore_kid_template_set content=...)  — advanced XML");
        lines.push("  Run: semaphore_kid_template_diagnose  symptom=<symptom>  for a guided action plan.");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_classify_batch ──────────────────────────────────────────────────
  server.tool(
    "semaphore_classify_batch",
    "Classify multiple MarkLogic documents against a controlled-vocabulary taxonomy in one call.\n\n" +
    "Accepts a list of document URIs or a collection URI (or both). For each document, retrieves\n" +
    "its content from MarkLogic and classifies it against the Semaphore CLS. Returns an array of\n" +
    "per-document classification results.\n\n" +
    "USE THIS TOOL WHEN:\n" +
    "  - You need to classify a set of documents (up to ~50) and store the results back in MarkLogic\n" +
    "  - Building a classification enrichment pipeline over a small corpus\n" +
    "  - Verifying classification quality across multiple documents at once\n\n" +
    "FOR LARGER CORPORA (100+ documents):\n" +
    "  Use flux_import or flux_reprocess with classify_with_semaphore=true instead — Flux handles\n" +
    "  parallel classification at scale and writes results directly back to the documents.\n\n" +
    "SCOPE TO SPECIFIC TAXONOMIES:\n" +
    "  Pass publish_sets=[\"name1\",\"name2\"] to restrict which taxonomies are queried.\n" +
    "  Without this, ALL active publish sets are used — which can produce hundreds of results per document.\n" +
    "  Use semaphore_publish_sets to list available names.\n\n" +
    "RESULTS FORMAT:\n" +
    "  An array of objects: { uri, categories: [{className, label, id, score}], error? }\n" +
    "  Documents that could not be retrieved or classified include an 'error' field.",
    {
      uris: z.array(z.string()).max(50).optional().describe(
        "List of document URIs to classify (max 50). Provide this OR collection (or both)."
      ),
      collection: z.string().optional().describe(
        "Classify all documents in this collection (up to page_length). " +
        "Use semaphore_classify_batch multiple times with start to process larger collections."
      ),
      start: z.number().int().positive().optional().describe(
        "Pagination start for collection listing (default: 1)."
      ),
      page_length: z.number().int().positive().max(50).optional().describe(
        "Number of documents to fetch from the collection (default: 20, max: 50)."
      ),
      threshold: z.number().int().min(0).max(100).optional().describe(
        "Minimum confidence threshold 0–100 (default: 0). Same scale as semaphore_classify."
      ),
      publish_set: z.string().optional().describe(
        "Restrict to a single publish set (e.g. 'iptcmediatopics'). " +
        "Run semaphore_publish_sets to discover available names."
      ),
      publish_sets: z.array(z.string()).optional().describe(
        "Restrict to a list of publish sets (e.g. ['iptcmediatopics', 'unescothesaurus']). " +
        "Strongly recommended when classifying against many active taxonomies — without this " +
        "every document is classified against all publish sets, which is slow and noisy. " +
        "Takes precedence over publish_set when both are provided."
      ),
      database: z.string().optional().describe("Database name for document retrieval"),
    },
    async ({ uris, collection, start, page_length, threshold, publish_set, publish_sets, database }) => {
      if (!semaphore.configured) {
        return {
          content: [{ type: "text", text: "Semaphore is not configured. Set SEMAPHORE_URL in the MCP server .env." }],
          isError: true,
        };
      }
      if (!uris?.length && !collection) {
        return {
          content: [{ type: "text", text: "Provide at least one of: uris (list of document URIs) or collection." }],
          isError: true,
        };
      }
      try {
        // Build target URI list
        const targetUris: string[] = [...(uris ?? [])];
        if (collection) {
          const listing = await clients.documents.list({
            collection,
            start: start ?? 1,
            pageLength: page_length ?? 20,
            database,
          });
          for (const u of listing.uris ?? []) {
            if (!targetUris.includes(u)) targetUris.push(u);
          }
        }

        if (targetUris.length === 0) {
          return { content: [{ type: "text", text: "No documents found to classify." }] };
        }

        // Classify each document
        const results: Array<{
          uri: string;
          categories?: Array<{ className: string; label: string; id: string; score: number }>;
          error?: string;
        }> = [];

        for (const uri of targetUris) {
          try {
            const doc = await clients.documents.get(uri, database, false);
            const textContent = typeof doc.content === "string"
              ? doc.content
              : JSON.stringify(doc.content);
            const clsResult = await semaphore.classify(textContent, threshold ?? 0, publish_set, publish_sets);
            results.push({ uri, categories: clsResult.categories });
          } catch (err) {
            results.push({ uri, error: err instanceof Error ? err.message : String(err) });
          }
        }

        const succeeded = results.filter(r => !r.error);
        const failed = results.filter(r => r.error);
        const totalCats = succeeded.reduce((n, r) => n + (r.categories?.length ?? 0), 0);

        const lines = [
          "SEMAPHORE BATCH CLASSIFICATION RESULTS",
          "─".repeat(50),
          `  Documents classified: ${succeeded.length}/${targetUris.length}`,
          `  Total categories:     ${totalCats}`,
          `  Avg per document:     ${succeeded.length > 0 ? (totalCats / succeeded.length).toFixed(1) : "—"}`,
          "",
        ];

        for (const r of succeeded) {
          const top = r.categories?.slice(0, 3).map(c => `${c.label} [${c.score.toFixed(2)}]`).join(", ") ?? "";
          lines.push(`  ${r.uri}`);
          lines.push(`    ${r.categories?.length ?? 0} categories — top: ${top || "(none)"}`);
        }

        if (failed.length > 0) {
          lines.push("", "ERRORS:");
          for (const r of failed) lines.push(`  • ${r.uri}: ${r.error}`);
        }

        lines.push("", "─".repeat(50));
        lines.push("Full results as JSON:");
        lines.push(JSON.stringify(results, null, 2));

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
    "  • Labeled concept count — how many concepts have a skos:prefLabel in the model's language (SPARQL)\n" +
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
      language: z.string().optional().describe(
        "BCP 47 language tag of the model's prefLabels, e.g. 'en', 'fr', 'de', 'nl'. " +
        "If omitted, the dominant language is auto-detected from the model's existing prefLabels."
      ),
    },
    async ({ model_uri, language }) => {
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

      // 2. Auto-detect or use supplied language, then count labeled concepts via SPARQL
      let lang = language;
      let labelCount = -1;
      try {
        const modelName = model_uri.replace(/^model:/, "");
        if (!lang) {
          const langRes = await semaphore.kmmSparqlQuery(model_uri,
            `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
             SELECT (LANG(?l) AS ?lang) (COUNT(?l) AS ?n) WHERE {
               GRAPH <urn:x-evn-master:${modelName}> {
                 ?c a skos:Concept ; skos:prefLabel ?l .
                 FILTER(LANG(?l) != "")
               }
             } GROUP BY LANG(?l) ORDER BY DESC(COUNT(?l)) LIMIT 1`
          );
          lang = langRes.rows[0]?.lang ?? "en";
        }
        const r = await semaphore.kmmSparqlQuery(model_uri,
          `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
           SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE {
             GRAPH <urn:x-evn-master:${modelName}> {
               ?c a skos:Concept ; skos:prefLabel ?l .
               FILTER(LANG(?l) = "${lang}")
             }
           }`
        );
        const n = r.rows[0]?.["n"];
        labelCount = n !== undefined ? parseInt(String(n), 10) : -1;
      } catch { /* ignore */ }
      const langLabel = lang ?? "en";
      lines.push(`  Language:                       @${langLabel}${language ? "" : "  (auto-detected)"}`);
      lines.push(`  Labeled concepts (SPARQL):      ${labelCount >= 0 ? labelCount : "ERROR — could not query"}`);

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
        lines.push("✗ PROBLEM DETECTED: " + kmmCount + " concepts exist but none have @" + langLabel + " prefLabels.");
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

  // ── semaphore_concept_search ──────────────────────────────────────────────────
  server.tool(
    "semaphore_concept_search",
    "Search for concepts in a KMM model by keyword, matching across prefLabel, altLabel, and hiddenLabel.\n\n" +
    "USE THIS TO:\n" +
    "  • Identify which concept(s) are responsible for a false-positive classification.\n" +
    "    Example: if 'wedding' appears wrongly on news articles, search keyword='wedding' to find the concept URI.\n" +
    "  • Explore what labels exist in a domain before tuning.\n" +
    "  • Verify that label changes (via semaphore_concept_labels_update) took effect.\n\n" +
    "WORKFLOW FOR FIXING FALSE POSITIVES:\n" +
    "  1. semaphore_concept_search — find the concept responsible (by label keyword)\n" +
    "  2. semaphore_concept_get    — see ALL labels on that concept\n" +
    "  3. semaphore_concept_labels_update — remove the overly-broad label\n" +
    "  4. semaphore_publish        — rebuild the CLS rule set\n" +
    "  5. semaphore_classify       — verify the false positive is gone\n\n" +
    "NOTE: Prefer removing overly-broad labels over adding complex rules. Simpler taxonomy = better precision.",
    {
      model_uri: z.string().describe(
        "KMM model URI, e.g. 'model:IPTCMediaTopics'. Get from semaphore_kmm_models_list."
      ),
      keyword: z.string().describe(
        "Keyword to search for (case-insensitive substring match across all label types)."
      ),
      lang: z.string().optional().describe(
        "Language tag filter, e.g. 'en'. Default: no language filter (matches all languages)."
      ),
      limit: z.number().optional().describe(
        "Max results to return. Default: 30."
      ),
    },
    async ({ model_uri, keyword, lang, limit = 30 }) => {
      if (!semaphore.kmmBaseUrl) {
        return { content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }], isError: true };
      }
      if (!semaphore.kmmConfigured) {
        return { content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }], isError: true };
      }
      const langFilter = lang ? `FILTER(LANG(?lv) = "${lang}")` : "";
      // Restrict ?prefLabel to English (or no language tag) to avoid a cartesian
      // product that produces one row per language variant of the display label.
      const escaped = keyword.replace(/"/g, '\\"');
      const query = `
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
SELECT DISTINCT ?concept ?prefLabel ?labelType ?matchedLabel WHERE {
  ?concept a skos:Concept .
  ?concept skos:prefLabel ?prefLabel .
  FILTER(LANG(?prefLabel) = "en" || LANG(?prefLabel) = "")
  { ?concept skos:prefLabel ?lv . BIND("prefLabel" AS ?labelType) }
  UNION
  { ?concept skos:altLabel ?lv . BIND("altLabel" AS ?labelType) }
  UNION
  { ?concept skos:hiddenLabel ?lv . BIND("hiddenLabel" AS ?labelType) }
  BIND(STR(?lv) AS ?matchedLabel)
  ${langFilter}
  FILTER(CONTAINS(LCASE(?matchedLabel), LCASE("${escaped}")))
}
ORDER BY ?prefLabel ?labelType
LIMIT ${limit}`;
      try {
        const result = await semaphore.kmmSparqlQuery(model_uri, query);
        const { rows } = result;
        if (rows.length === 0) {
          return {
            content: [{
              type: "text",
              text:
                `CONCEPT SEARCH — no results for "${keyword}"\n\n` +
                "The keyword was not found in any prefLabel, altLabel, or hiddenLabel.\n\n" +
                "Try:\n" +
                "  • A shorter or different keyword (e.g. 'wed' instead of 'wedding')\n" +
                "  • Remove the lang filter to search all languages\n" +
                `  • semaphore_kmm_sparql to run a custom query against ${model_uri}`,
            }],
          };
        }
        // Compute column widths from data so the full concept URI is never truncated.
        const conceptWidth = Math.max(11, ...rows.map(r => (r.concept ?? "").length));
        const prefWidth = Math.max(9, ...rows.map(r => (r.prefLabel ?? "").length));
        const ltWidth = Math.max(9, ...rows.map(r => (r.labelType ?? "").length));
        const header = "concept_uri".padEnd(conceptWidth) + "  " + "prefLabel".padEnd(prefWidth) + "  " + "labelType".padEnd(ltWidth) + "  matchedLabel";
        const lines = [
          `CONCEPT SEARCH — "${keyword}" in ${model_uri}`,
          "─".repeat(60),
          `Found ${rows.length} match(es)${rows.length === limit ? ` (limit ${limit} — may be more)` : ""}`,
          "",
          header,
          "─".repeat(header.length + 44),
        ];
        for (const r of rows) {
          const concept = (r.concept ?? "").padEnd(conceptWidth);
          const pref = (r.prefLabel ?? "").padEnd(prefWidth);
          const lt = (r.labelType ?? "").padEnd(ltWidth);
          const ml = (r.matchedLabel ?? "").slice(0, 60);
          lines.push(`${concept}  ${pref}  ${lt}  ${ml}`);
        }
        lines.push("");
        lines.push("NEXT STEP: semaphore_concept_get  model_uri=\"" + model_uri + "\"  concept_uri=\"<URI above>\"");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_concept_get ─────────────────────────────────────────────────────
  server.tool(
    "semaphore_concept_get",
    "Retrieve the full profile of a concept from a KMM model: all labels (prefLabel, altLabel, hiddenLabel), " +
    "hierarchical links (broader, narrower), associative links (related), and scopeNote.\n\n" +
    "USE THIS TO:\n" +
    "  • Understand exactly why a concept matches certain text — every label becomes a phrase-match rule.\n" +
    "  • Identify which specific altLabel or hiddenLabel is causing false positives.\n" +
    "  • Inspect hierarchy context before deciding whether to remove a label or restructure the taxonomy.\n\n" +
    "LABEL TYPES AND CLASSIFICATION IMPACT:\n" +
    "  prefLabel   — primary phrase match (highest weight, required, one per concept per language)\n" +
    "  altLabel    — synonym phrases (same weight as prefLabel in ContextualCitation rules)\n" +
    "  hiddenLabel — hidden phrase triggers (not displayed in UI, still drives classification)\n\n" +
    "TUNING STRATEGY:\n" +
    "  • False positive from a too-broad altLabel → use semaphore_concept_labels_update to remove it\n" +
    "  • Concept too narrow (misses relevant text) → add altLabels for common synonyms\n" +
    "  • Preclusion (concept X fires when Y is present) → Semaphore has no native NOT operator;\n" +
    "    simulate by removing the offending label or creating a separate 'exclusion' concept\n" +
    "    with a SPARQL rule that overrides the score — but prefer label removal first.",
    {
      model_uri: z.string().describe(
        "KMM model URI, e.g. 'model:IPTCMediaTopics'. Get from semaphore_kmm_models_list."
      ),
      concept_uri: z.string().describe(
        "Full concept URI, e.g. 'http://cv.iptc.org/newscodes/mediatopic/20000209'. " +
        "Get from semaphore_concept_search."
      ),
    },
    async ({ model_uri, concept_uri }) => {
      if (!semaphore.kmmBaseUrl) {
        return { content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }], isError: true };
      }
      if (!semaphore.kmmConfigured) {
        return { content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }], isError: true };
      }
      const uri = concept_uri.replace(/>/g, "").replace(/</g, "");
      const conceptRef = uri.startsWith("http") ? `<${uri}>` : uri;
      const query = `
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
SELECT ?predicate ?value WHERE {
  ${conceptRef} ?predicate ?value .
  FILTER(?predicate IN (
    skos:prefLabel, skos:altLabel, skos:hiddenLabel,
    skos:broader, skos:narrower, skos:related,
    skos:scopeNote, skos:definition, skos:notation
  ))
}
ORDER BY ?predicate ?value
LIMIT 500`;
      try {
        const result = await semaphore.kmmSparqlQuery(model_uri, query);
        const { rows } = result;
        if (rows.length === 0) {
          return {
            content: [{
              type: "text",
              text:
                `CONCEPT NOT FOUND: ${concept_uri}\n\n` +
                "No triples found for this URI in the model.\n" +
                "Verify the URI with semaphore_concept_search or semaphore_kmm_sparql.",
            }],
          };
        }

        // Group by predicate
        const groups: Record<string, string[]> = {};
        for (const r of rows) {
          const pred = (r.predicate ?? "").replace("http://www.w3.org/2004/02/skos/core#", "skos:");
          const val = r.value ?? "";
          (groups[pred] ??= []).push(val);
        }

        const lines = [
          `CONCEPT PROFILE — ${model_uri}`,
          "─".repeat(60),
          `URI: ${concept_uri}`,
          "",
        ];

        const order = [
          "skos:prefLabel", "skos:altLabel", "skos:hiddenLabel",
          "skos:scopeNote", "skos:definition",
          "skos:broader", "skos:narrower", "skos:related",
          "skos:notation",
        ];
        for (const pred of order) {
          if (groups[pred]) {
            lines.push(`${pred}:`);
            for (const v of groups[pred]) lines.push(`  ${v}`);
            lines.push("");
          }
        }
        // Any remaining predicates not in the ordered list
        for (const [pred, vals] of Object.entries(groups)) {
          if (!order.includes(pred)) {
            lines.push(`${pred}:`);
            for (const v of vals) lines.push(`  ${v}`);
            lines.push("");
          }
        }

        const altLabels = groups["skos:altLabel"] ?? [];
        const hiddenLabels = groups["skos:hiddenLabel"] ?? [];
        const singleWordAlts = altLabels.filter(l => !l.includes(" "));
        lines.push("TUNING GUIDANCE:");
        if (altLabels.length > 10) {
          lines.push(`  • This concept has ${altLabels.length} altLabels — a large label set increases false-positive risk.`);
        }
        if (singleWordAlts.length > 0) {
          lines.push(`  • ${singleWordAlts.length} single-word altLabel(s): ${singleWordAlts.slice(0, 8).map(l => `"${l}"`).join(", ")}${singleWordAlts.length > 8 ? ", ..." : ""}`);
          lines.push("    Single-word labels are the #1 source of false positives (e.g. 'index' matches 'for loop index').");
          lines.push("    Replace with qualified multi-word phrases: 'index' → 'database index', 'clone' → 'git clone'.");
        }
        if (hiddenLabels.length > 0) {
          lines.push(`  • ${hiddenLabels.length} hiddenLabel(s) are invisible in the UI but still drive classification.`);
        }
        lines.push("");
        lines.push("TO REMOVE A LABEL:  semaphore_concept_labels_update  action=remove  label_type=altLabel  label_value=\"<value>\"");
        lines.push("TO ADD A LABEL:     semaphore_concept_labels_update  action=add     label_type=altLabel  label_value=\"<value>\"");
        lines.push("AFTER CHANGES:      semaphore_publish  →  semaphore_classify  (to verify)");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_concept_labels_update ──────────────────────────────────────────
  server.tool(
    "semaphore_concept_labels_update",
    "Add or remove a single label (prefLabel, altLabel, or hiddenLabel) on a concept in a KMM model.\n\n" +
    "This is the primary tool for taxonomy model tuning to fix classification quality issues.\n" +
    "Always prefer this over writing complex publisher configuration rules.\n\n" +
    "WHEN TO USE EACH LABEL TYPE:\n" +
    "  altLabel    — synonyms and common phrasings you WANT to trigger this concept\n" +
    "  hiddenLabel — trigger phrases that shouldn't appear in the UI (e.g. abbreviations, misspellings)\n" +
    "  prefLabel   — the primary display name (only one per concept per language; change with care)\n\n" +
    "FIXING FALSE POSITIVES:\n" +
    "  1. Use semaphore_concept_search to find the concept responsible.\n" +
    "  2. Use semaphore_concept_get to see all its labels.\n" +
    "  3. Use this tool with action='remove' to remove the overly-broad label.\n" +
    "  4. Replace the removed label with a QUALIFIED MULTI-WORD phrase (see strategy below).\n" +
    "  5. Run semaphore_publish to rebuild the CLS rule set.\n" +
    "  6. Run semaphore_classify to verify the false positive is resolved.\n\n" +
    "SINGLE-WORD → MULTI-WORD REPLACEMENT STRATEGY:\n" +
    "  Single-word altLabels like 'index', 'clone', 'push' are the #1 source of false positives.\n" +
    "  They match in any context (e.g. 'for loop index' → Databases, 'deep clone object' → VCS).\n" +
    "  Fix: remove the bare word and add a qualified two-word phrase that only fires in context:\n" +
    "    'index'      → 'database index'        (won't fire on 'loop index' or 'array index')\n" +
    "    'clone'      → 'git clone'              (won't fire on 'deep clone' or 'clone object')\n" +
    "    'constraint' → 'database constraint'    (won't fire on 'iOS constraint' or 'type constraint')\n" +
    "    'push'       → 'git push'               (won't fire on 'push notification')\n" +
    "  Multi-word labels also score HIGHER (phraselist + nearlist both fire → 1.0 vs 0.6 for single-word).\n" +
    "  KID weight tuning (nearlist/phraselist) CANNOT fix single-word false positives — nearlist\n" +
    "  requires multi-word labels to fire, so single-word matches always score at the phraselist weight.\n\n" +
    "IMPROVING RECALL (too few correct matches):\n" +
    "  Add altLabels for common synonyms, abbreviations, or domain-specific phrasings.\n" +
    "  Prefer multi-word phrases over single words to avoid introducing new false positives.\n\n" +
    "PRECLUSION / NEGATIVE EVIDENCE:\n" +
    "  Semaphore does not have a native score-subtraction operator in standard KID template rules.\n" +
    "  The CLS 'not' attribute (not=\"1\" on phraselist/nearlist) means ABSENCE-FIRING, not score-reduction:\n" +
    "    not=\"0\" (default) — contributes weight when the pattern IS found in the document\n" +
    "    not=\"1\"           — contributes weight when the pattern is NOT found in the document\n" +
    "  This means hiddenLabel + not=\"1\" in the KID template creates UPWARD SEPARATION:\n" +
    "    • Genuine concept articles (no disqualifying words) score HIGHER (phraselist + not=\"1\" both fire)\n" +
    "    • False-positive articles (disqualifying words present) score the SAME as before (not=\"1\" contributes 0)\n" +
    "  It does NOT reduce false-positive scores — it widens the gap between true and false positives.\n" +
    "  Combined with a raised threshold (e.g. 65+), this can eliminate false positives IF true positives\n" +
    "  reliably score above the new threshold. Test with semaphore_classify before committing.\n\n" +
    "  Best approaches for false positives (in order of preference):\n" +
    "  1. Remove the label causing the match (simplest, model-level fix)\n" +
    "  2. hiddenLabel + not=\"1\" KID template rule → raises true-positive scores, enabling a higher threshold\n" +
    "     Step 1: semaphore_kmm_sparql_update — add skos:hiddenLabel disqualifying-context words to the concept\n" +
    "     Step 2: semaphore_kid_template_set content='...' — add <phraselist not=\"1\" labeltypes=\"hiddenLabel\" weight=\"N\" foreach=\"1\"/> to the EVIDENCE combine\n" +
    "     Step 3: semaphore_publish → semaphore_classify threshold=0 on both true and false positive examples\n" +
    "     Step 4: if separation is visible, raise pipeline threshold accordingly\n" +
    "  3. Narrow the concept scope — add skos:scopeNote to document intent (won't affect rules, but helps humans)\n\n" +
    "IMPORTANT: After any label change, run semaphore_publish to apply the change to the Classification Server.",
    {
      model_uri: z.string().describe(
        "KMM model URI, e.g. 'model:IPTCMediaTopics'. Get from semaphore_kmm_models_list."
      ),
      concept_uri: z.string().describe(
        "Full concept URI, e.g. 'http://cv.iptc.org/newscodes/mediatopic/20000209'. " +
        "Get from semaphore_concept_search."
      ),
      action: z.enum(["add", "remove"]).describe(
        "'add' inserts the label; 'remove' deletes it."
      ),
      label_type: z.enum(["prefLabel", "altLabel", "hiddenLabel"]).describe(
        "SKOS label property to modify."
      ),
      label_value: z.string().describe(
        "The literal string value of the label, e.g. 'wedding'. Do not include language tag here — use lang param."
      ),
      lang: z.string().optional().describe(
        "Language tag for the label, e.g. 'en'. Default: 'en'."
      ),
    },
    async ({ model_uri, concept_uri, action, label_type, label_value, lang = "en" }) => {
      if (!semaphore.kmmBaseUrl) {
        return { content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }], isError: true };
      }
      if (!semaphore.kmmConfigured) {
        return { content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }], isError: true };
      }

      const uri = concept_uri.replace(/>/g, "").replace(/</g, "");
      const conceptRef = uri.startsWith("http") ? `<${uri}>` : uri;
      const predicate = `<http://www.w3.org/2004/02/skos/core#${label_type}>`;
      const escaped = label_value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const literal = `"${escaped}"@${lang}`;
      const triple = `${conceptRef} ${predicate} ${literal}`;

      // Build SKOS-XL reification so labels appear in Studio "Preferred/Alternative Labels"
      // managed sections rather than only in the raw Metadata view.
      // hiddenLabel has no skosxl equivalent — only reify prefLabel and altLabel.
      const xlLabelType = label_type === "prefLabel" ? "prefLabel"
                        : label_type === "altLabel"  ? "altLabel"
                        : null;
      const xlTriples: string[] = [];
      if (xlLabelType && uri.startsWith("http")) {
        const typeSlug = label_type === "prefLabel" ? "pref" : "alt";
        const labelNodeUri = `${uri}/xlabels/${lang}/${typeSlug}/${encodeURIComponent(label_value)}`;
        xlTriples.push(
          `<${labelNodeUri}> a <http://www.w3.org/2008/05/skos-xl#Label> .`,
          `<${labelNodeUri}> <http://www.w3.org/2008/05/skos-xl#literalForm> ${literal} .`,
          `${conceptRef} <http://www.w3.org/2008/05/skos-xl#${xlLabelType}> <${labelNodeUri}> .`,
        );
      }

      const allTriples = [triple, ...xlTriples].join(" ");
      const sparql = action === "add"
        ? `INSERT DATA { ${allTriples} }`
        : `DELETE DATA { ${allTriples} }`;

      try {
        await semaphore.kmmSparqlUpdate(model_uri, sparql);

        const lines = [
          `CONCEPT LABEL ${action === "add" ? "ADDED" : "REMOVED"}`,
          "─".repeat(50),
          "",
          `  Model:      ${model_uri}`,
          `  Concept:    ${concept_uri}`,
          `  Action:     ${action === "add" ? "ADDED" : "REMOVED"}`,
          `  Label type: skos:${label_type}`,
          `  Value:      "${label_value}"@${lang}`,
          "",
          "SPARQL executed:",
          `  ${sparql}`,
          "",
          "NEXT STEPS:",
          `  1. Verify:    semaphore_concept_get  model_uri="${model_uri}"  concept_uri="${concept_uri}"`,
          `  2. Re-publish: semaphore_publish  model_uri="${model_uri}"`,
          "  3. Test:      semaphore_classify  (with a document that previously showed the false positive)",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_taxonomy_validate ───────────────────────────────────────────────
  server.tool(
    "semaphore_taxonomy_validate",
    "Run structural quality checks on a SKOS taxonomy loaded in KMM. " +
    "Executes SPARQL queries to detect common modeling anti-patterns and report hierarchy health.\n\n" +
    "CHECKS PERFORMED:\n" +
    "  1. Concept counts — total concepts, top concepts, leaf concepts (no narrower)\n" +
    "  2. Flat suspects — concepts that have many altLabels (≥5) but NO skos:narrower children;\n" +
    "     these are candidates for anti-pattern refactoring (child names stuffed as altLabels)\n" +
    "  3. Orphan concepts — concepts with no skos:broader and not declared skos:topConceptOf\n" +
    "  4. Missing prefLabels in the model's language — concepts lacking a skos:prefLabel in the expected language (breaks CLS publishing)\n" +
    "  5. Duplicate altLabels — the same altLabel string appearing on multiple concepts\n" +
    "  6. Hierarchy depth — how many concepts exist at each depth level (1 = top, 2 = children, etc.)\n" +
    "  7. ConceptScheme URI — verifies a ConceptScheme exists at {namespace}{ModelId}Taxonomy\n" +
    "     (required for the Semaphore Publisher to enumerate concepts at publish time)\n\n" +
    "Run this after semaphore_kmm_skos_load and before semaphore_publish to catch issues early.\n\n" +
    "LANGUAGE: If omitted, the dominant prefLabel language is auto-detected from the model. " +
    "Override with the 'language' parameter if the auto-detection picks the wrong tag (e.g. if the model " +
    "has a mix of languages and you want to validate a specific one).",
    {
      model_uri: z.string().describe(
        "KMM model URI to validate, e.g. 'model:AWSServices'. " +
        "Get from semaphore_kmm_models_list."
      ),
      language: z.string().optional().describe(
        "BCP 47 language tag to validate prefLabels against, e.g. 'en', 'fr', 'de', 'nl'. " +
        "If omitted, the dominant language is auto-detected from the model's existing prefLabels."
      ),
      flat_suspect_threshold: z.number().int().min(1).optional().describe(
        "Minimum number of altLabels on a concept before it is flagged as a flat suspect. Default: 5."
      ),
    },
    async ({ model_uri, language, flat_suspect_threshold = 5 }) => {
      if (!semaphore.kmmBaseUrl) {
        return { content: [{ type: "text", text: "KMM is not configured." }], isError: true };
      }
      try {
        const SKOS = "http://www.w3.org/2004/02/skos/core#";

        // Auto-detect dominant prefLabel language if not specified
        let lang = language;
        if (!lang) {
          try {
            const langRes = await semaphore.kmmSparqlQuery(model_uri,
              `PREFIX skos: <${SKOS}>
               SELECT (LANG(?l) AS ?lang) (COUNT(?l) AS ?n) WHERE {
                 ?c a skos:Concept ; skos:prefLabel ?l .
                 FILTER(LANG(?l) != "")
               } GROUP BY LANG(?l) ORDER BY DESC(COUNT(?l)) LIMIT 1`
            );
            lang = langRes.rows[0]?.lang ?? "en";
          } catch {
            lang = "en";
          }
        }

        // 1. Total concepts
        const totalResult = await semaphore.kmmSparqlQuery(model_uri,
          `PREFIX skos: <${SKOS}>
           SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c a skos:Concept }`
        );
        const totalConcepts = parseInt(totalResult.rows[0]?.n ?? "0", 10);

        // 2. Top concepts
        const topResult = await semaphore.kmmSparqlQuery(model_uri,
          `PREFIX skos: <${SKOS}>
           SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c skos:topConceptOf ?s }`
        );
        const topConcepts = parseInt(topResult.rows[0]?.n ?? "0", 10);

        // 3. Leaf concepts (no narrower children)
        const leafResult = await semaphore.kmmSparqlQuery(model_uri,
          `PREFIX skos: <${SKOS}>
           SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE {
             ?c a skos:Concept .
             FILTER NOT EXISTS { ?c skos:narrower ?child }
             FILTER NOT EXISTS { ?child skos:broader ?c }
           }`
        );
        const leafConcepts = parseInt(leafResult.rows[0]?.n ?? "0", 10);

        // 4. Flat suspects: many altLabels, no narrower
        const flatResult = await semaphore.kmmSparqlQuery(model_uri,
          `PREFIX skos: <${SKOS}>
           SELECT ?c ?label (COUNT(?alt) AS ?altCount) WHERE {
             ?c a skos:Concept ;
                skos:prefLabel ?label ;
                skos:altLabel ?alt .
             FILTER NOT EXISTS { ?c skos:narrower ?child }
             FILTER NOT EXISTS { ?child2 skos:broader ?c }
             FILTER(LANG(?label) = "${lang}")
           }
           GROUP BY ?c ?label
           HAVING (COUNT(?alt) >= ${flat_suspect_threshold})
           ORDER BY DESC(COUNT(?alt))`
        );

        // 5. Orphan concepts
        const orphanResult = await semaphore.kmmSparqlQuery(model_uri,
          `PREFIX skos: <${SKOS}>
           SELECT ?c ?label WHERE {
             ?c a skos:Concept .
             OPTIONAL { ?c skos:prefLabel ?label . FILTER(LANG(?label) = "${lang}") }
             FILTER NOT EXISTS { ?c skos:broader ?parent }
             FILTER NOT EXISTS { ?c skos:topConceptOf ?scheme }
           }`
        );

        // 6. Missing prefLabel in model language
        const missingLangResult = await semaphore.kmmSparqlQuery(model_uri,
          `PREFIX skos: <${SKOS}>
           SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE {
             ?c a skos:Concept .
             FILTER NOT EXISTS {
               ?c skos:prefLabel ?l .
               FILTER(LANG(?l) = "${lang}")
             }
           }`
        );
        const missingLang = parseInt(missingLangResult.rows[0]?.n ?? "0", 10);

        // 7. Hierarchy depth counts (depth 1 = topConcept, depth 2 = direct child, depth 3+ = deeper)
        const depth1Result = await semaphore.kmmSparqlQuery(model_uri,
          `PREFIX skos: <${SKOS}>
           SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c skos:topConceptOf ?s }`
        );
        const depth2Result = await semaphore.kmmSparqlQuery(model_uri,
          `PREFIX skos: <${SKOS}>
           SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE {
             ?c skos:broader ?parent .
             ?parent skos:topConceptOf ?s .
           }`
        );
        const depth3Result = await semaphore.kmmSparqlQuery(model_uri,
          `PREFIX skos: <${SKOS}>
           SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE {
             ?c skos:broader ?parent .
             ?parent skos:broader ?gp .
             ?gp skos:topConceptOf ?s .
           }`
        );
        const d1 = parseInt(depth1Result.rows[0]?.n ?? "0", 10);
        const d2 = parseInt(depth2Result.rows[0]?.n ?? "0", 10);
        const d3 = parseInt(depth3Result.rows[0]?.n ?? "0", 10);

        // Build report
        const lines: string[] = [
          "TAXONOMY VALIDATION REPORT",
          "─".repeat(50),
          "",
          `  Model:          ${model_uri}`,
          `  Language:       @${lang}${language ? "" : "  (auto-detected)"}`,
          `  Total concepts: ${totalConcepts}`,
          `  Top concepts:   ${topConcepts}  (depth 1)`,
          `  Depth 2:        ${d2} concepts`,
          `  Depth 3+:       ${d3} concepts`,
          `  Leaf concepts:  ${leafConcepts} (no children)`,
          "",
        ];

        // Missing prefLabel in model language
        if (missingLang === 0) {
          lines.push(`  ✓ All concepts have a @${lang} skos:prefLabel`);
        } else {
          lines.push(`  ✗ MISSING @${lang} prefLabel: ${missingLang} concept(s) — will break CLS publishing`);
        }

        // Orphans
        if (orphanResult.rows.length === 0) {
          lines.push("  ✓ No orphan concepts (all have skos:broader or skos:topConceptOf)");
        } else {
          lines.push(`  ✗ ORPHAN concepts: ${orphanResult.rows.length} concept(s) with no broader/topConceptOf:`);
          orphanResult.rows.slice(0, 10).forEach(r => {
            lines.push(`      ${r.label ?? r.c}`);
          });
          if (orphanResult.rows.length > 10) lines.push(`      ... and ${orphanResult.rows.length - 10} more`);
        }

        // Flat suspects
        lines.push("");
        if (flatResult.rows.length === 0) {
          lines.push(`  ✓ No flat suspects (no leaf concepts with ≥${flat_suspect_threshold} altLabels)`);
        } else {
          lines.push(`  ⚠ FLAT SUSPECTS (leaf concepts with ≥${flat_suspect_threshold} altLabels — possible anti-pattern):`);
          lines.push("    These concepts have many altLabels but no narrower children.");
          lines.push("    Consider: are any altLabels actually distinct sub-concepts that deserve their own skos:Concept?");
          lines.push("");
          flatResult.rows.forEach(r => {
            lines.push(`      "${r.label}"  (${r.altCount} altLabels)`);
          });
        }

        // ── ConceptScheme URI check ──────────────────────────────────────────
        // The Semaphore Publisher requires a ConceptScheme at {namespace}{ModelId}Taxonomy
        const modelName = model_uri.replace(/^model:/, "");
        const expectedSuffix = `${modelName}Taxonomy`;
        let hasCorrectScheme = false;
        let schemeUris: string[] = [];
        try {
          const schemeRes = await semaphore.kmmSparqlQuery(model_uri,
            `PREFIX skos: <${SKOS}>
             SELECT ?scheme WHERE { ?scheme a skos:ConceptScheme } LIMIT 10`
          );
          schemeUris = schemeRes.rows.map(r => r.scheme ?? "").filter(Boolean);
          hasCorrectScheme = schemeUris.some(s => s.endsWith(expectedSuffix));
        } catch { /* non-fatal */ }

        lines.push("");
        if (schemeUris.length === 0) {
          lines.push(`  ✗ NO ConceptScheme found — required for publishing!`);
          lines.push(`    Add a ConceptScheme URI ending with '${expectedSuffix}' via semaphore_kmm_sparql_update.`);
        } else if (!hasCorrectScheme) {
          lines.push(`  ✗ CONCEPTSCHEME URI MISMATCH:`);
          lines.push(`    Expected URI ending with: .../${expectedSuffix}`);
          schemeUris.forEach(s => lines.push(`    Found: ${s}`));
          lines.push(`    The publisher's concept-enumeration query uses '{namespace}${expectedSuffix}'.`);
          lines.push(`    Rename/add the scheme or the publish will produce only 1 rule.`);
        } else {
          const matchingScheme = schemeUris.find(s => s.endsWith(expectedSuffix))!;
          lines.push(`  ✓ ConceptScheme URI is correct: ${matchingScheme}`);
        }

        lines.push("");
        lines.push("NEXT STEPS:");
        if (missingLang > 0) {
          lines.push(`  - Fix missing @${lang} labels: use semaphore_concept_labels_update for each affected concept`);
        }
        if (orphanResult.rows.length > 0) {
          lines.push(`  - Fix orphans: add skos:broader or skos:topConceptOf via semaphore_kmm_sparql_update`);
        }
        if (flatResult.rows.length > 0) {
          lines.push(`  - Review flat suspects: refactor by adding skos:narrower sub-concepts where appropriate`);
        }
        if (!hasCorrectScheme) {
          lines.push(`  - Fix ConceptScheme URI: add a ConceptScheme ending with '${expectedSuffix}'`);
        }
        if (missingLang === 0 && orphanResult.rows.length === 0 && hasCorrectScheme) {
          lines.push(`  - Taxonomy looks structurally sound — proceed with semaphore_publish_config_fix_plain_skos then semaphore_publish`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_taxonomy_scaffold ───────────────────────────────────────────────
  server.tool(
    "semaphore_taxonomy_scaffold",
    "Generate a properly structured SKOS Turtle skeleton for a new taxonomy, following best practices. " +
    "Returns ready-to-load Turtle text that can be passed directly to semaphore_kmm_skos_load.\n\n" +
    "WHAT THIS GENERATES:\n" +
    "  - A skos:ConceptScheme with skos:hasTopConcept links and skos:definition (no dcterms:* metadata)\n" +
    "  - Top-level concepts with skos:topConceptOf and skos:narrower links\n" +
    "  - Narrower (child) concepts with skos:broader back-links\n" +
    "  - Placeholder skos:definition on top concepts\n" +
    "  - All labels tagged with the specified language (default: @en)\n" +
    "  - skos:altLabel stubs on child concepts (to be filled in with synonyms, NOT child names)\n\n" +
    "IMPORTANT — AVOID dcterms:* METADATA ON ConceptScheme:\n" +
    "  Do NOT add dcterms:created, dcterms:description, or other Dublin Core properties to the\n" +
    "  skos:ConceptScheme node. KMM's domain/range validation rejects these with 'Definition\n" +
    "  incomplete — domain or range not valid' warnings. Use instead:\n" +
    "    skos:definition  — for descriptions (replaces dcterms:description)\n" +
    "    skos:note        — for general notes\n" +
    "  Do NOT add any dcterms:created timestamp — KMM tracks creation internally.\n\n" +
    "SKOS BEST PRACTICES REMINDER:\n" +
    "  ✓ skos:narrower/skos:broader = hierarchy (child concept IS-A parent)\n" +
    "  ✓ skos:altLabel = synonyms/abbreviations for THAT concept only\n" +
    "  ✗ Do NOT list narrower concept names as altLabels on the parent\n" +
    "  ✓ Use skos:related for cross-cutting associations between sibling branches\n\n" +
    "After generating, edit the Turtle to add meaningful altLabels to each child concept, " +
    "then pass to semaphore_kmm_skos_load using the skos_content parameter.",
    {
      scheme_name: z.string().describe(
        "Human-readable name for the concept scheme, e.g. 'AWS Services Taxonomy'."
      ),
      scheme_id: z.string().describe(
        "CamelCase identifier for the scheme and namespace, e.g. 'AWSServices'. " +
        "Used to build concept URIs like <ns:AWSServices> and <ns:EC2>."
      ),
      namespace: z.string().describe(
        "Base namespace URI for the taxonomy, e.g. 'http://example.com/taxonomy/aws/'. " +
        "Must end with '/' or '#'."
      ),
      language: z.string().optional().describe(
        "BCP 47 language tag for all generated labels, e.g. 'en', 'fr', 'de', 'nl'. " +
        "Defaults to 'en'. Use the primary language of the taxonomy content."
      ),
      top_concepts: z.array(z.object({
        id: z.string().describe("CamelCase identifier for this top concept, e.g. 'Compute'."),
        label: z.string().describe("Human-readable preferred label, e.g. 'Compute'."),
        definition: z.string().optional().describe("Optional definition for this top concept."),
        narrower: z.array(z.object({
          id: z.string().describe("CamelCase identifier, e.g. 'EC2'."),
          label: z.string().describe("Preferred label, e.g. 'Amazon EC2'."),
          alt_labels: z.array(z.string()).optional().describe(
            "Synonyms and abbreviations for THIS concept (not its children), e.g. ['EC2', 'Elastic Compute Cloud']."
          ),
        })).optional().describe("Narrower (child) concepts under this top concept."),
      })).describe("Top-level concept definitions with optional narrower children."),
    },
    async ({ scheme_name, scheme_id, namespace, language, top_concepts }) => {
      const ns = namespace.endsWith("/") || namespace.endsWith("#") ? namespace : namespace + "/";
      const prefix = scheme_id.toLowerCase().replace(/[^a-z0-9]/g, "");
      const lang = language ?? "en";
      // Strip trailing "Taxonomy" from scheme_id to avoid doubled suffix (e.g. "FooTaxonomyTaxonomy")
      const schemeBase = scheme_id.replace(/Taxonomy$/i, "");

      const lines: string[] = [
        `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .`,
        `@prefix ${prefix}: <${ns}> .`,
        "",
        `${prefix}:${schemeBase}Taxonomy a skos:ConceptScheme ;`,
        `    skos:prefLabel "${scheme_name}"@${lang} ;`,
        `    skos:definition "Hierarchical taxonomy of ${scheme_name}"@${lang} ;`,
      ];

      // hasTopConcept list
      const topIds = top_concepts.map(tc => `${prefix}:${tc.id}`);
      lines.push(`    skos:hasTopConcept ${topIds.join(", ")} .`);
      lines.push("");

      for (const tc of top_concepts) {
        const narrowerIds = (tc.narrower ?? []).map(n => `${prefix}:${n.id}`);

        lines.push(`# ── TOP CONCEPT: ${tc.label.toUpperCase()} ${"─".repeat(Math.max(0, 50 - tc.label.length))}`);
        lines.push("");
        lines.push(`${prefix}:${tc.id} a skos:Concept ;`);
        lines.push(`    skos:inScheme ${prefix}:${schemeBase}Taxonomy ;`);
        lines.push(`    skos:topConceptOf ${prefix}:${schemeBase}Taxonomy ;`);
        lines.push(`    skos:prefLabel "${tc.label}"@${lang} ;`);
        if (tc.definition) {
          lines.push(`    skos:definition "${tc.definition.replace(/"/g, '\\"')}"@${lang} ;`);
        } else {
          lines.push(`    skos:definition "TODO: Add definition for ${tc.label}"@${lang} ;`);
        }
        if (narrowerIds.length > 0) {
          lines.push(`    skos:narrower ${narrowerIds.join(", ")} .`);
        } else {
          lines.push(`    skos:narrower ${prefix}:TODO_AddChildConcepts .  # Replace with actual narrower concepts`);
        }
        lines.push("");

        for (const child of (tc.narrower ?? [])) {
          const altLabels = (child.alt_labels ?? []).map(a => `"${a.replace(/"/g, '\\"')}"@${lang}`);
          lines.push(`${prefix}:${child.id} a skos:Concept ;`);
          lines.push(`    skos:inScheme ${prefix}:${schemeBase}Taxonomy ;`);
          lines.push(`    skos:broader ${prefix}:${tc.id} ;`);
          lines.push(`    skos:prefLabel "${child.label}"@${lang} ;`);
          if (altLabels.length > 0) {
            lines.push(`    skos:altLabel ${altLabels.join(", ")} .`);
          } else {
            lines.push(`    skos:altLabel "TODO: Add synonyms for ${child.label}"@${lang} .  # Replace with real altLabels`);
          }
          lines.push("");
        }
      }

      const turtle = lines.join("\n");
      const conceptCount = top_concepts.length + top_concepts.reduce((sum, tc) => sum + (tc.narrower?.length ?? 0), 0);

      const skosXlBackfillSparql =
        `PREFIX skos: <http://www.w3.org/2004/02/skos/core#> ` +
        `PREFIX skosxl: <http://www.w3.org/2008/05/skos-xl#> ` +
        `INSERT { ?c skosxl:prefLabel ?n . ?n a skosxl:Label . ?n skosxl:literalForm ?l . } ` +
        `WHERE { { ?c a skos:Concept } UNION { ?c a skos:ConceptScheme } ` +
        `?c skos:prefLabel ?l . ` +
        `BIND(IRI(CONCAT(STR(?c),"/xlabels/",LANG(?l),"/pref/",ENCODE_FOR_URI(STR(?l)))) AS ?n) ` +
        `FILTER NOT EXISTS { ?n a skosxl:Label } }`;

      const output = [
        "TAXONOMY SCAFFOLD GENERATED",
        "─".repeat(50),
        "",
        `  Scheme:        ${scheme_name}`,
        `  Namespace:     ${ns}`,
        `  Top concepts:  ${top_concepts.length}`,
        `  Total concepts: ${conceptCount} (including ${conceptCount - top_concepts.length} narrower)`,
        "",
        "TURTLE CONTENT (pass to semaphore_kmm_skos_load as skos_content):",
        "─".repeat(50),
        turtle,
        "─".repeat(50),
        "",
        "NEXT STEPS:",
        "  1. Edit the Turtle above — fill in meaningful skos:altLabel synonyms on child concepts",
        "  2. Add skos:related links for cross-cutting relationships between sibling branches",
        "  3. Replace any TODO placeholders",
        "  4. semaphore_kmm_skos_load  model_uri='<your-model>'  skos_content='<turtle above>'",
        "  5. semaphore_taxonomy_validate  model_uri='<your-model>'  (check structure)",
        "  6. ⚠️  REQUIRED — Add SKOS-XL reification IMMEDIATELY after loading.",
        "     Without this step, Semaphore Studio shows 'No preferred labels' / 'Create a preferred label'",
        "     even though the plain skos:prefLabel triples exist. Studio manages SKOS-XL labels, not plain SKOS.",
        `     semaphore_kmm_sparql_update  model_uri='<your-model>'`,
        `     sparql='${skosXlBackfillSparql}'`,
        "  7. semaphore_publish_config_fix_plain_skos  model_uri='<your-model>'",
        "  8. semaphore_publish  model_uri='<your-model>'",
      ];

      return { content: [{ type: "text", text: output.join("\n") }] };
    }
  );

  // ── semaphore_kid_template_get ────────────────────────────────────────────────
  server.tool(
    "semaphore_kid_template_get",
    "Retrieve the current Semaphore publisher rule template (.kid file) from a model's workspace.\n\n" +
    "The .kid file is an XML template that controls how Semaphore generates CLS rules from taxonomy " +
    "concepts. It defines the scoring weights for:\n" +
    "  • Exact phrase matches (phraselist weight)\n" +
    "  • Near-word matches (nearlist weight — constituent words appearing near each other)\n" +
    "  • Hierarchy contributions (linklist LowerInHierarchy weight — child concept fires → parent gets credit)\n" +
    "  • Associative contributions (linklist Associative weight — related concepts boost score)\n" +
    "  • Associative cap (combine weight capping total associative contribution)\n\n" +
    "USE THIS TO:\n" +
    "  • Inspect the current scoring weights before tuning\n" +
    "  • Retrieve the template XML to edit and re-upload via semaphore_kid_template_set\n" +
    "  • Verify that a previous semaphore_kid_template_set took effect\n\n" +
    "DEFAULT WEIGHTS (ContextualCitation.kid):\n" +
    "  phraselist=20, nearlist=50, linklist LowerInHierarchy=60, Associative=50, associative cap=30",
    {
      model_uri: z.string().describe(
        "KMM model URI, e.g. 'model:IPTCMediaTopics'. Get from semaphore_kmm_models_list."
      ),
      template_name: z.string().optional().describe(
        "Template filename to retrieve, e.g. 'ContextualCitation.kid'. " +
        "Default: 'ContextualCitation.kid' (the standard Semaphore template)."
      ),
    },
    async ({ model_uri, template_name = "ContextualCitation.kid" }) => {
      if (!semaphore.kmmBaseUrl) {
        return { content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }], isError: true };
      }
      if (!semaphore.kmmConfigured) {
        return { content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }], isError: true };
      }
      try {
        const content = await semaphore.kmmGetKidTemplate(model_uri, template_name);
        if (content === null) {
          return {
            content: [{
              type: "text",
              text:
                `TEMPLATE NOT FOUND: ${template_name}\n\n` +
                `No publisher workspace or template found for ${model_uri}.\n\n` +
                "Possible causes:\n" +
                "  • The model has never been published — run semaphore_publish first to create the workspace.\n" +
                "  • The template name is different — check with semaphore_publish_config_fix_plain_skos which template is configured.\n\n" +
                "To set a custom template, use semaphore_kid_template_set.",
            }],
          };
        }
        const lines = [
          `PUBLISHER TEMPLATE: ${template_name}`,
          `Model: ${model_uri}`,
          "─".repeat(60),
          "",
          content,
          "",
          "─".repeat(60),
          "To customize weights or content, use semaphore_kid_template_set.",
          "After updating the template, run semaphore_publish to rebuild the CLS rule set.",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_kid_template_set ────────────────────────────────────────────────
  server.tool(
    "semaphore_kid_template_set",
    "Upload a custom Semaphore publisher rule template (.kid file) for a model.\n\n" +
    "WHAT VELOCITY TEMPLATES ARE:\n" +
    "  The .kid file is a Velocity template that runs at PUBLISH TIME — it controls how the Semaphore\n" +
    "  publisher converts each SKOS concept into CLS classification rules. It defines what types of\n" +
    "  evidence score (exact phrases, near-word matches, child-concept firing, related-concept firing)\n" +
    "  and how much each type contributes. The template is compiled once per publish and the resulting\n" +
    "  .rules file is what the CLS uses at classification time.\n\n" +
    "  KEY ARCHITECTURAL FACT: the template applies IDENTICALLY to every concept in the model.\n" +
    "  A weight change raises or lowers evidence contribution for ALL concepts equally.\n" +
    "  This is why templates are the right fix for SYSTEMIC problems and the wrong fix for\n" +
    "  problems with a specific concept — use label editing for those.\n\n" +
    "PRACTICAL TRIGGER FOR USING THIS TOOL:\n" +
    "  → You find yourself wanting to make the same label edit to many concepts for the same reason.\n" +
    "    That reason is a scoring behaviour that belongs in the template, not in individual concept labels.\n" +
    "  → The default scoring behaviour doesn't match your content type (short headlines vs long reports,\n" +
    "    structured documents with reliable title zones, controlled terminology with no synonyms, etc.)\n" +
    "  → You need a rule structure (zone-biasing, absence-firing) that label editing cannot express.\n\n" +
    "WHEN TO USE THIS TOOL vs. OTHER APPROACHES:\n" +
    "  Use label editing (semaphore_concept_labels_update) FIRST:\n" +
    "    → A specific concept fires on wrong text (remove the offending altLabel)\n" +
    "    → A concept misses correct text (add altLabels / hiddenLabels for synonyms)\n" +
    "    → The fix is isolated to one or a few concepts\n" +
    "  Use threshold tuning (semaphore_classify threshold param) SECOND:\n" +
    "    → You want to explore the precision/recall trade-off without changing the model\n" +
    "    → Quick iteration before committing to model or template changes\n" +
    "  Use this tool (template weight tuning) when:\n" +
    "    → The same scoring problem affects every concept (nearlist noise, hierarchy not propagating,\n" +
    "      associative links inflating scores, title zone not outweighing body)\n" +
    "    → The content type systematically defeats the default scoring (short text, zone-structured docs)\n" +
    "    → You need absence-firing rules (boost true-positives by detecting disqualifying context)\n" +
    "  Use raw content (content param) when:\n" +
    "    → You need KID elements not covered by the weight presets (e.g. labeltypes filtering,\n" +
    "      custom combine structures, pos-specific phraselist rules)\n\n" +
    "PRESETS (recommended starting points — override individual weights as needed):\n" +
    "  balanced         — phrase=20, near=50, hierarchy=60, assoc=50/cap30  (Semaphore default)\n" +
    "  short_text       — phrase=60, near=20, hierarchy=40, assoc=0          (headlines, metadata, short snippets)\n" +
    "  exact_only       — phrase=100, near=0, hierarchy=0,  assoc=0          (max precision, no inference)\n" +
    "  precision        — phrase=70, near=20, hierarchy=0,  assoc=0          (high-precision, no hierarchy)\n" +
    "  hierarchy_heavy  — phrase=20, near=30, hierarchy=90, assoc=40/cap20   (coarse topics, deep taxonomies)\n" +
    "  entity           — phrase=70, near=30, hierarchy=0,  assoc=0          (named-entity style taxonomies)\n\n" +
    "ZONE-BIASING (title_weight / body_weight):\n" +
    "  When provided, the template applies SEPARATE evidence combines for title and body zones.\n" +
    "  CLS zones are defined in the document structure — title zone = pos=1, body zone = pos=0.\n" +
    "  Example: title_weight=80, body_weight=20 means a phrase in the title counts 4× more than body.\n" +
    "  Use when: document structure is reliable (news articles, academic papers, product descriptions).\n" +
    "  Do NOT use for: plain-text blobs, RSS descriptions, short snippets without distinct zones.\n\n" +
    "INDIVIDUAL WEIGHT PARAMETERS (override preset values):\n" +
    "  phraselist_weight       — weight for exact phrase matches (preset value used if omitted)\n" +
    "                            Higher = exact phrase mentions drive classification more strongly.\n" +
    "  nearlist_weight         — weight for near-word matches (preset value used if omitted)\n" +
    "                            Higher = constituent words appearing near each other score more.\n" +
    "                            NOTE: nearlist requires multi-word labels — single-word concepts\n" +
    "                            score entirely via phraselist regardless of nearlist weight.\n" +
    "  lower_hierarchy_weight  — weight for lower-in-hierarchy linklist (preset value used if omitted)\n" +
    "                            Higher = child concept firing gives more credit to the parent.\n" +
    "  associative_weight      — raw weight for associative linklist (preset value used if omitted)\n" +
    "  associative_cap         — combine weight capping total associative contribution (preset value)\n\n" +
    "NEGATIVE EVIDENCE VIA hiddenLabel + not=\"1\" (advanced):\n" +
    "  The CLS 'not' attribute means ABSENCE-FIRING, not score-reduction:\n" +
    "    not=\"1\" fires when the pattern is NOT found → boosts true-positive articles\n" +
    "    not=\"1\" contributes 0 when the pattern IS found → no effect on false-positive scores\n" +
    "  To use: add skos:hiddenLabel disqualifying-context words to the concept via\n" +
    "  semaphore_kmm_sparql_update, then provide custom content with:\n" +
    "    <phraselist pos=\"0\" stem=\"1\" weight=\"N\" not=\"1\" foreach=\"1\" labeltypes=\"hiddenLabel\" />\n" +
    "  Then publish + classify to verify the true/false-positive gap widens.\n\n" +
    "RAW CONTENT:\n" +
    "  Provide 'content' with the full .kid XML to upload an entirely custom template.\n" +
    "  Retrieve the current template with semaphore_kid_template_get to use as a starting point.\n\n" +
    "AFTER UPDATING:\n" +
    "  Run semaphore_publish to rebuild the CLS rule set with the new template.\n" +
    "  Then run semaphore_classify to verify the scoring change had the desired effect.",
    {
      model_uri: z.string().describe(
        "KMM model URI, e.g. 'model:IPTCMediaTopics'. Get from semaphore_kmm_models_list."
      ),
      template_name: z.string().optional().describe(
        "Template filename to set, e.g. 'ContextualCitation.kid'. " +
        "Default: 'ContextualCitation.kid'. If a non-default name is provided, " +
        "the publisher XML config is also patched to reference it."
      ),
      preset: z.enum(["balanced", "short_text", "exact_only", "precision", "hierarchy_heavy", "entity"]).optional().describe(
        "Named starting-point preset. Sets all five weights to well-known values for a specific use case.\n" +
        "  balanced        — Semaphore defaults; good general starting point\n" +
        "  short_text      — for headlines, metadata, short snippets; high phrase weight, low near\n" +
        "  exact_only      — maximum precision; phrase matches only, no near/hierarchy/associative\n" +
        "  precision       — high phrase + modest near; no hierarchy/associative propagation\n" +
        "  hierarchy_heavy — strong hierarchy propagation; good for coarse topics with deep taxonomies\n" +
        "  entity          — named-entity style; phrase + near evidence only, no hierarchy\n" +
        "Individual weight params (phraselist_weight etc.) override preset values when both are provided."
      ),
      content: z.string().optional().describe(
        "Raw .kid XML content to upload. Mutually exclusive with preset and weight parameters. " +
        "Use semaphore_kid_template_get to retrieve the current template as a starting point."
      ),
      title_weight: z.number().int().min(0).max(100).optional().describe(
        "Zone-biasing: relative weight for evidence found in the document TITLE zone (pos=1). " +
        "When provided together with body_weight, generates a zone-biased template where title and body " +
        "contribute evidence in proportion to these weights. Typical value: 70–80 to boost title matches. " +
        "Do not use for documents without reliable title/body structure."
      ),
      body_weight: z.number().int().min(0).max(100).optional().describe(
        "Zone-biasing: relative weight for evidence found in the document BODY zone (pos=0). " +
        "Must be provided together with title_weight. Typical value: 20–30."
      ),
      phraselist_weight: z.number().int().min(0).max(100).optional().describe(
        "Weight for exact phrase matches (0–100). Overrides preset value. Default (no preset): 20."
      ),
      nearlist_weight: z.number().int().min(0).max(100).optional().describe(
        "Weight for near-word matches (0–100). Overrides preset value. Default (no preset): 50."
      ),
      lower_hierarchy_weight: z.number().int().min(0).max(100).optional().describe(
        "Weight for lower-in-hierarchy linklist (0–100). Overrides preset value. Default (no preset): 60."
      ),
      associative_weight: z.number().int().min(0).max(100).optional().describe(
        "Raw associative linklist weight (0–100). Overrides preset value. Default (no preset): 50."
      ),
      associative_cap: z.number().int().min(0).max(100).optional().describe(
        "Max total associative contribution as a combine weight (0–100). Overrides preset value. Default (no preset): 30."
      ),
    },
    async ({
      model_uri,
      template_name = "ContextualCitation.kid",
      preset,
      content,
      title_weight,
      body_weight,
      phraselist_weight,
      nearlist_weight,
      lower_hierarchy_weight,
      associative_weight,
      associative_cap,
    }) => {
      if (!semaphore.kmmBaseUrl) {
        return { content: [{ type: "text", text: "KMM is not configured. Set SEMAPHORE_HOST in the MCP server .env." }], isError: true };
      }
      if (!semaphore.kmmConfigured) {
        return { content: [{ type: "text", text: "KMM credentials not configured. Set SEMAPHORE_USERNAME and SEMAPHORE_PASSWORD." }], isError: true };
      }

      let templateContent: string;

      if (content) {
        // Raw content provided — use as-is
        templateContent = content;
      } else {
        // Resolve preset defaults, then apply any explicit overrides
        const PRESETS: Record<string, { phrase: number; near: number; hierarchy: number; assoc: number; assocCap: number }> = {
          balanced:        { phrase: 20,  near: 50, hierarchy: 60, assoc: 50, assocCap: 30 },
          short_text:      { phrase: 60,  near: 20, hierarchy: 40, assoc: 0,  assocCap: 0  },
          exact_only:      { phrase: 100, near: 0,  hierarchy: 0,  assoc: 0,  assocCap: 0  },
          precision:       { phrase: 70,  near: 20, hierarchy: 0,  assoc: 0,  assocCap: 0  },
          hierarchy_heavy: { phrase: 20,  near: 30, hierarchy: 90, assoc: 40, assocCap: 20 },
          entity:          { phrase: 70,  near: 30, hierarchy: 0,  assoc: 0,  assocCap: 0  },
        };
        const base = preset ? PRESETS[preset] : { phrase: 20, near: 50, hierarchy: 60, assoc: 50, assocCap: 30 };
        const phrase    = phraselist_weight       ?? base.phrase;
        const near      = nearlist_weight         ?? base.near;
        const hierarchy = lower_hierarchy_weight  ?? base.hierarchy;
        const assoc     = associative_weight      ?? base.assoc;
        const assocCap  = associative_cap         ?? base.assocCap;
        const presetLabel = preset ?? "custom";

        const useZones = title_weight !== undefined && body_weight !== undefined;

        // Build EVIDENCE combine — either zone-biased or flat
        const evidenceLines = useZones
          ? [
              `\t\t<!-- Evidence lookup — zone-biased (title pos=1 weight=${title_weight}, body pos=0 weight=${body_weight}) -->`,
              `\t\t<combine label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE" weight="100">`,
              `\t\t\t<!-- Title zone evidence (higher weight) -->`,
              `\t\t\t<combine weight="${title_weight}">`,
              `\t\t\t\t<phraselist pos="1" stem="1" weight="${phrase}" foreach="1" />`,
              near > 0 ? `\t\t\t\t<nearlist pos="1" stem="1" weight="${near}" foreach="1" />` : "",
              `\t\t\t</combine>`,
              `\t\t\t<!-- Body zone evidence -->`,
              `\t\t\t<combine weight="${body_weight}">`,
              `\t\t\t\t<phraselist pos="0" stem="1" weight="${phrase}" foreach="1" />`,
              near > 0 ? `\t\t\t\t<nearlist pos="0" stem="1" weight="${near}" foreach="1" />` : "",
              `\t\t\t</combine>`,
              `\t\t</combine>`,
            ].filter(l => l !== "")
          : [
              `\t\t<!-- Evidence lookup — all document zones -->`,
              `\t\t<combine label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE" weight="100">`,
              `\t\t\t<phraselist pos="0" stem="1" weight="${phrase}" foreach="1" />`,
              near > 0 ? `\t\t\t<nearlist pos="0" stem="1" weight="${near}" foreach="1" />` : "",
              `\t\t</combine>`,
            ].filter(l => l !== "");

        templateContent = [
          `<!-- Template: ${template_name} | preset: ${presetLabel}${useZones ? ` | zone-biased title=${title_weight} body=${body_weight}` : ""} -->`,
          `<rulebase language="\${language.iso_code}">`,
          "",
          `\t<!--`,
          `\t  Preset: ${presetLabel}`,
          `\t  phrase=${phrase}, near=${near}, hierarchy=${hierarchy}, assoc=${assoc} (cap ${assocCap}%)`,
          useZones ? `\t  Zone-biased: title=${title_weight}, body=${body_weight}` : "",
          `\t-->`,
          "",
          `\t<content>`,
          "",
          `\t\t<!-- Firing category -->`,
          `\t\t<category class="\${rulebaseClass}" name="\${resource.label}" id="\${resource.guid}">`,
          `\t\t\t<link label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_FINAL"/>`,
          `\t\t</category>`,
          "",
          `\t\t<!-- Combine: evidence + hierarchy + associative contributions -->`,
          `\t\t<combine label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_FINAL" weight="100">`,
          `\t\t\t<link label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE"/>`,
          assocCap > 0 ? [
            `\t\t\t<combine weight="${assocCap}">`,
            `\t\t\t\t<linklist label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE" weight="${assoc}" relationshiptypes="Associative"/>`,
            `\t\t\t</combine>`,
          ].join("\n") : "",
          hierarchy > 0 ? [
            `\t\t\t<combine weight="100">`,
            `\t\t\t\t<linklist label="link.\${rulebaseClass}.\${resource.label}.\${language.iso_code}.\${resource.guid}_EVIDENCE" weight="${hierarchy}" relationshiptypes="LowerInHierarchy"/>`,
            `\t\t\t</combine>`,
          ].join("\n") : "",
          `\t\t</combine>`,
          "",
          ...evidenceLines,
          "",
          `\t</content>`,
          "",
          `</rulebase>`,
        ].filter(l => l !== "").join("\n");
      }

      try {
        await semaphore.kmmSetKidTemplate(model_uri, templateContent, { templateName: template_name });

        let usedDesc: string;
        if (content) {
          usedDesc = "(raw XML content provided)";
        } else {
          const presetLabel = preset ?? "custom";
          const resolvedPreset = preset
            ? ({ balanced: { phrase: 20, near: 50, hierarchy: 60, assoc: 50, assocCap: 30 }, short_text: { phrase: 60, near: 20, hierarchy: 40, assoc: 0, assocCap: 0 }, exact_only: { phrase: 100, near: 0, hierarchy: 0, assoc: 0, assocCap: 0 }, precision: { phrase: 70, near: 20, hierarchy: 0, assoc: 0, assocCap: 0 }, hierarchy_heavy: { phrase: 20, near: 30, hierarchy: 90, assoc: 40, assocCap: 20 }, entity: { phrase: 70, near: 30, hierarchy: 0, assoc: 0, assocCap: 0 } }[preset])
            : { phrase: 20, near: 50, hierarchy: 60, assoc: 50, assocCap: 30 };
          const phrase    = phraselist_weight      ?? resolvedPreset!.phrase;
          const near      = nearlist_weight        ?? resolvedPreset!.near;
          const hierarchy = lower_hierarchy_weight ?? resolvedPreset!.hierarchy;
          const assoc     = associative_weight     ?? resolvedPreset!.assoc;
          const assocCap  = associative_cap        ?? resolvedPreset!.assocCap;
          usedDesc = `preset=${presetLabel}, phrase=${phrase}, near=${near}, hierarchy=${hierarchy}, assoc=${assoc} (cap=${assocCap}%)`;
          if (title_weight !== undefined && body_weight !== undefined) {
            usedDesc += `, zone-biased title=${title_weight} body=${body_weight}`;
          }
        }

        const lines = [
          "PUBLISHER TEMPLATE UPDATED",
          "─".repeat(55),
          "",
          `  Model:         ${model_uri}`,
          `  Template file: templates/${template_name}`,
          `  Config:        ${usedDesc}`,
          "",
          "The .kid template has been uploaded to the publisher workspace ZIP.",
          "",
          "NEXT STEPS:",
          `  1. Rebuild rules:  semaphore_publish  model_uri="${model_uri}"  wait_for_completion=true`,
          `  2. Verify:         semaphore_classify  content="<sample text>"  threshold=0`,
          `  3. Compare scores before/after to validate the weight change.`,
          "",
          "NOTE: Template changes only take effect after semaphore_publish completes.",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  // ── semaphore_kid_template_diagnose ──────────────────────────────────────────
  server.tool(
    "semaphore_kid_template_diagnose",
    "Diagnose a Semaphore classification quality problem and recommend the right fix approach.\n\n" +
    "UNDERSTANDING THE FIX LEVELS:\n" +
    "  Semaphore classification quality problems have three fix levels, each with different scope:\n\n" +
    "  1. LABEL LEVEL (semaphore_concept_labels_update)\n" +
    "     Fixes a specific concept's vocabulary — add/remove altLabels, hiddenLabels.\n" +
    "     Scope: one concept. Cost: low. Use when the problem is isolated.\n\n" +
    "  2. THRESHOLD LEVEL (semaphore_classify threshold param)\n" +
    "     Adjusts the precision/recall cut-off without changing the model or rules.\n" +
    "     Scope: all results, no model change. Cost: zero. Use to explore before committing.\n\n" +
    "  3. VELOCITY TEMPLATE LEVEL (semaphore_kid_template_set)\n" +
    "     Changes HOW the publisher generates rules from concepts — controls scoring weights for\n" +
    "     phrase matches, near-word matches, hierarchy propagation, and associative propagation.\n" +
    "     Scope: every concept in the model, equally. Requires re-publish.\n" +
    "     Use when: the problem is SYSTEMIC (affects all or most concepts), or the content type\n" +
    "     systematically defeats the default scoring (short text, zone-structured docs, etc.),\n" +
    "     or you would need the same label fix on many concepts for the same reason.\n\n" +
    "  PRACTICAL TRIGGER FOR TEMPLATE TUNING:\n" +
    "     'I keep making the same label edit to different concepts for the same reason.'\n" +
    "     That reason belongs in the template, not in individual concept labels.\n\n" +
    "WHEN TO USE THIS TOOL:\n" +
    "  • You have a classification quality problem but are unsure which fix level to apply.\n" +
    "  • semaphore_classify returned unexpected results (wrong concepts, uniform scores, too many hits).\n" +
    "  • You want a ranked action plan before making any changes.\n\n" +
    "SYMPTOMS AND DEFAULT DIAGNOSES:\n" +
    "  false_positives        — concept fires on irrelevant documents\n" +
    "  missing_matches        — concept fails to fire on relevant documents\n" +
    "  score_too_uniform      — all concepts score identically, threshold separation impossible\n" +
    "  hierarchy_not_firing   — parent concept does not fire when child concept fires\n" +
    "  nearlist_noise         — multi-word concept fires on documents with scattered unrelated words\n" +
    "  short_text_poor        — classification unreliable on short text (headlines, metadata)\n" +
    "  zone_ignored           — title-zone content not weighted more than body content\n" +
    "  associative_overfiring — related concepts boosting unrelated concept scores too aggressively\n\n" +
    "HOW TO USE:\n" +
    "  1. Provide 'symptom' (required) — the classification quality issue you observe.\n" +
    "  2. Optionally provide 'example_text' (the document or snippet that misbehaves) and\n" +
    "     'concept_uri' (the concept that is firing incorrectly or not firing).\n" +
    "  3. The tool returns a ranked action plan: label fix first, escalate to template only if needed.",
    {
      symptom: z.enum([
        "false_positives",
        "missing_matches",
        "score_too_uniform",
        "hierarchy_not_firing",
        "nearlist_noise",
        "short_text_poor",
        "zone_ignored",
        "associative_overfiring",
      ]).describe(
        "The classification quality symptom to diagnose."
      ),
      model_uri: z.string().optional().describe(
        "KMM model URI to target recommendations at. Get from semaphore_kmm_models_list."
      ),
      concept_uri: z.string().optional().describe(
        "The concept URI that is firing incorrectly or not firing. " +
        "If provided, specific label-inspection steps are included in the plan."
      ),
      example_text: z.string().optional().describe(
        "A short example of the text that is misbehaving (the document or snippet). " +
        "Helps the tool give more specific recommendations."
      ),
    },
    async ({ symptom, model_uri, concept_uri, example_text }) => {
      const modelNote = model_uri ? `model_uri="${model_uri}"` : 'model_uri="<your-model>"';
      const conceptNote = concept_uri ? `concept_uri="${concept_uri}"` : 'concept_uri="<from semaphore_concept_search>"';

      const plans: Record<string, string[]> = {
        false_positives: [
          "DIAGNOSIS: false_positives — concept fires on irrelevant documents",
          "─".repeat(60),
          "",
          "ROOT CAUSE CANDIDATES (in order of likelihood):",
          "  1. An overly-broad altLabel or hiddenLabel matches unrelated text",
          "  2. nearlist is firing on scattered constituent words in unrelated content",
          "  3. Associative evidence is propagating score from a related concept",
          "",
          "RECOMMENDED ACTION PLAN:",
          "",
          "  Step 1 — Inspect the concept labels (cheapest fix first)",
          `    semaphore_concept_get  ${modelNote}  ${conceptNote}`,
          "    Look for altLabels / hiddenLabels that are common words or short phrases.",
          "    → If found: semaphore_concept_labels_update  action=remove  label_type=altLabel",
          "    → Then: semaphore_publish → semaphore_classify to verify",
          "",
          "  Step 2 — Check if nearlist is the source (if Step 1 doesn't fix it)",
          `    semaphore_classify  content="<false-positive example>"  threshold=0`,
          "    If the false-positive score is < phrase_weight threshold and no exact phrase is present,",
          "    nearlist is likely contributing. Try:",
          `    semaphore_kid_template_set  ${modelNote}  preset=precision`,
          "    (reduces nearlist_weight to 20, disables hierarchy/associative)",
          "",
          "  Step 3 — Check associative evidence (if Steps 1–2 don't fix it)",
          `    semaphore_kid_template_set  ${modelNote}  associative_cap=0`,
          "    This disables associative propagation entirely for this model.",
          "",
          "  Step 4 — Absence-firing disambiguation (advanced, when Steps 1–3 are insufficient)",
          "    Add skos:hiddenLabel disqualifying-context words to the problem concept via",
          "    semaphore_kmm_sparql_update, then add a not=\"1\" phraselist rule via",
          `    semaphore_kid_template_set  ${modelNote}  content="<custom XML with not=\\"1\\" rule>"`,
          "    This boosts true-positive scores so threshold can be raised above false-positives.",
          example_text ? `\n  EXAMPLE TEXT PROVIDED: "${example_text.slice(0, 120)}${example_text.length > 120 ? "..." : ""}"` : "",
          "    Use semaphore_classify with this text + threshold=0 to see all firing evidence.",
        ],

        missing_matches: [
          "DIAGNOSIS: missing_matches — concept fails to fire on relevant documents",
          "─".repeat(60),
          "",
          "ROOT CAUSE CANDIDATES:",
          "  1. The taxonomy concept lacks altLabels for common synonyms / domain phrasings",
          "  2. The threshold is too high — document contains correct vocabulary but scores below cutoff",
          "  3. The concept has never been published (no CLS rules exist for it)",
          "  4. nearlist_weight is too low for multi-word concepts in long documents",
          "",
          "RECOMMENDED ACTION PLAN:",
          "",
          "  Step 1 — Test with threshold=0 to see if the concept fires at all",
          `    semaphore_classify  content="<relevant text>"  threshold=0`,
          "    If the concept fires at a low score: the concept + rules are working but threshold is too high.",
          "    → Lower the pipeline threshold, or add more altLabels to boost score.",
          "",
          "  Step 2 — Inspect concept labels and add synonyms",
          `    semaphore_concept_get  ${modelNote}  ${conceptNote}`,
          "    Add domain-specific synonyms as altLabels or abbreviations as hiddenLabels:",
          `    semaphore_concept_labels_update  ${modelNote}  ${conceptNote}  action=add  label_type=altLabel  label_value="<synonym>"`,
          "    → Then: semaphore_publish → semaphore_classify to verify",
          "",
          "  Step 3 — Boost nearlist if multi-word phrases appear split in long documents",
          `    semaphore_kid_template_set  ${modelNote}  nearlist_weight=70`,
          "",
          "  Step 4 — Verify the concept has been published",
          `    semaphore_publish_diagnose  model_uri="${model_uri ?? "<model>"}"`,
          "    Checks that the expected number of rules were generated (should be 1+ per concept).",
          example_text ? `\n  EXAMPLE TEXT PROVIDED: "${example_text.slice(0, 120)}${example_text.length > 120 ? "..." : ""}"` : "",
        ],

        score_too_uniform: [
          "DIAGNOSIS: score_too_uniform — all matching concepts score identically",
          "─".repeat(60),
          "",
          "ROOT CAUSE: This is almost always caused by ALL concepts having single-word labels.",
          "  • nearlist requires multi-word labels to fire — single-word concepts score only via",
          "    phraselist, which gives the same weight to every match → all concepts score equally.",
          "  • Threshold-based separation becomes impossible when scores are uniform.",
          "",
          "RECOMMENDED ACTION PLAN:",
          "",
          "  Option A — Add multi-word altLabels to key concepts (preferred)",
          "    Identify the most important concepts. Add descriptive phrase altLabels:",
          `    semaphore_concept_labels_update  ${modelNote}  action=add  label_type=altLabel  label_value="<descriptive phrase>"`,
          "    Multi-word labels will then generate nearlist rules, differentiating scores.",
          "",
          "  Option B — Raise phraselist_weight and lower nearlist_weight to 0",
          "    This makes phrase-match count (not just presence) drive the score:",
          `    semaphore_kid_template_set  ${modelNote}  preset=exact_only`,
          "    Documents mentioning a concept multiple times will score proportionally higher.",
          "",
          "  Option C — Enable zone-biasing (if documents have reliable title/body structure)",
          `    semaphore_kid_template_set  ${modelNote}  preset=balanced  title_weight=80  body_weight=20`,
          "    Title mentions then outweigh body mentions, providing natural score differentiation.",
        ],

        hierarchy_not_firing: [
          "DIAGNOSIS: hierarchy_not_firing — parent concept does not fire when child fires",
          "─".repeat(60),
          "",
          "ROOT CAUSE CANDIDATES:",
          "  1. lower_hierarchy_weight is 0 or too low in the current template",
          "  2. The hierarchy relationship is not modelled in the KMM (missing skos:broader link)",
          "  3. The child concept itself is not generating enough evidence to propagate",
          "",
          "RECOMMENDED ACTION PLAN:",
          "",
          "  Step 1 — Check current template hierarchy weight",
          `    semaphore_kid_template_get  ${modelNote}`,
          "    Look for the linklist with relationshiptypes=\"LowerInHierarchy\" — check its weight.",
          `    → If weight is 0: semaphore_kid_template_set  ${modelNote}  preset=hierarchy_heavy`,
          "",
          "  Step 2 — Verify the hierarchy relationship exists in KMM",
          `    semaphore_concept_get  ${modelNote}  ${conceptNote}`,
          "    Check 'broader' and 'narrower' links. If missing, the SPARQL doesn't have skos:broader triples.",
          "    Add via: semaphore_kmm_sparql_update  INSERT DATA { <child-uri> skos:broader <parent-uri> }",
          "",
          "  Step 3 — Tune the hierarchy weight specifically",
          `    semaphore_kid_template_set  ${modelNote}  lower_hierarchy_weight=90`,
          "    Then: semaphore_publish → semaphore_classify to verify parent now fires.",
        ],

        nearlist_noise: [
          "DIAGNOSIS: nearlist_noise — concepts fire because constituent words appear scattered",
          "─".repeat(60),
          "",
          "ROOT CAUSE: nearlist matches when the individual words of a multi-word label appear",
          "  near each other (within a CLS proximity window). Long documents with broad vocabulary",
          "  will naturally contain these word combinations by chance.",
          "",
          "RECOMMENDED ACTION PLAN:",
          "",
          "  Step 1 — Quick check: does the false positive disappear with nearlist_weight=0?",
          `    semaphore_kid_template_set  ${modelNote}  preset=exact_only`,
          "    Publish and test. If the false positive disappears, nearlist was the cause.",
          "",
          "  Step 2 — Find a balanced nearlist weight that reduces noise without losing recall",
          `    semaphore_kid_template_set  ${modelNote}  nearlist_weight=20`,
          "    (or use preset=precision: phrase=70, near=20, no hierarchy/associative)",
          "",
          "  Step 3 — If nearlist noise is from specific concepts, add altLabels for exact phrases",
          "    This allows the concept to rely on phraselist rather than nearlist for those matches.",
          `    semaphore_concept_labels_update  ${modelNote}  action=add  label_type=altLabel  label_value="<exact phrase>"`,
        ],

        short_text_poor: [
          "DIAGNOSIS: short_text_poor — classification unreliable on short text",
          "─".repeat(60),
          "",
          "ROOT CAUSE: Short text (headlines, metadata, ~10–50 words) provides little evidence.",
          "  • nearlist can fire on coincidental proximity in short windows",
          "  • hierarchy + associative propagation adds noise relative to direct signal",
          "  • Low token count means ALL weights are reduced proportionally",
          "",
          "RECOMMENDED ACTION PLAN:",
          "",
          "  Step 1 — Switch to short_text preset",
          `    semaphore_kid_template_set  ${modelNote}  preset=short_text`,
          "    (phrase=60, near=20, hierarchy=40, assoc=0)",
          "    This gives exact phrase matches the dominant weight and suppresses associative noise.",
          "",
          "  Step 2 — Or use exact_only for maximum precision",
          `    semaphore_kid_template_set  ${modelNote}  preset=exact_only`,
          "    Use this when you prefer zero false positives over recall.",
          "",
          "  Step 3 — Ensure concept labels include exact phrasings used in your short texts",
          "    Short texts often use specific jargon, acronyms, or abbreviated forms.",
          `    semaphore_concept_labels_update  ${modelNote}  action=add  label_type=hiddenLabel  label_value="<abbreviation>"`,
          "",
          "  Step 4 — Lower the threshold for short-text pipelines",
          "    Short texts generate weaker signals. A threshold of 30–40 may be more appropriate than 48.",
          "    Test: semaphore_classify  content=\"<short headline>\"  threshold=0",
          "    Observe score distribution before setting pipeline threshold.",
        ],

        zone_ignored: [
          "DIAGNOSIS: zone_ignored — title content not weighted more than body content",
          "─".repeat(60),
          "",
          "ROOT CAUSE: The default template does not use zone-biasing — all pos=0 (body zone).",
          "  Title/heading text is structurally more significant but treated identically to body.",
          "",
          "RECOMMENDED ACTION PLAN:",
          "",
          "  Step 1 — Verify your documents have reliable title/body zone structure",
          "    The Semaphore CLS zones are populated from the structured document input.",
          "    For Flux-imported documents, the JSON/XML field mapping determines zone assignment.",
          "    Title zone = pos=1 in the CLS rule; body zone = pos=0.",
          "    Confirm with: semaphore_classify  content=\"<title text>\" → check scores",
          "                  semaphore_classify  content=\"<body text>\"  → compare scores",
          "",
          "  Step 2 — Apply zone-biased template",
          `    semaphore_kid_template_set  ${modelNote}  preset=balanced  title_weight=80  body_weight=20`,
          "    This generates a template where title-zone phrase/near evidence counts 4× body evidence.",
          "    Tune title_weight/body_weight based on your document structure (e.g. 70/30 is more subtle).",
          "",
          "  Step 3 — Publish and validate",
          `    semaphore_publish  model_uri="${model_uri ?? "<model>"}"  wait_for_completion=true`,
          "    semaphore_classify with both a title-heavy and body-heavy example — verify score difference.",
        ],

        associative_overfiring: [
          "DIAGNOSIS: associative_overfiring — related concepts inflating scores of unrelated concepts",
          "─".repeat(60),
          "",
          "ROOT CAUSE: The linklist Associative contribution (skos:related links) is adding weight",
          "  to parent/sibling concepts when only a distantly related concept has direct evidence.",
          "",
          "RECOMMENDED ACTION PLAN:",
          "",
          "  Step 1 — Disable associative evidence entirely (cleanest fix)",
          `    semaphore_kid_template_set  ${modelNote}  associative_cap=0`,
          "    This removes associative propagation without changing phrase/near/hierarchy weights.",
          "    Publish and test — this usually resolves over-broad associative firing immediately.",
          "",
          "  Step 2 — If you want to preserve SOME associative contribution, lower the cap",
          `    semaphore_kid_template_set  ${modelNote}  associative_cap=10  associative_weight=30`,
          "    (cap=10 means associative can contribute at most 10% of the final score)",
          "",
          "  Step 3 — Inspect the skos:related links on the problem concept",
          `    semaphore_concept_get  ${modelNote}  ${conceptNote}`,
          "    If the related link itself is the problem (wrong semantic relation), remove it:",
          "    semaphore_kmm_sparql_update  DELETE DATA { <concept-uri> skos:related <related-uri> }",
        ],
      };

      const plan = plans[symptom];
      if (!plan) {
        return { content: [{ type: "text", text: `Unknown symptom: ${symptom}` }], isError: true };
      }

      const footer = [
        "",
        "─".repeat(60),
        "GENERAL DECISION HIERARCHY:",
        "  1. Label edit (semaphore_concept_labels_update)  — cheapest, isolated fix",
        "  2. Threshold adjust (semaphore_classify threshold)  — zero model changes, test first",
        "  3. Template weight tuning (semaphore_kid_template_set preset=...)  — global, affects all concepts",
        "  4. Raw template customisation (semaphore_kid_template_set content=...)  — advanced, surgical",
        "  Always publish after ANY change: semaphore_publish → semaphore_classify to verify.",
      ];

      return { content: [{ type: "text", text: [...plan, ...footer].filter(l => l !== "").join("\n") }] };
    }
  );
}
