import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError } from "../utils/errors.js";

export function registerOpticTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_optic_query",
    "Execute an Optic query against MarkLogic using a serialized plan (the $optic JSON format). Returns rows and column names.",
    {
      plan: z.union([z.record(z.unknown()), z.string()]).describe(
        "Serialized Optic plan as a JSON object (preferred) or JSON string. Must be the $optic plan format, e.g. {\"$optic\":{\"ns\":\"op\",\"fn\":\"operators\",\"args\":[...]}}.\n\n" +
        "COMMON OPERATORS:\n" +
        "- from-view: args=[\"schema\",\"view\"]\n" +
        "- where: args=[{\"ns\":\"op\",\"fn\":\"eq\",\"args\":[{col},{val}]}]\n" +
        "- select: args=[[col1, col2, ...]]\n" +
        "- order-by (SINGLE key): args=[{\"ns\":\"op\",\"fn\":\"desc\",\"args\":[\"colName\"]}]\n" +
        "- order-by (MULTIPLE keys): wrap in an array — args=[[{\"ns\":\"op\",\"fn\":\"asc\",\"args\":[\"col1\"]},{\"ns\":\"op\",\"fn\":\"desc\",\"args\":[\"col2\"]}]]\n" +
        "- group-by: args=[groupCols, [aggregates]]\n" +
        "- limit: args=[N]\n" +
        "- join-inner: args=[rightView, {\"ns\":\"op\",\"fn\":\"on\",\"args\":[leftCol,rightCol]}]"
      ),
      database: z.string().optional().describe("Target database (uses server default if omitted)"),
      strip_schema_prefix: z.boolean().optional().describe("Strip the 'schema.view.' prefix from result column names. Useful when querying a single view and the fully-qualified names are too verbose. Default: false."),
    },
    async ({ plan, database, strip_schema_prefix }) => {
      let planObj: Record<string, unknown>;
      if (typeof plan === "string") {
        try {
          planObj = JSON.parse(plan) as Record<string, unknown>;
        } catch {
          return { content: [{ type: "text", text: "Invalid plan: could not parse string as JSON. Pass the $optic plan as a JSON object, not a string." }], isError: true };
        }
      } else {
        planObj = plan;
      }
      try {
        const result = await clients.optic.query(planObj, database, strip_schema_prefix);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        let msg = toToolError(err);
        if (msg.includes("SQL-TABLENOTFOUND") || (msg.includes("Table") && msg.includes("not found"))) {
          msg += "\nHint: TDE templates must be stored in the Schemas database with collection 'http://marklogic.com/xdmp/tde'. Use ml_document_put with database='Schemas' to register your template, then use ml_schema_get_tde to verify it was applied.";
        }
        if (msg.includes("TABLEREINDEXING") || msg.includes("reindexing")) {
          msg += "\nHint: The TDE view is still being built. Use ml_reindex_status (database=\"Documents\") to check when reindex-count reaches 0, then retry.";
        }
        if (msg.includes("OPTIC-INVALARGS") && msg.includes("orderBy")) {
          msg += "\nHint: order-by accepts exactly 1 argument. For a single sort key use: {\"ns\":\"op\",\"fn\":\"order-by\",\"args\":[{\"ns\":\"op\",\"fn\":\"desc\",\"args\":[\"col\"]}]}. For MULTIPLE sort keys, wrap them in a nested array as the single argument: {\"ns\":\"op\",\"fn\":\"order-by\",\"args\":[[{\"ns\":\"op\",\"fn\":\"asc\",\"args\":[\"col1\"]},{\"ns\":\"op\",\"fn\":\"desc\",\"args\":[\"col2\"]}]]}.";
        }
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    }
  );

  server.tool(
    "ml_vector_search",
    "Find the k nearest neighbours to a query vector using cosine similarity over a TDE view. " +
    "Uses the Optic API (vec:cosine-similarity) — no eval required. MarkLogic 12+ only.\n\n" +
    "PREREQUISITES:\n" +
    "1. A TDE template that maps your embedding field to a column with type 'vec:vector'.\n" +
    "   Example TDE column: {\"name\":\"embedding\",\"scalar\":\"vec:vector\",\"val\":\"embedding\"}\n" +
    "2. The TDE template must be in the Schemas database (collection http://marklogic.com/xdmp/tde).\n" +
    "3. Use ml_views_list to confirm the view exists; use ml_schema_get_tde to inspect the column types.\n\n" +
    "For pre-filtering by other fields (e.g. filter by category BEFORE computing similarity), " +
    "use ml_optic_query directly with a where() operator before the bind(vec:cosine-similarity(...)) step. " +
    "Use the data_modeling_advisor prompt for guidance on TDE design for vector workloads.",
    {
      schema: z.string().describe("TDE schema name (from ml_views_list)"),
      view: z.string().describe("TDE view name (from ml_views_list)"),
      vector_column: z.string().describe("Column name in the view that holds vec:vector values (the stored embeddings)"),
      query_vector: z.array(z.number()).describe(
        "Query embedding as an array of floats. Must match the dimensionality of the stored vectors exactly."
      ),
      k: z.number().int().positive().max(1000).optional().describe("Number of nearest neighbours to return (default: 10)"),
      score_column: z.string().optional().describe("Name for the similarity score column in results (default: similarity_score)"),
      database: z.string().optional().describe("Target database (uses server default if omitted)"),
    },
    async ({ schema, view, vector_column, query_vector, k, score_column, database }) => {
      const scoreCol = score_column ?? "similarity_score";
      const limit = k ?? 10;

      // Build an Optic plan:
      //   fromView(schema, view)
      //   .bind(as(scoreCol, vec:cosine-similarity(col(vector_column), vec:vector(query_vector))))
      //   .orderBy(desc(col(scoreCol)))
      //   .limit(k)
      const plan: Record<string, unknown> = {
        $optic: {
          ns: "op", fn: "operators", args: [
            { ns: "op", fn: "from-view", args: [schema, view] },
            {
              ns: "op", fn: "bind", args: [
                {
                  ns: "op", fn: "as", args: [
                    scoreCol,
                    {
                      ns: "vec", fn: "cosine-similarity", args: [
                        { ns: "op", fn: "col", args: [vector_column] },
                        { ns: "vec", fn: "vector", args: [query_vector] },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              ns: "op", fn: "order-by", args: [
                { ns: "op", fn: "desc", args: [{ ns: "op", fn: "col", args: [scoreCol] }] },
              ],
            },
            { ns: "op", fn: "limit", args: [limit] },
          ],
        },
      };

      try {
        const result = await clients.optic.query(plan, database, true);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        let msg = toToolError(err);
        if (msg.includes("SQL-TABLENOTFOUND") || (msg.includes("Table") && msg.includes("not found"))) {
          msg += "\nHint: Use ml_views_list to confirm the view exists. TDE template must be in the Schemas database with collection 'http://marklogic.com/xdmp/tde'.";
        }
        if (msg.includes("TABLEREINDEXING") || msg.includes("reindexing")) {
          msg += "\nHint: TDE view is still indexing. Check ml_reindex_status (database='Documents') and retry when reindex-count reaches 0.";
        }
        if (msg.includes("vec") || msg.includes("VEC") || msg.includes("cosine") || msg.includes("VECTOR-INVALIDTYPE")) {
          msg += "\nHint: The vector_column must map to a TDE column declared with scalar type 'vec:vector'. Check ml_schema_get_tde to inspect column types. MarkLogic 12+ required.";
        }
        if (msg.includes("XDMP-ARGTYPE") || msg.includes("dimension") || msg.includes("DIMENSION")) {
          msg += "\nHint: The query_vector dimensionality must match the stored vectors exactly. Check the embedding size used when the vectors were inserted.";
        }
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    }
  );

  server.tool(
    "ml_views_list",
    "List all Optic row views available in MarkLogic — the schema.view pairs you can query with ml_optic_query. Each entry shows the schema name, view name, TDE template URI, and the document collections it covers. Use this to discover queryable views after importing data with generate_tde=true.",
    {
      database: z.string().optional().describe("Database name (schemas are always read from the Schemas DB)"),
    },
    async ({ database }) => {
      try {
        const views = await clients.schema.listViews(database);
        if (views.length === 0) {
          return { content: [{ type: "text", text: "No TDE views found. Import data with generate_tde=true or install a TDE template via ml_document_put (database='Schemas', collection='http://marklogic.com/xdmp/tde')." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(views, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
