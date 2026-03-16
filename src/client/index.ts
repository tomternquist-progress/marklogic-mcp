import type { AppConfig } from "../config/index.js";
import { MarkLogicBaseClient } from "./base.js";
import { AdminClient } from "./admin.js";
import { DocumentsClient } from "./documents.js";
import { SearchClient } from "./search.js";
import { EvalClient } from "./eval.js";
import { SchemaClient } from "./schema.js";
import { GraphsClient } from "./graphs.js";
import { OpticClient } from "./optic.js";
import { FluxClient } from "./flux.js";
import { FastTrackClient } from "./fasttrack.js";
import { SemaphoreClient } from "./semaphore.js";

export interface MarkLogicClients {
  admin: AdminClient;
  documents: DocumentsClient;
  search: SearchClient;
  eval: EvalClient;
  schema: SchemaClient;
  graphs: GraphsClient;
  optic: OpticClient;
  flux: FluxClient;
  fasttrack: FastTrackClient;
  semaphore: SemaphoreClient;
}

export function createClients(config: AppConfig): MarkLogicClients {
  const { connection, safety, flux: fluxConfig, semaphore: semaphoreConfig } = config;
  const base = new MarkLogicBaseClient(connection);
  const admin = new AdminClient(base);
  const documents = new DocumentsClient(base, safety.readonly);
  const search = new SearchClient(base);
  const evalClient = new EvalClient(base, safety.allowEval);
  const schema = new SchemaClient(base, search, admin);
  const graphs = new GraphsClient(base);
  const optic = new OpticClient(base);
  const flux = new FluxClient(fluxConfig.runnerUrl, connection);
  const fasttrack = new FastTrackClient(base, safety.readonly);
  const semaphore = new SemaphoreClient(semaphoreConfig);

  return { admin, documents, search, eval: evalClient, schema, graphs, optic, flux, fasttrack, semaphore };
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
  FluxClient,
  FastTrackClient,
  SemaphoreClient,
};
