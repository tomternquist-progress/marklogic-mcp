import type { AxiosResponse } from "axios";
import type { MarkLogicBaseClient } from "./base.js";
import { NotFoundError, WriteProtectedError } from "../utils/errors.js";

export interface DocumentMetadata {
  collections?: string[];
  permissions?: Array<{ "role-name": string; capabilities: string[] }>;
  properties?: Record<string, unknown>;
  quality?: number;
}

export interface GetDocumentResult {
  uri: string;
  content: unknown;
  contentType: string;
  metadata?: DocumentMetadata;
}

export interface ListDocumentsResult {
  uris: string[];
  total: number;
  start: number;
  pageLength: number;
}

export interface PutDocumentOptions {
  collections?: string[];
  permissions?: Array<{ "role-name": string; capability: string }>;
  quality?: number;
  database?: string;
}

export class DocumentsClient {
  constructor(
    private readonly base: MarkLogicBaseClient,
    private readonly readonly: boolean
  ) {}

  async get(uri: string, database?: string, includeMetadata = false): Promise<GetDocumentResult> {
    const qs = new URLSearchParams({ uri });
    if (database) qs.set("database", database);
    if (includeMetadata) { qs.append("category", "content"); qs.append("category", "metadata"); }

    let res: AxiosResponse<unknown>;
    try {
      res = await this.base.http.get(`/v1/documents?${qs.toString()}`, { responseType: "text" });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      if (e.statusCode === 404) throw new NotFoundError(uri);
      throw err;
    }

    return {
      uri,
      content: tryParseJson(res.data as string),
      contentType: (res.headers["content-type"] as string) ?? "application/octet-stream",
    };
  }

  async list(options: {
    collection?: string;
    directory?: string;
    start?: number;
    pageLength?: number;
    database?: string;
  }): Promise<ListDocumentsResult> {
    const params: Record<string, string | number> = {
      start: options.start ?? 1,
      "page-length": options.pageLength ?? 20,
    };
    if (options.collection) params.collection = options.collection;
    if (options.directory) params.directory = options.directory;
    if (options.database) params.database = options.database;

    const data = await this.base.get<{
      "uri-list": { uri: string | string[] };
      total: number;
      start: number;
      "page-length": number;
    }>(this.base.http, "/v1/documents", { params });

    const uriList = data?.["uri-list"]?.uri ?? [];
    const uris = Array.isArray(uriList) ? uriList : [uriList];
    return {
      uris,
      total: data?.total ?? uris.length,
      start: data?.start ?? 1,
      pageLength: data?.["page-length"] ?? 20,
    };
  }

  async put(uri: string, content: string, contentType: string, options: PutDocumentOptions = {}): Promise<void> {
    if (this.readonly) throw new WriteProtectedError();

    // Build query string manually so multiple collections serialize as repeated
    // collection= params (col=A&collection=B) rather than collection[]=A&collection[]=B,
    // which MarkLogic rejects with REST-UNSUPPORTEDPARAM.
    const qs = new URLSearchParams({ uri });
    if (options.database) qs.set("database", options.database);
    if (options.collections?.length) {
      for (const col of options.collections) qs.append("collection", col);
    }

    await this.base.put(this.base.http, `/v1/documents?${qs.toString()}`, content, {
      headers: { "Content-Type": contentType },
    });
  }

  async del(uri: string, database?: string): Promise<void> {
    if (this.readonly) throw new WriteProtectedError();
    const params: Record<string, string> = { uri };
    if (database) params.database = database;
    await this.base.delete(this.base.http, "/v1/documents", { params });
  }

  async patchDocument(uri: string, patch: unknown, database?: string): Promise<void> {
    if (this.readonly) throw new WriteProtectedError();
    const params: Record<string, string> = { uri };
    if (database) params.database = database;
    await this.base.patch(this.base.http, "/v1/documents", patch, {
      params,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
