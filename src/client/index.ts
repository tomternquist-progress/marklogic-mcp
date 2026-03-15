import type { ConnectionConfig } from "../config/schema.js";
import { MarkLogicBaseClient } from "./base.js";
import { AdminClient } from "./admin.js";
import { DocumentsClient } from "./documents.js";
import { SearchClient } from "./search.js";
import { EvalClient } from "./eval.js";
import { SchemaClient } from "./schema.js";
import { GraphsClient } from "./graphs.js";
import { OpticClient } from "./optic.js";

export interface MarkLogicClients {
  admin: AdminClient;
  documents: DocumentsClient;
  search: SearchClient;
  eval: EvalClient;
  schema: SchemaClient;
  graphs: GraphsClient;
  optic: OpticClient;
}

export function createClients(
  config: ConnectionConfig,
  readonly: boolean,
  allowEval: boolean
): MarkLogicClients {
  const base = new MarkLogicBaseClient(config);
  const admin = new AdminClient(base);
  const documents = new DocumentsClient(base, readonly);
  const search = new SearchClient(base);
  const evalClient = new EvalClient(base, allowEval);
  const schema = new SchemaClient(base, search, admin);
  const graphs = new GraphsClient(base);
  const optic = new OpticClient(base);

  return { admin, documents, search, eval: evalClient, schema, graphs, optic };
}

export {
  MarkLogicBaseClient,
  AdminClient,
  DocumentsClient,
  SearchClient,
  EvalClient,
  SchemaClient,
  GraphsClient,
  OpticClient,
};
