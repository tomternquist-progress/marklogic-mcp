/**
 * Semaphore Classification Server (SCS) MCP tools.
 *
 * The SCS API is XML-based over HTTP. Key configuration:
 *   SEMAPHORE_URL = http://<host>:<port>   (default SCS port: 5058)
 *
 * Architecture:
 *   Port 5058 — Classification Server (SCS): classifies text via XML API.
 *   Port 5080 — Semaphore Studio (KMM): taxonomy authoring web UI.
 *
 * For bulk classification, use Flux's built-in Semaphore support:
 *   flux_import extra_args: ["--classifier-host", "<host>", "--classifier-port", "5058",
 *                            "--classifier-path", "/"]
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

  // ── semaphore_classify ────────────────────────────────────────────────────────
  server.tool(
    "semaphore_classify",
    "Classify text content using the Semaphore Classification Server. Returns scored taxonomy categories.\n\n" +
    "HOW IT WORKS:\n" +
    "  The SCS parses your text, matches it against the loaded classification rules (publish sets),\n" +
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
    "                 \"--classifier-path\", \"/\"]\n" +
    "  Or use flux_reprocess with an SJS transform that calls xdmp.httpPost() to Semaphore.\n\n" +
    "THRESHOLD GUIDANCE:\n" +
    "  Default threshold is 48. Score range is 0–100.\n" +
    "  Use threshold=0 to see all candidate categories regardless of confidence.\n" +
    "  Production pipelines typically use 48–70 depending on precision requirements.",
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
                "  • No publish sets are loaded on the server (run semaphore_publish_sets to check)\n" +
                "  • The content does not match any classification rules\n" +
                "  • Try with threshold=0 to see all candidates\n\n" +
                "Debug: run semaphore_classes to confirm classification rules are active.",
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
