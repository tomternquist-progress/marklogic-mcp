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
import { ExtensionsClient } from "./extensions.js";
import { SecurityClient } from "./security.js";
import { PerformanceClient } from "./performance.js";

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
  extensions: ExtensionsClient;
  security: SecurityClient;
  performance: PerformanceClient;
}

export function createClients(config: AppConfig, oauthToken?: string): MarkLogicClients {
  const { connection, safety, flux: fluxConfig, semaphore: semaphoreConfig } = config;
  // In oauth mode the runtime token (from the HTTP session's Bearer header) takes
  // precedence over the static ML_OAUTH_TOKEN env var. Merge it in before constructing
  // the base client so every Axios instance in this session uses the correct token.
  const resolvedConnection =
    connection.authType === "oauth" && oauthToken
      ? { ...connection, staticOauthToken: oauthToken }
      : connection;
  const base = new MarkLogicBaseClient(resolvedConnection);
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
  const extensions = new ExtensionsClient(base);
  const security = new SecurityClient(base);
  const performance = new PerformanceClient(base);

  return { admin, documents, search, eval: evalClient, schema, graphs, optic, flux, fasttrack, semaphore, extensions, security, performance };
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
  ExtensionsClient,
  SecurityClient,
  PerformanceClient,
};
