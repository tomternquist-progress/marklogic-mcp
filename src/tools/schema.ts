import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MarkLogicClients } from "../client/index.js";
import { toToolError, appendTdeHint } from "../utils/errors.js";

export function registerSchemaTools(server: McpServer, clients: MarkLogicClients): void {
  server.tool(
    "ml_schema_discover",
    "Infer the document schema/structure of a MarkLogic collection by sampling documents. Returns field names, types, cardinality, and example values.",
    {
      collection: z.string().optional().describe("Collection URI to sample from"),
      sample_size: z.number().int().positive().max(50).optional().describe("Number of documents to sample (default: 10)"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ collection, sample_size, database }) => {
      try {
        const result = await clients.schema.discoverSchema({ collection, sampleSize: sample_size, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_schema_get_tde",
    "Retrieve Template Driven Extraction (TDE) schemas registered in the MarkLogic Schemas database. TDE schemas define row views over document data. Pass schema_name as the full URI (e.g. /tde/gdelt/events.json) to retrieve the template content; omit it to list all TDE URIs.",
    {
      schema_name: z.string().optional().describe("Full URI of the TDE template to retrieve (e.g. /tde/gdelt/events.json). Omit to list all TDE template URIs."),
      database: z.string().optional().describe("Database name for the TDE template lookup. Schemas are always read from the Schemas DB; this param routes the content DB context. Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ schema_name, database }) => {
      try {
        const schemas = await clients.schema.getTdeSchemas(database, schema_name);
        return { content: [{ type: "text", text: JSON.stringify(schemas, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_tde_validate",
    "Verify a TDE template is working by querying its Optic row view and returning sample rows. Reports row count vs document count, surfaces SQL-TABLENOTFOUND and TABLEREINDEXING errors, and shows sample rows so you can confirm the right data is being extracted. Uses Optic row queries for validation.\n\nPREREQUISITES:\n  1. Template must be in the Schemas database, collection http://marklogic.com/xdmp/tde.\n     Install via ml_tde_install (or ml_document_put with database='Schemas' and uri under /tde/).\n  2. After install, the database must finish reindexing before views are queryable.\n     Check with ml_reindex_status — wait until reindex-count reaches 0 before validating.\n  3. Use ml_views_list to confirm the schema.view pair your template defines is registered.\n\nNOTE: tde.validate([node],[]) (array-of-nodes signature) works in SJS on MarkLogic 12.0.1 and can be used for schema-level validation via ml_eval_javascript: tde.validate([cts.doc('/tde/my.json')],[])\n\nIMPORTANT — TDE JSON SYNTAX RULES (common mistakes):\n  1. Triple subject/object references must use { \"val\": \"<XPath-expression>\" }, NOT { \"column\": \"<name>\" }.\n     'column' is invalid in TDE triples and causes TDE-INVALIDTEMPLATEPROPNODE.\n     Correct: { \"subject\": { \"val\": \"sem:iri(fn:concat('http://.../', id))\" } }\n  2. Parent axis (../id) does NOT work in JSON sub-templates.\n     Use fn:root() to navigate back to the document root:\n     Correct: { \"val\": \"fn:root()/movie/id\" }\n  3. scalarType 'IRI' is NOT valid for row column definitions.\n     Row columns support: string, integer, long, float, double, decimal, dateTime, date, time, boolean, anyURI.\n     Construct IRIs only in the 'triples' section using sem:iri().\n  4. The template must be in the Schemas database with collection 'http://marklogic.com/xdmp/tde'.\n     Use ml_tde_install (or ml_document_put with database='Schemas') to deploy it correctly.",
    {
      tde_uri: z.string().describe("URI of the TDE template in the Schemas database, e.g. /tde/gdelt/events.json"),
      collection: z.string().describe("Collection to sample documents from, e.g. gdelt-events"),
      sample_size: z.number().int().positive().max(20).optional().describe("Number of documents to validate against (default: 5)"),
      database: z.string().optional().describe(
        "Content database to query for the documents and view, e.g. 'ps-forecast-content'. " +
        "REQUIRED for multi-DB topologies where the TDE's content DB is not the app server's default — " +
        "without it the validator routes to the default content DB and reports false-negative \"0 documents\". " +
        "Pass the same content DB associated with the Schemas DB where the TDE was installed."
      ),
    },
    async ({ tde_uri, collection, sample_size, database }) => {
      try {
        const result = await clients.schema.validateTde({ tdeUri: tde_uri, collection, sampleSize: sample_size, database });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const msg = appendTdeHint(toToolError(err));
        if (msg.includes("TDE-INVALIDTEMPLATEPROPNODE") || msg.includes("INVALIDTEMPLATEPROPNODE")) {
          return {
            content: [{
              type: "text",
              text: `${msg}\nHint: TDE-INVALIDTEMPLATEPROPNODE — an invalid property was used in the template.\n  • Using { "column": "name" } in a triple subject/predicate/object is invalid.\n    Fix: use { "val": "<XPath-expression>" } — e.g. { "subject": { "val": "sem:iri(fn:concat('http://example.org/', id))" } }\n  • scalarType "IRI" is not valid for row columns — use "string"; construct IRIs in the triples section via sem:iri().\n  • ../id does not navigate to parent in JSON sub-templates — use fn:root()/parentElement/id.`,
            }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    }
  );

  server.tool(
    "ml_indexes_list",
    "List all configured indexes for a MarkLogic database (range element, range path, range field, geospatial element pair, geospatial path). " +
    "Geospatial indexes are required by ml_geospatial_search — check here first to see what parent/lat/lon property names are indexed.",
    {
      database: z.string().describe("Database name to inspect"),
      index_type: z.enum(["range-element", "range-path", "range-field", "geospatial", "all"]).optional().describe("Filter by index type: 'geospatial' shows all geospatial index variants (default: all)"),
    },
    async ({ database, index_type }) => {
      try {
        const indexes = await clients.schema.listIndexes(database);
        const filtered = (!index_type || index_type === "all")
          ? indexes
          : index_type === "geospatial"
          ? indexes.filter((i) => i.type.startsWith("geospatial-"))
          : indexes.filter((i) => i.type === index_type);
        return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_search_surface",
    "ONE-SHOT \"what can I query?\" discovery for a collection. Returns everything an LLM (or " +
    "ml_parse_query, structured_query_builder, nl_to_search_query) needs to translate a natural-language " +
    "question into a working MarkLogic query — in a single tool call instead of three or four.\n\n" +
    "PRIMARY USE: chat → MarkLogic translation pipeline. Before asking an LLM to write a query, call " +
    "ml_search_surface to retrieve the field catalogue, range indexes, and search-options names. " +
    "Pass the result into the LLM's context; pipe its generated string-grammar query into ml_parse_query " +
    "(for validation), then ml_search (for execution).\n\n" +
    "RETURNS a JSON object:\n" +
    "  • collection / database / documentCount\n" +
    "  • inferredFields[]   — path, type, cardinality, hasRangeIndex, exampleValues (from doc sample)\n" +
    "  • rangeIndexes[]     — range/geospatial indexes configured on the database\n" +
    "  • searchOptionsNames[] — named search-options sets available on the server (any of which can be\n" +
    "                          passed to ml_search via options= for tagged-grammar parsing and faceting)\n" +
    "  • suggestedBindings  — pre-built ml_parse_query bindings map: ONLY range-indexed fields. Each\n" +
    "                          entry is a {type, name, scalar_type} ready to pass to ml_parse_query.\n" +
    "                          cts.parse SJS requires a range index for every tagged binding — but a\n" +
    "                          range index is NOT the only way to query a field (see below).\n" +
    "  • valueQueryableFields[] — top-level fields whose EXACT VALUES can be matched by passing a\n" +
    "                          structured_query to ml_search, with no range index needed. JSON\n" +
    "                          property/element/field value indexes are on by default in MarkLogic, so\n" +
    "                          { value-query: { json-property: 'incidentType', text: ['Hurricane'] } }\n" +
    "                          returns ONLY docs whose incidentType property literally equals 'Hurricane'.\n" +
    "                          PREFER this over bareword `q='Hurricane'`, which also matches docs that\n" +
    "                          merely mention the term in some other field.\n" +
    "  • wordQueryableFields[] — same fields, available for tokenised free-text matching via\n" +
    "                          { word-query: { json-property: 'description', text: ['hurricane'] } }\n" +
    "                          or via the universal index with bareword `q='hurricane'`.\n" +
    "  • barewordFields[]    — alias of wordQueryableFields, kept for backwards compatibility. Note the\n" +
    "                          earlier framing was misleading — a bareword query goes through the\n" +
    "                          universal index and matches ANYWHERE in the document, not just the named\n" +
    "                          field. For field-scoped matching, use valueQueryableFields with a\n" +
    "                          structured value-query.\n\n" +
    "QUERY-CONSTRUCTOR PICKER (no range index needed for any of these):\n" +
    "  EXACT VALUE on a JSON property → cts.jsonPropertyValueQuery(name, [values])\n" +
    "  EXACT VALUE on a field          → cts.fieldValueQuery(field, [values])\n" +
    "  EXACT VALUE on an XML element   → cts.elementValueQuery(qname, [values])\n" +
    "  WORD/STEMMED in a property      → cts.jsonPropertyWordQuery(name, text)\n" +
    "  WORD/STEMMED anywhere           → cts.wordQuery(text)\n" +
    "  IN A COLLECTION                 → cts.collectionQuery(uri)\n" +
    "  UNDER A DIRECTORY               → cts.directoryQuery(uri, depth)\n" +
    "  AND/OR/NOT                      → cts.andQuery / cts.orQuery / cts.notQuery\n" +
    "RANGE INDEX REQUIRED (only for these):\n" +
    "  RANGE comparison (>, <, GE, LE) → cts.jsonPropertyRangeQuery / cts.elementRangeQuery /\n" +
    "                                    cts.fieldRangeQuery / cts.pathRangeQuery\n" +
    "  TAGGED grammar in cts.parse     → every binding produces a cts.<kind>Reference\n" +
    "  Faceting / lexicon iteration    → ml_facets_query / ml_values_query\n\n" +
    "GOOD NEXT STEPS:\n" +
    "  → For exact-value filtering on non-indexed fields: build a structured value-query and pass to\n" +
    "    ml_search via structured_query. NO range index required.\n" +
    "      ml_search collection='X' structured_query='{\"query\":{\"value-query\":{\"json-property\":\"f\",\"text\":[\"v\"]}}}'\n" +
    "  → For LLM query generation: feed the JSON into the nl_to_search_query prompt with the user's question\n" +
    "  → For programmatic range queries: pick a field from rangeIndexes; build a structured range-query for ml_search\n" +
    "  → For richer faceting: pick a name from searchOptionsNames and call ml_search_options_get to read\n" +
    "    its constraint definitions, then pass that name to ml_search via the options= parameter",
    {
      collection: z.string().optional().describe("Collection URI to inspect. Omit to sample the whole database."),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
      sample_size: z.number().int().positive().max(50).optional().describe("Number of documents to sample for schema inference (default: 10)"),
    },
    async ({ collection, database, sample_size }) => {
      try {
        // Run discovery + options-list in parallel — both are read-only.
        const [discovery, optionsList] = await Promise.all([
          clients.schema.discoverSchema({ collection, sampleSize: sample_size, database }),
          clients.fasttrack.listSearchOptions(database).catch(() => [] as Array<{ name: string }>),
        ]);

        const optionNames = (optionsList ?? [])
          .map((o) => (typeof o === "string" ? o : (o as { name?: string })?.name))
          .filter((n): n is string => typeof n === "string" && n.length > 0);

        // Build suggested bindings for ml_parse_query — ONLY range-indexed fields, because
        // cts.parse SJS requires a range index for any tagged binding. Non-indexed fields
        // become "barewordFields" the agent can search via the universal index.
        const suggestedBindings: Record<string, { type: string; name: string; scalar_type?: string }> = {};
        for (const idx of discovery.rangeIndexes ?? []) {
          if (idx.type === "range-element" && idx.localname) {
            suggestedBindings[idx.localname] = {
              type: "element-range",
              name: idx.localname,
              scalar_type: idx.scalarType,
            };
          } else if (idx.type === "range-path" && idx.pathExpression) {
            // Use the leaf path step as the tag name for readability
            const leaf = idx.pathExpression.split("/").filter(Boolean).pop() ?? idx.pathExpression;
            suggestedBindings[leaf] = {
              type: "path-range",
              name: idx.pathExpression,
              scalar_type: idx.scalarType,
            };
          } else if (idx.type === "range-field" && idx.localname) {
            suggestedBindings[idx.localname] = {
              type: "field-range",
              name: idx.localname,
              scalar_type: idx.scalarType,
            };
          }
        }
        // Top-level fields the agent can query. Every top-level field with at least one
        // observed value supports structured value-query / word-query matching out of the
        // box — JSON property value & word indexes are on by default. The earlier
        // "barewordFields" framing implied bareword (universal-index) was the ONLY option
        // for non-range-indexed fields; that was wrong. Surface them as
        // valueQueryableFields so the agent reaches for structured_query first.
        const topLevelFields = (discovery.inferredFields ?? [])
          .filter((f) => !f.path.includes("/") && !suggestedBindings[f.path])
          .map((f) => f.path);
        const valueQueryableFields = topLevelFields;
        const wordQueryableFields = topLevelFields;
        // Kept as an alias so existing callers and tests don't break.
        const barewordFields = topLevelFields;

        const surface = {
          collection: collection ?? null,
          database: database ?? null,
          documentCount: discovery.documentCount,
          inferredFields: discovery.inferredFields,
          rangeIndexes: discovery.rangeIndexes,
          searchOptionsNames: optionNames,
          suggestedBindings,
          valueQueryableFields,
          wordQueryableFields,
          barewordFields,
          nextSteps: [
            "Exact value on a non-range-indexed field: ml_search structured_query='{\"query\":{\"value-query\":{\"json-property\":\"<field>\",\"text\":[\"<value>\"]}}}' — NO range index needed.",
            "Tagged range comparison ('age GE 65'): use entries from suggestedBindings via ml_parse_query — requires a range index on the bound field.",
            "Free-text token in a specific field: { word-query: { json-property: '<field>', text: ['<token>'] } } — uses the property word index, no range index needed.",
            "Free-text across the whole doc: ml_search q='<token>' — universal index, matches anywhere.",
            "Translate NL → query: invoke the nl_to_search_query prompt with this surface as context.",
            "Combine clauses: wrap multiple queries in { and-query: { queries: [...] } } or { or-query: ... }.",
          ],
        };
        return { content: [{ type: "text", text: JSON.stringify(surface, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_collections_list",
    "List document collections in MarkLogic with their document counts.",
    {
      limit: z.number().int().positive().max(500).optional().describe("Maximum collections to return (default: 50)"),
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ limit, database }) => {
      try {
        const collections = await clients.schema.listCollections(database, limit ?? 50);
        return { content: [{ type: "text", text: JSON.stringify(collections, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_tde_install",
    "Install a TDE (Template Driven Extraction) template into the MarkLogic Schemas database with the correct collection. " +
    "This is a convenience wrapper around ml_document_put that automatically sets database='Schemas' and " +
    "adds the required collection 'http://marklogic.com/xdmp/tde'.\n\n" +
    "Use this instead of ml_document_put when deploying TDE templates — it removes the friction of remembering " +
    "the database name and TDE collection URI.\n\n" +
    "AFTER INSTALLING:\n" +
    "  1. Run ml_tde_validate to verify the template produces the expected rows.\n" +
    "  2. MarkLogic reindexes asynchronously — ml_tde_validate will report TABLEREINDEXING while in progress.\n" +
    "  3. Once indexed, query via ml_optic_query or ml_eval_javascript with the op.fromView() API.\n\n" +
    "TDE SYNTAX RULES (common mistakes that cause TDE-INVALIDTEMPLATEPROPNODE):\n" +
    "  1. Triple subject/object must use { \"val\": \"<XPath>\" }, NOT { \"column\": \"<name>\" }\n" +
    "     Correct: { \"subject\": { \"val\": \"sem:iri(fn:concat('http://.../', id))\" } }\n" +
    "  2. Parent axis (../id) does NOT work in JSON sub-templates — use fn:root()/parentElement/field\n" +
    "  3. scalarType 'IRI' is NOT valid for row columns — use 'string' and construct IRIs in triples section\n\n" +
    "COLLECTION-SCOPED TEMPLATES (apply TDE to a subset of documents):\n" +
    "  The 'collections' filter inside a TDE template must use an ARRAY — a bare string value silently\n" +
    "  installs without error but the view will not exist (SQL-TABLENOTFOUND on every query):\n" +
    "    WRONG: \"collections\": {\"collection\": \"my-col\"}         ← string, silently broken\n" +
    "    RIGHT: \"collections\": {\"collection\": [\"my-col\"]}       ← array required\n" +
    "  Full example:\n" +
    "    { \"template\": { \"context\": \"/\", \"collections\": {\"collection\": [\"my-col\"]},\n" +
    "                     \"rows\": [{\"schemaName\": \"s\", \"viewName\": \"v\", \"columns\": [...]}] } }",
    {
      uri: z.string().describe("URI for the TDE template in the Schemas database, e.g. /tde/my-template.json"),
      content: z.string().describe("TDE template content (JSON or XML)"),
      content_type: z.enum(["application/json", "application/xml"]).optional().describe(
        "Content type (default: application/json)"
      ),
    },
    async ({ uri, content, content_type }) => {
      try {
        const TDE_COLLECTION = "http://marklogic.com/xdmp/tde";
        await clients.documents.put(uri, content, content_type ?? "application/json", {
          collections: [TDE_COLLECTION],
          database: "Schemas",
        });

        // Run tde.validate against the freshly-written template to catch structural
        // errors that documents.put accepts silently — the most common case being a
        // mis-shaped "collections" filter that produces a TDE without any working
        // view (SQL-TABLENOTFOUND on every query). See ML-5/ML-11 in the friction log.
        // A 403 (eval-in privilege missing) means we silently skip — the install
        // itself already succeeded.
        let validationNote = "";
        try {
          const err = await clients.schema.validateTemplateSyntax(uri);
          if (err) {
            return {
              content: [{
                type: "text",
                text:
                  `TDE TEMPLATE INSTALLED BUT FAILED VALIDATION\n` +
                  "─".repeat(50) + "\n\n" +
                  `  URI:        ${uri}\n` +
                  `  Database:   Schemas\n` +
                  `  Collection: ${TDE_COLLECTION}\n\n` +
                  `tde.validate reported errors — the template was written but will not produce a working view:\n\n${err}\n\n` +
                  "Common causes:\n" +
                  "  • collections filter must be a plain JSON array — { \"collections\": {\"collection\": [\"my-col\"]} }, NOT a bare string.\n" +
                  "  • triple subject/object must use { \"val\": \"<XPath>\" }, NOT { \"column\": \"<name>\" }.\n" +
                  "  • scalarType \"IRI\" is not allowed for row columns — use \"string\" and construct IRIs in the triples section.\n" +
                  "  • parent axis (../id) does not work in JSON sub-templates — use fn:root()/parent/id.\n\n" +
                  "Fix the template and re-run ml_tde_install (the put will replace the existing document).",
              }],
              isError: true,
            };
          }
          validationNote = "Template syntax validated (tde.validate reported no errors).\n";
        } catch {
          // Eval not permitted, or eval endpoint unreachable — skip the validation
          // step silently. The install itself succeeded.
          validationNote = "Template syntax was NOT validated (eval-in privilege required for tde.validate; install itself succeeded).\n";
        }

        return {
          content: [{
            type: "text",
            text:
              `TDE TEMPLATE INSTALLED\n` +
              "─".repeat(50) + "\n\n" +
              `  URI:        ${uri}\n` +
              `  Database:   Schemas\n` +
              `  Collection: ${TDE_COLLECTION}\n\n` +
              validationNote + "\n" +
              "MarkLogic will begin reindexing documents against this template asynchronously.\n\n" +
              "NEXT STEPS:\n" +
              `  1. Validate: ml_tde_validate  tde_uri="${uri}"  collection="<your-collection>"\n` +
              "  2. Query:    ml_optic_query   schema=\"<schemaName>\"  view=\"<viewName>\"\n" +
              "     Or in ml_eval_javascript (note: op must be required):\n" +
              "       const op = require('/MarkLogic/optic');\n" +
              "       op.fromView('<schemaName>', '<viewName>').result();",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );

  server.tool(
    "ml_namespaces_list",
    "List registered XML namespaces in a MarkLogic database. Essential for writing XQuery against XML documents.",
    {
      database: z.string().optional().describe("Database name. Default: server's content DB (usually 'Documents'). Projects have their own DBs — run ml_databases_list to discover them."),
    },
    async ({ database }) => {
      try {
        const namespaces = await clients.schema.listNamespaces(database);
        return { content: [{ type: "text", text: JSON.stringify(namespaces, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: toToolError(err) }], isError: true };
      }
    }
  );
}
